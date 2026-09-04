import { useCallback, useEffect, useState } from 'react';
import { api, resolveUploadUrl } from '../api';
import { useStore } from '../store';
import { Icon } from '../Icon';
import { avColor, initial } from '../util';
import type { AdminOverview, AdminServer, AdminMember, AdminUser, RegistrationInvite } from '../types';

function RegistrationInviteCard({ invite, now, onReload, onRotate }: {
  invite: RegistrationInvite; now: number; onReload: () => void; onRotate: () => void;
}) {
  const toast = useStore((state) => state.toast);
  const expiresAt = invite.expiresAt < 1_000_000_000_000 ? invite.expiresAt * 1000 : invite.expiresAt;
  const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  const countdown = [hours, minutes, secs].map((value) => String(value).padStart(2, '0')).join(':');
  const expires = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(expiresAt);
  const copy = () => {
    if (!navigator.clipboard) { toast('Выделите код и скопируйте вручную', 'info'); return; }
    navigator.clipboard.writeText(invite.code).then(() => toast('Код скопирован', 'ok')).catch(() => toast('Не удалось скопировать код', 'err'));
  };
  return (
    <div className="admin-invite-card">
      <div className="admin-invite-label"><span>Текущий код</span><i className={seconds ? 'active' : 'expired'}>{seconds ? 'действует' : 'обновляется'}</i></div>
      <div className="admin-invite-code"><code>{invite.code}</code><button type="button" aria-label="Копировать пригласительный код" onClick={copy}><Icon name="copy" sm /><span>Копировать</span></button></div>
      <div className="admin-invite-meta">
        <span><b>{seconds ? countdown : '00:00:00'}</b><small>до автоматической смены</small></span>
        <span><b>{expires}</b><small>срок действия</small></span>
        {invite.uses != null ? <span><b>{invite.uses}{invite.maxUses != null ? ` / ${invite.maxUses}` : ''}</b><small>регистраций по коду</small></span> : null}
        {invite.emailSends != null ? <span><b>{invite.emailSends}{invite.maxEmailSends != null ? ` / ${invite.maxEmailSends}` : ''}</b><small>писем по коду</small></span> : null}
      </div>
      <div className="admin-invite-actions">
        {!seconds ? <button type="button" className="admin-invite-reload" onClick={onReload}><Icon name="refresh" sm />Получить новый код</button> : null}
        <button type="button" className="admin-invite-reload danger" onClick={onRotate}><Icon name="refresh" sm />Сменить код сейчас</button>
      </div>
    </div>
  );
}

// Минимальная админ-панель (/admin): обзор всех серверов и юзеров + удаление сервера/участника/юзера
// и выдача админки. Доступ гейтится и на клиенте (me.isAdmin), и на сервере (requireAdmin).
export function AdminPage() {
  const me = useStore((s) => s.me);
  const goHome = useStore((s) => s.goHome);
  const toast = useStore((s) => s.toast);
  const [data, setData] = useState<AdminOverview | null>(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'servers' | 'users' | 'access'>('servers');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [registrationInvite, setRegistrationInvite] = useState<RegistrationInvite | null>(null);
  const [inviteError, setInviteError] = useState('');
  const [inviteLoading, setInviteLoading] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [bindingSupport, setBindingSupport] = useState<{ user: AdminUser; code: string; expiresAt: number } | null>(null);
  const isBootstrapAdmin = me?.username === 'denis';

  const load = useCallback(() => {
    setLoading(true); setErr('');
    api.adminOverview().then(setData).catch((e) => setErr(e?.message || 'Ошибка')).finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  const loadRegistrationInvite = useCallback(() => {
    if (!isBootstrapAdmin) return;
    setInviteLoading(true); setInviteError('');
    api.adminRegistrationInvite().then(setRegistrationInvite).catch((error) => setInviteError(error?.message || 'Не удалось получить код')).finally(() => setInviteLoading(false));
  }, [isBootstrapAdmin]);
  const rotateRegistrationInvite = async () => {
    if (!confirm('Сразу отозвать текущий пригласительный код? Все незавершённые регистрации с ним перестанут подтверждаться.')) return;
    setInviteLoading(true); setInviteError('');
    try { setRegistrationInvite(await api.adminRotateRegistrationInvite()); toast('Пригласительный код обновлён', 'ok'); }
    catch (error: any) { setInviteError(error?.message || 'Не удалось обновить код'); }
    finally { setInviteLoading(false); }
  };
  useEffect(() => { if (isBootstrapAdmin) loadRegistrationInvite(); }, [isBootstrapAdmin, loadRegistrationInvite]);
  useEffect(() => {
    if (tab !== 'access') return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [tab]);
  useEffect(() => {
    if (!registrationInvite?.expiresAt) return;
    const delay = Math.min(Math.max(1000, registrationInvite.expiresAt - Date.now() + 1000), 2_147_000_000);
    const id = window.setTimeout(loadRegistrationInvite, delay);
    return () => clearTimeout(id);
  }, [registrationInvite?.expiresAt, loadRegistrationInvite]);

  const delServer = async (s: AdminServer) => {
    if (!confirm(`Удалить сервер «${s.name}» со всеми сообщениями и участниками? Необратимо.`)) return;
    try { await api.adminDeleteServer(s.id); toast('Сервер удалён', 'info'); load(); } catch (e: any) { toast(e?.message || 'Ошибка', 'err'); }
  };
  const removeMember = async (s: AdminServer, u: AdminMember) => {
    if (!confirm(`Убрать ${u.displayName} из «${s.name}»?`)) return;
    try { await api.adminRemoveMember(s.id, u.id); toast('Участник убран', 'info'); load(); } catch (e: any) { toast(e?.message || 'Ошибка', 'err'); }
  };
  const delUser = async (u: AdminUser) => {
    if (!confirm(`Удалить юзера ${u.displayName} (@${u.username}) с сайта? Снесёт и его сервера-владения. Необратимо.`)) return;
    try { await api.adminDeleteUser(u.id); toast('Юзер удалён', 'info'); load(); } catch (e: any) { toast(e?.message || 'Ошибка', 'err'); }
  };
  const toggleAdmin = async (u: AdminUser) => {
    try { await api.adminSetAdmin(u.id, !u.isAdmin); load(); } catch (e: any) { toast(e?.message || 'Ошибка', 'err'); }
  };
  const issueBindingSupportCode = async (u: AdminUser) => {
    if (!confirm(`Вы проверили личность ${u.displayName} (@${u.username}) вне RelayApp? Код позволит один раз привязать почту без старого пароля.`)) return;
    try {
      const result = await api.adminEmailBindingSupportCode(u.id);
      setBindingSupport({ user: u, code: result.code, expiresAt: result.expiresAt });
    } catch (e: any) { toast(e?.message || 'Не удалось выдать код', 'err'); }
  };
  const copyBindingSupportCode = () => {
    if (!bindingSupport || !navigator.clipboard) { toast('Скопируйте код вручную', 'info'); return; }
    navigator.clipboard.writeText(bindingSupport.code).then(() => toast('Одноразовый код скопирован', 'ok')).catch(() => toast('Не удалось скопировать код', 'err'));
  };
  const toggleExp = (id: string) => setExpanded((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });

  return (
    <div className="admin">
      <div className="admin-head">
        <button className="admin-back" onClick={goHome}><Icon name="chevron" sm /> На главную</button>
        <h1>Админка</h1>
        <button className="admin-refresh" aria-label="Обновить данные" onClick={load} data-tip="Обновить"><Icon name="refresh" sm /></button>
      </div>

      {loading && !data ? <div className="admin-msg">Загрузка…</div>
      : err ? <div className="admin-msg err">{err}</div>
      : data ? (
        <>
          <div className="admin-stats">
            <div className="admin-stat"><b>{data.stats.servers}</b><span>серверов</span></div>
            <div className="admin-stat"><b>{data.stats.users}</b><span>юзеров</span></div>
          </div>

          <div className="admin-tabs">
            <button className={tab === 'servers' ? 'on' : ''} onClick={() => setTab('servers')}>Серверы</button>
            <button className={tab === 'users' ? 'on' : ''} onClick={() => setTab('users')}>Юзеры</button>
            {isBootstrapAdmin ? <button className={tab === 'access' ? 'on' : ''} onClick={() => setTab('access')}>Доступ</button> : null}
          </div>

          {tab === 'servers' ? (
            <div className="admin-list">
              {data.servers.length === 0 ? <div className="admin-msg">Серверов нет</div> : null}
              {data.servers.map((s) => (
                <div key={s.id} className="admin-srv">
                  <div className="admin-srv-h" onClick={() => toggleExp(s.id)}>
                    <span className="admin-ic" style={{ background: s.iconUrl ? '#0000' : avColor(s.name, s.iconColor) }}>
                      {s.iconUrl ? <img className="avimg" src={resolveUploadUrl(s.iconUrl)} alt="" /> : initial(s.name)}
                    </span>
                    <div className="admin-srv-nm">
                      <b>{s.name}</b>
                      <span>владелец: {s.owner ? s.owner.displayName + ' @' + s.owner.username : '—'} · {s.memberCount} участн.</span>
                    </div>
                    <span className={'admin-chev' + (expanded.has(s.id) ? ' open' : '')}><Icon name="chevron" sm /></span>
                    <button className="admin-del" aria-label={`Удалить сервер ${s.name}`} onClick={(e) => { e.stopPropagation(); delServer(s); }} data-tip="Удалить сервер"><Icon name="trash" sm /></button>
                  </div>
                  {expanded.has(s.id) ? (
                    <div className="admin-members">
                      {s.members.map((u) => (
                        <div key={u.id} className="admin-mrow">
                          <span className="admin-mav" style={{ background: avColor(u.displayName) }}>{initial(u.displayName)}</span>
                          <span className="admin-mnm">{u.displayName} <i>@{u.username}</i></span>
                          {u.role === 'owner' ? <span className="admin-badge owner">владелец</span> : <button className="admin-x" aria-label={`Убрать ${u.displayName} из сервера ${s.name}`} onClick={() => removeMember(s, u)} data-tip="Убрать из сервера">×</button>}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          ) : tab === 'users' ? (
            <div className="admin-list">
              {bindingSupport ? (
                <div className="admin-support-code" role="status">
                  <div><span>Одноразовый код для @{bindingSupport.user.username}</span><code>{bindingSupport.code}</code><small>Действует до {new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }).format(bindingSupport.expiresAt)}. Передайте только после проверки личности; повторно код не показывается.</small></div>
                  <button type="button" onClick={copyBindingSupportCode}><Icon name="copy" sm /> Копировать</button>
                  <button type="button" className="admin-support-close" aria-label="Скрыть одноразовый код" onClick={() => setBindingSupport(null)}>×</button>
                </div>
              ) : null}
              {data.users.map((u) => {
                const isSelf = me?.id === u.id;
                const isBoot = u.username === 'denis';
                return (
                  <div key={u.id} className="admin-urow">
                    <span className="admin-mav" style={{ background: u.avatarUrl ? '#0000' : avColor(u.displayName, u.avatarColor) }}>
                      {u.avatarUrl ? <img className="avimg" src={resolveUploadUrl(u.avatarUrl)} alt="" /> : initial(u.displayName)}
                    </span>
                    <div className="admin-unm">
                      <b>{u.displayName}{u.isAdmin ? <span className="admin-badge admin">админ</span> : null}</b>
                      <span>@{u.username} · {u.emailVerified ? 'почта подтверждена' : 'без почты'} · в {u.serverCount} серв · владелец {u.ownedCount}</span>
                    </div>
                    {isBootstrapAdmin && !u.emailVerified ? <button className="admin-adm" onClick={() => issueBindingSupportCode(u)}>Код привязки</button> : null}
                    <button className="admin-adm" disabled={isBoot} onClick={() => toggleAdmin(u)}>{u.isAdmin ? 'Забрать' : 'Выдать'} админку</button>
                    <button className="admin-del" aria-label={`Удалить пользователя ${u.displayName}`} disabled={isBoot || isSelf} onClick={() => delUser(u)} data-tip={isBoot ? 'Нельзя' : isSelf ? 'Это ты' : 'Удалить юзера'}><Icon name="trash" sm /></button>
                  </div>
                );
              })}
            </div>
          ) : isBootstrapAdmin ? (
            <section className="admin-access" aria-labelledby="admin-access-title" aria-busy={inviteLoading || undefined}>
              <div className="admin-access-head">
                <span className="admin-access-icon"><Icon name="shield" /></span>
                <div><span>Регистрация</span><h2 id="admin-access-title">Суточный код доступа</h2></div>
              </div>
              <p>Передавайте код только тем, кому разрешено создать аккаунт. Сервер автоматически заменит его после окончания срока.</p>
              {inviteLoading && !registrationInvite ? <div className="admin-invite-state"><span className="spin" /> Получаем код…</div>
              : inviteError ? <div className="admin-invite-state error" role="alert"><Icon name="warn" sm /><span>{inviteError}</span><button type="button" onClick={loadRegistrationInvite}>Повторить</button></div>
              : registrationInvite ? <RegistrationInviteCard invite={registrationInvite} now={now} onReload={loadRegistrationInvite} onRotate={rotateRegistrationInvite} />
              : null}
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
