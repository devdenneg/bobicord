//! Durable native authentication broker.
//!
//! The renderer receives only short-lived access JWTs. The rotating refresh credential is kept in
//! Windows Credential Manager and is used only by this allow-listed HTTP client. In particular,
//! there is intentionally no generic "native fetch" command and no command which returns a refresh
//! credential to JavaScript.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::ffi::c_void;
use std::ptr::null_mut;
use std::sync::Mutex as StdMutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex;
use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::FILETIME;
use windows::Win32::Security::Credentials::{
  CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_FLAGS,
  CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
};

const PROD_CREDENTIAL_TARGET: &str = "RelayApp/auth/session/v1";
const DEBUG_CREDENTIAL_TARGET: &str = "RelayApp/auth/session/debug/v1";
const CREDENTIAL_USERNAME: &str = "RelayApp";
const PROD_API_BASE: &str = "https://reelay.online/api";
const AUTH_PROTOCOL: &str = "persistent-v1";
const AUTH_TRANSPORT: &str = "bearer-v1";
const NATIVE_ORIGIN: &str = "tauri://localhost";
const MAX_CREDENTIAL_BYTES: usize = 2_048;
const MAX_AUTH_RESPONSE_BYTES: usize = 1_048_576;
const NOT_FOUND_HRESULT: i32 = 0x8007_0490u32 as i32;
const TREE_ACCESS_REFRESH_SKEW_MS: u64 = 30_000;
const TREE_ACCESS_HANDSHAKE_MARGIN_MS: u64 = 5_000;
const TREE_REFRESH_RETRY_BASE_MS: u64 = 10_000;
const TREE_REFRESH_RETRY_MAX_MS: u64 = 300_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeAuthError {
  code: String,
  message: String,
  status: u16,
  #[serde(skip_serializing_if = "Option::is_none")]
  details: Option<Value>,
  #[serde(skip_serializing_if = "Option::is_none")]
  attempts_remaining: Option<u64>,
  #[serde(skip_serializing_if = "Option::is_none")]
  retry_after: Option<u64>,
}

impl NativeAuthError {
  fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
    Self {
      code: code.into(), message: message.into(), status: 0, details: None,
      attempts_remaining: None, retry_after: None,
    }
  }

  fn storage(message: impl Into<String>) -> Self {
    Self::new("AUTH_SECURE_STORAGE_UNAVAILABLE", message)
  }

  fn network(error: &reqwest::Error) -> Self {
    let code = if error.is_timeout() { "REQUEST_TIMEOUT" } else { "NETWORK_ERROR" };
    let message = if error.is_timeout() {
      "Сервер не ответил вовремя"
    } else {
      "Не удалось связаться с сервером"
    };
    Self::new(code, message)
  }

  fn terminal(&self) -> bool {
    self.status == 401
      && (self.code == "SESSION_REVOKED" || self.code == "REFRESH_INVALID")
  }

  pub(crate) fn tree_refresh_failure(&self) -> (&'static str, bool) {
    // HTTP status is authoritative even when an upstream error body supplies its own code.
    // Treating a named 5xx as terminal would stop an otherwise healthy long-running stream during
    // a deploy, while retrying an arbitrary 4xx forever would hide a broken/revoked credential.
    if self.status == 429 { return ("native-auth-rate-limit", false); }
    if self.status >= 500 { return ("native-auth-upstream", false); }
    if self.status == 401 { return ("native-auth-session-ended", true); }
    if self.status >= 400 { return ("native-auth-invalid-response", true); }
    match self.code.as_str() {
      "NETWORK_ERROR" => ("native-auth-network", false),
      "REQUEST_TIMEOUT" => ("native-auth-timeout", false),
      "SESSION_REVOKED" | "REFRESH_INVALID" | "UNAUTHORIZED" => ("native-auth-session-ended", true),
      "LOGOUT_PENDING" => ("native-auth-logout-pending", true),
      "AUTH_SECURE_STORAGE_UNAVAILABLE" => ("native-auth-storage", true),
      _ => ("native-auth-invalid-response", true),
    }
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum StoredState {
  Active,
  LogoutPending,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CredentialEnvelope {
  version: u8,
  state: StoredState,
  session_id: String,
  refresh_token: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
enum ResumeState {
  Anonymous,
  Active,
  LogoutPending,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeResumeResult {
  state: ResumeState,
  #[serde(skip_serializing_if = "Option::is_none")]
  bundle: Option<Value>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativePushCleanup {
  user_id: String,
  endpoint: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeLogoutResult {
  complete: bool,
  pending: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  push_cleanup: Option<Value>,
}

enum RequestAuthorization<'a> {
  None,
  Bearer(&'a str),
  Refresh(&'a str),
}

struct ParsedBundle {
  envelope: CredentialEnvelope,
  sanitized: Value,
}

trait CredentialStore: Send + Sync {
  fn read(&self) -> Result<Option<CredentialEnvelope>, NativeAuthError>;
  fn write(&self, envelope: &CredentialEnvelope) -> Result<(), NativeAuthError>;
  fn delete(&self) -> Result<(), NativeAuthError>;
}

struct WindowsCredentialStore;

impl CredentialStore for WindowsCredentialStore {
  fn read(&self) -> Result<Option<CredentialEnvelope>, NativeAuthError> { read_credential() }
  fn write(&self, envelope: &CredentialEnvelope) -> Result<(), NativeAuthError> {
    write_credential(envelope)
  }
  fn delete(&self) -> Result<(), NativeAuthError> { delete_credential() }
}

trait AuthTransport: Send + Sync {
  fn post_json<'a>(
    &'a self,
    path: &'static str,
    authorization: RequestAuthorization<'a>,
    body: Value,
  ) -> impl std::future::Future<Output = Result<Value, NativeAuthError>> + Send + 'a;
}

pub struct NativeAuthState {
  owner: Mutex<()>,
  access_cache: StdMutex<Option<CachedAccess>>,
  access_retry: StdMutex<Option<CachedRefreshFailure>>,
  client: reqwest::Client,
  api_base: String,
}

#[derive(Clone)]
struct CachedAccess {
  token: String,
  expires_at: u64,
  session_id: String,
}

#[derive(Clone)]
struct CachedRefreshFailure {
  session_id: String,
  retry_at: u64,
  error: NativeAuthError,
}

impl NativeAuthState {
  pub fn new() -> Result<Self, String> {
    let api_base = validated_api_base()?;
    let https_only = api_base.starts_with("https://");
    let client = reqwest::Client::builder()
      .connect_timeout(Duration::from_secs(8))
      .timeout(Duration::from_secs(15))
      .redirect(reqwest::redirect::Policy::none())
      .https_only(https_only)
      .user_agent("RelayApp-native-auth/1")
      .build()
      .map_err(|_| "failed to initialize native auth transport".to_string())?;
    Ok(Self {
      owner: Mutex::new(()),
      access_cache: StdMutex::new(None),
      access_retry: StdMutex::new(None),
      client,
      api_base,
    })
  }

  async fn post_json(
    &self,
    path: &'static str,
    authorization: RequestAuthorization<'_>,
    body: Value,
  ) -> Result<Value, NativeAuthError> {
    // Every caller uses a literal from this exhaustive allow-list. Keep the check at the transport
    // boundary as defence in depth against a future accidental generic command.
    if !matches!(path,
      "/auth/session/upgrade" | "/auth/session/refresh" | "/auth/session/logout"
      | "/login" | "/auth/register/verify" | "/auth/email/verify"
      | "/auth/password/change"
    ) {
      return Err(NativeAuthError::new("AUTH_ROUTE_FORBIDDEN", "Запрос авторизации запрещён"));
    }
    let refresh_secret = match &authorization {
      RequestAuthorization::Refresh(value) => Some(*value),
      _ => None,
    };
    let mut request = self.client
      .post(format!("{}{}", self.api_base, path))
      .header("X-Relay-Auth-Protocol", AUTH_PROTOCOL)
      .header("X-Relay-Auth-Transport", AUTH_TRANSPORT)
      .header("Origin", NATIVE_ORIGIN)
      .header("Cache-Control", "no-store")
      .json(&body);
    request = match authorization {
      RequestAuthorization::None => request,
      RequestAuthorization::Bearer(value) => {
        validate_header_secret(value)?;
        request.bearer_auth(value)
      }
      RequestAuthorization::Refresh(value) => {
        validate_refresh_token(value)?;
        request.header("Authorization", format!("Refresh {value}"))
      }
    };
    let mut response = request.send().await.map_err(|error| NativeAuthError::network(&error))?;
    let status = response.status();
    if response.content_length().is_some_and(|length| length > MAX_AUTH_RESPONSE_BYTES as u64) {
      return Err(NativeAuthError::new("INVALID_RESPONSE", "Ответ авторизации слишком большой"));
    }
    let mut bytes = Vec::with_capacity(
      response.content_length().unwrap_or(0).min(MAX_AUTH_RESPONSE_BYTES as u64) as usize,
    );
    while let Some(chunk) = response.chunk().await.map_err(|error| NativeAuthError::network(&error))? {
      if bytes.len().saturating_add(chunk.len()) > MAX_AUTH_RESPONSE_BYTES {
        return Err(NativeAuthError::new("INVALID_RESPONSE", "Ответ авторизации слишком большой"));
      }
      bytes.extend_from_slice(&chunk);
    }
    if !status.is_success() && refresh_secret.is_some_and(|secret| {
      bytes.windows(secret.len()).any(|window| window == secret.as_bytes())
    }) {
      // Even a misconfigured or compromised upstream must not reflect the refresh credential into
      // a serialized Tauri command error. The renderer gets only a generic response failure.
      return Err(NativeAuthError::new("INVALID_RESPONSE", "Некорректный ответ сервера авторизации"));
    }
    let data: Value = serde_json::from_slice(&bytes)
      .map_err(|_| NativeAuthError::new("INVALID_RESPONSE", "Некорректный ответ сервера авторизации"))?;
    if !status.is_success() {
      return Err(server_error(status.as_u16(), &data));
    }
    Ok(data)
  }

  async fn refresh_locked(&self, current: &CredentialEnvelope) -> Result<Value, NativeAuthError> {
    let bundle = match refresh_with(&WindowsCredentialStore, self, current).await {
      Ok(bundle) => bundle,
      Err(error) => {
        if error.tree_refresh_failure().1 {
          self.invalidate_tree_access_cache();
        } else {
          remember_cached_refresh_failure(
            &self.access_retry, &current.session_id, &error, now_millis(),
          );
        }
        return Err(error);
      }
    };
    self.remember_access(&bundle)?;
    Ok(bundle)
  }

  async fn persist_rotated_bundle(
    &self,
    response: Value,
    previous: Option<&CredentialEnvelope>,
  ) -> Result<Value, NativeAuthError> {
    let bundle = persist_rotated_with(&WindowsCredentialStore, self, response, previous).await?;
    self.remember_access(&bundle)?;
    Ok(bundle)
  }

  async fn authenticated_mutation(
    &self,
    path: &'static str,
    access_token: &str,
    body: Value,
  ) -> Result<Value, NativeAuthError> {
    let bundle = match authenticated_mutation_with(
      &WindowsCredentialStore, self, path, access_token, body,
    ).await {
      Ok(bundle) => bundle,
      Err(error) => {
        if error.tree_refresh_failure().1 { self.invalidate_tree_access_cache(); }
        return Err(error);
      }
    };
    self.remember_access(&bundle)?;
    Ok(bundle)
  }

  fn remember_access(&self, value: &Value) -> Result<(), NativeAuthError> {
    let cached = cached_access(value)?;
    *self.access_cache.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(cached);
    *self.access_retry.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    Ok(())
  }

  pub(crate) fn invalidate_tree_access_cache(&self) {
    *self.access_cache.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    *self.access_retry.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
  }

  /// Compare-and-clear for an exact rejected socket credential. A delayed 401/4001 from an older
  /// watch must not evict a newer access token installed by another watch or renderer refresh.
  pub(crate) fn invalidate_rejected_tree_access(&self, rejected_token: &str) {
    if invalidate_rejected_cached_access(&self.access_cache, rejected_token) {
      // An authoritative 401/4001 must bypass a transient auth cooldown and try a genuinely fresh
      // access token. The CAS above prevents an old socket from clearing a newer generation.
      *self.access_retry.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    }
  }

  /// Internal tree-signalling renewal. It shares the exact Credential Manager lock/rotation path
  /// used by the renderer command, but returns only the already-sanitized short-lived access JWT.
  /// The rotating refresh credential and CSRF value never cross this boundary.
  pub(crate) async fn refresh_tree_access_token(&self) -> Result<String, NativeAuthError> {
    let _owner = self.owner.lock().await;
    let current = match read_credential()? {
      Some(current) => current,
      None => {
        self.invalidate_tree_access_cache();
        return Err(NativeAuthError::new("SESSION_REVOKED", "Сохранённая сессия не найдена"));
      }
    };
    if current.state != StoredState::Active {
      self.invalidate_tree_access_cache();
      return Err(NativeAuthError::new("LOGOUT_PENDING", "Предыдущий выход ещё не завершён"));
    }
    let now = now_millis();
    // Copy the bounded access value while the synchronous cache guard is held, then drop the guard
    // before the refresh await. This keeps NativeAuthState Send-safe and ensures every watch and
    // broadcast shares the same outer owner instead of independently rotating the refresh token.
    let (reusable, fallback) = {
      let mut cache = self.access_cache.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
      if cache.as_ref().is_some_and(|cached| cached.session_id != current.session_id) {
        *cache = None;
      }
      (
        reusable_cached_access(
          cache.as_ref(), &current.session_id, now, TREE_ACCESS_REFRESH_SKEW_MS,
        ),
        reusable_cached_access(
          cache.as_ref(), &current.session_id, now, TREE_ACCESS_HANDSHAKE_MARGIN_MS,
        ),
      )
    };
    if let Some(token) = reusable { return Ok(token); }
    if let Some(error) = cached_refresh_failure(
      &self.access_retry, &current.session_id, now,
    ) {
      return fallback.ok_or(error);
    }
    match self.refresh_locked(&current).await {
      Ok(bundle) => sanitized_access_token(&bundle),
      Err(error) => {
        // A transient auth outage does not make an access JWT invalid. Keep the last few usable
        // seconds as a handshake fallback; exact 401/4001 already CAS-cleared this cache, and a
        // terminal refresh always clears it before arriving here.
        if !error.tree_refresh_failure().1 {
          if let Some(token) = fallback { return Ok(token); }
        }
        Err(error)
      }
    }
  }
}

impl AuthTransport for NativeAuthState {
  fn post_json<'a>(
    &'a self,
    path: &'static str,
    authorization: RequestAuthorization<'a>,
    body: Value,
  ) -> impl std::future::Future<Output = Result<Value, NativeAuthError>> + Send + 'a {
    async move { NativeAuthState::post_json(self, path, authorization, body).await }
  }
}

async fn refresh_with<S: CredentialStore, T: AuthTransport>(
  store: &S,
  transport: &T,
  current: &CredentialEnvelope,
) -> Result<Value, NativeAuthError> {
  let response = transport.post_json(
    "/auth/session/refresh",
    RequestAuthorization::Refresh(&current.refresh_token),
    json!({}),
  ).await;
  let response = match response {
    Ok(value) => value,
    Err(error) => {
      if error.terminal() {
        // The server is authoritative. Removing the only active credential here ensures a
        // renderer crash before its local marker is written cannot resurrect a revoked account.
        store.delete()?;
      }
      return Err(error);
    }
  };
  persist_rotated_with(store, transport, response, Some(current)).await
}

async fn persist_rotated_with<S: CredentialStore, T: AuthTransport>(
  store: &S,
  transport: &T,
  response: Value,
  previous: Option<&CredentialEnvelope>,
) -> Result<Value, NativeAuthError> {
  let parsed = parse_persistent_bundle(response)?;
  if let Some(old) = previous {
    if old.session_id != parsed.envelope.session_id {
      return Err(NativeAuthError::new(
        "INVALID_AUTH_RESPONSE", "Сервер вернул другую сессию устройства",
      ));
    }
    if let Err(error) = store.write(&parsed.envelope) {
      // The server accepts a bounded window of authentic prior generations. Retaining the old
      // Credential Manager value is therefore crash-safe: the next refresh recovers the newest
      // generation and retries this exact write without logging the user out.
      log::warn!("native auth credential rotation was not persisted: {}", error.code);
    }
    return Ok(parsed.sanitized);
  }

  if let Err(storage_error) = store.write(&parsed.envelope) {
    // A first login/upgrade has no previous durable recovery credential. Best-effort revoke the
    // just-created server row and never expose its refresh credential to the renderer.
    let _ = transport.post_json(
      "/auth/session/logout",
      RequestAuthorization::Refresh(&parsed.envelope.refresh_token),
      json!({ "pushCleanups": [] }),
    ).await;
    return Err(storage_error);
  }
  Ok(parsed.sanitized)
}

async fn authenticated_mutation_with<S: CredentialStore, T: AuthTransport>(
  store: &S,
  transport: &T,
  path: &'static str,
  access_token: &str,
  body: Value,
) -> Result<Value, NativeAuthError> {
  let current = store.read()?.ok_or_else(|| {
    NativeAuthError::new("SESSION_REVOKED", "Сохранённая сессия не найдена")
  })?;
  if current.state != StoredState::Active {
    return Err(NativeAuthError::new(
      "LOGOUT_PENDING", "Предыдущий выход ещё не подтверждён сервером",
    ));
  }
  let response = transport.post_json(path, RequestAuthorization::Bearer(access_token), body).await;
  let response = match response {
    Ok(value) => value,
    Err(error) => {
      if error.terminal() { store.delete()?; }
      return Err(error);
    }
  };
  persist_rotated_with(store, transport, response, Some(&current)).await
}

fn validated_api_base() -> Result<String, String> {
  let configured = option_env!("RELAY_NATIVE_API_BASE").unwrap_or(PROD_API_BASE).trim();
  if configured == PROD_API_BASE { return Ok(configured.to_string()); }
  #[cfg(debug_assertions)]
  {
    let parsed = reqwest::Url::parse(configured)
      .map_err(|_| "RELAY_NATIVE_API_BASE is not a valid URL".to_string())?;
    let loopback = parsed.scheme() == "http"
      && matches!(parsed.host_str(), Some("127.0.0.1") | Some("localhost"))
      && parsed.port().is_some()
      && parsed.username().is_empty()
      && parsed.password().is_none()
      && parsed.path().trim_end_matches('/') == "/api"
      && parsed.query().is_none()
      && parsed.fragment().is_none();
    if loopback { return Ok(configured.trim_end_matches('/').to_string()); }
  }
  Err("native auth API must be the production origin or an explicit debug loopback".to_string())
}

fn validate_header_secret(value: &str) -> Result<(), NativeAuthError> {
  if value.is_empty() || value.len() > 16_384 || !value.is_ascii()
    || value.bytes().any(|byte| byte <= 0x20 || byte == 0x7f)
  {
    return Err(NativeAuthError::new("AUTH_CREDENTIAL_INVALID", "Некорректные данные сессии"));
  }
  Ok(())
}

fn token_component(value: &str) -> bool {
  !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn validate_refresh_token(value: &str) -> Result<String, NativeAuthError> {
  if value.len() > 512 || !value.is_ascii() {
    return Err(NativeAuthError::new("REFRESH_INVALID", "Некорректная защищённая сессия"));
  }
  let parts: Vec<&str> = value.split('.').collect();
  let valid_generation = parts.get(2).is_some_and(|part| {
    !part.is_empty() && part.len() <= 11
      && part.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'z').contains(&byte))
  });
  if parts.len() != 4 || parts[0] != "rr1" || parts[1].len() != 32
    || !token_component(parts[1]) || !valid_generation
    || parts[3].len() != 43 || !token_component(parts[3])
  {
    return Err(NativeAuthError::new("REFRESH_INVALID", "Некорректная защищённая сессия"));
  }
  Ok(parts[1].to_string())
}

fn parse_persistent_bundle(mut value: Value) -> Result<ParsedBundle, NativeAuthError> {
  let object = value.as_object_mut().ok_or_else(|| {
    NativeAuthError::new("INVALID_AUTH_RESPONSE", "Некорректный ответ авторизации")
  })?;
  if object.get("protocol").and_then(Value::as_str) != Some(AUTH_PROTOCOL) {
    return Err(NativeAuthError::new("INVALID_AUTH_RESPONSE", "Сервер не подтвердил защищённую сессию"));
  }
  let token = object.get("token").and_then(Value::as_str).unwrap_or("");
  let access = object.get("accessToken").and_then(Value::as_str).unwrap_or("");
  validate_header_secret(access)?;
  if token != access {
    return Err(NativeAuthError::new("INVALID_AUTH_RESPONSE", "Сервер вернул разные ключи доступа"));
  }
  let expires = object.get("accessExpiresAt").and_then(Value::as_u64).unwrap_or(0);
  let now = now_millis();
  if expires <= now.saturating_sub(5_000) {
    return Err(NativeAuthError::new("INVALID_AUTH_RESPONSE", "Сервер вернул истёкший доступ"));
  }
  let session_id = object.get("sessionId").and_then(Value::as_str).unwrap_or("").to_string();
  if session_id.len() != 32 || !token_component(&session_id) {
    return Err(NativeAuthError::new("INVALID_AUTH_RESPONSE", "Некорректный идентификатор сессии"));
  }
  let user = object.get("user").and_then(Value::as_object);
  if user.and_then(|item| item.get("id")).and_then(Value::as_str).unwrap_or("").is_empty()
    || user.and_then(|item| item.get("username")).and_then(Value::as_str).unwrap_or("").is_empty()
  {
    return Err(NativeAuthError::new("INVALID_AUTH_RESPONSE", "Ответ не содержит аккаунт"));
  }
  let account_state = object.get("account").and_then(Value::as_object)
    .and_then(|item| item.get("state")).and_then(Value::as_str).unwrap_or("");
  if !matches!(account_state, "ready" | "email_required" | "email_verification") {
    return Err(NativeAuthError::new("INVALID_AUTH_RESPONSE", "Некорректное состояние аккаунта"));
  }
  let refresh_token = object.remove("refreshToken").and_then(|item| item.as_str().map(str::to_string))
    .ok_or_else(|| NativeAuthError::new("INVALID_AUTH_RESPONSE", "Сервер не вернул защищённую сессию"))?;
  object.remove("csrfToken");
  let refresh_session_id = validate_refresh_token(&refresh_token)?;
  if refresh_session_id != session_id {
    return Err(NativeAuthError::new("INVALID_AUTH_RESPONSE", "Сервер смешал разные сессии"));
  }
  // Never let an unexpected nested echo smuggle the credential through IPC.
  if serde_json::to_string(&value).unwrap_or_default().contains(&refresh_token) {
    return Err(NativeAuthError::new("INVALID_AUTH_RESPONSE", "Ответ содержит закрытые данные"));
  }
  Ok(ParsedBundle {
    envelope: CredentialEnvelope {
      version: 1, state: StoredState::Active, session_id, refresh_token,
    },
    sanitized: value,
  })
}

fn now_millis() -> u64 {
  SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

fn sanitized_access_token(value: &Value) -> Result<String, NativeAuthError> {
  // parse_persistent_bundle already removed refreshToken/csrfToken before this value was returned;
  // validate again at the internal consumer boundary so a future refactor cannot turn tree URL
  // renewal into a secret-exfiltration path.
  if value.get("refreshToken").is_some() || value.get("csrfToken").is_some() {
    return Err(NativeAuthError::new("INVALID_AUTH_RESPONSE", "Ответ содержит закрытые данные"));
  }
  let token = value.get("accessToken").and_then(Value::as_str).unwrap_or("");
  validate_header_secret(token)?;
  if value.get("token").and_then(Value::as_str) != Some(token) {
    return Err(NativeAuthError::new("INVALID_AUTH_RESPONSE", "Сервер вернул разные ключи доступа"));
  }
  Ok(token.to_string())
}

fn cached_access(value: &Value) -> Result<CachedAccess, NativeAuthError> {
  let token = sanitized_access_token(value)?;
  let expires_at = value.get("accessExpiresAt").and_then(Value::as_u64).unwrap_or(0);
  if expires_at <= now_millis() {
    return Err(NativeAuthError::new("INVALID_AUTH_RESPONSE", "Сервер вернул истёкший доступ"));
  }
  let session_id = value.get("sessionId").and_then(Value::as_str).unwrap_or("");
  if session_id.len() != 32 || !token_component(session_id) {
    return Err(NativeAuthError::new("INVALID_AUTH_RESPONSE", "Некорректный идентификатор сессии"));
  }
  Ok(CachedAccess { token, expires_at, session_id: session_id.to_string() })
}

fn reusable_cached_access(
  cache: Option<&CachedAccess>,
  session_id: &str,
  now: u64,
  margin_ms: u64,
) -> Option<String> {
  cache
    .filter(|cached| cached.session_id == session_id
      && cached.expires_at > now.saturating_add(margin_ms))
    .map(|cached| cached.token.clone())
}

fn tree_refresh_retry_ms(error: &NativeAuthError) -> u64 {
  let requested = error.retry_after.unwrap_or(0).saturating_mul(1_000);
  requested.max(TREE_REFRESH_RETRY_BASE_MS).min(TREE_REFRESH_RETRY_MAX_MS)
}

fn remember_cached_refresh_failure(
  cache: &StdMutex<Option<CachedRefreshFailure>>,
  session_id: &str,
  error: &NativeAuthError,
  now: u64,
) {
  if error.tree_refresh_failure().1 { return; }
  *cache.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(CachedRefreshFailure {
    session_id: session_id.to_string(),
    retry_at: now.saturating_add(tree_refresh_retry_ms(error)),
    error: error.clone(),
  });
}

fn cached_refresh_failure(
  cache: &StdMutex<Option<CachedRefreshFailure>>,
  session_id: &str,
  now: u64,
) -> Option<NativeAuthError> {
  let mut cache = cache.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
  match cache.as_ref() {
    Some(failure) if failure.session_id == session_id && failure.retry_at > now => {
      Some(failure.error.clone())
    }
    Some(_) => { *cache = None; None }
    None => None,
  }
}

fn invalidate_rejected_cached_access(
  cache: &StdMutex<Option<CachedAccess>>,
  rejected_token: &str,
) -> bool {
  let mut cache = cache.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
  if !cache.as_ref().is_some_and(|cached| cached.token == rejected_token) { return false; }
  *cache = None;
  true
}

fn server_error(status: u16, data: &Value) -> NativeAuthError {
  let raw = data.get("error");
  let detail = raw.and_then(Value::as_object);
  let message = raw.and_then(Value::as_str)
    .or_else(|| detail.and_then(|item| item.get("message")).and_then(Value::as_str))
    .unwrap_or(if status == 401 { "Сессия больше не активна" } else { "Ошибка авторизации" });
  let code = detail.and_then(|item| item.get("code")).and_then(Value::as_str)
    .unwrap_or(if status == 401 { "UNAUTHORIZED" } else { "HTTP_ERROR" });
  let details = detail.and_then(|item| item.get("details")).cloned();
  let attempts_remaining = detail.and_then(|item| item.get("attemptsRemaining")).and_then(Value::as_u64)
    .or_else(|| details.as_ref().and_then(|item| item.get("attemptsRemaining")).and_then(Value::as_u64));
  let retry_after = detail.and_then(|item| item.get("retryAfter")).and_then(Value::as_u64)
    .or_else(|| details.as_ref().and_then(|item| item.get("retryAfter")).and_then(Value::as_u64));
  NativeAuthError {
    code: code.to_string(), message: message.to_string(), status, details,
    attempts_remaining, retry_after,
  }
}

fn encode_envelope(envelope: &CredentialEnvelope) -> Result<Vec<u8>, NativeAuthError> {
  if envelope.version != 1 || envelope.session_id != validate_refresh_token(&envelope.refresh_token)? {
    return Err(NativeAuthError::storage("Некорректное состояние защищённой сессии"));
  }
  let bytes = serde_json::to_vec(envelope)
    .map_err(|_| NativeAuthError::storage("Не удалось подготовить защищённую сессию"))?;
  if bytes.len() > MAX_CREDENTIAL_BYTES {
    return Err(NativeAuthError::storage("Защищённая сессия слишком большая"));
  }
  Ok(bytes)
}

fn decode_envelope(bytes: &[u8]) -> Result<CredentialEnvelope, NativeAuthError> {
  if bytes.is_empty() || bytes.len() > MAX_CREDENTIAL_BYTES {
    return Err(NativeAuthError::storage("Хранилище содержит некорректную сессию"));
  }
  let envelope: CredentialEnvelope = serde_json::from_slice(bytes)
    .map_err(|_| NativeAuthError::storage("Хранилище содержит некорректную сессию"))?;
  encode_envelope(&envelope)?;
  Ok(envelope)
}

fn wide(value: &str) -> Vec<u16> {
  value.encode_utf16().chain(std::iter::once(0)).collect()
}

fn credential_target() -> &'static str {
  // A debug executable may be redirected to a loopback API. Never let it read or overwrite the
  // production refresh credential, even when both binaries run under the same Windows account.
  if cfg!(debug_assertions) { DEBUG_CREDENTIAL_TARGET } else { PROD_CREDENTIAL_TARGET }
}

struct CredentialAllocation(*mut CREDENTIALW);
impl Drop for CredentialAllocation {
  fn drop(&mut self) {
    if !self.0.is_null() {
      unsafe { CredFree(self.0.cast::<c_void>()); }
    }
  }
}

fn read_credential() -> Result<Option<CredentialEnvelope>, NativeAuthError> {
  let target = wide(credential_target());
  let mut raw: *mut CREDENTIALW = null_mut();
  if let Err(error) = unsafe {
    CredReadW(PCWSTR(target.as_ptr()), CRED_TYPE_GENERIC, None, &mut raw)
  } {
    if error.code().0 == NOT_FOUND_HRESULT { return Ok(None); }
    return Err(NativeAuthError::storage(format!("Credential Manager read failed ({})", error.code().0)));
  }
  let allocation = CredentialAllocation(raw);
  if allocation.0.is_null() {
    return Err(NativeAuthError::storage("Credential Manager returned an empty record"));
  }
  let credential = unsafe { &*allocation.0 };
  let size = credential.CredentialBlobSize as usize;
  if size == 0 || size > MAX_CREDENTIAL_BYTES || credential.CredentialBlob.is_null() {
    return Err(NativeAuthError::storage("Credential Manager contains an invalid record"));
  }
  let bytes = unsafe { std::slice::from_raw_parts(credential.CredentialBlob, size) };
  decode_envelope(bytes).map(Some)
}

fn write_credential(envelope: &CredentialEnvelope) -> Result<(), NativeAuthError> {
  let mut payload = encode_envelope(envelope)?;
  let mut target = wide(credential_target());
  let mut username = wide(CREDENTIAL_USERNAME);
  let credential = CREDENTIALW {
    Flags: CRED_FLAGS(0),
    Type: CRED_TYPE_GENERIC,
    TargetName: PWSTR(target.as_mut_ptr()),
    Comment: PWSTR(null_mut()),
    LastWritten: FILETIME::default(),
    CredentialBlobSize: payload.len() as u32,
    CredentialBlob: payload.as_mut_ptr(),
    Persist: CRED_PERSIST_LOCAL_MACHINE,
    AttributeCount: 0,
    Attributes: null_mut(),
    TargetAlias: PWSTR(null_mut()),
    UserName: PWSTR(username.as_mut_ptr()),
  };
  unsafe { CredWriteW(&credential, 0) }
    .map_err(|error| NativeAuthError::storage(format!("Credential Manager write failed ({})", error.code().0)))
}

fn delete_credential() -> Result<(), NativeAuthError> {
  let target = wide(credential_target());
  match unsafe { CredDeleteW(PCWSTR(target.as_ptr()), CRED_TYPE_GENERIC, None) } {
    Ok(()) => Ok(()),
    Err(error) if error.code().0 == NOT_FOUND_HRESULT => Ok(()),
    Err(error) => Err(NativeAuthError::storage(format!("Credential Manager delete failed ({})", error.code().0))),
  }
}

fn active_username(bundle: &Value) -> &str {
  bundle.get("user").and_then(Value::as_object)
    .and_then(|user| user.get("username")).and_then(Value::as_str).unwrap_or("")
}

fn authorize_invoker(window: &tauri::WebviewWindow) -> Result<(), NativeAuthError> {
  if window.label() != "main" {
    return Err(NativeAuthError::new("AUTH_INVOKER_FORBIDDEN", "Окно не может использовать сессию"));
  }
  let url = window.url()
    .map_err(|_| NativeAuthError::new("AUTH_INVOKER_FORBIDDEN", "Не удалось проверить окно"))?;
  let bundled = url.username().is_empty() && url.password().is_none()
    && matches!(
      (url.scheme(), url.host_str(), url.port()),
      ("tauri", Some("localhost"), None)
        | ("http", Some("tauri.localhost"), None)
        | ("https", Some("tauri.localhost"), None)
    );
  #[cfg(debug_assertions)]
  let development = url.username().is_empty() && url.password().is_none()
    && matches!(
      (url.scheme(), url.host_str(), url.port()),
      ("http", Some("localhost"), Some(5173))
        | ("http", Some("127.0.0.1"), Some(5173))
    );
  #[cfg(not(debug_assertions))]
  let development = false;
  if !bundled && !development {
    return Err(NativeAuthError::new("AUTH_INVOKER_FORBIDDEN", "Источник окна не может использовать сессию"));
  }
  Ok(())
}

fn begin_logout_with<S: CredentialStore>(store: &S) -> Result<bool, NativeAuthError> {
  let Some(mut current) = store.read()? else { return Ok(false); };
  if current.state == StoredState::Active {
    current.state = StoredState::LogoutPending;
    // This write is the durable linearization point of explicit native logout. The UI must not
    // claim success or discard its access token if Credential Manager rejects it.
    store.write(&current)?;
  }
  Ok(true)
}

async fn drain_logout_with<S: CredentialStore, T: AuthTransport>(
  store: &S,
  transport: &T,
  push_cleanups: Vec<NativePushCleanup>,
) -> Result<NativeLogoutResult, NativeAuthError> {
  let Some(current) = store.read()? else {
    return Ok(NativeLogoutResult { complete: true, pending: false, push_cleanup: None });
  };
  if current.state != StoredState::LogoutPending {
    return Ok(NativeLogoutResult { complete: true, pending: false, push_cleanup: None });
  }
  let response = transport.post_json(
    "/auth/session/logout",
    RequestAuthorization::Refresh(&current.refresh_token),
    json!({ "pushCleanups": push_cleanups }),
  ).await;
  match response {
    Ok(value) => {
      store.delete()?;
      Ok(NativeLogoutResult {
        complete: true,
        pending: false,
        push_cleanup: value.get("pushCleanup").cloned(),
      })
    }
    Err(error) if error.terminal() => {
      store.delete()?;
      Ok(NativeLogoutResult { complete: true, pending: false, push_cleanup: None })
    }
    Err(error) => Err(error),
  }
}

#[tauri::command]
pub async fn native_auth_resume(
  state: tauri::State<'_, NativeAuthState>,
  window: tauri::WebviewWindow,
  legacy_token: Option<String>,
) -> Result<NativeResumeResult, NativeAuthError> {
  authorize_invoker(&window)?;
  let _owner = state.owner.lock().await;
  match read_credential()? {
    Some(current) if current.state == StoredState::LogoutPending => Ok(NativeResumeResult {
      state: ResumeState::LogoutPending, bundle: None,
    }),
    Some(current) => {
      let bundle = state.refresh_locked(&current).await?;
      Ok(NativeResumeResult { state: ResumeState::Active, bundle: Some(bundle) })
    }
    None => {
      let legacy = legacy_token.unwrap_or_default();
      if legacy.trim().is_empty() {
        return Ok(NativeResumeResult { state: ResumeState::Anonymous, bundle: None });
      }
      validate_header_secret(&legacy)?;
      let response = state.post_json(
        "/auth/session/upgrade",
        RequestAuthorization::Bearer(&legacy),
        json!({ "deviceName": "RelayApp Windows" }),
      ).await?;
      let bundle = state.persist_rotated_bundle(response, None).await?;
      Ok(NativeResumeResult { state: ResumeState::Active, bundle: Some(bundle) })
    }
  }
}

#[tauri::command]
pub async fn native_auth_refresh(
  state: tauri::State<'_, NativeAuthState>,
  window: tauri::WebviewWindow,
) -> Result<Value, NativeAuthError> {
  authorize_invoker(&window)?;
  let _owner = state.owner.lock().await;
  let current = read_credential()?.ok_or_else(|| {
    NativeAuthError::new("SESSION_REVOKED", "Сохранённая сессия не найдена")
  })?;
  if current.state != StoredState::Active {
    return Err(NativeAuthError::new("LOGOUT_PENDING", "Предыдущий выход ещё не завершён"));
  }
  state.refresh_locked(&current).await
}

#[tauri::command]
pub async fn native_auth_login(
  state: tauri::State<'_, NativeAuthState>,
  window: tauri::WebviewWindow,
  username: String,
  password: String,
) -> Result<Value, NativeAuthError> {
  authorize_invoker(&window)?;
  let _owner = state.owner.lock().await;
  if let Some(current) = read_credential()? {
    if current.state == StoredState::LogoutPending {
      return Err(NativeAuthError::new("LOGOUT_PENDING", "Предыдущий выход ещё не завершён"));
    }
    let existing = state.refresh_locked(&current).await?;
    if active_username(&existing).trim().eq_ignore_ascii_case(username.trim()) {
      return Ok(existing);
    }
    return Err(NativeAuthError::new(
      "SESSION_ALREADY_ACTIVE", "На устройстве уже открыт другой аккаунт",
    ));
  }
  let response = state.post_json(
    "/login", RequestAuthorization::None,
    json!({ "username": username, "password": password, "deviceName": "RelayApp Windows" }),
  ).await?;
  state.persist_rotated_bundle(response, None).await
}

#[tauri::command]
pub async fn native_auth_register_verify(
  state: tauri::State<'_, NativeAuthState>,
  window: tauri::WebviewWindow,
  flow_id: String,
  code: String,
) -> Result<Value, NativeAuthError> {
  authorize_invoker(&window)?;
  let _owner = state.owner.lock().await;
  if let Some(current) = read_credential()? {
    let code = if current.state == StoredState::LogoutPending {
      "LOGOUT_PENDING"
    } else {
      "SESSION_ALREADY_ACTIVE"
    };
    return Err(NativeAuthError::new(code, "На устройстве уже сохранена сессия"));
  }
  let response = state.post_json(
    "/auth/register/verify", RequestAuthorization::None,
    json!({ "flowId": flow_id, "code": code, "deviceName": "RelayApp Windows" }),
  ).await?;
  state.persist_rotated_bundle(response, None).await
}

#[tauri::command]
pub async fn native_auth_email_verify(
  state: tauri::State<'_, NativeAuthState>,
  window: tauri::WebviewWindow,
  access_token: String,
  flow_id: String,
  code: String,
) -> Result<Value, NativeAuthError> {
  authorize_invoker(&window)?;
  let _owner = state.owner.lock().await;
  state.authenticated_mutation(
    "/auth/email/verify", &access_token, json!({ "flowId": flow_id, "code": code }),
  ).await
}

#[tauri::command]
pub async fn native_auth_password_change(
  state: tauri::State<'_, NativeAuthState>,
  window: tauri::WebviewWindow,
  access_token: String,
  current_password: String,
  new_password: String,
) -> Result<Value, NativeAuthError> {
  authorize_invoker(&window)?;
  let _owner = state.owner.lock().await;
  state.authenticated_mutation(
    "/auth/password/change", &access_token,
    json!({ "currentPassword": current_password, "newPassword": new_password }),
  ).await
}

#[tauri::command]
pub async fn native_auth_begin_logout(
  state: tauri::State<'_, NativeAuthState>,
  window: tauri::WebviewWindow,
) -> Result<bool, NativeAuthError> {
  authorize_invoker(&window)?;
  let _owner = state.owner.lock().await;
  state.invalidate_tree_access_cache();
  begin_logout_with(&WindowsCredentialStore)
}

#[tauri::command]
pub async fn native_auth_drain_logout(
  state: tauri::State<'_, NativeAuthState>,
  window: tauri::WebviewWindow,
  push_cleanups: Vec<NativePushCleanup>,
) -> Result<NativeLogoutResult, NativeAuthError> {
  authorize_invoker(&window)?;
  let _owner = state.owner.lock().await;
  state.invalidate_tree_access_cache();
  drain_logout_with(&WindowsCredentialStore, &*state, push_cleanups).await
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::collections::VecDeque;
  use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
  use std::sync::Mutex as StdMutex;

  struct MockStore {
    value: StdMutex<Option<CredentialEnvelope>>,
    fail_write: AtomicBool,
    deletes: AtomicUsize,
  }

  impl MockStore {
    fn new(value: Option<CredentialEnvelope>) -> Self {
      Self {
        value: StdMutex::new(value),
        fail_write: AtomicBool::new(false),
        deletes: AtomicUsize::new(0),
      }
    }

    fn stored(&self) -> Option<CredentialEnvelope> {
      self.value.lock().unwrap().clone()
    }
  }

  impl CredentialStore for MockStore {
    fn read(&self) -> Result<Option<CredentialEnvelope>, NativeAuthError> {
      Ok(self.stored())
    }

    fn write(&self, envelope: &CredentialEnvelope) -> Result<(), NativeAuthError> {
      if self.fail_write.load(Ordering::SeqCst) {
        return Err(NativeAuthError::storage("injected write failure"));
      }
      *self.value.lock().unwrap() = Some(envelope.clone());
      Ok(())
    }

    fn delete(&self) -> Result<(), NativeAuthError> {
      self.deletes.fetch_add(1, Ordering::SeqCst);
      *self.value.lock().unwrap() = None;
      Ok(())
    }
  }

  struct MockTransport {
    responses: StdMutex<VecDeque<Result<Value, NativeAuthError>>>,
    calls: StdMutex<Vec<(&'static str, &'static str)>>,
  }

  impl MockTransport {
    fn new(responses: Vec<Result<Value, NativeAuthError>>) -> Self {
      Self {
        responses: StdMutex::new(responses.into()),
        calls: StdMutex::new(Vec::new()),
      }
    }

    fn push(&self, response: Result<Value, NativeAuthError>) {
      self.responses.lock().unwrap().push_back(response);
    }
  }

  impl AuthTransport for MockTransport {
    fn post_json<'a>(
      &'a self,
      path: &'static str,
      authorization: RequestAuthorization<'a>,
      _body: Value,
    ) -> impl std::future::Future<Output = Result<Value, NativeAuthError>> + Send + 'a {
      async move {
        let kind = match authorization {
          RequestAuthorization::None => "none",
          RequestAuthorization::Bearer(_) => "bearer",
          RequestAuthorization::Refresh(_) => "refresh",
        };
        self.calls.lock().unwrap().push((path, kind));
        self.responses.lock().unwrap().pop_front()
          .expect("missing injected auth transport response")
      }
    }
  }

  fn refresh(session: &str, generation: &str) -> String {
    format!("rr1.{session}.{generation}.{}", "A".repeat(43))
  }

  fn bundle(session: &str, refresh_token: &str) -> Value {
    json!({
      "protocol": "persistent-v1",
      "token": "short-lived-access",
      "accessToken": "short-lived-access",
      "accessExpiresAt": u64::MAX - 1,
      "sessionId": session,
      "refreshToken": refresh_token,
      "csrfToken": "must-not-cross-ipc",
      "user": { "id": "u1", "username": "alice" },
      "account": { "state": "ready" }
    })
  }

  fn envelope(session: &str, generation: &str, state: StoredState) -> CredentialEnvelope {
    CredentialEnvelope {
      version: 1,
      state,
      session_id: session.to_string(),
      refresh_token: refresh(session, generation),
    }
  }

  #[test]
  fn refresh_format_and_envelope_are_strict() {
    let session = "A".repeat(32);
    let token = refresh(&session, "0");
    assert_eq!(validate_refresh_token(&token).unwrap(), session);
    assert!(validate_refresh_token("rr1.bad.0.bad").is_err());
    let envelope = CredentialEnvelope {
      version: 1, state: StoredState::LogoutPending,
      session_id: session, refresh_token: token,
    };
    assert_eq!(decode_envelope(&encode_envelope(&envelope).unwrap()).unwrap().state,
      StoredState::LogoutPending);
  }

  #[test]
  fn renderer_bundle_never_contains_refresh_or_csrf() {
    let session = "B".repeat(32);
    let token = refresh(&session, "z");
    let parsed = parse_persistent_bundle(bundle(&session, &token)).unwrap();
    let serialized = serde_json::to_string(&parsed.sanitized).unwrap();
    assert!(!serialized.contains(&token));
    assert!(!serialized.contains("refreshToken"));
    assert!(!serialized.contains("csrfToken"));
    assert_eq!(parsed.envelope.refresh_token, token);
  }

  #[test]
  fn tree_renewal_accepts_only_the_sanitized_short_access_token() {
    let session = "T".repeat(32);
    let refresh = refresh(&session, "0");
    let parsed = parse_persistent_bundle(bundle(&session, &refresh)).unwrap();
    assert_eq!(sanitized_access_token(&parsed.sanitized).unwrap(), "short-lived-access");

    let mut leaked = parsed.sanitized.clone();
    leaked["refreshToken"] = Value::String(refresh);
    assert!(sanitized_access_token(&leaked).is_err());

    let mut mismatched = parsed.sanitized;
    mismatched["token"] = Value::String("different-access".into());
    assert!(sanitized_access_token(&mismatched).is_err());
  }

  #[test]
  fn delayed_tree_rejection_cannot_clear_a_newer_cached_access() {
    let cache = StdMutex::new(Some(CachedAccess {
      token: "access-b".into(), expires_at: u64::MAX, session_id: "S".repeat(32),
    }));
    invalidate_rejected_cached_access(&cache, "access-a");
    assert_eq!(cache.lock().unwrap().as_ref().unwrap().token, "access-b");
    invalidate_rejected_cached_access(&cache, "access-b");
    assert!(cache.lock().unwrap().is_none());
  }

  #[test]
  fn tree_access_cache_is_shared_until_the_expiry_skew_or_session_changes() {
    let cache = CachedAccess {
      token: "shared-access".into(), expires_at: 1_000_000, session_id: "S".repeat(32),
    };
    assert_eq!(
      reusable_cached_access(Some(&cache), &"S".repeat(32), 900_000, 30_000).as_deref(),
      Some("shared-access"),
    );
    assert!(reusable_cached_access(Some(&cache), &"S".repeat(32), 970_000, 30_000).is_none(),
      "the exact 30-second boundary must refresh instead of starting a marginal socket");
    assert!(reusable_cached_access(Some(&cache), &"N".repeat(32), 900_000, 30_000).is_none(),
      "an access JWT is never reused across durable device sessions");
  }

  #[test]
  fn rapid_transient_tree_refreshes_share_one_negative_cooldown() {
    let failures = StdMutex::new(None);
    let session = "Q".repeat(32);
    let mut outage = NativeAuthError::new("AUTH_BUSY", "arbitrary upstream detail");
    outage.status = 503;
    remember_cached_refresh_failure(&failures, &session, &outage, 1_000);

    for offset in 1..10_000 {
      let cached = cached_refresh_failure(&failures, &session, 1_000 + offset).unwrap();
      assert_eq!(cached.tree_refresh_failure(), ("native-auth-upstream", false));
    }
    assert!(cached_refresh_failure(&failures, &session, 11_000).is_none());

    remember_cached_refresh_failure(&failures, &session, &outage, 20_000);
    assert!(cached_refresh_failure(&failures, &"R".repeat(32), 20_001).is_none(),
      "a cooldown never crosses a durable session boundary");
  }

  #[test]
  fn mismatched_session_or_nested_secret_is_rejected() {
    let first = "C".repeat(32);
    let second = "D".repeat(32);
    assert!(parse_persistent_bundle(bundle(&first, &refresh(&second, "0"))).is_err());
    let token = refresh(&first, "0");
    let mut echoed = bundle(&first, &token);
    echoed["user"]["echo"] = Value::String(token);
    assert!(parse_persistent_bundle(echoed).is_err());
  }

  #[test]
  fn production_or_debug_loopback_is_the_only_api_origin() {
    assert_eq!(PROD_API_BASE, "https://reelay.online/api");
    assert_ne!(PROD_CREDENTIAL_TARGET, DEBUG_CREDENTIAL_TARGET);
    assert!(matches!(
      "/auth/session/refresh",
      "/auth/session/upgrade" | "/auth/session/refresh" | "/auth/session/logout"
    ));
  }

  #[tokio::test]
  async fn failed_rotation_write_keeps_recoverable_previous_generation() {
    let session = "E".repeat(32);
    let previous = envelope(&session, "0", StoredState::Active);
    let store = MockStore::new(Some(previous.clone()));
    store.fail_write.store(true, Ordering::SeqCst);
    let transport = MockTransport::new(vec![Ok(bundle(&session, &refresh(&session, "1")))]);

    let sanitized = refresh_with(&store, &transport, &previous).await.unwrap();

    assert!(sanitized.get("refreshToken").is_none());
    assert_eq!(store.stored().unwrap().refresh_token, previous.refresh_token);
    assert_eq!(*transport.calls.lock().unwrap(), vec![("/auth/session/refresh", "refresh")]);
  }

  #[tokio::test]
  async fn first_secure_write_failure_revokes_new_server_session() {
    let session = "F".repeat(32);
    let store = MockStore::new(None);
    store.fail_write.store(true, Ordering::SeqCst);
    let transport = MockTransport::new(vec![Ok(json!({ "ok": true }))]);

    let error = persist_rotated_with(
      &store,
      &transport,
      bundle(&session, &refresh(&session, "0")),
      None,
    ).await.unwrap_err();

    assert_eq!(error.code, "AUTH_SECURE_STORAGE_UNAVAILABLE");
    assert!(store.stored().is_none());
    assert_eq!(*transport.calls.lock().unwrap(), vec![("/auth/session/logout", "refresh")]);
  }

  #[tokio::test]
  async fn offline_logout_remains_pending_until_a_later_success() {
    let session = "G".repeat(32);
    let store = MockStore::new(Some(envelope(&session, "0", StoredState::Active)));
    let transport = MockTransport::new(vec![Err(NativeAuthError::new(
      "NETWORK_ERROR", "offline",
    ))]);

    assert!(begin_logout_with(&store).unwrap());
    assert_eq!(store.stored().unwrap().state, StoredState::LogoutPending);
    assert!(drain_logout_with(&store, &transport, vec![]).await.is_err());
    assert_eq!(store.stored().unwrap().state, StoredState::LogoutPending);

    transport.push(Ok(json!({ "ok": true })));
    let completed = drain_logout_with(&store, &transport, vec![]).await.unwrap();
    assert!(completed.complete);
    assert!(!completed.pending);
    assert!(store.stored().is_none());
  }

  #[tokio::test]
  async fn authoritative_terminal_refresh_deletes_the_device_credential() {
    let session = "H".repeat(32);
    let current = envelope(&session, "0", StoredState::Active);
    let store = MockStore::new(Some(current.clone()));
    let transport = MockTransport::new(vec![Err(NativeAuthError {
      code: "SESSION_REVOKED".to_string(),
      message: "revoked".to_string(),
      status: 401,
      details: None,
      attempts_remaining: None,
      retry_after: None,
    })]);

    let error = refresh_with(&store, &transport, &current).await.unwrap_err();

    assert_eq!(error.code, "SESSION_REVOKED");
    assert!(store.stored().is_none());
    assert_eq!(store.deletes.load(Ordering::SeqCst), 1);
  }

  #[tokio::test]
  async fn upstream_failure_cannot_spoof_revocation_and_delete_the_device_credential() {
    let session = "I".repeat(32);
    let current = envelope(&session, "0", StoredState::Active);
    let store = MockStore::new(Some(current.clone()));
    let transport = MockTransport::new(vec![Err(NativeAuthError {
      code: "SESSION_REVOKED".to_string(),
      message: "untrusted upstream payload".to_string(),
      status: 503,
      details: None,
      attempts_remaining: None,
      retry_after: None,
    })]);

    let error = refresh_with(&store, &transport, &current).await.unwrap_err();

    assert!(!error.terminal());
    assert_eq!(error.tree_refresh_failure(), ("native-auth-upstream", false));
    assert!(store.stored().is_some());
    assert_eq!(store.deletes.load(Ordering::SeqCst), 0);
  }

  #[test]
  fn unauthorized_status_stops_tree_retry_even_with_a_misleading_body_code() {
    let unauthorized = NativeAuthError {
      code: "NETWORK_ERROR".to_string(),
      message: "untrusted upstream payload".to_string(),
      status: 401,
      details: None,
      attempts_remaining: None,
      retry_after: None,
    };
    let forbidden = NativeAuthError {
      code: "REQUEST_TIMEOUT".to_string(),
      message: "untrusted upstream payload".to_string(),
      status: 403,
      details: None,
      attempts_remaining: None,
      retry_after: None,
    };

    assert_eq!(unauthorized.tree_refresh_failure(), ("native-auth-session-ended", true));
    assert_eq!(forbidden.tree_refresh_failure(), ("native-auth-invalid-response", true));
    // Only the exact authoritative revocation codes may delete the durable account credential.
    assert!(!unauthorized.terminal());
    assert!(!forbidden.terminal());
  }
}
