import { useEffect, useRef, useState } from 'react';
import { Room } from 'livekit-client';
import { api, resolveUploadUrl, webOrigin } from '../api';
import { useStore, getEngine } from '../store';
import { getSettings, setSettings } from '../settings';
import { THEMES, getTheme, setTheme } from '../theme';
import { playSound } from '../sounds';
import { Icon } from '../Icon';
import { MicMeter } from './MicMeter';
import { AV_COLORS, avColor, downscaleImage, initial, keyLabel, comboLabel } from '../util';
import type { AudioSettings, InvitePreview, Role, Member, KeybindAction } from '../types';
import { PERM, PERM_LIST, hasPerm } from '../types';
import { Backdrop } from './Backdrop';
import { BroadcastModal } from './BroadcastModal';
import { DownloadsModal } from './DownloadsModal';
import { LeaderboardModal } from './Leaderboard';
import { GiphyPicker, ProfileBannerAttribution, ProfileBannerMedia } from './ProfileBanner';
import { isTauri, setGlobalHotkeys } from '../native';
import { enableNotifications, notifSupported, notifPermission } from '../notify';
import { unsubscribePush, syncPushPrefs } from '../push';

function CreateModal() {
  const close = () => useStore.getState().setModal(null);
  const [name, setName] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  async function create() {
    if (name.trim().length < 2) { setErr('Название минимум 2 символа'); return; }
    setBusy(true);
    try { const d = await api.createServer(name.trim()); close(); await useStore.getState().loadMe(); await useStore.getState().openServer(d.server.id, undefined, 'channels'); useStore.getState().toast('Сервер создан', 'ok'); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }
  return <Backdrop onClose={close} label="Создать сервер">
    <h2><Icon name="plus" />Создать сервер</h2>
    <p className="msub">Сервер приватный — попасть можно только по приглашению. Пригласишь друзей ссылкой из меню сервера.</p>
    <div className="fld"><label>Название</label><input autoFocus value={name} maxLength={40} placeholder="Например: Наша тусовка" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && create()} /></div>
    <div className="rowbtns"><button className="ghost" style={{ margin: 0 }} onClick={close}>Отмена</button><button className="primary" style={{ margin: 0 }} disabled={busy} onClick={create}>Создать</button></div>
    <div className="err">{err}</div>
  </Backdrop>;
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
  return <Backdrop onClose={close} label="Присоединиться">
    <h2><Icon name="link" />Присоединиться</h2>
    <p className="msub">Вставь код приглашения или полную ссылку. Ссылка действует 30 минут.</p>
    <div className="fld"><label>Код или ссылка</label><input autoFocus value={code} placeholder="напр. aBc123 или https://.../?invite=..." onChange={(e) => onCode(e.target.value)} /></div>
    {preview ? <div style={{ background: 'var(--bg2)', border: '1px solid var(--line-2)', borderRadius: 'var(--r-md)', padding: 12, marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ width: 40, height: 40, borderRadius: 12, background: avColor(preview.server.name, preview.server.iconColor), display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, color: '#fff' }}>{initial(preview.server.name)}</div>
        <div><b style={{ color: 'var(--txt-h)' }}>{preview.server.name}</b><div style={{ fontSize: 12.5, color: 'var(--muted)' }}>{preview.server.memberCount} участник(ов)</div></div>
      </div>
    </div> : null}
    <div className="rowbtns"><button className="ghost" style={{ margin: 0 }} onClick={close}>Отмена</button><button className="primary" style={{ margin: 0 }} disabled={busy} onClick={join}>Войти</button></div>
    <div className="err">{err}</div>
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

function ProfileModal() {
  const me = useStore((s) => s.me)!;
  const [dn, setDn] = useState(me.displayName); const [bio, setBio] = useState(me.bio || ''); const [color, setColor] = useState(me.avatarColor);
  const [avatarUrl, setAvatarUrl] = useState(me.avatarUrl || '');
  const [bannerUrl, setBannerUrl] = useState(me.profileBannerUrl || '');
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false); const [uploading, setUploading] = useState(false);
  const [bannerUploading, setBannerUploading] = useState(false); const [giphyOpen, setGiphyOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const bannerRef = useRef<HTMLInputElement>(null);
  const giphyTriggerRef = useRef<HTMLButtonElement>(null);
  const bannerAbortRef = useRef<AbortController | null>(null);
  const bannerUploadSeq = useRef(0);
  const pendingGiphySendRef = useRef('');
  const pendingLocalBannerRef = useRef('');
  const cleanupPendingLocalBanner = (preserve = '') => {
    const url = pendingLocalBannerRef.current;
    if (!url || url === preserve) return;
    pendingLocalBannerRef.current = '';
    api.deleteProfileBannerUpload(url).catch(() => {});
  };
  const close = () => {
    bannerUploadSeq.current += 1;
    bannerAbortRef.current?.abort();
    cleanupPendingLocalBanner();
    useStore.getState().setModal(null);
  };
  const closeGiphy = () => {
    setGiphyOpen(false);
    window.requestAnimationFrame(() => giphyTriggerRef.current?.focus());
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
  async function pickAvatar(file: File) {
    if (!file.type.startsWith('image/')) { setErr('Можно только картинки'); return; }
    if (file.size > 10 * 1024 * 1024) { setErr('Картинка больше 10 МБ'); return; }
    setUploading(true); setErr('');
    try { const blob = await cropSquare(file, 256); const { url } = await api.uploadImage(blob); setAvatarUrl(url); }
    catch (e: any) { setErr(e?.message || 'Ошибка загрузки'); }
    finally { setUploading(false); }
  }
  async function save() {
    setBusy(true);
    try {
      const d = await api.updateMe({ displayName: dn.trim(), bio, avatarColor: color, avatarUrl, profileBannerUrl: bannerUrl });
      if (bannerUrl.startsWith('giphy:') && pendingGiphySendRef.current) {
        fetch(pendingGiphySendRef.current, { mode: 'no-cors', keepalive: true }).catch(() => {});
        pendingGiphySendRef.current = '';
      }
      if (pendingLocalBannerRef.current === bannerUrl) pendingLocalBannerRef.current = '';
      useStore.getState().setMe(d.user); useStore.getState().refreshMembers(); useStore.getState().refreshServers(); close(); useStore.getState().toast('Профиль сохранён', 'ok');
    }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }
  async function pickBanner(file: File) {
    const allowed = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
    if (!allowed.has(file.type)) { setErr('Фон: PNG, JPEG, WebP или GIF'); return; }
    if (file.size > 10 * 1024 * 1024) { setErr('Фон больше 10 МБ'); return; }
    bannerAbortRef.current?.abort();
    const sequence = ++bannerUploadSeq.current;
    const controller = new AbortController();
    bannerAbortRef.current = controller;
    setBannerUploading(true); setErr(''); setGiphyOpen(false);
    try {
      const prepared = file.type === 'image/gif' ? file : await downscaleImage(file, 1600, .84);
      if (controller.signal.aborted || sequence !== bannerUploadSeq.current) return;
      const { url } = await api.uploadProfileBanner(prepared, controller.signal);
      if (controller.signal.aborted || sequence !== bannerUploadSeq.current) {
        api.deleteProfileBannerUpload(url).catch(() => {});
        return;
      }
      cleanupPendingLocalBanner(url);
      pendingLocalBannerRef.current = url;
      pendingGiphySendRef.current = '';
      setBannerUrl(url);
    } catch (e: any) {
      if (sequence === bannerUploadSeq.current && e?.name !== 'AbortError') setErr(e?.message || 'Ошибка загрузки фона');
    } finally {
      if (sequence === bannerUploadSeq.current) { bannerAbortRef.current = null; setBannerUploading(false); }
    }
  }
  return <Backdrop onClose={close} label="Профиль" boxClass="profile-modal">
    <button className="settings-x" onClick={close} aria-label="Закрыть"><Icon name="close" /></button>
    <div className={'pm-hero' + (bannerUrl ? ' has-banner' : '')}>
      <ProfileBannerMedia value={bannerUrl} className="pm-hero-banner" attribution={false} />
      <ProfileBannerAttribution value={bannerUrl} className="pm-banner-credit" />
      <div className="pm-banner-actions" aria-label="Фон профиля">
        <button type="button" disabled={bannerUploading || busy} aria-label="Загрузить фон профиля" data-tip="Загрузить картинку или GIF" onClick={() => bannerRef.current?.click()}>{bannerUploading ? <span className="spin" /> : <Icon name="image" sm />}<span>Фон</span></button>
        <button ref={giphyTriggerRef} type="button" disabled={bannerUploading || busy} className={giphyOpen ? 'on' : ''} aria-expanded={giphyOpen} aria-label="Выбрать фон из GIPHY" data-tip="Выбрать GIF из GIPHY" onClick={() => giphyOpen ? closeGiphy() : setGiphyOpen(true)}><span aria-hidden="true">GIF</span></button>
        {bannerUrl ? <button type="button" disabled={bannerUploading || busy} className="danger" aria-label="Убрать фон профиля" data-tip="Убрать фон" onClick={() => { cancelBannerUpload(); cleanupPendingLocalBanner(); pendingGiphySendRef.current = ''; setGiphyOpen(false); setBannerUrl(''); }}><Icon name="close" sm /></button> : null}
      </div>
      <button type="button" className="pm-av" onClick={() => fileRef.current?.click()} aria-label="Загрузить аватар" title="Загрузить аватар" style={{ background: avatarUrl ? '#0000' : avColor(dn, color) }}>
        {avatarUrl ? <img className="avimg" src={resolveUploadUrl(avatarUrl)} alt="" /> : initial(dn)}
        {uploading ? <span className="spin" style={{ position: 'absolute', inset: 0, margin: 'auto' }} /> : <span className="pm-av-edit"><Icon name="edit" sm /></span>}
      </button>
      <div className="pm-id">
        <div className="pm-nm">{dn.trim() || 'Без имени'}</div>
        <div className="pm-un">@{me.username}</div>
      </div>
    </div>
    <div className="pm-body">
      <div className="pm-avbtns">
        <button className="ghost" style={{ margin: 0, padding: '7px 14px', fontSize: 13, width: 'auto' }} disabled={uploading} onClick={() => fileRef.current?.click()}>{uploading ? 'Загрузка…' : 'Загрузить фото'}</button>
        {avatarUrl ? <button className="ghost" style={{ margin: 0, padding: '7px 14px', fontSize: 13, width: 'auto', color: 'var(--red)' }} onClick={() => setAvatarUrl('')}>Убрать</button> : null}
      </div>
      <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; if (f) pickAvatar(f); e.target.value = ''; }} />
      <input ref={bannerRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; if (f) pickBanner(f); e.target.value = ''; }} />
      {giphyOpen ? <GiphyPicker onClose={closeGiphy} onSelect={(value, sendAnalyticsUrl) => { cancelBannerUpload(); cleanupPendingLocalBanner(); pendingGiphySendRef.current = sendAnalyticsUrl || ''; setBannerUrl(value); closeGiphy(); }} /> : null}
      <div className="fld"><label>Отображаемое имя</label><input value={dn} maxLength={32} onChange={(e) => setDn(e.target.value)} /></div>
      <div className="fld"><label>О себе</label><textarea value={bio} maxLength={200} rows={2} placeholder="пара слов о себе" onChange={(e) => setBio(e.target.value)} /></div>
      <div className="fld"><label>Цвет аватара{avatarUrl ? ' (когда без фото)' : ''}</label><div className="colorpick">{AV_COLORS.map((c, i) => <button type="button" key={i} className={'cp' + (i === color ? ' sel' : '')} style={{ background: c }} aria-label={`Цвет аватара ${i + 1}`} aria-pressed={i === color} onClick={() => setColor(i)} />)}</div></div>
      <div className="err">{err}</div>
      <div className="pm-foot">
        <button className="ghost pm-logout" style={{ margin: 0 }} onClick={() => { cleanupPendingLocalBanner(); useStore.getState().logout(); }}><Icon name="leave" sm />Выйти</button>
        <button className="primary" style={{ margin: 0 }} disabled={busy || uploading || bannerUploading} onClick={save}>Сохранить</button>
      </div>
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
  return <Backdrop onClose={close} label="Сервер">
    <div className="srv-menu-head">
      <div className="sm-ic" style={{ background: active.iconUrl ? '#0000' : avColor(active.name, active.iconColor) }}>{active.iconUrl ? <img className="avimg" src={resolveUploadUrl(active.iconUrl)} alt="" /> : initial(active.name)}</div>
      <div><h2 style={{ margin: 0 }}>{active.name}</h2><p className="msub" style={{ margin: '2px 0 0' }}>{active.memberCount} участник(ов){owner ? ' · ты владелец' : ''}</p></div>
    </div>
    {active.description ? <p className="msub" style={{ marginTop: 4 }}>{active.description}</p> : null}
    <div className="rowbtns">
      <button className="sm-act" onClick={() => useStore.getState().setModal('invite')}><Icon name="link" sm />Пригласить</button>
      {canManage ? <button className="sm-act accent" onClick={() => useStore.getState().setModal('srvsettings')}><Icon name="gear" sm />Настройки сервера</button> : null}
    </div>
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
      <div className="rowbtns">
        <button className="sm-act" onClick={close}>Закрыть</button>
        <button className="sm-act danger" onClick={() => setConfirming(true)}><Icon name="leave" sm />{owner ? 'Удалить сервер' : 'Покинуть сервер'}</button>
      </div>
    )}
    <div className="err">{err}</div>
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
  return <Backdrop onClose={close} label="Пригласить">
    <h2><Icon name="link" />Пригласить друзей</h2>
    <p className="msub">Ссылка одноразово живёт 30 минут. Просрочилась — жми «Новая ссылка».</p>
    <div className="invite-box"><input readOnly value={link} /><button aria-label="Копировать ссылку приглашения" data-tip="Копировать" disabled={!link || expired} onClick={() => copy(link)}>📋</button></div>
    <div style={{ fontSize: 12.5, color: expired ? 'var(--red)' : 'var(--muted)', margin: '8px 2px 0' }}>{link ? (expired ? 'Ссылка истекла — создай новую' : `Действует ещё: ${left}`) : 'Создаю ссылку…'}</div>
    <button className="ghost" style={{ marginTop: 12 }} disabled={busy} onClick={gen}><Icon name="refresh" sm />Новая ссылка</button>
    <button className="close" onClick={close}>Готово</button>
  </Backdrop>;
}

const DEFAULT_ROLE_COLORS = ['#5865f2', '#23a559', '#f0b232', '#f23f43', '#eb459e', '#3b9dff', '#9b59b6', '#e67e22'];

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
          <button key={c.id} className={tab === c.id ? 'active' : ''} onClick={() => setTab(c.id)}><Icon name={c.icon} />{c.label}</button>
        ))}
      </nav>
      <div className="settings-main">
        <button className="settings-x" onClick={close} aria-label="Закрыть"><Icon name="close" /></button>
        <div className="settings-main-inner">
          {tab === 'profile' && canServer ? <><h2><Icon name="edit" />Профиль сервера</h2><ServerProfileTab active={active} /></> : null}
          {tab === 'roles' && canRoles ? <><h2><Icon name="shield" />Роли</h2><RolesTab active={active} /></> : null}
          {tab === 'members' && canRoles ? <><h2><Icon name="users" />Участники</h2><RoleAssignTab active={active} members={members} /></> : null}
        </div>
      </div>
    </div>
  </Backdrop>;
}

function ServerProfileTab({ active }: { active: import('../types').ServerDetail }) {
  const [name, setName] = useState(active.name); const [desc, setDesc] = useState(active.description || '');
  const [color, setColor] = useState(active.iconColor); const [iconUrl, setIconUrl] = useState(active.iconUrl || '');
  const [busy, setBusy] = useState(false); const [uploading, setUploading] = useState(false); const [err, setErr] = useState('');
  const [music, setMusic] = useState(!!active.musicEnabled);
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
    try { await api.patchServer(active.id, { name: name.trim(), description: desc, iconColor: color, iconUrl, musicEnabled: music, statsEnabled: statsOn }); await useStore.getState().refreshServer(); useStore.getState().refreshServers(); useStore.getState().toast('Сохранено', 'ok'); }
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
    <div className="fld"><label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}>
      <input type="checkbox" checked={music} onChange={(e) => setMusic(e.target.checked)} style={{ marginTop: 3, width: 16, height: 16, accentColor: 'var(--accent)', flex: '0 0 auto' }} />
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}><b style={{ fontSize: 13.5, color: 'var(--txt-h)' }}>Совместное прослушивание (YouTube)</b><span style={{ fontSize: 12, color: 'var(--muted)' }}>Мини-плеер в голосовом канале: общая очередь, синхронно у всех. По умолчанию выключено.</span></span>
    </label></div>
    <div className="fld"><label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}>
      <input type="checkbox" checked={statsOn} onChange={(e) => setStatsOn(e.target.checked)} style={{ marginTop: 3, width: 16, height: 16, accentColor: 'var(--accent)', flex: '0 0 auto' }} />
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}><b style={{ fontSize: 13.5, color: 'var(--txt-h)' }}>Рейтинг и уровни <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--accent)', border: '1px solid color-mix(in srgb,var(--accent) 45%,transparent)', borderRadius: 5, padding: '0 5px', marginLeft: 4 }}>ЭКСПЕРИМЕНТ</span></b><span style={{ fontSize: 12, color: 'var(--muted)' }}>Кнопка 🏆 в шапке канала: рейтинг по времени в голосовом и эфире + бесконечные уровни. Считается с момента включения. По умолчанию выключено.</span></span>
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
        <div className="assign-nm">{m.displayName}{m.role === 'owner' ? <span className="rl">👑</span> : ''}{busy === m.id ? <span className="spin" style={{ width: 12, height: 12 }} /> : null}</div>
        <div className="assign-roles">{roles.map((r) => { const on = (m.roles || []).some((x) => x.id === r.id); return <button key={r.id} className={'role-chip' + (on ? ' on' : '')} style={on ? { background: r.color || 'var(--accent)', borderColor: r.color || 'var(--accent)' } : { borderColor: (r.color || 'var(--line-2)') + '88', color: r.color || 'var(--muted)' }} onClick={() => toggle(m, r.id)}>{r.name}</button>; })}</div>
      </div>
    </div>)}
  </div>;
}

const KEYBIND_LABELS: Record<KeybindAction, string> = { muteMic: 'Заглушить микрофон', deafen: 'Заглушить звук' };

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

function SettingsModal() {
  const close = () => useStore.getState().setModal(null);
  const [, force] = useState(0); const rerender = () => force((n) => n + 1);
  const s = getSettings();
  const [ins, setIns] = useState<MediaDeviceInfo[]>([]); const [outs, setOuts] = useState<MediaDeviceInfo[]>([]);
  const [binding, setBinding] = useState(false);
  const [captureAction, setCaptureAction] = useState<KeybindAction | null>(null);
  useEffect(() => { Room.getLocalDevices('audioinput').then(setIns).catch(() => {}); Room.getLocalDevices('audiooutput').then(setOuts).catch(() => {}); }, []);
  useEffect(() => { if (!binding) return; const k = (e: KeyboardEvent) => { e.preventDefault(); setSettings({ pttKey: e.code }); setBinding(false); rerender(); }; window.addEventListener('keydown', k, { once: true }); return () => window.removeEventListener('keydown', k); }, [binding]);
  const E = getEngine();
  const upd = (patch: Partial<AudioSettings>, act?: () => void) => { setSettings(patch); act?.(); rerender(); };
  type Tab = 'voice' | 'notif' | 'appearance' | 'keys' | 'game';
  const [tab, setTab] = useState<Tab>('voice');
  const cats: { id: Tab; label: string; icon: string }[] = [
    { id: 'voice', label: 'Голос и звук', icon: 'mic-sm' },
    { id: 'notif', label: 'Уведомления', icon: 'bell' },
    { id: 'appearance', label: 'Оформление', icon: 'palette' },
    { id: 'keys', label: 'Клавиши', icon: 'keyboard' },
    ...(isTauri ? [{ id: 'game' as Tab, label: 'Игровой статус', icon: 'cam' }] : []),
  ];
  return <Backdrop onClose={close} label="Настройки" boxClass="box-settings">
    <div className="settings">
      <nav className="settings-nav">
        <div className="settings-nav-h">Настройки</div>
        {cats.map((c) => (
          <button key={c.id} className={tab === c.id ? 'active' : ''} onClick={() => setTab(c.id)}>
            <Icon name={c.icon} />{c.label}
          </button>
        ))}
      </nav>
      <div className="settings-main">
        <button className="settings-x" onClick={close} aria-label="Закрыть"><Icon name="close" /></button>
        <div className="settings-main-inner">

          {tab === 'voice' && <>
            <h2><Icon name="mic-sm" />Голос и звук</h2>
            <div className="grp">
              <div className="gt">Микрофон</div>
              <div className="fld"><label>Устройство ввода</label><select value={s.input} onChange={(e) => upd({ input: e.target.value }, () => E?.reapplyMic())}><option value="">По умолчанию</option>{ins.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || d.deviceId}</option>)}</select></div>
              <div className="fld" style={{ marginTop: 10 }}><label>Шумоподавление</label>
                <select value={s.nsMode} onChange={(e) => upd({ nsMode: e.target.value as AudioSettings['nsMode'] }, () => { E?.reapplyMic(); E?.restartLevelMeter(); })}>
                  <option value="rnnoise">RNNoise (нейросеть)</option>
                  <option value="basic">Базовый (браузер)</option>
                  <option value="off">Нет</option>
                </select>
                <div className="mm-hint">RNNoise — нейросеть, режет фоновый гул (кулеры, гудение); Базовый — встроенный шумодав браузера; Нет — без обработки.</div>
              </div>
              <MicMeter />
              <div className="fld" style={{ marginTop: 10 }}><label>Режим передачи</label>
                <div className="seg"><button className={s.mode === 'voice' ? 'active' : ''} onClick={() => upd({ mode: 'voice' }, () => E?.onModeChanged())}>Активация голосом</button><button className={s.mode === 'ptt' ? 'active' : ''} onClick={() => upd({ mode: 'ptt' }, () => E?.onModeChanged())}>Push-to-Talk</button></div>
                {s.mode === 'ptt' ? <div className="ptt-hint">Удерживай <span className="kbd">{keyLabel(s.pttKey)}</span> · <button style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => setBinding(true)}>{binding ? 'Нажми клавишу...' : 'Сменить'}</button></div> : null}
              </div>
            </div>
            <div className="grp"><div className="gt">Звук</div>
              <div className="fld"><label>Устройство вывода</label><select value={s.output} onChange={(e) => upd({ output: e.target.value }, () => E?.applyOutput())}><option value="">По умолчанию</option>{outs.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || d.deviceId}</option>)}</select></div>
              <div className="fld"><label>Общая громкость: {s.master}%</label><input type="range" min={0} max={100} value={s.master} onChange={(e) => upd({ master: +e.target.value }, () => E?.applyMaster())} /></div>
              <div className="fld"><label>Громкость уведомлений: {s.notifyVolume}%</label><input type="range" min={0} max={100} value={s.notifyVolume} onChange={(e) => upd({ notifyVolume: +e.target.value })} onMouseUp={() => playSound('system')} /></div>
            </div>
          </>}

          {tab === 'notif' && <>
            <h2><Icon name="bell" />Уведомления</h2>
            {!notifSupported() ? (
              <div className="fld"><label style={{ color: 'var(--txt-dim)' }}>Системные уведомления не поддерживаются на этом устройстве</label></div>
            ) : <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <label className="perm-op">
                <input type="checkbox" checked={s.notif} onChange={async (e) => {
                  if (e.target.checked) {
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
                }} />
                <span><b>Системные уведомления</b><i>Упоминания — когда окно не в фокусе; трансляции и обновления — всегда{notifPermission() === 'denied' ? ' · доступ запрещён в системе' : ''}</i></span>
              </label>
              {NOTIF_KINDS.map((o) => (
                <label key={o.key} className="perm-op" style={{ opacity: s.notif ? 1 : .45, pointerEvents: s.notif ? 'auto' : 'none' }}>
                  <input type="checkbox" disabled={!s.notif} checked={s[o.key]} onChange={(e) => { upd({ [o.key]: e.target.checked } as Partial<AudioSettings>); syncPushPrefs(); }} />
                  <span><b>{o.title}</b><i>{o.desc}</i></span>
                </label>
              ))}
            </div>}
          </>}

          {tab === 'appearance' && <>
            <h2><Icon name="palette" />Оформление</h2>
            <div className="fld"><label>Тема оформления</label>
              <div className="theme-grid" role="group" aria-label="Тема оформления">
                {THEMES.map((t) => (
                    <button type="button" key={t.id} aria-pressed={getTheme() === t.id} className={'theme-op' + (getTheme() === t.id ? ' active' : '')} onClick={() => { setTheme(t.id); rerender(); }}>
                      <span className="theme-sw">{t.swatch.map((c, i) => <i key={i} style={{ background: c }} />)}</span>
                      <span className="theme-copy"><span className="theme-nm">{t.name}</span><small>{t.description}</small></span>
                      {getTheme() === t.id ? <Icon name="check" sm /> : null}
                  </button>
                ))}
              </div>
            </div>
          </>}

          {tab === 'keys' && <>
            <h2><Icon name="keyboard" />Клавиши</h2>
            {(Object.keys(KEYBIND_LABELS) as KeybindAction[]).map((action) => (
              <div key={action} className="fld" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                <span style={{ fontSize: 13.5, color: 'var(--txt)' }}>{KEYBIND_LABELS[action]}</span>
                <button style={{ padding: '5px 12px', fontSize: 12.5, width: 'auto', display: 'flex', alignItems: 'center', gap: 8 }} onClick={() => setCaptureAction(action)}>
                  <span className="kbd">{comboLabel(s.keybinds[action])}</span>Сменить
                </button>
              </div>
            ))}
            {isTauri ? <label className="perm-op" style={{ marginTop: 8 }}>
              <input type="checkbox" checked={s.disableGlobalHotkeys} onChange={(e) => upd({ disableGlobalHotkeys: e.target.checked }, () => setGlobalHotkeys(getSettings().keybinds, !e.target.checked))} />
              <span><b>Отключить комбинацию вне приложения</b><i>Клавиши сработают только когда окно RelayApp в фокусе</i></span>
            </label> : null}
          </>}

          {tab === 'game' && isTauri && <>
            <h2><Icon name="cam" />Игровой статус</h2>
            <label className="perm-op">
              <input type="checkbox" checked={s.shareGame} onChange={(e) => upd({ shareGame: e.target.checked })} />
              <span><b>Показывать, во что играю</b><i>Другие увидят название и иконку игры рядом с ником (только полноэкранная игра на переднем плане или распознанная Windows). Читается имя окна и иконка — без доступа к самой игре.</i></span>
            </label>
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
  return <Backdrop onClose={cancel} label="Переключение сервера">
    <h2><Icon name="leave" />Перейти на другой сервер?</h2>
    <p className="msub">Ты сейчас подключён к «<b style={{ color: 'var(--txt-h)' }}>{from?.name}</b>». Переход{target ? <> на «<b style={{ color: 'var(--txt-h)' }}>{target.name}</b>»</> : null} отключит тебя от текущего сервера — голос, трансляции и realtime-чат прервутся.</p>
    <div className="switch-srv-row">
      <div className="ssr-card"><div className="ssr-ic" style={{ background: from ? avColor(from.name, from.iconColor) : 'var(--panel3)' }}>{from ? initial(from.name) : '—'}</div><span>{from?.name || '—'}</span></div>
      <Icon name="chevron" />
      <div className="ssr-card"><div className="ssr-ic" style={{ background: target ? avColor(target.name, target.iconColor) : 'var(--panel3)' }}>{target ? initial(target.name) : '—'}</div><span>{target?.name || '—'}</span></div>
    </div>
    <div className="rowbtns"><button className="ghost" style={{ margin: 0 }} onClick={cancel}>Остаться</button><button className="primary" style={{ margin: 0 }} onClick={confirm}>Перейти</button></div>
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
    default: return null;
  }
}
