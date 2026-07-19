import { useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, isApiError, setToken } from '../api';
import { Icon } from '../Icon';
import { useStore } from '../store';
import type { ChallengeResponse, EmailChallenge } from '../types';
import { Backdrop } from './Backdrop';

type GateStep = 'email' | 'verify';
type Failure = { message: string; field?: string };
type Challenge = {
  id: string;
  emailMasked: string;
  expiresAt: number;
  resendAt: number;
  attemptsRemaining?: number;
  delivered: boolean;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function epochMs(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n < 1_000_000_000_000 ? n * 1000 : n;
}

function challengeFrom(response: ChallengeResponse, fallbackId = ''): Challenge {
  const raw = response.challenge || response.account?.challenge || (response as EmailChallenge);
  const id = raw?.flowId || response.flowId || raw?.id || raw?.challengeId || response.challengeId || fallbackId;
  if (!id) throw new ApiError('Сервер не вернул идентификатор подтверждения', { code: 'INVALID_RESPONSE' });
  return {
    id,
    emailMasked: raw?.emailMasked || raw?.maskedEmail || response.emailMasked || response.maskedEmail || '',
    expiresAt: epochMs(raw?.expiresAt ?? response.expiresAt, Date.now() + 10 * 60_000),
    resendAt: epochMs(raw?.resendAt ?? response.resendAt, Date.now() + 60_000),
    attemptsRemaining: raw?.attemptsRemaining ?? response.attemptsRemaining,
    delivered: raw?.delivered ?? response.delivered ?? true,
  };
}

function flowStorageKey(userId?: string) {
  return `relay.auth.email-flow.v1:${userId || 'unknown'}`;
}

function readStoredChallenge(key: string): Challenge | null {
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
      attemptsRemaining: Number.isFinite(attempts) && attempts >= 0 ? Math.floor(attempts) : undefined,
      delivered: raw.delivered !== false,
    };
  } catch {
    try { sessionStorage.removeItem(key); } catch { /* storage can be disabled */ }
    return null;
  }
}

function persistChallenge(key: string, challenge: Challenge | null) {
  try {
    if (!challenge) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(challenge));
  } catch { /* an unavailable sessionStorage must not block authentication */ }
}

function challengeFromAccount(account: ReturnType<typeof useStore.getState>['accountGate']): Challenge | null {
  if (account?.state !== 'email_verification' || !account.challenge) return null;
  try { return challengeFrom({ challenge: account.challenge }); } catch { return null; }
}

function asFailure(error: unknown, fallback: string): Failure {
  if (!isApiError(error)) return { message: error instanceof Error ? error.message : fallback };
  const aliases: Record<string, string> = { mail: 'email', password: 'currentPassword', verificationCode: 'code', otp: 'code', recoveryCode: 'supportCode' };
  const fieldsByCode: Record<string, string> = {
    INVALID_EMAIL: 'email', EMAIL_IN_USE: 'email', INVALID_PASSWORD: 'currentPassword', INVALID_CODE: 'code',
    RECOVERY_CODE_REQUIRED: 'supportCode', RECOVERY_CODE_USED: 'supportCode',
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
  return { message, field: normalized && ['email', 'currentPassword', 'supportCode', 'code'].includes(normalized) ? normalized : undefined };
}

function makeRequestId() {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function formatWait(seconds: number) {
  if (seconds < 60) return `${seconds} сек.`;
  return `${Math.ceil(seconds / 60)} мин.`;
}

export function AccountEmailGate() {
  const pendingUser = useStore((state) => state.pendingUser);
  const accountGate = useStore((state) => state.accountGate);
  const acceptSession = useStore((state) => state.acceptSession);
  const setAccountGate = useStore((state) => state.setAccountGate);
  const logout = useStore((state) => state.logout);
  const storageKey = useMemo(() => flowStorageKey(pendingUser?.id), [pendingUser?.id]);
  const initialChallenge = useMemo(() => challengeFromAccount(accountGate) || readStoredChallenge(storageKey), [accountGate, storageKey]);
  const [step, setStep] = useState<GateStep>(initialChallenge ? 'verify' : 'email');
  const [challenge, setChallenge] = useState<Challenge | null>(initialChallenge);
  const [email, setEmail] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [supportCode, setSupportCode] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const startRequestId = useRef('');
  const [code, setCode] = useState('');
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    persistChallenge(storageKey, challenge);
  }, [challenge, storageKey]);

  const wait = Math.max(0, Math.ceil(((challenge?.resendAt || 0) - now) / 1000));
  const expired = Boolean(challenge && challenge.expiresAt <= now);
  const fieldError = (field: string) => failure?.field === field ? failure.message : '';
  const generalError = failure && (!failure.field || (step === 'email' ? !['email', 'currentPassword', 'supportCode'].includes(failure.field) : failure.field !== 'code')) ? failure.message : '';

  function publishChallenge(next: Challenge) {
    setChallenge(next);
    setAccountGate({
      state: 'email_verification',
      challenge: {
        id: next.id,
        flowId: next.id,
        emailMasked: next.emailMasked,
        expiresAt: next.expiresAt,
        resendAt: next.resendAt,
        attemptsRemaining: next.attemptsRemaining,
        delivered: next.delivered,
      },
    });
    setStep('verify');
    setCode('');
  }

  async function start(event: React.FormEvent) {
    event.preventDefault();
    const normalizedEmail = email.trim();
    if (!EMAIL_RE.test(normalizedEmail)) { setFailure({ message: 'Введите корректный адрес почты', field: 'email' }); document.getElementById('gate-email')?.focus(); return; }
    if (!currentPassword && supportCode.length !== 12) {
      setFailure({ message: supportCode ? 'Одноразовый код должен содержать 12 символов' : 'Введите текущий пароль или одноразовый код от denis', field: 'supportCode' });
      document.getElementById('gate-support-code')?.focus();
      return;
    }
    if (!startRequestId.current) startRequestId.current = makeRequestId();
    setBusy(true); setFailure(null);
    try {
      publishChallenge(challengeFrom(await api.emailStart(normalizedEmail, currentPassword, startRequestId.current, supportCode)));
      setSupportCode('');
    }
    catch (error) { setFailure(asFailure(error, 'Не удалось отправить код')); }
    finally { setBusy(false); }
  }

  async function recoverCompletedBinding(): Promise<boolean> {
    if (!pendingUser?.username || !currentPassword) return false;
    try {
      const response = await api.login(pendingUser.username, currentPassword);
      setToken(response.token);
      if (response.account?.state === 'ready') {
        persistChallenge(storageKey, null);
        setChallenge(null);
        setCurrentPassword('');
        setSupportCode('');
        await acceptSession(response.user, response.account);
        return true;
      }
      setAccountGate(response.account);
      return false;
    } catch {
      return false;
    }
  }

  async function verify(event: React.FormEvent) {
    event.preventDefault();
    if (!challenge) { setStep('email'); return; }
    if (code.length !== 4) { setFailure({ message: 'Введите четыре цифры', field: 'code' }); document.getElementById('gate-code')?.focus(); return; }
    setBusy(true); setFailure(null);
    try {
      const response = await api.emailVerify(challenge.id, code);
      if (response.token) setToken(response.token);
      persistChallenge(storageKey, null);
      setChallenge(null);
      setCurrentPassword('');
      setSupportCode('');
      await acceptSession(response.user || pendingUser!, response.account || { state: 'ready' });
    } catch (error) {
      if (isApiError(error) && error.attemptsRemaining !== undefined) {
        setChallenge((current) => current ? { ...current, attemptsRemaining: error.attemptsRemaining } : current);
      }
      const ambiguous = isApiError(error) && (
        error.status === 0 || error.status >= 500 || error.code === 'FLOW_CONSUMED' || error.code === 'EMAIL_ALREADY_VERIFIED'
        || error.code === 'SESSION_REVOKED' || error.code === 'UNAUTHORIZED'
      );
      if (ambiguous && await recoverCompletedBinding()) return;
      const next = asFailure(error, 'Не удалось подтвердить почту');
      if (isApiError(error) && ['CODE_ATTEMPTS_EXCEEDED', 'FLOW_NOT_FOUND'].includes(error.code)) {
        startRequestId.current = '';
        setChallenge(null);
        setCode('');
        setSupportCode('');
        setAccountGate({ state: 'email_required' });
        setStep('email');
        setFailure(next);
      } else if (ambiguous && !currentPassword) {
        setFailure({ message: 'Привязка могла завершиться. Войдите заново или восстановите пароль через указанную почту.' });
      } else setFailure(next);
    }
    finally { setBusy(false); }
  }

  async function resend() {
    if (!challenge || wait > 0 || busy) return;
    setBusy(true); setFailure(null);
    try { publishChallenge(challengeFrom(await api.emailResend(challenge.id), challenge.id)); }
    catch (error) {
      const next = asFailure(error, 'Не удалось отправить новый код');
      if (isApiError(error) && error.retryAfter !== undefined) {
        setChallenge((current) => current ? { ...current, resendAt: Date.now() + error.retryAfter! * 1000 } : current);
      }
      if (isApiError(error) && ['CODE_ATTEMPTS_EXCEEDED', 'FLOW_EXPIRED', 'FLOW_NOT_FOUND'].includes(error.code)) {
        startRequestId.current = '';
        setChallenge(null);
        setCode('');
        setSupportCode('');
        setAccountGate({ state: 'email_required' });
        setStep('email');
        setFailure(next);
      } else setFailure(next);
    }
    finally { setBusy(false); }
  }

  function changeEmail() {
    startRequestId.current = '';
    setFailure(null); setCode(''); setChallenge(null); setSupportCode(''); setStep('email');
    setAccountGate({ state: 'email_required' });
    requestAnimationFrame(() => document.getElementById('gate-email')?.focus());
  }

  return (
    <Backdrop onClose={() => {}} dismissible={false} boxClass="account-email-gate" label="Обязательная привязка электронной почты">
      <div className="gate-head">
        <span className="gate-icon"><Icon name="shield" /></span>
        <div><span className="gate-kicker">Защита аккаунта</span><h2>{step === 'email' ? 'Привяжите почту' : 'Подтвердите почту'}</h2></div>
      </div>

      {step === 'email' ? (
        <form noValidate aria-busy={busy || undefined} onSubmit={start}>
          <p className="msub">{pendingUser ? <><b>{pendingUser.displayName}</b>, </> : null}почта понадобится для восстановления доступа. Не выходите из аккаунта, пока не завершите привязку.</p>
          <div className="fld"><label htmlFor="gate-email">Электронная почта</label>
            <input id="gate-email" type="email" inputMode="email" autoFocus autoComplete="email" autoCapitalize="none" spellCheck={false} maxLength={254}
              value={email} aria-invalid={Boolean(fieldError('email')) || undefined} aria-describedby={fieldError('email') ? 'gate-email-error' : undefined}
              onChange={(event) => { startRequestId.current = ''; setEmail(event.target.value); if (failure) setFailure(null); }} />
            {fieldError('email') ? <div id="gate-email-error" className="auth-field-error" role="alert">{fieldError('email')}</div> : null}
          </div>
          <div className="fld"><label htmlFor="gate-password">Текущий пароль</label>
            <div className="auth-password">
              <input id="gate-password" type={showPassword ? 'text' : 'password'} autoComplete="current-password" value={currentPassword}
                aria-invalid={Boolean(fieldError('currentPassword') || fieldError('password')) || undefined}
                aria-describedby={(fieldError('currentPassword') || fieldError('password')) ? 'gate-password-error' : undefined}
                onChange={(event) => { startRequestId.current = ''; setCurrentPassword(event.target.value); if (failure) setFailure(null); }} />
              <button type="button" className="auth-password-toggle" aria-label={showPassword ? 'Скрыть текущий пароль' : 'Показать текущий пароль'} aria-pressed={showPassword} onClick={() => setShowPassword((value) => !value)}><Icon name={showPassword ? 'eye-off' : 'eye'} sm /></button>
            </div>
            {(fieldError('currentPassword') || fieldError('password')) ? <div id="gate-password-error" className="auth-field-error" role="alert">{fieldError('currentPassword') || fieldError('password')}</div> : null}
          </div>
          <div className="gate-or" aria-hidden="true"><span>или, если пароль забыт</span></div>
          <div className="fld"><label htmlFor="gate-support-code">Одноразовый код от denis</label>
            <input id="gate-support-code" className="auth-code-text" type="text" autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={16}
              value={supportCode} aria-invalid={Boolean(fieldError('supportCode')) || undefined}
              aria-describedby={`gate-support-code-hint${fieldError('supportCode') ? ' gate-support-code-error' : ''}`}
              onChange={(event) => {
                startRequestId.current = '';
                setSupportCode(event.target.value.replace(/[\s-]/g, '').toUpperCase().slice(0, 12));
                if (failure) setFailure(null);
              }} />
            <div id="gate-support-code-hint" className="auth-hint">Попросите denis выдать код после проверки, что аккаунт ваш. Код заменяет пароль только для одной привязки.</div>
            {fieldError('supportCode') ? <div id="gate-support-code-error" className="auth-field-error" role="alert">{fieldError('supportCode')}</div> : null}
          </div>
          <button type="submit" className="primary" disabled={busy}>{busy ? <span className="spin" /> : null}Отправить код</button>
        </form>
      ) : challenge ? (
        <form noValidate aria-busy={busy || undefined} onSubmit={verify}>
          <p className="msub">{challenge.delivered
            ? <>Код из четырёх цифр отправлен на <b>{challenge.emailMasked || email}</b>.</>
            : <>Письмо на <b>{challenge.emailMasked || email}</b> пока не отправлено. Повторите отправку ниже.</>}</p>
          <div className="fld auth-otp-row"><label htmlFor="gate-code">Код из письма</label>
            <input id="gate-code" className="auth-otp" type="text" inputMode="numeric" pattern="[0-9]*" maxLength={4} autoFocus autoComplete="one-time-code"
              value={code} aria-invalid={Boolean(fieldError('code')) || undefined} aria-describedby={fieldError('code') ? 'gate-code-error' : 'gate-code-hint'}
              onChange={(event) => { setCode(event.target.value.replace(/\D/g, '').slice(0, 4)); if (failure) setFailure(null); }} />
            <div id="gate-code-hint" className="auth-hint">
              {expired
                ? 'Срок действия кода истёк — запросите новый.'
                : challenge.attemptsRemaining !== undefined
                  ? `Не сообщайте код другим людям. Осталось попыток: ${challenge.attemptsRemaining}.`
                  : 'Не сообщайте код другим людям.'}
            </div>
            {fieldError('code') ? <div id="gate-code-error" className="auth-field-error" role="alert">{fieldError('code')}</div> : null}
          </div>
          <button type="submit" className="primary" disabled={busy || !challenge.delivered || expired || code.length !== 4}>{busy ? <span className="spin" /> : null}Подтвердить и продолжить</button>
          <div className="auth-secondary-row">
            <button type="button" className="link" onClick={changeEmail}>Изменить почту</button>
            <button type="button" className="link" disabled={busy || wait > 0} onClick={resend}>{wait > 0 ? `Новый код через ${formatWait(wait)}` : 'Отправить ещё раз'}</button>
          </div>
        </form>
      ) : null}

      {generalError ? <div className="auth-form-error" role="alert"><Icon name="warn" sm /><span>{generalError}</span></div> : null}
      <div className="gate-foot"><span>Можно указать только адрес, к которому у вас есть доступ. Без привязанной почты после выхода восстановить пароль нельзя.</span><button type="button" disabled={busy} onClick={() => { persistChallenge(storageKey, null); logout(); }}>Выйти всё равно</button></div>
      <div className="auth-live" role="status" aria-live="polite">{busy ? 'Запрос выполняется' : ''}</div>
    </Backdrop>
  );
}
