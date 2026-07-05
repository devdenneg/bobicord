import { useEffect, useRef, useState } from 'react';
import { Room } from 'livekit-client';
import { api } from '../api';
import { useStore, getEngine } from '../store';
import { getSettings, setSettings } from '../settings';
import { playSound } from '../sounds';
import { Icon } from '../Icon';
import { AV_COLORS, avColor, initial, keyLabel } from '../util';
import type { AudioSettings, InvitePreview } from '../types';

function Backdrop({ children, onClose, label }: { children: React.ReactNode; onClose: () => void; label?: string }) {
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);
  return <div className="modal show" onMouseDown={(e) => e.target === e.currentTarget && onClose()}><div className="box" role="dialog" aria-modal="true" aria-label={label}>{children}</div></div>;
}

function CreateModal() {
  const close = () => useStore.getState().setModal(null);
  const [name, setName] = useState(''); const [pass, setPass] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  async function create() {
    if (name.trim().length < 2) { setErr('Название минимум 2 символа'); return; }
    setBusy(true);
    try { const d = await api.createServer(name.trim(), pass || undefined); close(); await useStore.getState().loadMe(); await useStore.getState().openServer(d.server.id); useStore.getState().toast('Сервер создан', 'ok'); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }
  return <Backdrop onClose={close} label="Создать сервер">
    <h2><Icon name="plus" />Создать сервер</h2>
    <p className="msub">Дай серверу имя. Пароль опционален — нужен для приглашений «по паролю».</p>
    <div className="fld"><label>Название</label><input autoFocus value={name} maxLength={40} placeholder="Например: Наша тусовка" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && create()} /></div>
    <div className="fld"><label>Пароль сервера (опционально)</label><input value={pass} maxLength={64} placeholder="оставь пустым если не нужен" onChange={(e) => setPass(e.target.value)} /></div>
    <div className="rowbtns"><button className="ghost" style={{ margin: 0 }} onClick={close}>Отмена</button><button className="primary" style={{ margin: 0 }} disabled={busy} onClick={create}>Создать</button></div>
    <div className="err">{err}</div>
  </Backdrop>;
}

function extractCode(v: string) { v = v.trim(); const m = v.match(/[?&]invite=([^&\s]+)/); if (m) return m[1]; return v; }
function JoinModal() {
  const close = () => useStore.getState().setModal(null);
  const prefill = useStore((s) => s.joinPrefill);
  const [code, setCode] = useState(prefill || ''); const [pass, setPass] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const tRef = useRef<number | null>(null);
  async function doPreview(c: string) { const cc = extractCode(c); if (!cc) { setPreview(null); return; } try { const d = await api.invitePreview(cc); setPreview(d); setErr(''); } catch (e: any) { setPreview(null); setErr(e.message); } }
  useEffect(() => { if (prefill) doPreview(prefill); /* eslint-disable-next-line */ }, []);
  function onCode(v: string) { setCode(v); if (tRef.current) clearTimeout(tRef.current); tRef.current = window.setTimeout(() => doPreview(v), 400); }
  async function join() {
    const cc = extractCode(code); if (!cc) { setErr('Введи код'); return; }
    setBusy(true); setErr('');
    try { const d = await api.joinInvite(cc, pass || undefined); close(); await useStore.getState().loadMe(); await useStore.getState().openServer(d.server.id); useStore.getState().toast('Ты на сервере «' + d.server.name + '»', 'ok'); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }
  return <Backdrop onClose={close} label="Присоединиться">
    <h2><Icon name="link" />Присоединиться</h2>
    <p className="msub">Вставь код приглашения или полную ссылку.</p>
    <div className="fld"><label>Код или ссылка</label><input autoFocus value={code} placeholder="напр. aBc123 или https://.../?invite=..." onChange={(e) => onCode(e.target.value)} /></div>
    {preview ? <div style={{ background: 'var(--bg2)', border: '1px solid var(--line-2)', borderRadius: 'var(--r-md)', padding: 12, marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ width: 40, height: 40, borderRadius: 12, background: avColor(preview.server.name, preview.server.iconColor), display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, color: '#fff' }}>{initial(preview.server.name)}</div>
        <div><b style={{ color: 'var(--txt-h)' }}>{preview.server.name}</b><div style={{ fontSize: 12.5, color: 'var(--muted)' }}>{preview.server.memberCount} участник(ов)</div></div>
      </div>
    </div> : null}
    {preview?.requiresPassword ? <div className="fld"><label>Пароль сервера</label><input type="password" value={pass} placeholder="требуется этим приглашением" onChange={(e) => setPass(e.target.value)} /></div> : null}
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
        {avatarUrl ? <img className="avimg" src={avatarUrl} alt="" /> : initial(dn)}
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
  const [pass, setPass] = useState(''); const [err, setErr] = useState('');
  const owner = active.myRole === 'owner';
  async function setPassword() { try { await api.setServerPassword(active.id, pass); useStore.getState().toast('Пароль обновлён', 'ok'); setPass(''); useStore.setState({ active: { ...active, hasPassword: !!pass } }); } catch (e: any) { setErr(e.message); } }
  async function leave() { try { if (owner) await api.deleteServer(active.id); else await api.leaveServer(active.id); close(); useStore.getState().toast('Готово', 'ok'); useStore.getState().goHome(); } catch (e: any) { setErr(e.message); } }
  return <Backdrop onClose={close} label="Сервер">
    <h2>{active.name}</h2>
    <p className="msub">{active.memberCount} участник(ов){owner ? ' · ты владелец' : ''}</p>
    {owner ? <div className="grp"><div className="gt">Владелец</div>
      <div className="fld"><label>Пароль сервера (для парольных инвайтов)</label><input value={pass} placeholder="задать/сменить пароль" onChange={(e) => setPass(e.target.value)} /></div>
      <button className="ghost" style={{ margin: 0 }} onClick={setPassword}>Сохранить пароль</button></div> : null}
    <div className="rowbtns"><button className="ghost" style={{ margin: 0 }} onClick={close}>Закрыть</button><button className="primary" style={{ margin: 0, background: 'var(--red-fill)' }} onClick={leave}>{owner ? 'Удалить сервер' : 'Покинуть сервер'}</button></div>
    <div className="err">{err}</div>
  </Backdrop>;
}

function InviteModal() {
  const close = () => useStore.getState().setModal(null);
  const active = useStore((s) => s.active)!;
  const [plain, setPlain] = useState(''); const [pw, setPw] = useState('');
  useEffect(() => { api.createInvite(active.id, false).then((d) => setPlain(location.origin + '/?invite=' + d.code)).catch(() => {}); }, [active.id]);
  const copy = (v: string) => { if (v) navigator.clipboard.writeText(v).then(() => useStore.getState().toast('Скопировано', 'ok')); };
  return <Backdrop onClose={close} label="Пригласить">
    <h2><Icon name="link" />Пригласить друзей</h2>
    <p className="msub">Отправь ссылку — по ней друг попадёт на сервер.</p>
    <div className="gt">Обычная ссылка</div>
    <div className="invite-box"><input readOnly value={plain} /><button data-tip="Копировать" onClick={() => copy(plain)}>📋</button></div>
    <div className="grp"><div className="gt">Ссылка с паролем</div>
      <p className="msub" style={{ margin: '0 0 8px' }}>{active.hasPassword ? 'Требует пароль сервера при входе.' : 'Сначала задай пароль сервера (меню сервера).'}</p>
      {pw ? <div className="invite-box"><input readOnly value={pw} /><button data-tip="Копировать" onClick={() => copy(pw)}>📋</button></div> : null}
      {active.hasPassword ? <button className="ghost" style={{ marginTop: 8 }} onClick={() => api.createInvite(active.id, true).then((d) => { setPw(location.origin + '/?invite=' + d.code); useStore.getState().toast('Парольная ссылка создана', 'ok'); })}>Создать парольную ссылку</button> : null}
    </div>
    <button className="close" onClick={close}>Готово</button>
  </Backdrop>;
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
      <div className="fld" style={{ marginTop: 10 }}><label>Громкость микрофона: {s.micVolume}%</label><input type="range" min={0} max={200} value={s.micVolume} onChange={(e) => upd({ micVolume: +e.target.value }, () => E?.applyMicVolume())} /></div>
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
    case 'settings': return <SettingsModal />;
    default: return null;
  }
}
