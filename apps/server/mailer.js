'use strict';

const fs = require('fs');
const net = require('net');

const DEFAULT_FROM_NAME = 'RelayApp';
const MAX_SECRET_BYTES = 16 * 1024;
const SMTP_TIMEOUT_MS = 15 * 1000;

function mailerError(code, message) {
  const error = new Error(message);
  error.name = 'MailerError';
  error.code = code;
  return error;
}

function configError() {
  return mailerError('MAIL_CONFIG_INVALID', 'Настройки отправки почты заполнены неверно.');
}

function unavailableError() {
  return mailerError('MAIL_UNAVAILABLE', 'Отправка почты временно недоступна. Попробуйте позже.');
}

function deliveryError() {
  return mailerError('MAIL_DELIVERY_FAILED', 'Не удалось отправить письмо. Попробуйте позже.');
}

function envValue(env, name) {
  const value = env && env[name];
  return value == null ? '' : String(value).trim();
}

function parseBoolean(value, fallback) {
  if (value === '') return fallback;
  if (/^(?:1|true|yes|on)$/iu.test(value)) return true;
  if (/^(?:0|false|no|off)$/iu.test(value)) return false;
  throw configError();
}

function validHost(host) {
  if (!host || host.length > 253 || /[\u0000-\u0020\u007f]/u.test(host)) return false;
  if (net.isIP(host)) return true;
  const labels = host.split('.');
  return labels.every((label) => label.length > 0 && label.length <= 63
    && /^[a-z0-9-]+$/iu.test(label) && !label.startsWith('-') && !label.endsWith('-'));
}

function validMailbox(address) {
  if (!address || address.length > 254 || /[\r\n\u0000]/u.test(address)) return false;
  const at = address.lastIndexOf('@');
  if (at <= 0 || at !== address.indexOf('@')) return false;
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  return local.length <= 64 && !local.startsWith('.') && !local.endsWith('.') && !local.includes('..')
    && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/u.test(local) && validHost(domain);
}

function readPassword(file) {
  if (!file || /[\r\n\u0000]/u.test(file)) throw configError();
  let stat;
  let password;
  try {
    stat = fs.statSync(file);
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_SECRET_BYTES) throw configError();
    password = fs.readFileSync(file, 'utf8');
  } catch {
    throw configError();
  }
  // Docker secrets and editor-created secret files normally end in one newline. Remove only
  // line endings: spaces may be a legitimate part of an SMTP password and must be preserved.
  password = password.replace(/(?:\r\n|\n|\r)+$/u, '');
  if (!password || /[\r\n\u0000]/u.test(password)) throw configError();
  return password;
}

function normalizePublicUrl(value) {
  let url;
  try { url = new URL(value); }
  catch { throw configError(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw configError();
  }
  // Authentication pages are fixed application routes. Keeping only the origin prevents a
  // deployment typo from turning a reset letter into an open redirect to an arbitrary path.
  return url.origin;
}

function loadMailerConfig(env = process.env) {
  const host = envValue(env, 'SMTP_HOST');
  const user = envValue(env, 'SMTP_USER');
  const passwordFile = envValue(env, 'SMTP_PASSWORD_FILE');
  const fromAddress = envValue(env, 'MAIL_FROM_ADDRESS');

  // Port/TLS defaults and the public application URL may be present in a shared .env even while
  // mail is intentionally disabled. Only actual SMTP identity fields opt the service in.
  // Compose always mounts the password secret path so a disabled first rollout can start before
  // SMTP is provisioned. A path by itself is not an opt-in; only public SMTP identity fields are.
  if (![host, user, fromAddress].some(Boolean)) {
    return Object.freeze({ configured: false });
  }

  const portRaw = envValue(env, 'SMTP_PORT') || '587';
  const port = Number(portRaw);
  const fromName = envValue(env, 'MAIL_FROM_NAME') || DEFAULT_FROM_NAME;
  const appPublicUrl = normalizePublicUrl(envValue(env, 'APP_PUBLIC_URL'));

  if (!validHost(host) || !user || user.length > 320 || /[\r\n\u0000]/u.test(user)
    || !validMailbox(fromAddress) || !fromName || fromName.length > 100
    || /[\r\n\u0000]/u.test(fromName) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw configError();
  }

  const secure = parseBoolean(envValue(env, 'SMTP_SECURE'), port === 465);
  let requireTLS = parseBoolean(envValue(env, 'SMTP_REQUIRE_TLS'), !secure);
  if (port === 587) {
    if (secure) throw configError();
    requireTLS = true;
  }
  if (port === 465 && !secure) throw configError();
  // SMTP credentials must never rely on opportunistic STARTTLS. This also covers provider-specific
  // submission ports such as 2525, where a stripped STARTTLS capability would otherwise downgrade.
  if (!secure && !requireTLS) throw configError();

  const config = {
    configured: true,
    host,
    port,
    secure,
    requireTLS,
    user,
    fromName,
    fromAddress,
    appPublicUrl,
  };
  // Keep the secret usable by the factory but out of accidental object inspection/JSON logs.
  Object.defineProperty(config, 'password', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: readPassword(passwordFile),
  });
  return Object.freeze(config);
}

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/gu, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

function plainText(value) {
  return String(value == null ? '' : value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '');
}

function formatExpiry(expiresAt) {
  const date = expiresAt instanceof Date ? expiresAt : new Date(Number(expiresAt));
  if (!Number.isFinite(date.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('ru-RU', {
      timeZone: 'Europe/Moscow',
      day: 'numeric',
      month: 'long',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

function emailShell({ preheader, eyebrow, title, bodyHtml, actionHtml = '', notice }) {
  const safePreheader = escapeHtml(preheader);
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="dark">
  <meta name="supported-color-schemes" content="dark">
  <title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:#0d0f16;color:#f4f2f8;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all;">${safePreheader}</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background:#0d0f16;">
    <tr>
      <td align="center" style="padding:32px 14px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:560px;background:#191c27;border:1px solid #303544;border-radius:20px;overflow:hidden;box-shadow:0 24px 70px rgba(0,0,0,.35);">
          <tr>
            <td style="height:6px;font-size:0;line-height:0;background:linear-gradient(90deg,#8b5cf6,#c95cff 52%,#ff5c96);">&nbsp;</td>
          </tr>
          <tr>
            <td style="padding:34px 34px 12px;">
              <div style="font-size:12px;line-height:16px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#bd94ff;">${escapeHtml(eyebrow)}</div>
              <h1 style="margin:10px 0 0;font-size:28px;line-height:34px;letter-spacing:-.02em;color:#ffffff;">${escapeHtml(title)}</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:10px 34px 8px;font-size:16px;line-height:25px;color:#cbd0dc;">${bodyHtml}</td>
          </tr>
          ${actionHtml ? `<tr><td style="padding:14px 34px 12px;">${actionHtml}</td></tr>` : ''}
          <tr>
            <td style="padding:12px 34px 34px;">
              <div style="padding:14px 16px;border-radius:12px;background:#222633;border:1px solid #343949;font-size:13px;line-height:20px;color:#aeb5c4;">${escapeHtml(notice)}</div>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 34px;border-top:1px solid #2b2f3c;font-size:12px;line-height:18px;color:#777f91;">
              Это автоматическое письмо от RelayApp. Отвечать на него не нужно.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function codeCopy(purpose) {
  if (purpose === 'registration') {
    return {
      subject: 'Код регистрации в RelayApp',
      title: 'Завершите регистрацию',
      lead: 'Введите этот код в RelayApp, чтобы подтвердить адрес и создать аккаунт.',
    };
  }
  if (purpose === 'binding') {
    return {
      subject: 'Подтверждение почты в RelayApp',
      title: 'Подтвердите электронную почту',
      lead: 'Введите этот код в RelayApp, чтобы привязать адрес к аккаунту.',
    };
  }
  return {
    subject: 'Код подтверждения RelayApp',
    title: 'Подтвердите электронную почту',
    lead: 'Введите этот код в RelayApp, чтобы подтвердить электронную почту.',
  };
}

function buildEmailCodeMessage({ code, purpose, expiresAt } = {}) {
  const copy = codeCopy(String(purpose || ''));
  const safeCode = escapeHtml(code);
  const expiration = formatExpiry(expiresAt);
  const expirationText = expiration ? `Код действует до ${expiration} по московскому времени.` : 'Срок действия кода ограничен.';
  const bodyHtml = `<p style="margin:0 0 18px;">${escapeHtml(copy.lead)}</p>
    <div style="padding:20px 18px;border-radius:14px;background:#11141d;border:1px solid #3b4152;text-align:center;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:34px;line-height:42px;font-weight:800;letter-spacing:.28em;color:#ffffff;">${safeCode}</div>
    <p style="margin:14px 0 0;font-size:13px;line-height:20px;color:#9199aa;">${escapeHtml(expirationText)}</p>`;
  return {
    subject: copy.subject,
    text: `${copy.title}\n\n${copy.lead}\n\nКод: ${plainText(code)}\n${expirationText}\n\nЕсли вы не запрашивали этот код, просто проигнорируйте письмо.`,
    html: emailShell({
      preheader: `${copy.title}: ${plainText(code)}`,
      eyebrow: 'Безопасность аккаунта',
      title: copy.title,
      bodyHtml,
      notice: 'Никому не сообщайте этот код. Сотрудники RelayApp никогда его не запрашивают.',
    }),
  };
}

function resetUrl(appPublicUrl, token) {
  const base = normalizePublicUrl(String(appPublicUrl || ''));
  return `${base}/reset-password#token=${encodeURIComponent(String(token == null ? '' : token))}`;
}

function buildPasswordResetMessage({ username, token, expiresAt, appPublicUrl } = {}) {
  const login = plainText(username);
  const url = resetUrl(appPublicUrl, token);
  const expiration = formatExpiry(expiresAt);
  const expirationText = expiration ? `Ссылка действует до ${expiration} по московскому времени.` : 'Срок действия ссылки ограничен.';
  const bodyHtml = `<p style="margin:0 0 8px;">Для аккаунта <strong style="color:#ffffff;">${escapeHtml(login)}</strong> запрошено восстановление доступа.</p>
    <p style="margin:0;font-size:14px;line-height:22px;color:#9199aa;">${escapeHtml(expirationText)} После смены пароля все прежние сессии будут завершены.</p>`;
  const safeUrl = escapeHtml(url);
  const actionHtml = `<table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr><td style="border-radius:12px;background:#9b5cff;"><a href="${safeUrl}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:14px 22px;font-size:15px;line-height:20px;font-weight:800;color:#ffffff;text-decoration:none;">Сменить пароль</a></td></tr></table>
    <p style="margin:14px 0 0;font-size:12px;line-height:18px;color:#777f91;word-break:break-all;">Если кнопка не открывается, скопируйте ссылку:<br><a href="${safeUrl}" style="color:#bd94ff;text-decoration:underline;">${safeUrl}</a></p>`;
  return {
    subject: 'Восстановление доступа к RelayApp',
    text: `Восстановление доступа к RelayApp\n\nЛогин: ${login}\n${expirationText}\n\nСменить пароль: ${url}\n\nЕсли вы не запрашивали восстановление, ничего не делайте. Пароль не изменится.`,
    html: emailShell({
      preheader: `Восстановление доступа для аккаунта ${login}`,
      eyebrow: 'Безопасность аккаунта',
      title: 'Восстановление доступа',
      bodyHtml,
      actionHtml,
      notice: 'Если вы не запрашивали восстановление, ничего не делайте. Пароль останется прежним.',
    }),
  };
}

function buildPasswordChangedMessage({ username } = {}) {
  const login = plainText(username);
  const bodyHtml = `<p style="margin:0;">Пароль аккаунта <strong style="color:#ffffff;">${escapeHtml(login)}</strong> успешно изменён. Все прежние сессии завершены.</p>`;
  return {
    subject: 'Пароль RelayApp изменён',
    text: `Пароль RelayApp изменён\n\nПароль аккаунта ${login} успешно изменён. Все прежние сессии завершены.\n\nЕсли это были не вы, срочно обратитесь к администратору сервера.`,
    html: emailShell({
      preheader: `Пароль аккаунта ${login} изменён`,
      eyebrow: 'Уведомление безопасности',
      title: 'Пароль изменён',
      bodyHtml,
      notice: 'Если это были не вы, срочно обратитесь к администратору сервера.',
    }),
  };
}

function buildEmailBoundMessage({ username } = {}) {
  const login = plainText(username);
  const bodyHtml = `<p style="margin:0;">Электронная почта подтверждена и привязана к аккаунту <strong style="color:#ffffff;">${escapeHtml(login)}</strong>.</p>
    <p style="margin:12px 0 0;font-size:14px;line-height:22px;color:#9199aa;">Теперь этот адрес можно использовать для безопасного восстановления доступа.</p>`;
  return {
    subject: 'Почта привязана к RelayApp',
    text: `Почта привязана к RelayApp\n\nЭлектронная почта подтверждена и привязана к аккаунту ${login}. Теперь этот адрес можно использовать для восстановления доступа.`,
    html: emailShell({
      preheader: `Почта аккаунта ${login} подтверждена`,
      eyebrow: 'Аккаунт защищён',
      title: 'Почта подтверждена',
      bodyHtml,
      notice: 'Если вы не выполняли это действие, смените пароль и обратитесь к администратору сервера.',
    }),
  };
}

function safeRecipient(value) {
  const recipient = String(value == null ? '' : value).trim();
  if (!validMailbox(recipient)) throw deliveryError();
  return recipient;
}

function createUnavailableMailer({ verifyError = null } = {}) {
  const unavailable = async () => { throw unavailableError(); };
  return {
    configured: false,
    available: false,
    async verify() {
      if (verifyError) throw unavailableError();
      return false;
    },
    sendEmailCode: unavailable,
    sendPasswordReset: unavailable,
    sendPasswordChanged: unavailable,
    sendEmailBound: unavailable,
  };
}

function createSmtpMailer({ env = process.env, nodemailer: nodemailerOverride, logger } = {}) {
  // Deliberately never pass SMTP exceptions or message metadata to a logger here: provider errors
  // can contain an envelope address, while message data contains codes and reset tokens.
  void logger;
  let config;
  try { config = loadMailerConfig(env); }
  catch { return createUnavailableMailer({ verifyError: true }); }
  if (!config.configured) return createUnavailableMailer();

  let transport = null;
  let transportCreationFailed = false;
  try {
    const nodemailerImpl = nodemailerOverride || require('nodemailer');
    const tls = { rejectUnauthorized: true, minVersion: 'TLSv1.2' };
    if (!net.isIP(config.host)) tls.servername = config.host;
    transport = nodemailerImpl.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      requireTLS: config.requireTLS,
      ignoreTLS: false,
      auth: { user: config.user, pass: config.password },
      tls,
      pool: true,
      maxConnections: 3,
      maxMessages: 100,
      connectionTimeout: SMTP_TIMEOUT_MS,
      greetingTimeout: SMTP_TIMEOUT_MS,
      socketTimeout: SMTP_TIMEOUT_MS,
      dnsTimeout: SMTP_TIMEOUT_MS,
      disableFileAccess: true,
      disableUrlAccess: true,
      logger: false,
      debug: false,
    });
  } catch {
    transportCreationFailed = true;
  }

  const mailer = {
    configured: true,
    available: false,
    async verify() {
      if (transportCreationFailed || !transport || typeof transport.verify !== 'function') {
        mailer.available = false;
        throw unavailableError();
      }
      try {
        await transport.verify();
        mailer.available = true;
        return true;
      } catch {
        mailer.available = false;
        throw unavailableError();
      }
    },
    async sendEmailCode({ to, code, purpose, expiresAt } = {}) {
      if (!mailer.available) throw unavailableError();
      if (!/^\d{4}$/u.test(String(code || ''))) throw deliveryError();
      return send(safeRecipient(to), buildEmailCodeMessage({ code, purpose, expiresAt }));
    },
    async sendPasswordReset({ to, username, token, expiresAt } = {}) {
      if (!mailer.available) throw unavailableError();
      if (!/^[A-Za-z0-9_-]{32,256}$/u.test(String(token || ''))) throw deliveryError();
      return send(safeRecipient(to), buildPasswordResetMessage({
        username,
        token,
        expiresAt,
        appPublicUrl: config.appPublicUrl,
      }));
    },
    async sendPasswordChanged({ to, username } = {}) {
      if (!mailer.available) throw unavailableError();
      return send(safeRecipient(to), buildPasswordChangedMessage({ username }));
    },
    async sendEmailBound({ to, username } = {}) {
      if (!mailer.available) throw unavailableError();
      return send(safeRecipient(to), buildEmailBoundMessage({ username }));
    },
  };

  function transportIsUnhealthy(error) {
    const code = String(error && error.code || '').toUpperCase();
    const command = String(error && error.command || '').toUpperCase();
    const responseCode = Number(error && error.responseCode) || 0;
    if (['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'ECONNRESET', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'EAUTH', 'ETLS'].includes(code)) {
      return true;
    }
    if (command === 'CONN' || command === 'AUTH' || command === 'STARTTLS') return true;
    // 421 is a server/service shutdown, unlike recipient-specific RCPT failures (450/550).
    return responseCode === 421;
  }

  async function send(to, message) {
    try {
      return await transport.sendMail({
        from: { name: config.fromName, address: config.fromAddress },
        to,
        subject: message.subject,
        text: message.text,
        html: message.html,
        disableFileAccess: true,
        disableUrlAccess: true,
        headers: {
          'Auto-Submitted': 'auto-generated',
          'X-Auto-Response-Suppress': 'All',
        },
      });
    } catch (error) {
      // A rejected recipient/message must not disable mail for every account. Only transport,
      // authentication and TLS failures trip the breaker; periodic verify restores it.
      if (transportIsUnhealthy(error)) mailer.available = false;
      logger?.warn?.('[mail] SMTP delivery failed');
      throw deliveryError();
    }
  }

  return mailer;
}

module.exports = {
  createSmtpMailer,
  loadMailerConfig,
  buildEmailCodeMessage,
  buildPasswordResetMessage,
  buildPasswordChangedMessage,
  buildEmailBoundMessage,
};
