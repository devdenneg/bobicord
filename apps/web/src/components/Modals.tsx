import { useEffect, useRef, useState } from 'react';
import { Room } from 'livekit-client';
import { api, resolveUploadUrl } from '../api';
import { useStore, getEngine } from '../store';
import { getSettings, setSettings } from '../settings';
import { THEMES, getTheme, setTheme } from '../theme';
import { playSound } from '../sounds';
import { Icon } from '../Icon';
import { MicMeter } from './MicMeter';
import { AV_COLORS, avColor, initial, keyLabel } from '../util';
import type { AudioSettings, InvitePreview, Role, Member } from '../types';
import { PERM, PERM_LIST, hasPerm } from '../types';
import { Backdrop } from './Backdrop';
import { BroadcastModal } from './BroadcastModal';

function CreateModal() {
  const close = () => useStore.getState().setModal(null);
  const [name, setName] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  async function create() {
    if (name.trim().length < 2) { setErr('Название минимум 2 символа'); return; }
    setBusy(true);
    try { const d = await api.createServer(name.trim()); close(); await useStore.getState().loadMe(); await useStore.getState().openServer(d.server.id); useStore.getState().toast('Сервер создан', 'ok'); }
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
    try { const d = await api.joinInvite(cc); close(); await useStore.getState().loadMe(); await useStore.getState().openServer(d.server.id); useStore.getState().toast('Ты на сервере «' + d.server.name + '»', 'ok'); }
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
  const close = () => useStore.getState().setModal(null);
  const me = useStore((s) => s.me)!;
  const [dn, setDn] = useState(me.displayName); const [bio, setBio] = useState(me.bio || ''); const [color, setColor] = useState(me.avatarColor);
  const [avatarUrl, setAvatarUrl] = useState(me.avatarUrl || '');
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false); const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
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
    try { const d = await api.updateMe({ displayName: dn.trim(), bio, avatarColor: color, avatarUrl }); useStore.getState().setMe(d.user); useStore.getState().refreshMembers(); useStore.getState().refreshServers(); close(); useStore.getState().toast('Профиль сохранён', 'ok'); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }
  return <Backdrop onClose={close} label="Профиль">
    <h2>Профиль</h2>
    <div className="fld" style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 18 }}>
      <div className="me-mini" style={{ width: 64, height: 64, borderRadius: 20, fontSize: 26, background: avatarUrl ? '#0000' : avColor(dn, color), overflow: 'hidden', position: 'relative', cursor: 'pointer' }} onClick={() => fileRef.current?.click()} title="Загрузить аватар">
        {avatarUrl ? <img className="avimg" src={resolveUploadUrl(avatarUrl)} alt="" /> : initial(dn)}
        {uploading ? <span className="spin" style={{ position: 'absolute', inset: 0, margin: 'auto' }} /> : null}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>@{me.username}</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="ghost" style={{ margin: 0, padding: '6px 12px', fontSize: 13, width: 'auto' }} disabled={uploading} onClick={() => fileRef.current?.click()}>{uploading ? 'Загрузка…' : 'Загрузить фото'}</button>
          {avatarUrl ? <button className="ghost" style={{ margin: 0, padding: '6px 12px', fontSize: 13, width: 'auto', color: 'var(--red)' }} onClick={() => setAvatarUrl('')}>Убрать</button> : null}
        </div>
      </div>
      <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; if (f) pickAvatar(f); e.target.value = ''; }} />
    </div>
    <div className="fld"><label>Отображаемое имя</label><input value={dn} maxLength={32} onChange={(e) => setDn(e.target.value)} /></div>
    <div className="fld"><label>О себе</label><textarea value={bio} maxLength={200} rows={2} placeholder="пара слов о себе" onChange={(e) => setBio(e.target.value)} /></div>
    <div className="fld"><label>Цвет аватара{avatarUrl ? ' (когда без фото)' : ''}</label><div className="colorpick">{AV_COLORS.map((c, i) => <div key={i} className={'cp' + (i === color ? ' sel' : '')} style={{ background: c }} onClick={() => setColor(i)} />)}</div></div>
    <div className="rowbtns"><button className="ghost" style={{ margin: 0, color: 'var(--red)' }} onClick={() => useStore.getState().logout()}>Выйти из аккаунта</button><button className="primary" style={{ margin: 0 }} disabled={busy} onClick={save}>Сохранить</button></div>
    <div className="err">{err}</div>
  </Backdrop>;
}

function ServerMenuModal() {
  const close = () => useStore.getState().setModal(null);
  const active = useStore((s) => s.active)!;
  const [err, setErr] = useState('');
  const owner = active.myRole === 'owner';
  const canManage = owner || hasPerm(active.myPerms || 0, PERM.MANAGE_SERVER) || hasPerm(active.myPerms || 0, PERM.MANAGE_ROLES);
  async function leave() { try { if (owner) await api.deleteServer(active.id); else await api.leaveServer(active.id); close(); useStore.getState().toast('Готово', 'ok'); useStore.getState().goHome(); } catch (e: any) { setErr(e.message); } }
  return <Backdrop onClose={close} label="Сервер">
    <div className="srv-menu-head">
      <div className="sm-ic" style={{ background: active.iconUrl ? '#0000' : avColor(active.name, active.iconColor) }}>{active.iconUrl ? <img className="avimg" src={resolveUploadUrl(active.iconUrl)} alt="" /> : initial(active.name)}</div>
      <div><h2 style={{ margin: 0 }}>{active.name}</h2><p className="msub" style={{ margin: '2px 0 0' }}>{active.memberCount} участник(ов){owner ? ' · ты владелец' : ''}</p></div>
    </div>
    {active.description ? <p className="msub" style={{ marginTop: 4 }}>{active.description}</p> : null}
    <div className="rowbtns">
      <button className="ghost" style={{ margin: 0 }} onClick={() => useStore.getState().setModal('invite')}><Icon name="link" sm />Пригласить</button>
      {canManage ? <button className="primary" style={{ margin: 0 }} onClick={() => useStore.getState().setModal('srvsettings')}><Icon name="gear" sm />Настройки сервера</button> : null}
    </div>
    <div className="rowbtns"><button className="ghost" style={{ margin: 0 }} onClick={close}>Закрыть</button><button className="primary" style={{ margin: 0, background: 'var(--red-fill)' }} onClick={leave}>{owner ? 'Удалить сервер' : 'Покинуть сервер'}</button></div>
    <div className="err">{err}</div>
  </Backdrop>;
}

function InviteModal() {
  const close = () => useStore.getState().setModal(null);
  const active = useStore((s) => s.active)!;
  const [link, setLink] = useState(''); const [expires, setExpires] = useState(0); const [busy, setBusy] = useState(false); const [left, setLeft] = useState('');
  async function gen() {
    setBusy(true);
    try { const d = await api.createInvite(active.id); setLink(location.origin + '/?invite=' + d.code); setExpires(d.expires); }
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
    <div className="invite-box"><input readOnly value={link} /><button data-tip="Копировать" disabled={!link || expired} onClick={() => copy(link)}>📋</button></div>
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
  const [tab, setTab] = useState<'profile' | 'roles' | 'members'>(canServer ? 'profile' : 'roles');
  return <Backdrop onClose={close} label="Настройки сервера" wide>
    <h2><Icon name="gear" />Настройки сервера</h2>
    <div className="seg" style={{ marginBottom: 14 }}>
      {canServer ? <button className={tab === 'profile' ? 'active' : ''} onClick={() => setTab('profile')}>Профиль</button> : null}
      {canRoles ? <button className={tab === 'roles' ? 'active' : ''} onClick={() => setTab('roles')}>Роли</button> : null}
      {canRoles ? <button className={tab === 'members' ? 'active' : ''} onClick={() => setTab('members')}>Участники</button> : null}
    </div>
    {tab === 'profile' && canServer ? <ServerProfileTab active={active} /> : null}
    {tab === 'roles' && canRoles ? <RolesTab active={active} /> : null}
    {tab === 'members' && canRoles ? <RoleAssignTab active={active} members={members} /> : null}
    <button className="close" onClick={close}>Готово</button>
  </Backdrop>;
}

function ServerProfileTab({ active }: { active: import('../types').ServerDetail }) {
  const [name, setName] = useState(active.name); const [desc, setDesc] = useState(active.description || '');
  const [color, setColor] = useState(active.iconColor); const [iconUrl, setIconUrl] = useState(active.iconUrl || '');
  const [busy, setBusy] = useState(false); const [uploading, setUploading] = useState(false); const [err, setErr] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  async function pick(file: File) {
    if (!file.type.startsWith('image/')) { setErr('Только картинки'); return; }
    if (file.size > 10 * 1024 * 1024) { setErr('Больше 10 МБ'); return; }
    setUploading(true); setErr('');
    try { const blob = await cropSquare(file, 256); const { url } = await api.uploadImage(blob); setIconUrl(url); } catch (e: any) { setErr(e?.message || 'Ошибка'); } finally { setUploading(false); }
  }
  async function save() {
    setBusy(true); setErr('');
    try { await api.patchServer(active.id, { name: name.trim(), description: desc, iconColor: color, iconUrl }); await useStore.getState().refreshServer(); useStore.getState().refreshServers(); useStore.getState().toast('Сохранено', 'ok'); }
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
      <div className="assign-nm">{m.displayName}{m.role === 'owner' ? <span className="rl">👑</span> : ''}{busy === m.id ? <span className="spin" style={{ width: 12, height: 12 }} /> : null}</div>
      <div className="assign-roles">{roles.map((r) => { const on = (m.roles || []).some((x) => x.id === r.id); return <button key={r.id} className={'role-chip' + (on ? ' on' : '')} style={on ? { background: r.color || 'var(--accent)', borderColor: r.color || 'var(--accent)' } : { borderColor: r.color || 'var(--line-2)', color: r.color || 'var(--muted)' }} disabled={m.role === 'owner'} onClick={() => toggle(m, r.id)}>{r.name}</button>; })}</div>
    </div>)}
  </div>;
}

function SettingsModal() {
  const close = () => useStore.getState().setModal(null);
  const [, force] = useState(0); const rerender = () => force((n) => n + 1);
  const s = getSettings();
  const [ins, setIns] = useState<MediaDeviceInfo[]>([]); const [outs, setOuts] = useState<MediaDeviceInfo[]>([]);
  const [binding, setBinding] = useState(false);
  useEffect(() => { Room.getLocalDevices('audioinput').then(setIns).catch(() => {}); Room.getLocalDevices('audiooutput').then(setOuts).catch(() => {}); }, []);
  useEffect(() => { if (!binding) return; const k = (e: KeyboardEvent) => { e.preventDefault(); setSettings({ pttKey: e.code }); setBinding(false); rerender(); }; window.addEventListener('keydown', k, { once: true }); return () => window.removeEventListener('keydown', k); }, [binding]);
  const E = getEngine();
  const upd = (patch: Partial<AudioSettings>, act?: () => void) => { setSettings(patch); act?.(); rerender(); };
  return <Backdrop onClose={close} label="Настройки звука">
    <h2><Icon name="gear" />Звук и микрофон</h2>
    <div className="grp" style={{ border: 'none', marginTop: 8, paddingTop: 0 }}>
      <div className="gt"><Icon name="mic-sm" sm /> Микрофон</div>
      <div className="fld"><label>Устройство ввода</label><select value={s.input} onChange={(e) => upd({ input: e.target.value }, () => E?.reapplyMic())}><option value="">По умолчанию</option>{ins.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || d.deviceId}</option>)}</select></div>
      <MicMeter />
      <div className="fld" style={{ marginTop: 10 }}><label>Режим передачи</label>
        <div className="seg"><button className={s.mode === 'voice' ? 'active' : ''} onClick={() => upd({ mode: 'voice' }, () => E?.onModeChanged())}>Активация голосом</button><button className={s.mode === 'ptt' ? 'active' : ''} onClick={() => upd({ mode: 'ptt' }, () => E?.onModeChanged())}>Push-to-Talk</button></div>
        {s.mode === 'ptt' ? <div className="ptt-hint">Удерживай <span className="kbd">{keyLabel(s.pttKey)}</span> · <button style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => setBinding(true)}>{binding ? 'Нажми клавишу...' : 'Сменить'}</button></div> : null}
      </div>
    </div>
    <div className="grp"><div className="gt"><Icon name="head" sm /> Звук</div>
      <div className="fld"><label>Устройство вывода</label><select value={s.output} onChange={(e) => upd({ output: e.target.value }, () => E?.applyOutput())}><option value="">По умолчанию</option>{outs.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || d.deviceId}</option>)}</select></div>
      <div className="fld"><label>Общая громкость: {s.master}%</label><input type="range" min={0} max={100} value={s.master} onChange={(e) => upd({ master: +e.target.value }, () => E?.applyMaster())} /></div>
      <div className="fld"><label>Громкость уведомлений: {s.notifyVolume}%</label><input type="range" min={0} max={100} value={s.notifyVolume} onChange={(e) => upd({ notifyVolume: +e.target.value })} onMouseUp={() => playSound('system')} /></div>
    </div>
    <div className="grp"><div className="gt"><Icon name="palette" sm /> Оформление</div>
      <div className="fld"><label>Тема оформления</label>
        <div className="theme-grid">
          {THEMES.map((t) => (
            <button key={t.id} className={'theme-op' + (getTheme() === t.id ? ' active' : '')} onClick={() => { setTheme(t.id); rerender(); }}>
              <span className="theme-sw">{t.swatch.map((c, i) => <i key={i} style={{ background: c }} />)}</span>
              <span className="theme-nm">{t.name}</span>
              {getTheme() === t.id ? <Icon name="check" sm /> : null}
            </button>
          ))}
        </div>
      </div>
    </div>
    <button className="close" onClick={close}>Готово</button>
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
    default: return null;
  }
}
