import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type {
  AdminVoiceDiagnosticCursor,
  AdminVoiceDiagnosticDetail,
  AdminVoiceDiagnosticSummary,
  VoiceDiagnosticEvent,
  VoiceDiagnosticIncident,
} from '../types';
import { Icon } from '../Icon';

const PAGE_SIZE = 50;

const INCIDENT_LABELS: Record<VoiceDiagnosticIncident, string> = {
  manual: 'Ручной отчёт',
  join_stuck: 'Зависшее подключение',
  connection_failed: 'Ошибка подключения',
  reconnect_loop: 'Цикл переподключений',
  uplink_silent: 'Нет исходящего звука',
  inbound_silent: 'Нет входящего звука',
  mute_divergence: 'Рассинхрон мута',
  mic_failed: 'Ошибка микрофона',
  playback_blocked: 'Воспроизведение заблокировано',
  output_route_failed: 'Ошибка аудиовыхода',
  ui_stall: 'Зависание интерфейса',
  session_ended: 'Завершённая сессия',
};

const EVENT_LABELS: Partial<Record<VoiceDiagnosticEvent['kind'], string>> = {
  join_started: 'Подключение начато',
  join_completed: 'Подключение завершено',
  join_failed: 'Подключение не удалось',
  reconnecting: 'Переподключение',
  reconnected: 'Связь восстановлена',
  disconnected: 'Связь потеряна',
  mic_recovery_started: 'Восстановление микрофона',
  mic_recovery_finished: 'Микрофон восстановлен',
  mute_changed: 'Состояние микрофона изменено',
  deafen_changed: 'Состояние звука изменено',
  background: 'Приложение свёрнуто',
  foreground: 'Приложение открыто',
  playback_blocked: 'Воспроизведение заблокировано',
  output_route_failed: 'Ошибка аудиовыхода',
  ui_stall: 'Задержка интерфейса',
  uplink_stalled: 'Исходящий звук остановился',
  inbound_stalled: 'Входящий звук остановился',
  left: 'Выход из канала',
};

const FIELD_LABELS: Record<string, string> = {
  stage: 'этап', outcome: 'результат', code: 'код', httpStatus: 'HTTP',
  connectionState: 'соединение', iceState: 'ICE', trackState: 'трек',
  audioContextState: 'аудиоконтекст', outputRoute: 'выход', micMode: 'режим микрофона',
  networkType: 'сеть', documentHidden: 'в фоне', online: 'браузер онлайн',
  micEnabled: 'микрофон включён', publicationMuted: 'публикация заглушена',
  upstreamPaused: 'отправка приостановлена', deafened: 'звук выключен', pushToTalk: 'PTT',
  speechDetected: 'обнаружена речь', canPlaybackAudio: 'звук разрешён', rttMs: 'RTT, мс',
  jitterMs: 'джиттер, мс', packetsLostDelta: 'потеряно пакетов',
  packetsReceivedDelta: 'получено пакетов', packetsSentDelta: 'отправлено пакетов',
  bytesReceivedDelta: 'получено байт', bytesSentDelta: 'отправлено байт',
  concealedSamplesDelta: 'скрыто аудиосэмплов', audioLevel: 'уровень аудио',
  eventLoopLagMs: 'задержка UI, мс', joinElapsedMs: 'подключение, мс',
  reconnectCount: 'переподключений', participantCount: 'участников',
};

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${milliseconds} мс`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)} с`;
  return `${Math.floor(milliseconds / 60_000)} мин ${Math.round((milliseconds % 60_000) / 1_000)} с`;
}

function eventFacts(event: VoiceDiagnosticEvent): { label: string; value: string }[] {
  return Object.entries(event)
    .filter(([key, value]) => key !== 'atMs' && key !== 'kind' && value !== undefined)
    .map(([key, value]) => ({
      label: FIELD_LABELS[key] || key,
      value: typeof value === 'boolean' ? (value ? 'да' : 'нет') : String(value),
    }));
}

export function AdminVoiceDiagnostics() {
  const [items, setItems] = useState<AdminVoiceDiagnosticSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [detail, setDetail] = useState<AdminVoiceDiagnosticDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [nextCursor, setNextCursor] = useState<AdminVoiceDiagnosticCursor | null>(null);
  const detailRequest = useRef(0);
  const listRequest = useRef(0);

  const loadPage = useCallback((cursor: AdminVoiceDiagnosticCursor | null, append: boolean) => {
    const request = ++listRequest.current;
    setLoading(true);
    setError('');
    api.adminVoiceDiagnostics({ limit: PAGE_SIZE, cursor: cursor || undefined })
      .then((response) => {
        if (listRequest.current !== request) return;
        setItems((current) => {
          if (!append) return response.items;
          const existing = new Set(current.map((item) => item.id));
          return current.concat(response.items.filter((item) => !existing.has(item.id)));
        });
        setNextCursor(response.nextCursor);
      })
      .catch((cause: any) => {
        if (listRequest.current === request) setError(cause?.message || 'Не удалось загрузить диагностику');
      })
      .finally(() => {
        if (listRequest.current === request) setLoading(false);
      });
  }, []);

  const load = useCallback(() => { loadPage(null, false); }, [loadPage]);

  useEffect(() => { load(); }, [load]);

  const open = (id: string) => {
    if (selectedId === id) {
      detailRequest.current += 1;
      setSelectedId('');
      setDetail(null);
      setDetailLoading(false);
      return;
    }
    const request = ++detailRequest.current;
    setSelectedId(id);
    setDetail(null);
    setDetailLoading(true);
    api.adminVoiceDiagnostic(id)
      .then((response) => { if (detailRequest.current === request) setDetail(response); })
      .catch((cause: any) => { if (detailRequest.current === request) setError(cause?.message || 'Не удалось открыть отчёт'); })
      .finally(() => { if (detailRequest.current === request) setDetailLoading(false); });
  };

  return (
    <section className="admin-diag" aria-labelledby="admin-diag-title">
      <div className="admin-diag-head">
        <div>
          <h2 id="admin-diag-title">Диагностика голоса</h2>
          <p>Технические состояния и метрики за последние 3 дня. Токены, адреса, ICE-кандидаты, SDP, идентификаторы устройств, сообщения и аудио не сохраняются.</p>
        </div>
        <button type="button" className="admin-refresh" aria-label="Обновить диагностику" onClick={load}><Icon name="refresh" sm /></button>
      </div>

      {error ? <div className="admin-msg err" role="alert">{error}</div> : null}
      {loading && !items.length ? <div className="admin-msg">Загрузка…</div> : null}
      {!loading && !items.length && !error ? <div className="admin-msg">Диагностических отчётов пока нет</div> : null}

      <div className="admin-diag-list">
        {items.map((item) => {
          const expanded = selectedId === item.id;
          return (
            <article className={'admin-diag-card' + (expanded ? ' open' : '')} key={item.id}>
              <button type="button" className="admin-diag-summary" onClick={() => open(item.id)} aria-expanded={expanded}>
                <span className="admin-diag-severity" aria-hidden="true" />
                <span className="admin-diag-main">
                  <b>{INCIDENT_LABELS[item.incident]}</b>
                  <small>@{item.username} · {item.client}/{item.platform} · {item.eventCount} событий</small>
                </span>
                <span className="admin-diag-time">
                  {new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(item.createdAt)}
                  <small>{formatDuration(item.durationMs)}</small>
                </span>
                <span className={'admin-chev' + (expanded ? ' open' : '')}><Icon name="chevron" sm /></span>
              </button>

              {expanded ? (
                <div className="admin-diag-detail">
                  {detailLoading ? <div className="admin-msg">Открываем отчёт…</div> : null}
                  {detail?.id === item.id ? (
                    <>
                      <div className="admin-diag-client">
                        <span><b>{detail.report.client.installMode}</b><small>запуск</small></span>
                        <span><b>{detail.report.client.networkType}</b><small>сеть</small></span>
                        <span><b>{detail.report.client.appVersion || '—'}</b><small>версия</small></span>
                        {detail.report.truncated ? <i>ранние события усечены лимитом</i> : null}
                      </div>
                      <ol className="admin-diag-timeline">
                        {detail.report.events.map((event, index) => (
                          <li key={`${event.atMs}-${event.kind}-${index}`}>
                            <time>+{formatDuration(event.atMs)}</time>
                            <div>
                              <b>{EVENT_LABELS[event.kind] || event.kind}</b>
                              {eventFacts(event).length ? (
                                <dl>{eventFacts(event).map((fact) => <span key={fact.label}><dt>{fact.label}</dt><dd>{fact.value}</dd></span>)}</dl>
                              ) : null}
                            </div>
                          </li>
                        ))}
                      </ol>
                    </>
                  ) : null}
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
      {nextCursor ? (
        <button
          type="button"
          className="admin-diag-more"
          disabled={loading}
          onClick={() => loadPage(nextCursor, true)}
        >
          {loading ? 'Загрузка…' : 'Загрузить ещё'}
        </button>
      ) : null}
    </section>
  );
}
