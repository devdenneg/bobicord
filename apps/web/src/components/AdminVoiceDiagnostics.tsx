import { useCallback, useEffect, useRef, useState } from 'react';
import './AdminVoiceDiagnostics.css';
import { api } from '../api';
import type {
  AdminVoiceDiagnosticCursor,
  AdminVoiceDiagnosticDetail,
  AdminVoiceDiagnosticSummary,
  VoiceDiagnosticEvent,
  VoiceDiagnosticClientKind,
  VoiceDiagnosticIncident,
} from '../types';
import { Icon } from '../Icon';

const PAGE_SIZE = 50;

const INCIDENT_LABELS: Record<VoiceDiagnosticIncident, string> = {
  manual: 'Ручной отчёт',
  auth_failed: 'Ошибка входа в аккаунт',
  auth_recovered: 'Вход в аккаунт восстановлен',
  join_succeeded: 'Голосовой канал подключён',
  join_stuck: 'Медленное или зависшее подключение',
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
  stream_watch_succeeded: 'Трансляция подключена',
  stream_watch_failed: 'Трансляция не подключилась',
  stream_watch_recovered: 'Просмотр трансляции восстановлен',
};

const EVENT_LABELS: Partial<Record<VoiceDiagnosticEvent['kind'], string>> = {
  auth_request_started: 'Запрос авторизации начат',
  auth_request_finished: 'Запрос авторизации завершён',
  join_started: 'Подключение начато',
  intent_finished: 'Запрос на вход выполнен',
  hub_connected: 'Служебное соединение установлено',
  lease_claimed: 'Канал занят',
  media_token_received: 'Получен доступ к медиасоединению',
  media_connected: 'Медиасоединение установлено',
  media_activated: 'Медиасоединение активировано',
  mic_capture_finished: 'Захват микрофона готов',
  mic_published: 'Микрофон опубликован',
  mic_source_changed: 'Состояние источника микрофона изменено',
  rtc_sample: 'Показатели сети и аудио',
  network_changed: 'Сеть изменилась',
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
  stream_watch_started: 'Подключение к трансляции начато',
  stream_watch_step: 'Этап подключения к трансляции',
  stream_watch_retry: 'Повтор подключения к трансляции',
  stream_watch_finished: 'Подключение к трансляции завершено',
};

const FIELD_LABELS: Record<string, string> = {
  stage: 'этап', outcome: 'результат', code: 'код', httpStatus: 'HTTP',
  requestElapsedMs: 'запрос, мс',
  connectionState: 'соединение', iceState: 'ICE', trackState: 'трек',
  audioContextState: 'аудиоконтекст', outputRoute: 'выход', micMode: 'режим микрофона',
  audioSessionState: 'аудиосессия', audioSessionType: 'тип аудиосессии', captureEvent: 'событие захвата',
  rawTrackMuted: 'исходный трек заглушён', rawTrackEnabled: 'исходный трек включён',
  publishedTrackEnabled: 'отправляемый трек включён',
  micCapturePath: 'путь микрофона',
  outputTarget: 'источник вывода', outputOperation: 'операция вывода',
  watchEndReason: 'причина завершения просмотра',
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
  streamTransport: 'медиатранспорт',
};

const VALUE_LABELS: Record<string, string> = {
  active: 'активна',
  inactive: 'неактивна',
  interrupted: 'прервана системой',
  auto: 'автоматически',
  'play-and-record': 'запись и воспроизведение',
  ambient: 'смешиваемый звук',
  transient: 'кратковременный звук',
  'transient-solo': 'кратковременный эксклюзивный звук',
  mute: 'источник заглушён',
  unmute: 'источник возобновлён',
  session_state: 'изменение аудиосессии',
  auth_login: 'вход в аккаунт',
  auth_session: 'проверка сессии',
  auth_profile: 'загрузка профиля',
  direct: 'прямой аудиотрек',
  webaudio: 'обработка WebAudio',
  intent: 'запрос на вход',
  hub: 'служебное соединение',
  claim: 'выбор голосового канала',
  media_token: 'доступ к медиасоединению',
  media_connect: 'медиасоединение',
  activation: 'активация медиа',
  mic_capture: 'захват микрофона',
  mic_publish: 'публикация микрофона',
  mic_recovery: 'восстановление микрофона',
  playback: 'воспроизведение',
  output_route: 'выбор аудиовыхода',
  rtc: 'показатели сети',
  ui: 'интерфейс',
  watch_intent: 'намерение смотреть',
  watch_auth: 'авторизация',
  watch_listeners: 'слушатели клиента',
  watch_native_start: 'запуск нативного просмотра',
  watch_signaling: 'сигналинг',
  watch_join: 'вход в дерево трансляции',
  watch_parent: 'назначение источника',
  watch_negotiation: 'согласование WebRTC',
  watch_track: 'получение видеотрека',
  watch_playback: 'декодирование и показ',
  watch_recovery: 'восстановление просмотра',
  started: 'начато',
  ok: 'успешно',
  failed: 'ошибка',
  timed_out: 'истекло время ожидания',
  blocked: 'заблокировано браузером',
  unsupported: 'не поддерживается',
  cancelled: 'отменено',
  superseded: 'заменено новой попыткой',
  stalled: 'нет прогресса',
  recovered: 'восстановлено',
  none: 'без ошибки',
  timeout: 'превышено время ожидания',
  network: 'ошибка сети',
  offline: 'устройство офлайн',
  auth: 'ошибка авторизации',
  rate_limited: 'слишком много запросов',
  server: 'ошибка сервера',
  invalid_response: 'некорректный ответ',
  permission: 'нет разрешения',
  media_blocked: 'медиа заблокировано браузером',
  disconnected: 'соединение разорвано',
  sdk: 'ошибка медиадвижка',
  aborted: 'попытка прервана',
  invalid_state: 'контекст страницы недействителен',
  session_closing: 'предыдущая медиасессия завершается',
  unknown: 'неизвестно',
  signaling_unauthorized: 'сигналинг: сессия не авторизована',
  signaling_forbidden: 'сигналинг: доступ запрещён',
  listener_failed: 'не удалось подключить слушатели клиента',
  native_start_failed: 'не удалось запустить нативный просмотр',
  signaling_closed: 'сигналинг закрылся',
  no_parent: 'источник трансляции не назначен',
  negotiation_failed: 'согласование WebRTC не удалось',
  ice_failed: 'ICE-соединение не установлено',
  track_missing: 'видеотрек не получен',
  decode_timeout: 'кадр не декодирован вовремя',
  playback_waiting: 'воспроизведение ожидает запуска',
  user_close: 'пользователь закрыл трансляцию',
  view_switch: 'переход на другой сервер',
  server_exit: 'выход с сервера',
  auth_handoff: 'обновление авторизации',
  session_terminal: 'завершение сессии',
  logout: 'выход из аккаунта',
  engine_dispose: 'остановка медиадвижка',
  connection_loss: 'потеря соединения',
  stream_ended: 'трансляция завершена',
  quality_change: 'смена качества',
  recovery_failed: 'восстановление просмотра не удалось',
  playback_timeout: 'истекло время ожидания воспроизведения',
  livekit: 'LiveKit',
  tree_web: 'дерево — браузер',
  tree_native: 'дерево — клиент',
  voice_mixer: 'голосовой микшер',
  media_element: 'медиаэлемент',
  stream_mixer: 'микшер трансляции',
  context_recovery: 'восстановление аудиоконтекста',
  enumerate: 'поиск системного устройства',
  set_sink: 'переключение устройства',
  create_context: 'создание аудиоконтекста',
  rebind: 'перепривязка микшера',
  resume: 'возобновление аудиоконтекста',
  start_audio: 'запуск воспроизведения комнаты',
  new: 'создано',
  connecting: 'подключается',
  connected: 'подключено',
  reconnecting: 'переподключается',
  closed: 'закрыто',
  checking: 'проверка',
  completed: 'завершено',
  live: 'активен',
  ended: 'завершён',
  missing: 'отсутствует',
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
      value: key === 'httpStatus' && value === 0 ? 'нет ответа'
        : typeof value === 'boolean' ? (value ? 'да' : 'нет') : (VALUE_LABELS[String(value)] || String(value)),
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
  const [incident, setIncident] = useState<VoiceDiagnosticIncident | ''>('');
  const [client, setClient] = useState<VoiceDiagnosticClientKind | ''>('');
  const detailRequest = useRef(0);
  const listRequest = useRef(0);

  const loadPage = useCallback((cursor: AdminVoiceDiagnosticCursor | null, append: boolean) => {
    const request = ++listRequest.current;
    setLoading(true);
    setError('');
    if (!append) {
      setItems([]);
      setNextCursor(null);
      detailRequest.current += 1;
      setSelectedId('');
      setDetail(null);
      setDetailLoading(false);
    }
    api.adminVoiceDiagnostics({ limit: PAGE_SIZE, cursor: cursor || undefined, incident: incident || undefined, client: client || undefined })
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
  }, [incident, client]);

  const load = useCallback(() => { loadPage(null, false); }, [loadPage]);

  useEffect(() => {
    load();
    return () => { listRequest.current += 1; detailRequest.current += 1; };
  }, [load]);

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
          <h2 id="admin-diag-title">Диагностика связи</h2>
          <p>Технические состояния голоса и подключения к трансляциям за последние 3 дня. В этом разделе не сохраняются токены, адреса, ICE-кандидаты, SDP, идентификаторы устройств, сообщения и аудио.</p>
        </div>
        <button type="button" className="admin-refresh" aria-label="Обновить диагностику" onClick={load}><Icon name="refresh" sm /></button>
      </div>

      <div className="admin-diag-filters">
        <label>Событие<select value={incident} onChange={(event) => setIncident(event.target.value as VoiceDiagnosticIncident | '')}>
          <option value="">Все события</option>
          {Object.entries(INCIDENT_LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
        </select></label>
        <label>Клиент<select value={client} onChange={(event) => setClient(event.target.value as VoiceDiagnosticClientKind | '')}>
          <option value="">Все клиенты</option><option value="web">Браузер</option><option value="native">Приложение</option>
        </select></label>
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
                <span className={'admin-diag-severity' + (item.incident === 'join_succeeded' || item.incident === 'stream_watch_succeeded' || item.incident === 'auth_recovered' ? ' success' : '')} aria-hidden="true" />
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
                      <p className="admin-diag-timeline-hint">Время от начала сессии; Δ — интервал после предыдущего события.</p>
                      <ol className="admin-diag-timeline">
                        {detail.report.events.map((event, index) => (
                          <li key={`${event.atMs}-${event.kind}-${index}`}>
                            <time>+{formatDuration(event.atMs)}{index > 0 ? <small>Δ {formatDuration(Math.max(0, event.atMs - detail.report.events[index - 1].atMs))}</small> : null}</time>
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
