import { useCallback, useEffect, useState } from 'react';
import { api, resolveUploadUrl } from '../api';
import { useStore } from '../store';
import { Icon } from '../Icon';
import { avColor, initial } from '../util';
import type { AdminOverview, AdminServer, AdminMember, AdminUser } from '../types';

// Минимальная админ-панель (/admin): обзор всех серверов и юзеров + удаление сервера/участника/юзера
// и выдача админки. Доступ гейтится и на клиенте (me.isAdmin), и на сервере (requireAdmin).
export function AdminPage() {
  const me = useStore((s) => s.me);
  const goHome = useStore((s) => s.goHome);
  const toast = useStore((s) => s.toast);
  const [data, setData] = useState<AdminOverview | null>(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'servers' | 'users'>('servers');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const load = useCallback(() => {
    setLoading(true); setErr('');
    api.adminOverview().then(setData).catch((e) => setErr(e?.message || 'Ошибка')).finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

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
  const toggleExp = (id: string) => setExpanded((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });

  return (
    <div className="admin">
      <div className="admin-head">
        <button className="admin-back" onClick={goHome}><Icon name="chevron" sm /> На главную</button>
        <h1>Админка</h1>
        <button className="admin-refresh" onClick={load} data-tip="Обновить"><Icon name="refresh" sm /></button>
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
                    <button className="admin-del" onClick={(e) => { e.stopPropagation(); delServer(s); }} data-tip="Удалить сервер"><Icon name="trash" sm /></button>
                  </div>
                  {expanded.has(s.id) ? (
                    <div className="admin-members">
                      {s.members.map((u) => (
                        <div key={u.id} className="admin-mrow">
                          <span className="admin-mav" style={{ background: avColor(u.displayName) }}>{initial(u.displayName)}</span>
                          <span className="admin-mnm">{u.displayName} <i>@{u.username}</i></span>
                          {u.role === 'owner' ? <span className="admin-badge owner">владелец</span> : <button className="admin-x" onClick={() => removeMember(s, u)} data-tip="Убрать из сервера">×</button>}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          ) : (
            <div className="admin-list">
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
                      <span>@{u.username} · в {u.serverCount} серв · владелец {u.ownedCount}</span>
                    </div>
                    <button className="admin-adm" disabled={isBoot} onClick={() => toggleAdmin(u)}>{u.isAdmin ? 'Забрать' : 'Выдать'} админку</button>
                    <button className="admin-del" disabled={isBoot || isSelf} onClick={() => delUser(u)} data-tip={isBoot ? 'Нельзя' : isSelf ? 'Это ты' : 'Удалить юзера'}><Icon name="trash" sm /></button>
                  </div>
                );
              })}
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}
