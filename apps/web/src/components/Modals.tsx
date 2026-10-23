import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { api, isApiError, resolveUploadUrl, setToken, webOrigin } from '../api';
import {
  beginAuthSessionHandoff,
  completeAuthSessionHandoff,
  useStore,
  getEngine,
} from '../store';
import { getSettings, setSettings, subscribeSettings } from '../settings';
import { audioDeviceInventory } from '../audioDeviceInventory';
import { ACCENTS, THEME_MODES, getAccent, getThemeMode, setAccent, setThemeMode } from '../theme';
import { playSound } from '../sounds';
import { Icon } from '../Icon';
import { MicMeter } from './MicMeter';
import { AV_COLORS, avColor, downscaleImage, initial, initials2, keyLabel, comboLabel, plural } from '../util';
import type { AudioSettings, InvitePreview, Role, Member, KeybindAction } from '../types';
import { PERM, PERM_LIST, hasPerm } from '../types';
import { Backdrop } from './Backdrop';
import { BroadcastModal } from './BroadcastModal';
import { DownloadsModal } from './DownloadsModal';
import { SHORTCUTS } from './CommandOverlays';
import { LeaderboardModal } from './Leaderboard';
import { ReleaseHistoryModal } from './ReleaseHistoryModal';
import { normalizeProfileBanner, ProfileBannerMedia } from './ProfileBanner';
import { isTauri, setGlobalHotkeys } from '../native';
import { enableNotifications, notifSupported, notifPermission } from '../notify';
import { unsubscribePush, syncPushPrefs } from '../push';
import {
  audioDeviceChoices,
  audioOutputChoices,
  currentAppleMobilePlatform,
  withSelectedAudioDevice,
} from '../audioDevices';

function CreateModal() {
  const close = () => useStore.getState().setModal(null);
  const [name, setName] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  async function create() {
    if (name.trim().length < 2) { setErr('Название минимум 2 символа'); return; }
    setBusy(true);
    try { const d = await api.createServer(name.trim()); close(); await useStore.getState().loadMe(); await useStore.getState().openServer(d.server.id, undefined, 'channels'); useStore.getState().toast('Сервер создан', 'ok'); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }
  return <Backdrop onClose={close} label="Создать сервер" boxClass="box-dialog">
    <JoinCreateTabs current="create" />
    <h2>Новый сервер</h2>
    <p className="msub">Сервер приватный — попасть можно только по приглашению. Пригласишь друзей ссылкой из меню сервера.</p>
    <div className="fld"><label htmlFor="create-server-name">Название</label><input id="create-server-name" autoFocus value={name} maxLength={40} placeholder="Например: Наша тусовка" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && create()} /></div>
    <div className="rowbtns"><button className="ghost" onClick={close}>Отмена</button><button className="primary" disabled={busy} onClick={create}>{busy ? <span className="spin" /> : null}Создать сервер</button></div>
    <div className="err" role="alert">{err}</div>
  </Backdrop>;
}

// Создать / войти по коду — один диалог с переключателем (две модалки store, общий заголовок).
function JoinCreateTabs({ current }: { current: 'create' | 'join' }) {
  const setModal = useStore.getState().setModal;
  return (
    <div className="tabs2 dlg-tabs" role="tablist" aria-label="Сервер">
      <button type="button" role="tab" aria-selected={current === 'create'} className={current === 'create' ? 'active' : ''} onClick={() => current !== 'create' && setModal('create')}>Создать</button>
      <button type="button" role="tab" aria-selected={current === 'join'} className={current === 'join' ? 'active' : ''} onClick={() => current !== 'join' && setModal('join')}>Войти по коду</button>
    </div>
  );
}

function extractCode(v: string) { v = v.trim(); const m = v.match(/[?&]invite=([^&\s]+)/); if (m) return m[1]; return v; }
function JoinModal() {
  const close = () => useStore.getState().setModal(null);
  const prefill = useStore((s) => s.joinPrefill);
  const [code, setCode] = useState(prefill || ''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const tRef = useRef<number | null>(null);
  async function doPreview(c: string) { const cc = extractCode(c); if (!cc) { setPreview(null); return; } try { const d = await api.invitePreview(cc); setPreview(d); setErr(''); } catch (e: any) { setPreview(null); setErr(e.message); } }
  useEffect(() => { if (prefill) doPreview(prefill); /* eslint-disable-next-line */ }, []);
  function onCode(v: string) { setCode(v); if (tRef.current) clearTimeout(tRef.current); tRef.current = window.setTimeout(() => doPreview(v), 400); }
  async function join() {
    const cc = extractCode(code); if (!cc) { setErr('Введи код'); return; }
    setBusy(true); setErr('');
    try { const d = await api.joinInvite(cc); close(); await useStore.getState().loadMe(); await useStore.getState().openServer(d.server.id, undefined, 'channels'); useStore.getState().toast('Ты на сервере «' + d.server.name + '»', 'ok'); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }
  return <Backdrop onClose={close} label="Присоединиться" boxClass="box-dialog">
    <JoinCreateTabs current="join" />
    <h2>Вход по приглашению</h2>
    <p className="msub">Вставь ссылку или код. Ссылка действует 30 минут.</p>
    <div className="fld"><label htmlFor="join-code" className="sr-only">Код или ссылка</label>
      <input id="join-code" className="join-code" autoFocus value={code} autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="Код или ссылка" onChange={(e) => onCode(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && join()} />
    </div>
    {preview ? <div className="join-preview">
      <span className="jp-ic" style={{ background: avColor(preview.server.name, preview.server.iconColor) }}>{initials2(preview.server.name)}</span>
      <span className="jp-txt"><b>{preview.server.name}</b><i>{preview.server.memberCount} {plural(preview.server.memberCount, ['участник', 'участника', 'участников'])}</i></span>
    </div> : null}
    <button className="primary" disabled={busy} onClick={join}>{busy ? <span className="spin" /> : null}Присоединиться</button>
    <div className="err" role="alert">{err}</div>
  </Backdrop>;
}

// кроп картинки в квадрат + даунскейл до size (для аватара)
function cropSquare(file: File, size: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const src = URL.createObjectURL(file);
    img.onload = () => {
      const s = Math.min(img.width, img.height);
      const c = document.createElement('canvas'); c.width = size; c.height = size;
      const ctx = c.getContext('2d'); if (!ctx) { reject(new Error('canvas')); return; }
      ctx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
      URL.revokeObjectURL(src);
      c.toBlob((b) => (b ? resolve(b) : reject(new Error('canvas'))), 'image/jpeg', 0.9);
    };
    img.onerror = () => { URL.revokeObjectURL(src); reject(new Error('Не удалось прочитать картинку')); };
    img.src = src;
  });
}

type ProfileTab = 'profile' | 'security';
type PasswordField = 'currentPassword' | 'newPassword' | 'confirmPassword';
type PasswordFailure = { message: string; field?: PasswordField };

const PROFILE_PASSWORD_MIN = 15;
const PROFILE_PASSWORD_MAX = 64;
// HTML maxLength считает UTF-16 units, а сервер — Unicode code points. Запасной
// cap защищает DOM от огромной строки, не обрезая корректные пароли с emoji.
const PROFILE_PASSWORD_INPUT_MAX = 256;
const textLength = (value: string) => Array.from(value.normalize('NFC')).length;

function ProfilePasswordInput({ id, label, value, autoComplete, maxLength, hint, error, disabled, onChange }: {
  id: string;
  label: string;
  value: string;
  autoComplete: 'current-password' | 'new-password';
  maxLength: number;
  hint: string;
  error?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const [visible, setVisible] = useState(false);
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  return <div className="fld pm-password-field">
    <label htmlFor={id}>{label}</label>
    <div className="auth-password">
      <input id={id} type={visible ? 'text' : 'password'} value={value} maxLength={maxLength}
        name={autoComplete} autoComplete={autoComplete} autoCapitalize="none" spellCheck={false}
        required aria-required="true" disabled={disabled}
        aria-invalid={error ? true : undefined} aria-describedby={`${hintId}${error ? ` ${errorId}` : ''}`}
        onChange={(event) => onChange(event.target.value)} />
      <button type="button" className="auth-password-toggle" aria-pressed={visible} disabled={disabled}
        aria-label={visible ? `Скрыть поле «${label}»` : `Показать поле «${label}»`}
        onClick={() => setVisible((current) => !current)}>
        <Icon name={visible ? 'eye-off' : 'eye'} sm />
      </button>
    </div>
    <div id={hintId} className="auth-hint">{hint}</div>
    {error ? <div id={errorId} className="auth-field-error" role="alert">{error}</div> : null}
  </div>;
}

function ProfileModal() {
  const me = useStore((s) => s.me)!;
  const [tab, setTab] = useState<ProfileTab>('profile');
  const [dn, setDn] = useState(me.displayName);
  const [bio, setBio] = useState(me.bio || '');
  const [color, setColor] = useState(me.avatarColor);
  const [avatarUrl, setAvatarUrl] = useState(me.avatarUrl || '');
  const [bannerUrl, setBannerUrl] = useState(normalizeProfileBanner(me.profileBannerUrl));
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [bannerUploading, setBannerUploading] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordFailure, setPasswordFailure] = useState<PasswordFailure | null>(null);
  const [passwordSuccess, setPasswordSuccess] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const bannerRef = useRef<HTMLInputElement>(null);
  const bannerAbortRef = useRef<AbortController | null>(null);
  const bannerUploadSeq = useRef(0);
  const pendingLocalBannerRef = useRef('');
  const profileDirty = dn.trim() !== me.displayName || bio !== (me.bio || '') || color !== me.avatarColor
    || avatarUrl !== (me.avatarUrl || '') || bannerUrl !== normalizeProfileBanner(me.profileBannerUrl);
  const profileNeedsAttention = Boolean(err || !dn.trim());
  const hasPasswordDraft = Boolean(currentPassword || newPassword || confirmPassword);
  const interactionLocked = busy || passwordBusy || uploading || bannerUploading;
  const cleanupPendingLocalBanner = (preserve = '') => {
    const url = pendingLocalBannerRef.current;
    if (!url || url === preserve) return;
    pendingLocalBannerRef.current = '';
    api.deleteProfileBannerUpload(url).catch(() => {});
  };
  const performClose = () => {
    bannerUploadSeq.current += 1;
    bannerAbortRef.current?.abort();
    cleanupPendingLocalBanner();
    useStore.getState().setModal(null);
  };
  const requestClose = () => {
    if (interactionLocked) return;
    if (profileDirty || hasPasswordDraft) {
      const message = profileDirty && hasPasswordDraft
        ? 'Изменения профиля и введённые пароли не сохранены. Закрыть окно и сбросить их?'
        : profileDirty
          ? 'Изменения профиля не сохранены. Закрыть окно и сбросить их?'
          : 'Введённые пароли будут очищены. Закрыть окно?';
      if (!window.confirm(message)) return;
    }
    performClose();
  };
  const cancelBannerUpload = () => {
    bannerUploadSeq.current += 1;
    bannerAbortRef.current?.abort();
    bannerAbortRef.current = null;
    setBannerUploading(false);
  };
  useEffect(() => () => {
    bannerUploadSeq.current += 1;
    bannerAbortRef.current?.abort();
    cleanupPendingLocalBanner();
  }, []);

  function selectTab(next: ProfileTab, focus = false) {
    if (passwordBusy) return;
    setTab(next);
    if (focus) requestAnimationFrame(() => document.getElementById(`profile-tab-${next}`)?.focus());
  }
  function onTabKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    selectTab(tab === 'profile' ? 'security' : 'profile', true);
  }
  async function pickAvatar(file: File) {
    if (!file.type.startsWith('image/')) { setErr('Выберите изображение в формате PNG, JPEG, GIF или WebP.'); return; }
    if (file.size > 10 * 1024 * 1024) { setErr('Размер изображения не должен превышать 10 МБ.'); return; }
    setUploading(true); setErr('');
    try { const blob = await cropSquare(file, 256); const { url } = await api.uploadImage(blob); setAvatarUrl(url); }
    catch (e: any) { setErr(e?.message || 'Не удалось загрузить изображение.'); }
    finally { setUploading(false); }
  }
  async function save() {
    if (!dn.trim()) {
      requestAnimationFrame(() => document.getElementById('profile-display-name')?.focus());
      return;
    }
    if (!profileDirty || busy) return;
    setBusy(true); setErr('');
    try {
      const d = await api.updateMe({ displayName: dn.trim(), bio, avatarColor: color, avatarUrl, profileBannerUrl: bannerUrl });
      if (pendingLocalBannerRef.current === bannerUrl) pendingLocalBannerRef.current = '';
      useStore.getState().setMe(d.user);
      useStore.getState().refreshMembers();
      useStore.getState().refreshServers();
      performClose();
      useStore.getState().toast('Профиль сохранён', 'ok');
    }
    catch (e: any) { setErr(e?.message || 'Не удалось сохранить профиль.'); }
    finally { setBusy(false); }
  }
  async function pickBanner(file: File) {
    const allowed = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
    if (!allowed.has(file.type)) { setErr('Для фона подойдут PNG, JPEG, WebP или GIF.'); return; }
    if (file.size > 10 * 1024 * 1024) { setErr('Размер фона не должен превышать 10 МБ.'); return; }
    bannerAbortRef.current?.abort();
    const sequence = ++bannerUploadSeq.current;
    const controller = new AbortController();
    bannerAbortRef.current = controller;
    setBannerUploading(true); setErr('');
    try {
      // Canvas/downscale уничтожает анимацию. GIF и WebP отправляем как есть (размер уже
      // ограничен выше), чтобы animated WebP действительно продолжал играть в профиле.
      const prepared = file.type === 'image/gif' || file.type === 'image/webp'
        ? file
        : await downscaleImage(file, 1600, .84);
      if (controller.signal.aborted || sequence !== bannerUploadSeq.current) return;
      const { url } = await api.uploadProfileBanner(prepared, controller.signal);
      if (controller.signal.aborted || sequence !== bannerUploadSeq.current) {
        api.deleteProfileBannerUpload(url).catch(() => {});
        return;
      }
      cleanupPendingLocalBanner(url);
      pendingLocalBannerRef.current = url;
      setBannerUrl(url);
    } catch (e: any) {
      if (sequence === bannerUploadSeq.current && e?.name !== 'AbortError') setErr(e?.message || 'Не удалось загрузить фон.');
    } finally {
      if (sequence === bannerUploadSeq.current) { bannerAbortRef.current = null; setBannerUploading(false); }
    }
  }
  function editPassword(setter: (value: string) => void, value: string) {
    setter(value);
    setPasswordFailure(null);
    setPasswordSuccess('');
  }
  function rejectPassword(message: string, field?: PasswordField) {
    setPasswordFailure({ message, field });
    if (field) requestAnimationFrame(() => document.getElementById(`profile-${field}`)?.focus());
  }
  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!currentPassword) { rejectPassword('Введите текущий пароль.', 'currentPassword'); return; }
    const nextLength = textLength(newPassword);
    if (nextLength < PROFILE_PASSWORD_MIN) { rejectPassword(`Используйте не менее ${PROFILE_PASSWORD_MIN} символов.`, 'newPassword'); return; }
    if (nextLength > PROFILE_PASSWORD_MAX) { rejectPassword(`Используйте не более ${PROFILE_PASSWORD_MAX} символов.`, 'newPassword'); return; }
    if (newPassword !== confirmPassword) { rejectPassword('Пароли не совпадают.', 'confirmPassword'); return; }
    if (newPassword.normalize('NFC') === currentPassword.normalize('NFC')) { rejectPassword('Новый пароль должен отличаться от текущего.', 'newPassword'); return; }
    setPasswordBusy(true); setPasswordFailure(null); setPasswordSuccess('');
    const handoff = beginAuthSessionHandoff();
    let tokenChanged = false;
    try {
      const response = await api.changePassword(currentPassword, newPassword.normalize('NFC'));
      setToken(response.token);
      tokenChanged = true;
      useStore.getState().setMe(response.user);
      setCurrentPassword(''); setNewPassword(''); setConfirmPassword('');
      setPasswordSuccess('Пароль изменён. Остальные сеансы завершены, а это окно осталось авторизованным.');
      void syncPushPrefs();
      // Ротация учётных данных уже завершена. Восстановление LiveKit может занять до 20 секунд
      // при сетевой проблеме и не должно удерживать форму в состоянии «Меняем пароль…».
      void completeAuthSessionHandoff(handoff, true);
      useStore.getState().toast('Пароль изменён', 'ok');
    } catch (error) {
      await completeAuthSessionHandoff(handoff, tokenChanged);
      if (tokenChanged) {
        useStore.getState().toast('Пароль изменён, но соединение потребуется открыть заново', 'warn');
        return;
      }
      if (isApiError(error)) {
        const fieldByCode: Record<string, PasswordField> = {
          INVALID_CURRENT_PASSWORD: 'currentPassword', PASSWORD_CHANGE_RATE_LIMITED: 'currentPassword',
          WEAK_PASSWORD: 'newPassword', PASSWORD_TOO_LONG: 'newPassword', PASSWORD_UNCHANGED: 'newPassword',
        };
        const rawField = error.field;
        const field = rawField === 'currentPassword' || rawField === 'newPassword' || rawField === 'confirmPassword'
          ? rawField : fieldByCode[error.code];
        let message = error.message || 'Не удалось изменить пароль.';
        if (error.attemptsRemaining !== undefined && error.code === 'INVALID_CURRENT_PASSWORD') message += ` Осталось попыток: ${error.attemptsRemaining}.`;
        if (error.retryAfter) message += ` Повторите через ${error.retryAfter < 60 ? `${error.retryAfter} сек.` : `${Math.ceil(error.retryAfter / 60)} мин.`}`;
        rejectPassword(message, field);
      } else rejectPassword(error instanceof Error ? error.message : 'Не удалось изменить пароль.');
    } finally { setPasswordBusy(false); }
  }
  const passwordFieldError = (field: PasswordField) => passwordFailure?.field === field ? passwordFailure.message : '';
  const passwordGeneralError = passwordFailure && !passwordFailure.field ? passwordFailure.message : '';

  return <Backdrop onClose={requestClose} label="Профиль и безопасность" boxClass="profile-modal">
    <button type="button" className="settings-x" disabled={interactionLocked} onClick={requestClose} aria-label="Закрыть"><Icon name="close" /></button>
    <div className={'pm-hero' + (bannerUrl ? ' has-banner' : '')}>
      <ProfileBannerMedia value={bannerUrl} className="pm-hero-banner" />
      <div className="pm-banner-actions" role="group" aria-label="Фон профиля">
        <button type="button" disabled={bannerUploading || busy || passwordBusy} aria-label="Сменить фон профиля" data-tip="PNG, JPEG, GIF или WebP, до 10 МБ" onClick={() => bannerRef.current?.click()}>
          {bannerUploading ? <span className="spin" /> : <Icon name="image" sm />}<span>{bannerUrl ? 'Сменить фон' : 'Добавить фон'}</span>
        </button>
        {bannerUrl ? <button type="button" disabled={bannerUploading || busy || passwordBusy} className="danger pm-banner-remove" aria-label="Убрать фон профиля"
          onClick={() => { cancelBannerUpload(); cleanupPendingLocalBanner(); setBannerUrl(''); }}><Icon name="trash" sm /><span>Убрать</span></button> : null}
      </div>
      <button type="button" className="pm-av" disabled={uploading || busy || passwordBusy} onClick={() => fileRef.current?.click()} aria-label="Сменить аватар"
        title="Сменить аватар" style={{ background: avatarUrl ? '#0000' : avColor(dn, color) }}>
        {avatarUrl ? <img className="avimg" src={resolveUploadUrl(avatarUrl)} alt="" /> : initial(dn)}
        {uploading ? <span className="spin" style={{ position: 'absolute', inset: 0, margin: 'auto' }} /> : <span className="pm-av-edit"><Icon name="edit" sm /></span>}
      </button>
      <div className="pm-id"><div className="pm-nm">{dn.trim() || 'Без имени'}</div><div className="pm-un">@{me.username}</div></div>
    </div>
    <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={(e) => { const file = e.target.files?.[0]; if (file) void pickAvatar(file); e.target.value = ''; }} />
    <input ref={bannerRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={(e) => { const file = e.target.files?.[0]; if (file) void pickBanner(file); e.target.value = ''; }} />
    <div className="pm-tabs" role="tablist" aria-label="Настройки аккаунта">
      <button id="profile-tab-profile" type="button" role="tab" aria-selected={tab === 'profile'} aria-controls="profile-panel-profile"
        disabled={passwordBusy} tabIndex={tab === 'profile' ? 0 : -1} className={(tab === 'profile' ? 'active' : '') + (profileDirty || profileNeedsAttention ? ' has-draft' : '')}
        aria-label={profileNeedsAttention ? 'Профиль, требуется внимание' : profileDirty ? 'Профиль, есть несохранённые изменения' : 'Профиль'}
        onKeyDown={onTabKeyDown} onClick={() => selectTab('profile')}>
        <Icon name="edit" sm />Профиль{profileDirty || profileNeedsAttention ? <span className={'pm-tab-dot' + (profileNeedsAttention ? ' error' : '')} aria-hidden="true" /> : null}
      </button>
      <button id="profile-tab-security" type="button" role="tab" aria-selected={tab === 'security'} aria-controls="profile-panel-security"
        disabled={passwordBusy} tabIndex={tab === 'security' ? 0 : -1} className={tab === 'security' ? 'active' : ''} onKeyDown={onTabKeyDown} onClick={() => selectTab('security')}><Icon name="shield" sm />Безопасность</button>
    </div>
    <form id="profile-panel-profile" className="pm-body pm-profile-panel" role="tabpanel" hidden={tab !== 'profile'} tabIndex={tab === 'profile' ? 0 : -1} aria-labelledby="profile-tab-profile"
      noValidate onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <div className="pm-profile-scroll">
        <section className="pm-section" aria-labelledby="profile-main-heading">
        <div className="pm-section-head"><div><h3 id="profile-main-heading">Основная информация</h3><p>Имя и описание видны участникам ваших серверов.</p></div></div>
        <div className="pm-avbtns" aria-describedby="profile-avatar-help">
          <button type="button" className="ghost" disabled={uploading || busy} onClick={() => fileRef.current?.click()}><Icon name="image" sm />{uploading ? 'Загрузка…' : avatarUrl ? 'Сменить фото' : 'Добавить фото'}</button>
          {avatarUrl ? <button type="button" className="ghost danger" disabled={uploading || busy} onClick={() => { setAvatarUrl(''); setErr(''); }}><Icon name="trash" sm />Убрать</button> : null}
        </div>
        <div id="profile-avatar-help" className="pm-field-note">Изображение обрежется до квадрата. Максимальный размер — 10 МБ.</div>
        <div className="fld">
          <div className="pm-field-head"><label htmlFor="profile-display-name">Отображаемое имя</label><span>{textLength(dn)}/32</span></div>
          <input id="profile-display-name" name="displayName" value={dn} maxLength={32} autoComplete="nickname"
            aria-invalid={!dn.trim() || undefined} aria-describedby={`profile-display-name-help${!dn.trim() ? ' profile-display-name-error' : ''}`}
            onChange={(e) => { setDn(e.target.value); setErr(''); }} />
          <div id="profile-display-name-help" className="pm-field-note">Так вас увидят в чатах и списках участников.</div>
          {!dn.trim() ? <div id="profile-display-name-error" className="auth-field-error" role="alert">Введите отображаемое имя.</div> : null}
        </div>
        <div className="fld">
          <div className="pm-field-head"><label htmlFor="profile-bio">О себе</label><span>{textLength(bio)}/200</span></div>
          <textarea id="profile-bio" value={bio} maxLength={200} rows={3} placeholder="Расскажите немного о себе"
            aria-describedby="profile-bio-help" onChange={(e) => { setBio(e.target.value); setErr(''); }} />
          <div id="profile-bio-help" className="pm-field-note">Необязательно. Можно оставить поле пустым.</div>
        </div>
        </section>
        <section className="pm-section" aria-labelledby="profile-look-heading">
        <div className="pm-section-head"><div><h3 id="profile-look-heading">Цвет аватара</h3><p>{avatarUrl ? 'Используется, если фотография недоступна.' : 'Помогает отличать вас в списках и чате.'}</p></div></div>
        <div className="colorpick" role="group" aria-label="Цвет аватара">{AV_COLORS.map((value, index) => <button type="button" key={value}
          className={'cp' + (index === color ? ' sel' : '')} style={{ background: value }} aria-label={`Цвет ${index + 1}`} aria-pressed={index === color}
          onClick={() => { setColor(index); setErr(''); }} />)}</div>
        </section>
        {err ? <div className="pm-inline-error" role="alert"><Icon name="warn" sm /><span>{err}</span></div> : null}
      </div>
      <div className="pm-foot">
        <span className={profileDirty ? 'changed' : ''}>{profileDirty ? 'Есть несохранённые изменения' : 'Все изменения сохранены'}</span>
        <button type="submit" className="primary" disabled={!profileDirty || !dn.trim() || busy || uploading || bannerUploading}>{busy ? <><span className="spin" />Сохраняем…</> : 'Сохранить'}</button>
      </div>
    </form>
    <div id="profile-panel-security" className="pm-body pm-security" role="tabpanel" hidden={tab !== 'security'} tabIndex={tab === 'security' ? 0 : -1} aria-labelledby="profile-tab-security">
      <section className="pm-section" aria-labelledby="profile-account-heading">
        <div className="pm-section-head"><div><h3 id="profile-account-heading">Учётная запись</h3><p>Данные для входа и восстановления доступа.</p></div></div>
        <div className="pm-account-row"><span className="pm-account-icon"><Icon name="check" sm /></span><div><span>Электронная почта</span><strong>{me.email || 'Не привязана'}</strong></div><span className={me.emailVerified ? 'verified' : 'pending'}>{me.emailVerified ? 'Подтверждена' : 'Не подтверждена'}</span></div>
      </section>
      <section className="pm-section" aria-labelledby="profile-password-heading">
        <div className="pm-section-head"><div><h3 id="profile-password-heading">Смена пароля</h3><p>После сохранения остальные устройства выйдут из аккаунта.</p></div></div>
        <form className="pm-password-form" noValidate onSubmit={changePassword}>
          <ProfilePasswordInput id="profile-currentPassword" label="Текущий пароль" value={currentPassword} maxLength={1024} disabled={passwordBusy}
            autoComplete="current-password" hint="Подтвердите действие действующим паролем." error={passwordFieldError('currentPassword')}
            onChange={(value) => editPassword(setCurrentPassword, value)} />
          <ProfilePasswordInput id="profile-newPassword" label="Новый пароль" value={newPassword} maxLength={PROFILE_PASSWORD_INPUT_MAX} disabled={passwordBusy}
            autoComplete="new-password" hint={`От ${PROFILE_PASSWORD_MIN} до ${PROFILE_PASSWORD_MAX} символов. Лучше использовать длинную парольную фразу.`} error={passwordFieldError('newPassword')}
            onChange={(value) => editPassword(setNewPassword, value)} />
          <ProfilePasswordInput id="profile-confirmPassword" label="Повторите новый пароль" value={confirmPassword} maxLength={PROFILE_PASSWORD_INPUT_MAX} disabled={passwordBusy}
            autoComplete="new-password" hint="Повторите новый пароль без изменений." error={passwordFieldError('confirmPassword')}
            onChange={(value) => editPassword(setConfirmPassword, value)} />
          {passwordGeneralError ? <div className="auth-form-error" role="alert"><Icon name="warn" sm /><span>{passwordGeneralError}</span></div> : null}
          {passwordSuccess ? <div className="pm-password-success" role="status"><Icon name="check" sm /><span>{passwordSuccess}</span></div> : null}
          <button type="submit" className="primary pm-password-submit" disabled={passwordBusy}>{passwordBusy ? <><span className="spin" />Меняем пароль…</> : 'Сменить пароль'}</button>
        </form>
      </section>
      <div className="pm-session-actions"><div><strong>Завершить текущий сеанс</strong><span>На этом устройстве потребуется снова ввести логин и пароль.</span></div><button type="button" className="ghost pm-logout" disabled={interactionLocked} onClick={() => { cleanupPendingLocalBanner(); useStore.getState().logout(); }}><Icon name="leave" sm />Выйти</button></div>
    </div>
  </Backdrop>;
}

function ServerMenuModal() {
  const close = () => useStore.getState().setModal(null);
  const active = useStore((s) => s.active)!;
  const [err, setErr] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const owner = active.myRole === 'owner';
  const canManage = owner || hasPerm(active.myPerms || 0, PERM.MANAGE_SERVER) || hasPerm(active.myPerms || 0, PERM.MANAGE_ROLES);
  async function leave() {
    if (busy) return;
    setBusy(true); setErr('');
    try { if (owner) await api.deleteServer(active.id); else await api.leaveServer(active.id); close(); useStore.getState().toast(owner ? 'Сервер удалён' : 'Ты покинул сервер', 'ok'); useStore.getState().exitServer(); }
    catch (e: any) { setErr(e.message); setBusy(false); }
  }
  const go = (m: Parameters<ReturnType<typeof useStore.getState>['setModal']>[0]) => useStore.getState().setModal(m);
  return <Backdrop onClose={close} label="Меню сервера" boxClass="box-menu">
    <div className="menu-head">
      <span className="sm-ic" style={{ background: active.iconUrl ? '#0000' : avColor(active.name, active.iconColor) }}>{active.iconUrl ? <img className="avimg" src={resolveUploadUrl(active.iconUrl)} alt="" /> : initials2(active.name)}</span>
      <span className="menu-head-txt"><b>{active.name}</b><i>{active.memberCount} {plural(active.memberCount, ['участник', 'участника', 'участников'])}{owner ? ' · ты владелец' : ''}</i></span>
    </div>
    {active.description ? <p className="menu-desc">{active.description}</p> : null}
    <button className="menu-item" onClick={() => go('invite')}><Icon name="link" sm />Пригласить людей</button>
    {canManage ? <button className="menu-item" onClick={() => go('srvsettings')}><Icon name="gear" sm />Настройки сервера</button> : null}
    {active.statsEnabled ? <button className="menu-item" onClick={() => go('leaderboard')}><Icon name="crown" sm />Лидеры недели</button> : null}
    <div className="menu-sep" />
    {confirming ? (
      <div className="danger-confirm" role="alert">
        <span className="danger-confirm-icon"><Icon name="warn" /></span>
        <div className="danger-confirm-copy"><b>{owner ? `Удалить «${active.name}»?` : `Покинуть «${active.name}»?`}</b><span>{owner ? 'Сервер, история и приглашения будут удалены без возможности восстановления.' : 'Чтобы вернуться, понадобится новое приглашение.'}</span></div>
        <div className="danger-confirm-actions">
          <button className="sm-act" disabled={busy} onClick={() => setConfirming(false)}>Отмена</button>
          <button className="sm-act danger" disabled={busy} onClick={leave}>{busy ? <span className="spin" /> : <Icon name="leave" sm />}{owner ? 'Удалить навсегда' : 'Покинуть'}</button>
        </div>
      </div>
    ) : (
      <button className="menu-item danger" onClick={() => setConfirming(true)}><Icon name="hangup" sm />{owner ? 'Удалить сервер' : 'Покинуть сервер'}</button>
    )}
    {err ? <div className="err" role="alert">{err}</div> : null}
  </Backdrop>;
}

function InviteModal() {
  const close = () => useStore.getState().setModal(null);
  const active = useStore((s) => s.active)!;
  const [link, setLink] = useState(''); const [expires, setExpires] = useState(0); const [busy, setBusy] = useState(false); const [left, setLeft] = useState('');
  async function gen() {
    setBusy(true);
    try { const d = await api.createInvite(active.id); setLink(webOrigin() + '/?invite=' + d.code); setExpires(d.expires); }
    catch (e: any) { useStore.getState().toast(e.message, 'err'); } finally { setBusy(false); }
  }
  useEffect(() => { gen(); /* eslint-disable-next-line */ }, [active.id]);
  useEffect(() => {
    if (!expires) return;
    const tick = () => { const ms = expires - Date.now(); if (ms <= 0) { setLeft('истекло'); return false; } const m = Math.floor(ms / 60000); const s = Math.floor((ms % 60000) / 1000); setLeft(`${m}:${String(s).padStart(2, '0')}`); return true; };
    tick(); const t = setInterval(() => { if (!tick()) clearInterval(t); }, 1000); return () => clearInterval(t);
  }, [expires]);
  const copy = (v: string) => { if (v) navigator.clipboard.writeText(v).then(() => useStore.getState().toast('Скопировано', 'ok')); };
  const expired = left === 'истекло';
  return <Backdrop onClose={close} label="Пригласить" boxClass="box-dialog">
    <h2>Пригласить</h2>
    <p className="msub">Ссылка в «{active.name}» — действует 30 минут, одноразовая.</p>
    <div className="invite-box">
      <input readOnly value={link || 'Создаю ссылку…'} aria-label="Ссылка приглашения" onFocus={(e) => e.currentTarget.select()} />
      <button aria-label="Копировать ссылку приглашения" disabled={!link || expired} onClick={() => copy(link)}><Icon name="link" sm />Копировать</button>
    </div>
    <div className="invite-meta">
      <span className={expired ? 'bad' : undefined}>{link ? (expired ? 'Ссылка истекла — создай новую' : `Действует ещё ${left}`) : ''}</span>
      <button type="button" className="invite-new" disabled={busy} onClick={gen}><Icon name="refresh" sm />Новая ссылка</button>
    </div>
  </Backdrop>;
}

// Пресеты цвета роли — средняя светлота: имя с цветом роли читается и в тёмной, и в светлой теме.
const DEFAULT_ROLE_COLORS = ['#5f8fbf', '#4f9a76', '#b08a3e', '#c06a55', '#b0688a', '#4f97a3', '#8a76bd', '#b87a4b'];

function ServerSettingsModal() {
  const close = () => useStore.getState().setModal(null);
  const active = useStore((s) => s.active)!;
  const members = useStore((s) => s.members);
  const perms = active.myPerms || 0;
  const owner = active.myRole === 'owner';
  const canServer = owner || hasPerm(perms, PERM.MANAGE_SERVER);
  const canRoles = owner || hasPerm(perms, PERM.MANAGE_ROLES);
  type T = 'profile' | 'roles' | 'members';
  const cats = ([
    { id: 'profile', label: 'Профиль', icon: 'edit', show: canServer },
    { id: 'roles', label: 'Роли', icon: 'shield', show: canRoles },
    { id: 'members', label: 'Участники', icon: 'users', show: canRoles },
  ] as { id: T; label: string; icon: string; show: boolean }[]).filter((c) => c.show);
  const [tab, setTab] = useState<T>(canServer ? 'profile' : 'roles');
  return <Backdrop onClose={close} label="Настройки сервера" boxClass="box-settings">
    <div className="settings">
      <nav className="settings-nav">
        <div className="settings-nav-h" title={active.name} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{active.name}</div>
        {cats.map((c) => (
          <button key={c.id} className={tab === c.id ? 'active' : ''} aria-current={tab === c.id ? 'page' : undefined} onClick={() => setTab(c.id)}><Icon name={c.icon} />{c.label}</button>
        ))}
      </nav>
      <div className="settings-main">
        <div className="settings-head">
          <h2>{tab === 'profile' ? 'Профиль сервера' : tab === 'roles' ? 'Роли' : `Участники · ${members.length}`}</h2>
          <button className="settings-x" onClick={close} aria-label="Закрыть"><Icon name="close" sm /></button>
        </div>
        <div className="settings-main-inner">
          {tab === 'profile' && canServer ? <ServerProfileTab active={active} /> : null}
          {tab === 'roles' && canRoles ? <RolesTab active={active} /> : null}
          {tab === 'members' && canRoles ? <RoleAssignTab active={active} members={members} /> : null}
        </div>
      </div>
    </div>
  </Backdrop>;
}

function ServerProfileTab({ active }: { active: import('../types').ServerDetail }) {
  const [name, setName] = useState(active.name); const [desc, setDesc] = useState(active.description || '');
  const [color, setColor] = useState(active.iconColor); const [iconUrl, setIconUrl] = useState(active.iconUrl || '');
  const [busy, setBusy] = useState(false); const [uploading, setUploading] = useState(false); const [err, setErr] = useState('');
  const [statsOn, setStatsOn] = useState(!!active.statsEnabled);
  const fileRef = useRef<HTMLInputElement>(null);
  async function pick(file: File) {
    if (!file.type.startsWith('image/')) { setErr('Только картинки'); return; }
    if (file.size > 10 * 1024 * 1024) { setErr('Больше 10 МБ'); return; }
    setUploading(true); setErr('');
    try { const blob = await cropSquare(file, 256); const { url } = await api.uploadImage(blob); setIconUrl(url); } catch (e: any) { setErr(e?.message || 'Ошибка'); } finally { setUploading(false); }
  }
  async function save() {
    setBusy(true); setErr('');
    try { await api.patchServer(active.id, { name: name.trim(), description: desc, iconColor: color, iconUrl, statsEnabled: statsOn }); await useStore.getState().refreshServer(); useStore.getState().refreshServers(); useStore.getState().toast('Сохранено', 'ok'); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }
  return <>
    <div className="fld" style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
      <div className="sm-ic lg" style={{ background: iconUrl ? '#0000' : avColor(name, color), cursor: 'pointer' }} onClick={() => fileRef.current?.click()}>{iconUrl ? <img className="avimg" src={resolveUploadUrl(iconUrl)} alt="" /> : initial(name)}{uploading ? <span className="spin" style={{ position: 'absolute', inset: 0, margin: 'auto' }} /> : null}</div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="ghost" style={{ margin: 0, padding: '6px 12px', fontSize: 13, width: 'auto' }} disabled={uploading} onClick={() => fileRef.current?.click()}>Обложка</button>
        {iconUrl ? <button className="ghost" style={{ margin: 0, padding: '6px 12px', fontSize: 13, width: 'auto', color: 'var(--red)' }} onClick={() => setIconUrl('')}>Убрать</button> : null}
      </div>
      <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; if (f) pick(f); e.target.value = ''; }} />
    </div>
    <div className="fld"><label>Название</label><input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} /></div>
    <div className="fld"><label>Описание</label><textarea value={desc} maxLength={300} rows={2} placeholder="о чём этот сервер" onChange={(e) => setDesc(e.target.value)} /></div>
    <div className="fld"><label>Цвет иконки{iconUrl ? ' (когда без обложки)' : ''}</label><div className="colorpick">{AV_COLORS.map((c, i) => <div key={i} className={'cp' + (i === color ? ' sel' : '')} style={{ background: c }} onClick={() => setColor(i)} />)}</div></div>
    <div className="set-list"><label className="perm-op">
      <input type="checkbox" checked={statsOn} onChange={(e) => setStatsOn(e.target.checked)} />
      <span><b>Рейтинг и уровни <em className="exp-badge">Эксперимент</em></b><i>Кнопка рейтинга в шапке участников: время в голосе и эфире, бесконечные уровни. Считается с момента включения.</i></span>
    </label></div>
    <div className="rowbtns"><span /><button className="primary" style={{ margin: 0 }} disabled={busy} onClick={save}>Сохранить</button></div>
    <div className="err">{err}</div>
  </>;
}

function RolesTab({ active }: { active: import('../types').ServerDetail }) {
  const [roles, setRoles] = useState<Role[]>(active.roles || []);
  const [name, setName] = useState(''); const [color, setColor] = useState(DEFAULT_ROLE_COLORS[0]); const [perms, setPerms] = useState(0);
  const [editing, setEditing] = useState<Role | null>(null); const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const reload = async () => { try { const d = await api.getRoles(active.id); setRoles(d.roles); await useStore.getState().refreshServer(); } catch { /**/ } };
  async function submit() {
    if (name.trim().length < 1) { setErr('Название роли'); return; }
    setBusy(true); setErr('');
    try {
      if (editing) await api.updateRole(active.id, editing.id, { name: name.trim(), color, permissions: perms });
      else await api.createRole(active.id, { name: name.trim(), color, permissions: perms });
      setName(''); setColor(DEFAULT_ROLE_COLORS[0]); setPerms(0); setEditing(null); await reload();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }
  function edit(r: Role) { setEditing(r); setName(r.name); setColor(r.color || DEFAULT_ROLE_COLORS[0]); setPerms(r.permissions); }
  async function del(r: Role) { if (!confirm(`Удалить роль «${r.name}»?`)) return; try { await api.deleteRole(active.id, r.id); await reload(); } catch (e: any) { setErr(e.message); } }
  const togglePerm = (flag: number) => setPerms((p) => (p & flag ? p & ~flag : p | flag));
  return <>
    <div className="role-list">
      {roles.length === 0 ? <div className="msub" style={{ padding: '4px 2px' }}>Ролей пока нет. Создай первую ниже.</div> : null}
      {roles.map((r) => <div key={r.id} className="role-row">
        <span className="role-dot" style={{ background: r.color || 'var(--muted)' }} />
        <span className="role-nm" style={{ color: r.color || 'var(--txt)' }}>{r.name}</span>
        <button className="mini" onClick={() => edit(r)}>Изменить</button>
        <button className="mini danger" onClick={() => del(r)}><Icon name="close" sm /></button>
      </div>)}
    </div>
    <div className="grp"><div className="gt">{editing ? 'Изменить роль' : 'Новая роль'}</div>
      <div className="fld" style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
        <div style={{ flex: 1 }}><label>Название</label><input value={name} maxLength={24} placeholder="напр. Модератор" onChange={(e) => setName(e.target.value)} /></div>
        <input type="color" className="role-color" value={color} onChange={(e) => setColor(e.target.value)} title="Цвет роли" />
      </div>
      <div className="fld"><label>Привилегии</label>
        <div className="perm-list">{PERM_LIST.map((p) => <label key={p.key} className={'perm-op' + (perms & PERM[p.key] ? ' on' : '')}><input type="checkbox" checked={!!(perms & PERM[p.key])} onChange={() => togglePerm(PERM[p.key])} /><span><b>{p.label}</b><i>{p.hint}</i></span></label>)}</div>
      </div>
      <div className="rowbtns">{editing ? <button className="ghost" style={{ margin: 0 }} onClick={() => { setEditing(null); setName(''); setColor(DEFAULT_ROLE_COLORS[0]); setPerms(0); }}>Отмена</button> : <span />}<button className="primary" style={{ margin: 0 }} disabled={busy} onClick={submit}>{editing ? 'Сохранить' : 'Создать роль'}</button></div>
      <div className="err">{err}</div>
    </div>
  </>;
}

function RoleAssignTab({ active, members }: { active: import('../types').ServerDetail; members: Member[] }) {
  const roles = active.roles || [];
  const [busy, setBusy] = useState('');
  async function toggle(m: Member, roleId: string) {
    const cur = new Set((m.roles || []).map((r) => r.id));
    if (cur.has(roleId)) cur.delete(roleId); else cur.add(roleId);
    setBusy(m.id);
    try { await api.setMemberRoles(active.id, m.id, [...cur]); await useStore.getState().refreshServer(); } catch (e: any) { useStore.getState().toast(e.message, 'err'); } finally { setBusy(''); }
  }
  if (roles.length === 0) return <div className="msub" style={{ padding: '4px 2px' }}>Сначала создай роли во вкладке «Роли».</div>;
  return <div className="assign-list">
    {members.map((m) => <div key={m.id} className="assign-row">
      <div className="assign-av" style={{ background: m.avatarUrl ? '#0000' : avColor(m.displayName, m.avatarColor) }}>{m.avatarUrl ? <img className="avimg" src={resolveUploadUrl(m.avatarUrl)} alt="" /> : initial(m.displayName)}</div>
      <div className="assign-main">
        <div className="assign-nm">{m.displayName}{m.role === 'owner' ? <span className="rl" title="Владелец"><Icon name="crown" sm /></span> : ''}{busy === m.id ? <span className="spin" style={{ width: 12, height: 12 }} /> : null}</div>
        <div className="assign-roles">{roles.map((r) => { const on = (m.roles || []).some((x) => x.id === r.id); return <button key={r.id} className={'role-chip' + (on ? ' on' : '')} style={on ? { background: r.color || 'var(--accent)', borderColor: r.color || 'var(--accent)' } : { borderColor: (r.color || 'var(--line-2)') + '88', color: r.color || 'var(--muted)' }} onClick={() => toggle(m, r.id)}>{r.name}</button>; })}</div>
      </div>
    </div>)}
  </div>;
}

const KEYBIND_LABELS: Record<KeybindAction, string> = { muteMic: 'Выключить микрофон', deafen: 'Выключить звук' };

const NOTIF_KINDS: { key: 'notifMention' | 'notifStream' | 'notifUpdate'; title: string; desc: string }[] = [
  { key: 'notifMention', title: 'Упоминания', desc: 'Когда вас тегнули или ответили в чате' },
  { key: 'notifStream', title: 'Трансляции', desc: 'Когда кто-то начал трансляцию' },
  { key: 'notifUpdate', title: 'Обновления', desc: 'Когда вышло новое обновление приложения' },
];

// Мини-окно назначения клавиши: до 3 клавиш одновременно, живой показ комбинации, сохранение
// только по «Применить». Слушатели повешены на capture-фазу window, чтобы: (1) успеть
// stopPropagation раньше bubble-фазового Escape-хендлера родительского Backdrop (иначе Escape
// закрыл бы разом и диалог захвата, и всё окно настроек), и (2) не дать событию дойти до
// глобального in-app хоткей-хендлера (App.tsx) — иначе запись комбинации сама триггерила бы мут.
function KeyCaptureDialog({ action, onClose }: { action: KeybindAction; onClose: () => void }) {
  const [captured, setCaptured] = useState<string[]>([]);
  const [warn, setWarn] = useState(false);
  useEffect(() => {
    const held = new Set<string>();
    const kd = (e: KeyboardEvent) => {
      e.preventDefault(); e.stopPropagation();
      if (e.repeat) return;
      if (e.code === 'Escape') { onClose(); return; }
      if (held.size >= 3) { setWarn(true); return; }
      held.add(e.code);
      setCaptured([...held]);
    };
    const ku = (e: KeyboardEvent) => { e.preventDefault(); e.stopPropagation(); held.delete(e.code); };
    window.addEventListener('keydown', kd, true); window.addEventListener('keyup', ku, true);
    return () => { window.removeEventListener('keydown', kd, true); window.removeEventListener('keyup', ku, true); };
  }, [onClose]);
  function apply() {
    if (!captured.length) return;
    const next = { ...getSettings().keybinds, [action]: captured };
    setSettings({ keybinds: next });
    if (isTauri) setGlobalHotkeys(next, !getSettings().disableGlobalHotkeys);
    onClose();
  }
  return <Backdrop onClose={onClose} label="Назначить клавишу">
    <h2><Icon name="keyboard" />{KEYBIND_LABELS[action]}</h2>
    <p className="msub">Нажми комбинацию клавиш (до 3 одновременно) — она отобразится ниже. Esc отменяет.</p>
    <div className="fld" style={{ textAlign: 'center', padding: '10px 0' }}>
      <span className="kbd" style={{ fontSize: 15, padding: '6px 14px' }}>{captured.length ? comboLabel(captured) : 'Нажимай клавиши…'}</span>
    </div>
    {warn ? <div className="err" style={{ textAlign: 'center' }}>Максимум 3 клавиши одновременно</div> : null}
    <div className="rowbtns"><button className="ghost" style={{ margin: 0 }} onClick={onClose}>Отмена</button><button className="primary" style={{ margin: 0 }} disabled={!captured.length} onClick={apply}>Применить</button></div>
  </Backdrop>;
}

// Карточка аккаунта внизу навигации настроек — отдельный компонент: читает store только при показе.
function SettingsMe() {
  const me = useStore((s) => s.me);
  if (!me) return null;
  return (
    <button type="button" className="settings-me" onClick={() => useStore.getState().setModal('profile')} aria-label="Открыть профиль">
      <span className="settings-me-av" style={{ background: me.avatarUrl ? 'transparent' : avColor(me.displayName, me.avatarColor) }}>
        {me.avatarUrl ? <img src={resolveUploadUrl(me.avatarUrl)} alt="" /> : initial(me.displayName)}
      </span>
      <span className="settings-me-txt"><b>{me.displayName}</b><i>@{me.username}</i></span>
    </button>
  );
}

function NotifStatus() {
  const perm = notifPermission();
  return (
    <div className={'set-status ' + perm}>
      <i />
      <span>{perm === 'granted' ? 'Разрешены в системе' : perm === 'denied' ? 'Запрещены в системе — включите их в настройках ОС или браузера' : 'Система ещё не спрашивала разрешение'}</span>
    </div>
  );
}

function SettingsModal() {
  const close = () => useStore.getState().setModal(null);
  const [, force] = useState(0); const rerender = () => force((n) => n + 1);
  const s = getSettings();
  const appleMobile = currentAppleMobilePlatform();
  const [inventory, setInventory] = useState(audioDeviceInventory.getSnapshot);
  const output = audioOutputChoices(appleMobile, inventory.inputs, inventory.outputs);
  // A saved iOS input route must remain visible when privacy filtering temporarily hides it.
  const outputViaInput = output.viaInput || (appleMobile && !output.choices.length && !!s.input && !s.output);
  const ins = withSelectedAudioDevice(audioDeviceChoices(inventory.inputs), s.input);
  const outs = withSelectedAudioDevice(output.choices, outputViaInput ? s.input : s.output);
  const [binding, setBinding] = useState(false);
  const [captureAction, setCaptureAction] = useState<KeybindAction | null>(null);
  useEffect(() => audioDeviceInventory.subscribe(setInventory), []);
  useEffect(() => subscribeSettings(rerender), []);
  useEffect(() => { if (!binding) return; const k = (e: KeyboardEvent) => { e.preventDefault(); setSettings({ pttKey: e.code }); setBinding(false); rerender(); }; window.addEventListener('keydown', k, { once: true }); return () => window.removeEventListener('keydown', k); }, [binding]);
  const E = getEngine();
  const upd = (patch: Partial<AudioSettings>, act?: () => void) => { setSettings(patch); act?.(); rerender(); };
  type Tab = 'voice' | 'notif' | 'appearance' | 'keys' | 'game';
  const [tab, setTab] = useState<Tab>('voice');
  const cats: { id: Tab; label: string; icon: string }[] = [
    { id: 'voice', label: 'Голос и звук', icon: 'mic-sm' },
    { id: 'notif', label: 'Уведомления', icon: 'bell' },
    { id: 'appearance', label: 'Оформление', icon: 'eye' },
    { id: 'keys', label: 'Клавиши', icon: 'hash' },
    ...(isTauri ? [{ id: 'game' as Tab, label: 'Игровой статус', icon: 'gamepad' }] : []),
  ];
  const toggleRow = (opts: { checked: boolean; disabled?: boolean; title: string; desc?: string; onChange: (on: boolean) => void }) => (
    <label className={'perm-op' + (opts.disabled ? ' off' : '')}>
      <input type="checkbox" disabled={opts.disabled} checked={opts.checked} onChange={(e) => opts.onChange(e.target.checked)} />
      <span><b>{opts.title}</b>{opts.desc ? <i>{opts.desc}</i> : null}</span>
    </label>
  );
  const NS_OPTS: { id: AudioSettings['nsMode']; title: string; desc: string }[] = [
    { id: 'off', title: 'Выключено', desc: 'Чистый сигнал' },
    { id: 'basic', title: 'Базовое', desc: 'Встроенное в браузер' },
    { id: 'rnnoise', title: appleMobile ? 'Системное' : 'Умное · RNNoise', desc: appleMobile ? 'Обработка iOS' : 'Рекомендуем · ~1% CPU' },
  ];
  return <Backdrop onClose={close} label="Настройки" boxClass="box-settings">
    <div className="settings">
      <nav className="settings-nav">
        <div className="settings-nav-h">Настройки</div>
        {cats.map((c) => (
          <button key={c.id} className={tab === c.id ? 'active' : ''} aria-current={tab === c.id ? 'page' : undefined} onClick={() => setTab(c.id)}>
            <Icon name={c.icon} />{c.label}
          </button>
        ))}
        <SettingsMe />
      </nav>
      <div className="settings-main">
        <div className="settings-head">
          <h2>{cats.find((c) => c.id === tab)?.label}</h2>
          <button className="settings-x" onClick={close} aria-label="Закрыть"><Icon name="close" sm /></button>
        </div>
        <div className="settings-main-inner">

          {tab === 'voice' && <>
            <section className="set-sec">
              <div className="set-label">Микрофон</div>
              <div className="set-devices">
                {!appleMobile ? (
                  <label className="set-select">
                    <Icon name="mic-sm" sm />
                    <select aria-label="Устройство ввода" value={s.input} onFocus={audioDeviceInventory.refresh} onPointerDown={audioDeviceInventory.refresh} onChange={(e) => upd({ input: e.target.value }, () => { void E?.reapplyMic(); E?.restartLevelMeter(); })}>
                      <option value="">Микрофон по умолчанию</option>{ins.map((d) => <option key={d.id} value={d.id} disabled={d.unavailable}>{d.label}</option>)}
                    </select>
                    <Icon name="chevron" sm />
                  </label>
                ) : null}
                <label className="set-select">
                  <Icon name="head" sm />
                  <select aria-label={outputViaInput ? 'Маршрут звука' : 'Устройство вывода'} value={outputViaInput ? s.input : s.output} onFocus={audioDeviceInventory.refresh} onPointerDown={audioDeviceInventory.refresh} onChange={(e) => {
                    const id = e.target.value;
                    if (outputViaInput) {
                      upd({ input: id, output: '' }, () => { void E?.reapplyMic('route').then(() => E.applyOutput()); E?.restartLevelMeter(); });
                    } else upd({ output: id }, () => { void E?.applyOutput(); });
                  }}>
                    <option value="">{outputViaInput ? 'Маршрут: автоматически' : 'Вывод по умолчанию'}</option>
                    {outs.map((d) => <option key={d.id} value={d.id} disabled={d.unavailable}>{d.label}</option>)}
                  </select>
                  <Icon name="chevron" sm />
                </label>
              </div>
              {appleMobile ? <div className="mm-hint">На iPhone и iPad микрофон выбирается системой вместе с маршрутом звука.</div> : null}
              <MicMeter />
            </section>

            <section className="set-sec">
              <div className="set-label">Как включается микрофон</div>
              <div className="seg" role="radiogroup" aria-label="Режим передачи">
                <button role="radio" aria-checked={s.mode === 'voice'} className={s.mode === 'voice' ? 'active' : ''} onClick={() => upd({ mode: 'voice' }, () => E?.onModeChanged())}>Голосом</button>
                <button role="radio" aria-checked={s.mode === 'ptt'} className={s.mode === 'ptt' ? 'active' : ''} onClick={() => upd({ mode: 'ptt' }, () => E?.onModeChanged())}>По кнопке</button>
              </div>
              {s.mode === 'ptt' ? <div className="ptt-hint">Удерживай <span className="kbd">{keyLabel(s.pttKey)}</span><button type="button" className="ptt-bind" onClick={() => setBinding(true)}>{binding ? 'Нажми клавишу…' : 'Сменить'}</button></div> : null}
            </section>

            <section className="set-sec">
              <div className="set-label">Шумоподавление <span>клавиатура, вентилятор, улица</span></div>
              <div className="ns-opts" role="radiogroup" aria-label="Шумоподавление">
                {NS_OPTS.map((o) => (
                  <button key={o.id} type="button" role="radio" aria-checked={s.nsMode === o.id} className={'ns-op' + (s.nsMode === o.id ? ' active' : '')}
                    onClick={() => upd({ nsMode: o.id }, () => { E?.reapplyMic(); E?.restartLevelMeter(); })}>
                    <b>{o.title}</b><span>{o.desc}</span>
                  </button>
                ))}
              </div>
              {appleMobile ? <div className="mm-hint">На iPhone и iPad голос передаётся напрямую. Включённый шумодав использует системную обработку, чтобы отправка не зависела от Web Audio.</div> : null}
            </section>

            <section className="set-sliders">
              <div className="set-slider">
                <div className="set-slider-h"><span>Громкость собеседников</span><b>{s.master}%</b></div>
                <input type="range" min={0} max={100} value={s.master} aria-label="Общая громкость" style={{ '--val': s.master + '%' } as CSSProperties} onChange={(e) => upd({ master: +e.target.value }, () => E?.applyMaster())} />
              </div>
              <div className="set-slider">
                <div className="set-slider-h"><span>Громкость уведомлений</span><b>{s.notifyVolume}%</b></div>
                <input type="range" min={0} max={100} value={s.notifyVolume} aria-label="Громкость уведомлений" style={{ '--val': s.notifyVolume + '%' } as CSSProperties} onChange={(e) => upd({ notifyVolume: +e.target.value })} onMouseUp={() => playSound('system')} />
              </div>
            </section>
          </>}

          {tab === 'notif' && <>
            {!notifSupported() ? (
              <div className="set-note">Системные уведомления не поддерживаются на этом устройстве.</div>
            ) : <>
              <div className="set-list">
                {toggleRow({
                  checked: s.notif, title: 'Системные уведомления',
                  desc: 'Упоминания — когда окно не в фокусе; трансляции и обновления — всегда',
                  onChange: async (on) => {
                    if (on) {
                      localStorage.removeItem('notifOptOut'); // снова хотим уведомления
                      const ok = await enableNotifications();
                      if (!ok) useStore.getState().toast(notifPermission() === 'denied'
                        ? 'Разрешение заблокировано — включите уведомления для приложения в настройках ОС/браузера'
                        : 'Система не выдала разрешение на уведомления', 'err');
                    } else {
                      localStorage.setItem('notifOptOut', '1'); // явный опт-аут: не переспрашиваем при запуске
                      setSettings({ notif: false });
                      unsubscribePush(); // снимаем фоновую web-push подписку
                    }
                    rerender();
                  },
                })}
                {NOTIF_KINDS.map((o) => <div key={o.key} className="set-list-item">{toggleRow({
                  checked: s[o.key], disabled: !s.notif, title: o.title, desc: o.desc,
                  onChange: (on) => { upd({ [o.key]: on } as Partial<AudioSettings>); syncPushPrefs(); },
                })}</div>)}
              </div>
              <section className="set-sec">
                <div className="set-label">Содержимое уведомлений <span>что видно на заблокированном экране</span></div>
                <div className="seg" role="radiogroup" aria-label="Содержимое уведомлений">
                  {([['full', 'Отправитель и текст'], ['sender', 'Только отправитель'], ['hidden', 'Скрыть']] as const).map(([id, label]) => (
                    <button key={id} role="radio" aria-checked={s.notifPrivacy === id} disabled={!s.notif} className={s.notifPrivacy === id ? 'active' : ''} onClick={() => upd({ notifPrivacy: id })}>{label}</button>
                  ))}
                </div>
              </section>
              <NotifStatus />
            </>}
          </>}

          {tab === 'appearance' && <>
            <section className="set-sec">
              <div className="set-label">Тема</div>
              <div className="theme-modes" role="radiogroup" aria-label="Тема">
                {THEME_MODES.map((m) => {
                  const on = getThemeMode() === m.id;
                  return (
                    <button type="button" role="radio" aria-checked={on} key={m.id} className={'theme-mode' + (on ? ' active' : '')} onClick={() => { setThemeMode(m.id); rerender(); }}>
                      <span className={'theme-prev ' + m.id} aria-hidden="true"><i /><i /><i /></span>
                      <span className="theme-nm"><span className="theme-radio" aria-hidden="true" />{m.name}</span>
                    </button>
                  );
                })}
              </div>
            </section>
            <section className="set-sec">
              <div className="set-label">Акцент</div>
              <div className="accent-row" role="radiogroup" aria-label="Акцент">
                {ACCENTS.map((a) => {
                  const on = getAccent() === a.id;
                  return (
                    <button type="button" role="radio" aria-checked={on} key={a.id} className={'accent-op' + (on ? ' active' : '')} onClick={() => { setAccent(a.id); rerender(); }}>
                      <i style={{ background: a.swatch }} />{a.name}
                    </button>
                  );
                })}
              </div>
            </section>
          </>}

          {tab === 'keys' && <>
            <section className="set-sec">
              <div className="set-label">Голос</div>
              <div className="set-list keys">
                {(Object.keys(KEYBIND_LABELS) as KeybindAction[]).map((action) => {
                  const combo = s.keybinds[action];
                  const label = comboLabel(combo);
                  return (
                    <div key={action} className="key-row">
                      <span>{KEYBIND_LABELS[action]}</span>
                      <button type="button" className="key-bind" onClick={() => setCaptureAction(action)} aria-label={`Назначить: ${KEYBIND_LABELS[action]}`}>
                        {combo && combo.length ? label.split('+').map((k, i) => <kbd key={i}>{k.trim()}</kbd>) : <em>Назначить</em>}
                      </button>
                    </div>
                  );
                })}
              </div>
            </section>
            {isTauri ? <div className="set-list">{toggleRow({
              checked: !s.disableGlobalHotkeys, title: 'Работают поверх игры',
              desc: 'Сочетания срабатывают, когда окно Рилэя не в фокусе',
              onChange: (on) => upd({ disableGlobalHotkeys: !on }, () => setGlobalHotkeys(getSettings().keybinds, on)),
            })}</div> : null}
            <section className="set-sec">
              <div className="set-label">Навигация · не меняются</div>
              <div className="key-static">
                {SHORTCUTS.map(([combo, label]) => <div key={combo} className="key-row"><span>{label}</span><code>{combo}</code></div>)}
              </div>
            </section>
          </>}

          {tab === 'game' && isTauri && <>
            <div className="set-list">{toggleRow({
              checked: s.shareGame, title: 'Показывать, во что играю',
              desc: 'Название и иконка игры под твоим именем',
              onChange: (on) => upd({ shareGame: on }),
            })}</div>
            <p className="set-foot">Учитывается полноэкранная игра на переднем плане или распознанная Windows. Читается только имя окна и иконка — память игры не читается, с античитами конфликтов нет.</p>
          </>}

        </div>
      </div>
    </div>
    {captureAction ? <KeyCaptureDialog action={captureAction} onClose={() => { setCaptureAction(null); rerender(); }} /> : null}
  </Backdrop>;
}

// Предупреждение при переходе на ДРУГОЙ сервер, пока подключён к текущему.
function SwitchServerModal() {
  const servers = useStore((s) => s.servers);
  const fromId = useStore((s) => s.viewServerId);
  const targetId = useStore((s) => s.pendingSwitchId);
  const from = servers.find((x) => x.id === fromId);
  const target = servers.find((x) => x.id === targetId);
  const cancel = () => useStore.setState({ modal: null, pendingSwitchId: null });
  const confirm = () => useStore.getState().confirmSwitchServer();
  const ic = (x: typeof from) => <span className="ssr-ic" style={{ background: x ? avColor(x.name, x.iconColor) : 'var(--panel3)' }}>{x ? initials2(x.name) : '—'}</span>;
  return <Backdrop onClose={cancel} label="Переключение сервера" boxClass="box-dialog">
    <div className="switch-srv-row" aria-hidden="true">{ic(from)}<i />{ic(target)}</div>
    <h2>{target ? `Перейти в «${target.name}»?` : 'Перейти на другой сервер?'}</h2>
    <p className="msub">Ты выйдешь из «{from?.name}»: голос, трансляции и чат этого сервера отключатся.</p>
    <div className="rowbtns"><button className="ghost" onClick={cancel}>Остаться</button><button className="primary" onClick={confirm}>Перейти</button></div>
  </Backdrop>;
}

export function Modals() {
  const modal = useStore((s) => s.modal);
  switch (modal) {
    case 'create': return <CreateModal />;
    case 'join': return <JoinModal />;
    case 'profile': return <ProfileModal />;
    case 'srvmenu': return <ServerMenuModal />;
    case 'invite': return <InviteModal />;
    case 'srvsettings': return <ServerSettingsModal />;
    case 'settings': return <SettingsModal />;
    case 'broadcast': return <BroadcastModal />;
    case 'switchServer': return <SwitchServerModal />;
    case 'downloads': return <DownloadsModal />;
    case 'leaderboard': return <LeaderboardModal />;
    case 'releaseHistory': return <ReleaseHistoryModal />;
    default: return null;
  }
}
