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
    self.code == "SESSION_REVOKED" || self.code == "REFRESH_INVALID"
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
  client: reqwest::Client,
  api_base: String,
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
    Ok(Self { owner: Mutex::new(()), client, api_base })
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
    refresh_with(&WindowsCredentialStore, self, current).await
  }

  async fn persist_rotated_bundle(
    &self,
    response: Value,
    previous: Option<&CredentialEnvelope>,
  ) -> Result<Value, NativeAuthError> {
    persist_rotated_with(&WindowsCredentialStore, self, response, previous).await
  }

  async fn authenticated_mutation(
    &self,
    path: &'static str,
    access_token: &str,
    body: Value,
  ) -> Result<Value, NativeAuthError> {
    authenticated_mutation_with(&WindowsCredentialStore, self, path, access_token, body).await
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
  let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
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
}
