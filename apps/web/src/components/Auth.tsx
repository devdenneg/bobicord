import { useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, getToken, isApiError, setToken } from '../api';
import { useStore } from '../store';
import type { AccountStatus, AuthResponse, ChallengeResponse, EmailChallenge } from '../types';
import { Icon } from '../Icon';
import { LogoLoader } from './LogoLoader';

type AuthScreen =
  | 'session-retry'
  | 'login'
  | 'register'
  | 'register-verify'
  | 'forgot'
  | 'forgot-sent'
  | 'reset-inspect'
  | 'reset'
  | 'reset-done'
  | 'reset-invalid';

type FormFailure = { message: string; field?: string };
type ResolvedChallenge = {
  id: string;
  emailMasked: string;
  expiresAt: number;
  resendAt: number;
  delivered: boolean;
  attemptsRemaining?: number;
};

const PASSWORD_MIN = 15;
const PASSWORD_MAX = 64;
const REGISTRATION_FLOW_STORAGE = 'relay.auth.registration-flow.v1';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

function epochMs(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n < 1_000_000_000_000 ? n * 1000 : n;
}

function resolveChallenge(response: ChallengeResponse, fallbackId = ''): ResolvedChallenge {
  const raw = response.challenge || response.account?.challenge || (response as EmailChallenge);
  const id = raw?.flowId || response.flowId || raw?.id || raw?.challengeId || response.challengeId || fallbackId;
  if (!id) throw new ApiError('Сервер не вернул идентификатор подтверждения', { code: 'INVALID_RESPONSE' });
  return {
    id,
    emailMasked: raw?.emailMasked || raw?.maskedEmail || response.emailMasked || response.maskedEmail || '',
    expiresAt: epochMs(raw?.expiresAt ?? response.expiresAt, Date.now() + 10 * 60_000),
    resendAt: epochMs(raw?.resendAt ?? response.resendAt, Date.now() + 60_000),
    delivered: raw?.delivered ?? response.delivered ?? true,
    attemptsRemaining: raw?.attemptsRemaining ?? response.attemptsRemaining,
  };
}

function readStoredChallenge(key: string): ResolvedChallenge | null {
  try {
    const raw = JSON.parse(sessionStorage.getItem(key) || 'null');
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id || raw.id.length > 256) return null;
    const expiresAt = Number(raw.expiresAt);
    const resendAt = Number(raw.resendAt);
    if (!Number.isFinite(expiresAt) || !Number.isFinite(resendAt) || expiresAt < Date.now() - 24 * 60 * 60_000) {
      sessionStorage.removeItem(key);
      return null;
    }
    const attempts = Number(raw.attemptsRemaining);
    return {
      id: raw.id,
      emailMasked: typeof raw.emailMasked === 'string' ? raw.emailMasked.slice(0, 320) : '',
      expiresAt,
      resendAt,
      delivered: raw.delivered !== false,
      attemptsRemaining: Number.isFinite(attempts) && attempts >= 0 ? Math.floor(attempts) : undefined,
    };
  } catch {
    try { sessionStorage.removeItem(key); } catch { /* storage can be disabled */ }
    return null;
  }
}

function persistChallenge(key: string, challenge: ResolvedChallenge | null) {
  try {
    if (!challenge) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(challenge));
  } catch { /* an unavailable sessionStorage must not block authentication */ }
}

function passwordLength(value: string): number {
  return Array.from(value.normalize('NFC')).length;
}

function validateNewPassword(value: string): FormFailure | null {
  const length = passwordLength(value);
  if (length < PASSWORD_MIN) return { message: `Минимум ${PASSWORD_MIN} символов`, field: 'password' };
  if (length > PASSWORD_MAX) return { message: `Максимум ${PASSWORD_MAX} символа`, field: 'password' };
  return null;
}

function failureFrom(error: unknown, fallback: string): FormFailure {
  if (isApiError(error)) {
    const aliases: Record<string, string> = {
      login: 'username', user: 'username', mail: 'email', verificationCode: 'code', otp: 'code',
      invite: 'inviteCode', registrationInvite: 'inviteCode', newPassword: 'password',
      passwordConfirmation: 'passwordAgain', confirmPassword: 'passwordAgain',
    };
    const known = new Set(['username', 'email', 'password', 'passwordAgain', 'inviteCode', 'code']);
    const fieldsByCode: Record<string, string> = {
      INVALID_USERNAME: 'username', INVALID_EMAIL: 'email', WEAK_PASSWORD: 'password', PASSWORD_TOO_LONG: 'password',
      INVALID_INVITE: 'inviteCode', INVITE_EXHAUSTED: 'inviteCode', INVITE_REVOKED: 'inviteCode', INVALID_CODE: 'code',
    };
    const rawField = error.field || fieldsByCode[error.code];
    const normalized = rawField ? (aliases[rawField] || rawField) : undefined;
    let message = error.message || fallback;
    if (error.attemptsRemaining !== undefined && error.code === 'INVALID_CODE') {
      message += ` Осталось попыток: ${error.attemptsRemaining}.`;
    }
    if (error.retryAfter !== undefined && error.retryAfter > 0) {
      message += ` Повторите через ${formatWait(error.retryAfter)}`;
    }
    return { message, field: normalized && known.has(normalized) ? normalized : undefined };
  }
  return { message: error instanceof Error ? error.message : fallback };
}

function makeRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function focusById(id: string) {
  requestAnimationFrame(() => document.getElementById(id)?.focus());
}

function PasswordInput({
  id, value, onChange, autoComplete, label, maxLength, describedBy, invalid, autoFocus,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: 'current-password' | 'new-password';
  label: string;
  maxLength?: number;
  describedBy?: string;
  invalid?: boolean;
  autoFocus?: boolean;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="auth-password">
      <input
        id={id}
        type={visible ? 'text' : 'password'}
        value={value}
        maxLength={maxLength}
        autoComplete={autoComplete}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        autoFocus={autoFocus}
        onChange={(event) => onChange(event.target.value)}
      />
      <button
        type="button"
        className="auth-password-toggle"
        aria-label={visible ? `Скрыть поле «${label}»` : `Показать поле «${label}»`}
        aria-pressed={visible}
        onClick={() => setVisible((current) => !current)}
      >
        <Icon name={visible ? 'eye-off' : 'eye'} sm />
      </button>
    </div>
  );
}

function InlineError({ id, children }: { id: string; children?: string }) {
  return children ? <div id={id} className="auth-field-error" role="alert">{children}</div> : null;
}

function formatWait(seconds: number) {
  if (seconds <= 0) return '';
  if (seconds < 60) return `${seconds} сек.`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} мин.`;
}

export function Auth() {
  const acceptSession = useStore((state) => state.acceptSession);
  const sessionError = useStore((state) => state.sessionError);
  const resetToken = useStore((state) => state.passwordResetToken);
  const setPasswordResetToken = useStore((state) => state.setPasswordResetToken);
  const restoredRegistration = useMemo(() => readStoredChallenge(REGISTRATION_FLOW_STORAGE), []);
  const initialScreen: AuthScreen = resetToken ? 'reset-inspect' : sessionError ? 'session-retry' : restoredRegistration ? 'register-verify' : 'login';
  const [screen, setScreen] = useState<AuthScreen>(initialScreen);
  const [failure, setFailure] = useState<FormFailure | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());

  const [loginUser, setLoginUser] = useState('');
  const [loginPassword, setLoginPassword] = useState('');

  const [registerUser, setRegisterUser] = useState('');
  const [registerEmail, setRegisterEmail] = useState('');
  const [registerPassword, setRegisterPassword] = useState('');
  const [registerInvite, setRegisterInvite] = useState('');
  const registerRequestId = useRef('');
  const [registrationChallenge, setRegistrationChallenge] = useState<ResolvedChallenge | null>(restoredRegistration);
  const [registrationCode, setRegistrationCode] = useState('');

  const [forgotEmail, setForgotEmail] = useState('');
  const [forgotResendAt, setForgotResendAt] = useState(0);
  const [resetUsername, setResetUsername] = useState('');
  const [resetPassword, setResetPassword] = useState('');
  const [resetPasswordAgain, setResetPasswordAgain] = useState('');
  const [resetInspectAttempt, setResetInspectAttempt] = useState(0);
  const stepHeadingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    persistChallenge(REGISTRATION_FLOW_STORAGE, registrationChallenge);
  }, [registrationChallenge]);

  useEffect(() => {
    if (screen === 'login' || screen === 'register') return;
    requestAnimationFrame(() => stepHeadingRef.current?.focus());
  }, [screen]);

  useEffect(() => {
    if (screen !== 'reset-inspect' || !resetToken) return;
    let cancelled = false;
    api.inspectPasswordReset(resetToken).then((response) => {
      if (cancelled) return;
      if (response.valid === false) { setPasswordResetToken(null); setScreen('reset-invalid'); return; }
      setResetUsername(response.username || '');
      setScreen('reset');
    }).catch((error) => {
      if (cancelled) return;
      if (isApiError(error) && (error.status === 0 || error.status >= 500)) setFailure(failureFrom(error, 'Не удалось проверить ссылку'));
      else { setPasswordResetToken(null); setScreen('reset-invalid'); }
    });
    return () => { cancelled = true; };
  }, [resetToken, screen, resetInspectAttempt]);

  const registrationWait = Math.max(0, Math.ceil(((registrationChallenge?.resendAt || 0) - now) / 1000));
  const registrationExpired = Boolean(registrationChallenge && registrationChallenge.expiresAt <= now);
  const forgotWait = Math.max(0, Math.ceil((forgotResendAt - now) / 1000));
  const fieldError = (field: string) => failure?.field === field ? failure.message : '';
  const visibleFields: Record<AuthScreen, string[]> = {
    'session-retry': [], login: ['username', 'password'], register: ['username', 'email', 'password', 'inviteCode'],
    'register-verify': ['code'], forgot: ['email'], 'forgot-sent': [], 'reset-inspect': [], reset: ['password', 'passwordAgain'],
    'reset-done': [], 'reset-invalid': [],
  };
  const generalError = screen !== 'reset-inspect' && failure && (!failure.field || !visibleFields[screen].includes(failure.field)) ? failure.message : '';

  function switchScreen(next: AuthScreen) {
    setFailure(null);
    setBusy(false);
    setScreen(next);
  }

  function clearRegistrationFlow() {
    registerRequestId.current = '';
    setRegistrationChallenge(null);
    setRegistrationCode('');
  }

  function restartRegistration(nextFailure?: FormFailure) {
    clearRegistrationFlow();
    setFailure(nextFailure || null);
    setScreen('register');
    requestAnimationFrame(() => {
      const target = nextFailure?.field === 'inviteCode' ? 'auth-register-invite' : 'auth-register-user';
      document.getElementById(target)?.focus();
    });
  }

  async function finishSession(response: AuthResponse) {
    setToken(response.token);
    try {
      await acceptSession(response.user, response.account || ({ state: 'ready' } as AccountStatus));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Не удалось загрузить аккаунт';
      useStore.setState({ view: 'auth', sessionError: message });
      setScreen('session-retry');
      setFailure({ message });
    }
  }

  async function retrySession() {
    setBusy(true); setFailure(null);
    try {
      try {
        const response = await api.authSession();
        await acceptSession(response.user, response.account);
      } catch (error) {
        if (!isApiError(error) || (error.status !== 404 && error.status !== 410)) throw error;
        const legacy = await api.me();
        await acceptSession(legacy.user, { state: 'ready' });
      }
    } catch (error) {
      if (isApiError(error) && error.status === 401) {
        setToken(null);
        useStore.setState({ sessionError: '' });
        switchScreen('login');
      } else setFailure(failureFrom(error, 'Не удалось проверить сессию'));
    } finally { setBusy(false); }
  }

  async function submitLogin(event: React.FormEvent) {
    event.preventDefault();
    const username = loginUser.trim();
    if (!username) { setFailure({ message: 'Введите логин', field: 'username' }); focusById('auth-login-user'); return; }
    if (!loginPassword) { setFailure({ message: 'Введите пароль', field: 'password' }); focusById('auth-login-password'); return; }
    setBusy(true); setFailure(null);
    try { await finishSession(await api.login(username, loginPassword)); }
    catch (error) { setFailure(failureFrom(error, 'Не удалось войти')); }
    finally { setBusy(false); }
  }

  function changeRegistration(setter: (value: string) => void, value: string) {
    registerRequestId.current = '';
    setter(value);
    if (failure) setFailure(null);
  }

  async function submitRegistration(event: React.FormEvent) {
    event.preventDefault();
    const username = registerUser.trim();
    const email = registerEmail.trim();
    const inviteCode = registerInvite.trim();
    if (!USERNAME_RE.test(username)) { setFailure({ message: '3–20 символов: латиница, цифры или _', field: 'username' }); focusById('auth-register-user'); return; }
    if (!EMAIL_RE.test(email)) { setFailure({ message: 'Введите корректный адрес почты', field: 'email' }); focusById('auth-register-email'); return; }
    const passwordFailure = validateNewPassword(registerPassword);
    if (passwordFailure) { setFailure(passwordFailure); focusById('auth-register-password'); return; }
    if (!inviteCode) { setFailure({ message: 'Введите пригласительный код', field: 'inviteCode' }); focusById('auth-register-invite'); return; }
    if (!registerRequestId.current) registerRequestId.current = makeRequestId();
    setBusy(true); setFailure(null);
    try {
      const response = await api.registerStart({
        username,
        email,
        password:
          registerPassword.normalize('NFC'),
        inviteCode,
        requestId: registerRequestId.current,
      });
      setRegistrationChallenge(resolveChallenge(response));
      setRegistrationCode('');
      setScreen('register-verify');
    } catch (error) { setFailure(failureFrom(error, 'Не удалось начать регистрацию')); }
    finally { setBusy(false); }
  }

  async function submitRegistrationCode(event: React.FormEvent) {
    event.preventDefault();
    if (!registrationChallenge) { switchScreen('register'); return; }
    if (registrationCode.length !== 4) { setFailure({ message: 'Введите четыре цифры', field: 'code' }); focusById('auth-register-code'); return; }
    setBusy(true); setFailure(null);
    try {
      const response = await api.registerVerify(registrationChallenge.id, registrationCode);
      clearRegistrationFlow();
      setRegisterPassword('');
      await finishSession(response);
    } catch (error) {
      if (isApiError(error) && error.attemptsRemaining !== undefined) {
        setRegistrationChallenge((current) => current ? { ...current, attemptsRemaining: error.attemptsRemaining } : current);
      }
      const verifyUncertain = isApiError(error) && (error.status === 0 || error.status >= 500);
      const verifyConsumed = isApiError(error) && error.code === 'FLOW_CONSUMED';
      if (verifyConsumed || verifyUncertain) {
        if (registerUser.trim() && registerPassword) {
          try {
            const response = await api.login(registerUser.trim(), registerPassword.normalize('NFC'));
            clearRegistrationFlow();
            setRegisterPassword('');
            await finishSession(response);
            return;
          } catch (loginError) {
            if (verifyUncertain) {
              setFailure({ message: isApiError(loginError) && (loginError.status === 0 || loginError.status >= 500)
                ? 'Не удалось проверить результат. Код и подтверждение сохранены — повторите попытку.'
                : 'Подтверждение ещё не принято. Код сохранён — попробуйте ещё раз.' });
              return;
            }
          }
        }
        if (verifyUncertain) {
          setFailure({ message: 'Не удалось проверить результат. Код и подтверждение сохранены — повторите попытку.' });
          return;
        }
        setLoginUser(registerUser.trim());
        setLoginPassword('');
        clearRegistrationFlow();
        setScreen('login');
        setFailure({ message: 'Подтверждение уже принято. Войдите в созданный аккаунт.' });
        return;
      }
      const next = failureFrom(error, 'Не удалось подтвердить почту');
      if (isApiError(error) && ['CODE_ATTEMPTS_EXCEEDED', 'FLOW_EXPIRED', 'FLOW_NOT_FOUND', 'INVITE_REVOKED', 'INVITE_EXHAUSTED'].includes(error.code)) {
        restartRegistration(next);
      } else setFailure(next);
    }
    finally { setBusy(false); }
  }

  async function resendRegistrationCode() {
    if (!registrationChallenge || registrationWait > 0 || busy) return;
    setBusy(true); setFailure(null);
    try {
      const response = await api.registerResend(registrationChallenge.id);
      setRegistrationChallenge(resolveChallenge(response, registrationChallenge.id));
      setRegistrationCode('');
      focusById('auth-register-code');
    } catch (error) {
      const next = failureFrom(error, 'Не удалось отправить новый код');
      if (isApiError(error) && error.retryAfter !== undefined) {
        setRegistrationChallenge((current) => current ? { ...current, resendAt: Date.now() + error.retryAfter! * 1000 } : current);
      }
      if (isApiError(error) && ['CODE_ATTEMPTS_EXCEEDED', 'FLOW_EXPIRED', 'FLOW_NOT_FOUND'].includes(error.code)) restartRegistration(next);
      else setFailure(next);
    }
    finally { setBusy(false); }
  }

  async function sendRecovery(event?: React.FormEvent) {
    event?.preventDefault();
    const email = forgotEmail.trim();
    if (!EMAIL_RE.test(email)) { setFailure({ message: 'Введите корректный адрес почты', field: 'email' }); focusById('auth-forgot-email'); return; }
    setBusy(true); setFailure(null);
    try {
      const response = await api.forgotPassword(email);
      setForgotResendAt(epochMs(response.resendAt, Date.now() + 60_000));
      setScreen('forgot-sent');
    } catch (error) {
      if (isApiError(error) && error.retryAfter !== undefined) setForgotResendAt(Date.now() + error.retryAfter * 1000);
      setFailure(failureFrom(error, 'Не удалось отправить письмо'));
    }
    finally { setBusy(false); }
  }

  async function submitReset(event: React.FormEvent) {
    event.preventDefault();
    if (!resetToken) { setScreen('reset-invalid'); return; }
    const passwordFailure = validateNewPassword(resetPassword);
    if (passwordFailure) { setFailure(passwordFailure); focusById('auth-reset-password'); return; }
    const normalizedPassword = resetPassword.normalize('NFC');
    if (normalizedPassword !== resetPasswordAgain.normalize('NFC')) { setFailure({ message: 'Пароли не совпадают', field: 'passwordAgain' }); focusById('auth-reset-password-again'); return; }
    setBusy(true); setFailure(null);
    try {
      const response = await api.resetPassword(resetToken, normalizedPassword);
      if (response.username) setResetUsername(response.username);
      setToken(null);
      setPasswordResetToken(null);
      setResetPassword(''); setResetPasswordAgain('');
      setScreen('reset-done');
    } catch (error) {
      const next = failureFrom(error, 'Не удалось сменить пароль');
      if (isApiError(error) && ['RESET_INVALID', 'RESET_EXPIRED', 'RESET_USED'].includes(error.code)) {
        if (resetUsername) {
          try {
            await api.login(resetUsername, normalizedPassword);
            setToken(null);
            setPasswordResetToken(null);
            setResetPassword(''); setResetPasswordAgain('');
            setScreen('reset-done');
            return;
          } catch (loginError) {
            if (isApiError(loginError) && (loginError.status === 0 || loginError.status >= 500)) {
              setFailure(failureFrom(loginError, 'Пароль мог измениться, но проверить результат не удалось'));
              return;
            }
          }
        }
        setPasswordResetToken(null);
        setScreen('reset-invalid');
      } else setFailure(next);
    } finally { setBusy(false); }
  }

  async function returnToExistingSession() {
    if (!getToken()) { switchScreen('login'); return; }
    setBusy(true); setFailure(null);
    try {
      try {
        const session = await api.authSession();
        setPasswordResetToken(null);
        await acceptSession(session.user, session.account);
      } catch (error) {
        if (!isApiError(error) || (error.status !== 404 && error.status !== 410)) throw error;
        const legacy = await api.me();
        setPasswordResetToken(null);
        await acceptSession(legacy.user, { state: 'ready' });
      }
    } catch (error) {
      if (isApiError(error) && error.status === 401) {
        setToken(null); setPasswordResetToken(null); switchScreen('login');
      } else setFailure(failureFrom(error, 'Не удалось вернуться в приложение'));
    } finally { setBusy(false); }
  }

  const title = useMemo(() => {
    switch (screen) {
      case 'register-verify': return 'Подтвердите почту';
      case 'forgot': return 'Восстановление доступа';
      case 'forgot-sent': return 'Проверьте почту';
      case 'reset-inspect': return 'Проверяем ссылку';
      case 'reset': return 'Новый пароль';
      case 'reset-done': return 'Пароль изменён';
      case 'reset-invalid': return 'Ссылка недействительна';
      case 'session-retry': return 'Нет связи с сервером';
      case 'register': return 'Создайте аккаунт';
      default: return 'С возвращением';
    }
  }, [screen]);

  return (
    <main id="auth" className="overlay auth-overlay">
      <section className="card auth-card" aria-labelledby="auth-title" aria-busy={busy || undefined}>
        <div className="brand auth-brand" aria-label="Рилэй">
          <LogoLoader size={56} speedMs={8000} />
          <div><span className="wordmark">Рилэй</span><small>Голос, чат и трансляции для своих</small></div>
        </div>

        <div className="auth-heading">
          <h1 id="auth-title" ref={stepHeadingRef} tabIndex={-1}>{title}</h1>
          {screen === 'register' ? <span className="auth-step">Шаг 1 из 2</span> : screen === 'register-verify' ? <span className="auth-step">Шаг 2 из 2</span> : null}
        </div>

        {(screen === 'login' || screen === 'register') ? (
          <div className="tabs2" role="group" aria-label="Способ входа">
            <button type="button" aria-pressed={screen === 'login'} className={screen === 'login' ? 'active' : ''} onClick={() => switchScreen('login')}>Вход</button>
            <button type="button" aria-pressed={screen === 'register'} className={screen === 'register' ? 'active' : ''} onClick={() => switchScreen('register')}>Регистрация</button>
          </div>
        ) : null}

        {screen === 'session-retry' ? (
          <div className="auth-state">
            <span className="auth-state-icon"><Icon name="refresh" /></span>
            <p>Сохранённый вход не потерян. Проверьте интернет и попробуйте ещё раз.</p>
            <button type="button" className="primary" disabled={busy} onClick={retrySession}>{busy ? <span className="spin" /> : null}Повторить</button>
            <button type="button" className="link" onClick={() => { setToken(null); useStore.setState({ sessionError: '' }); switchScreen('login'); }}>Войти в другой аккаунт</button>
          </div>
        ) : null}

        {screen === 'login' ? (
          <form noValidate onSubmit={submitLogin}>
            <div className="row">
              <label htmlFor="auth-login-user">Логин</label>
              <input id="auth-login-user" value={loginUser} maxLength={20} autoFocus autoComplete="username" autoCapitalize="none" spellCheck={false}
                aria-invalid={Boolean(fieldError('username')) || undefined} aria-describedby={fieldError('username') ? 'auth-login-user-error' : undefined}
                onChange={(event) => { setLoginUser(event.target.value); if (failure) setFailure(null); }} />
              <InlineError id="auth-login-user-error">{fieldError('username')}</InlineError>
            </div>
            <div className="row">
              <div className="auth-label-line"><label htmlFor="auth-login-password">Пароль</label><button type="button" onClick={() => switchScreen('forgot')}>Забыли пароль?</button></div>
              <PasswordInput id="auth-login-password" label="Пароль" value={loginPassword} autoComplete="current-password"
                invalid={Boolean(fieldError('password'))} describedBy={fieldError('password') ? 'auth-login-password-error' : undefined}
                onChange={(value) => { setLoginPassword(value); if (failure) setFailure(null); }} />
              <InlineError id="auth-login-password-error">{fieldError('password')}</InlineError>
            </div>
            <button type="submit" className="primary" disabled={busy}>{busy ? <span className="spin" /> : null}Войти</button>
          </form>
        ) : null}

        {screen === 'register' ? (
          <form noValidate onSubmit={submitRegistration}>
            <p className="auth-copy">Регистрация доступна по суточному коду приглашения.</p>
            <div className="row"><label htmlFor="auth-register-user">Логин</label>
              <input id="auth-register-user" value={registerUser} maxLength={20} autoFocus autoComplete="username" autoCapitalize="none" spellCheck={false}
                placeholder="3–20: латиница, цифры, _" aria-invalid={Boolean(fieldError('username')) || undefined} aria-describedby={fieldError('username') ? 'auth-register-user-error' : undefined}
                onChange={(event) => changeRegistration(setRegisterUser, event.target.value)} />
              <InlineError id="auth-register-user-error">{fieldError('username')}</InlineError>
            </div>
            <div className="row"><label htmlFor="auth-register-email">Электронная почта</label>
              <input id="auth-register-email" type="email" inputMode="email" value={registerEmail} maxLength={254} autoComplete="email" autoCapitalize="none" spellCheck={false}
                placeholder="name@example.com" aria-invalid={Boolean(fieldError('email')) || undefined} aria-describedby={fieldError('email') ? 'auth-register-email-error' : undefined}
                onChange={(event) => changeRegistration(setRegisterEmail, event.target.value)} />
              <InlineError id="auth-register-email-error">{fieldError('email')}</InlineError>
            </div>
            <div className="row"><label htmlFor="auth-register-password">Пароль</label>
              <PasswordInput id="auth-register-password" label="Пароль" value={registerPassword} autoComplete="new-password"
                invalid={Boolean(fieldError('password'))} describedBy={`auth-register-password-hint${fieldError('password') ? ' auth-register-password-error' : ''}`}
                onChange={(value) => changeRegistration(setRegisterPassword, value)} />
              <div id="auth-register-password-hint" className="auth-hint">От {PASSWORD_MIN} до {PASSWORD_MAX} символов. Лучше использовать длинную парольную фразу.</div>
              <InlineError id="auth-register-password-error">{fieldError('password')}</InlineError>
            </div>
            <div className="row"><label htmlFor="auth-register-invite">Пригласительный код</label>
              <input id="auth-register-invite" className="auth-code-text" value={registerInvite} maxLength={64} autoComplete="off" autoCapitalize="characters" spellCheck={false}
                aria-invalid={Boolean(fieldError('inviteCode')) || undefined} aria-describedby={fieldError('inviteCode') ? 'auth-register-invite-error' : undefined}
                onChange={(event) => changeRegistration(setRegisterInvite, event.target.value.replace(/\s/g, '').toUpperCase())} />
              <InlineError id="auth-register-invite-error">{fieldError('inviteCode')}</InlineError>
            </div>
            <button type="submit" className="primary" disabled={busy}>{busy ? <span className="spin" /> : null}Продолжить</button>
          </form>
        ) : null}

        {screen === 'register-verify' && registrationChallenge ? (
          <form noValidate onSubmit={submitRegistrationCode}>
            <p className="auth-copy">{registrationChallenge.delivered
              ? <>Мы отправили код из четырёх цифр на <b>{registrationChallenge.emailMasked || registerEmail}</b>.</>
              : <>Отправка письма на <b>{registrationChallenge.emailMasked || registerEmail}</b> ещё не подтверждена. Подождите и повторите отправку.</>}</p>
            <div className="row auth-otp-row"><label htmlFor="auth-register-code">Код из письма</label>
              <input id="auth-register-code" className="auth-otp" type="text" inputMode="numeric" pattern="[0-9]*" maxLength={4}
                autoFocus={registrationChallenge.delivered} disabled={!registrationChallenge.delivered} autoComplete="one-time-code"
                value={registrationCode} aria-invalid={Boolean(fieldError('code')) || undefined} aria-describedby={fieldError('code') ? 'auth-register-code-error' : 'auth-register-code-hint'}
                onChange={(event) => { setRegistrationCode(event.target.value.replace(/\D/g, '').slice(0, 4)); if (failure) setFailure(null); }} />
              <div id="auth-register-code-hint" className="auth-hint">
                {registrationChallenge.attemptsRemaining !== undefined
                  ? `Код действует ограниченное время. Осталось попыток: ${registrationChallenge.attemptsRemaining}.`
                  : 'Код действует ограниченное время.'}
              </div>
              <InlineError id="auth-register-code-error">{fieldError('code')}</InlineError>
            </div>
            <button type="submit" className="primary" disabled={busy || !registrationChallenge.delivered || registrationExpired || registrationCode.length !== 4}>{busy ? <span className="spin" /> : null}Подтвердить и войти</button>
            <div className="auth-secondary-row">
              <button type="button" className="link" onClick={() => restartRegistration()}>Изменить данные</button>
              <button type="button" className="link" disabled={busy || registrationWait > 0} onClick={resendRegistrationCode}>
                {registrationWait > 0
                  ? `Новый код через ${formatWait(registrationWait)}`
                  : !registrationChallenge.delivered ? 'Повторить отправку' : registrationExpired ? 'Получить новый код' : 'Отправить ещё раз'}
              </button>
            </div>
          </form>
        ) : null}

        {screen === 'forgot' ? (
          <form noValidate onSubmit={sendRecovery}>
            <p className="auth-copy">Укажите привязанную почту. В письме будет ваш логин и безопасная ссылка для смены пароля.</p>
            <div className="row"><label htmlFor="auth-forgot-email">Электронная почта</label>
              <input id="auth-forgot-email" type="email" inputMode="email" value={forgotEmail} maxLength={254} autoFocus autoComplete="email" autoCapitalize="none" spellCheck={false}
                aria-invalid={Boolean(fieldError('email')) || undefined} aria-describedby={fieldError('email') ? 'auth-forgot-email-error' : undefined}
                onChange={(event) => { setForgotEmail(event.target.value); if (failure) setFailure(null); }} />
              <InlineError id="auth-forgot-email-error">{fieldError('email')}</InlineError>
            </div>
            <button type="submit" className="primary" disabled={busy}>{busy ? <span className="spin" /> : null}Отправить письмо</button>
            <button type="button" className="link" onClick={() => switchScreen('login')}>Вернуться ко входу</button>
          </form>
        ) : null}

        {screen === 'forgot-sent' ? (
          <div className="auth-state">
            <span className="auth-state-icon success"><Icon name="check" /></span>
            <p>Если этот адрес зарегистрирован, письмо уже отправлено. Проверьте также папку «Спам».</p>
            <button type="button" className="primary" disabled={busy || forgotWait > 0} onClick={() => sendRecovery()}>
              {forgotWait > 0 ? `Повторить через ${formatWait(forgotWait)}` : busy ? <><span className="spin" />Отправляю</> : 'Отправить ещё раз'}
            </button>
            <button type="button" className="link" onClick={() => switchScreen('login')}>Вернуться ко входу</button>
          </div>
        ) : null}

        {screen === 'reset-inspect' ? failure ? <div className="auth-state"><span className="auth-state-icon danger"><Icon name="warn" /></span><p>Не удалось проверить ссылку из-за проблем с соединением.</p><button type="button" className="primary" onClick={() => { setFailure(null); setResetInspectAttempt((value) => value + 1); }}>Повторить</button></div> : <div className="auth-state"><LogoLoader size={72} /><p>Проверяем безопасность ссылки…</p></div> : null}

        {screen === 'reset' ? (
          <form noValidate onSubmit={submitReset}>
            <p className="auth-copy">{resetUsername ? <>Меняем пароль для аккаунта <b>@{resetUsername}</b>.</> : 'Придумайте новый пароль для аккаунта.'}</p>
            <div className="row"><label htmlFor="auth-reset-password">Новый пароль</label>
              <PasswordInput id="auth-reset-password" label="Новый пароль" value={resetPassword} autoFocus autoComplete="new-password"
                invalid={Boolean(fieldError('password'))} describedBy={`auth-reset-password-hint${fieldError('password') ? ' auth-reset-password-error' : ''}`}
                onChange={(value) => { setResetPassword(value); if (failure) setFailure(null); }} />
              <div id="auth-reset-password-hint" className="auth-hint">От {PASSWORD_MIN} до {PASSWORD_MAX} символов. Подойдёт длинная парольная фраза.</div>
              <InlineError id="auth-reset-password-error">{fieldError('password')}</InlineError>
            </div>
            <div className="row"><label htmlFor="auth-reset-password-again">Повторите пароль</label>
              <PasswordInput id="auth-reset-password-again" label="Повторите пароль" value={resetPasswordAgain} autoComplete="new-password"
                invalid={Boolean(fieldError('passwordAgain'))} describedBy={fieldError('passwordAgain') ? 'auth-reset-password-again-error' : undefined}
                onChange={(value) => { setResetPasswordAgain(value); if (failure) setFailure(null); }} />
              <InlineError id="auth-reset-password-again-error">{fieldError('passwordAgain')}</InlineError>
            </div>
            <button type="submit" className="primary" disabled={busy}>{busy ? <span className="spin" /> : null}Сменить пароль</button>
          </form>
        ) : null}

        {screen === 'reset-done' ? (
          <div className="auth-state">
            <span className="auth-state-icon success"><Icon name="check" /></span>
            <p>Пароль обновлён. Для безопасности выполнен выход на всех устройствах.</p>
            <button type="button" className="primary" onClick={() => { setLoginUser(resetUsername); switchScreen('login'); }}>Перейти ко входу</button>
          </div>
        ) : null}

        {screen === 'reset-invalid' ? (
          <div className="auth-state">
            <span className="auth-state-icon danger"><Icon name="warn" /></span>
            <p>Ссылка уже использована или срок её действия истёк. Запросите новое письмо.</p>
            <button type="button" className="primary" onClick={() => { setPasswordResetToken(null); switchScreen('forgot'); }}>Запросить новую ссылку</button>
            {getToken() ? <button type="button" className="link" disabled={busy} onClick={returnToExistingSession}>Вернуться в приложение</button> : null}
            <button type="button" className="link" onClick={() => { setPasswordResetToken(null); switchScreen('login'); }}>Вернуться ко входу</button>
          </div>
        ) : null}

        {generalError ? <div className="auth-form-error" role="alert"><Icon name="warn" sm /><span>{generalError}</span></div> : null}
        <div className="auth-live" role="status" aria-live="polite">{busy ? 'Запрос выполняется' : ''}</div>
      </section>
    </main>
  );
}
