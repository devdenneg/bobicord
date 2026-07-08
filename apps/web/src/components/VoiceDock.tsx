import { useEffect } from 'react';
import { useStore, getEngine } from '../store';
import { useEngine } from '../hooks';
import { Icon } from '../Icon';
import { getSettings } from '../settings';
import { isTauri, onBroadcastStopped, stopNativeBroadcast } from '../native';

/* Вещание — только из нативного клиента (Evolution-TZ Э5 / CLAUDE.md инвариант 2).
   В браузере эта кнопка не рендерится вовсе. Конфиг источника/разрешения/битрейта
   и живая дебаг-статистика — в BroadcastModal (открывается по клику, живёт в
   глобальном сторе modal/broadcastLive, т.к. должна остаться открытой между
   ре-рендерами и переживать переключение вкладок сервера). */
function NativeBroadcastButton() {
  const eng = useEngine();
  const live = useStore((s) => s.broadcastLive);

  // Слушаем и когда модалка со статистикой закрыта — трансляция может
  // завершиться сама (например источник-окно закрыли, или энкодер/захват упали
  // фатально — mod.rs теперь шлёт это событие и в таких случаях тоже). Дополнительно
  // форсируем stop_broadcast: он же снимает Tauri-состояние (BroadcastState),
  // без этого повторный старт вечно отвечал бы «уже вещаем», даже когда трансляция
  // уже мертва.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    onBroadcastStopped((info) => {
      useStore.getState().setBroadcastLive(false);
      if (info.reason) useStore.getState().toast('Трансляция остановлена: ' + info.reason, 'err');
      stopNativeBroadcast().catch(() => {});
    }).then((u) => (unlisten = u));
    return () => unlisten?.();
  }, []);

  if (!eng.inVoice) return null;
  return (
    <button className={'cbtn' + (live ? ' danger-on' : '')} aria-pressed={live}
      data-tip={live ? 'Трансляция идёт' : 'Начать трансляцию экрана'}
      onClick={() => useStore.getState().setModal('broadcast')}>
      <Icon name={live ? 'screen-stop' : 'screen'} sm />
    </button>
  );
}

/* Веб-вещание — старый LiveKit-путь (VP8, через SFU), оставлен параллельно с
   нативным P2P-деревом (см. CLAUDE.md инвариант 2 / docs/Evolution-TZ.md, решение
   2026-07-06). Зритель сам определяет транспорт при `watch()` — тут ничего не меняем. */
function ShareButton() {
  const eng = useEngine();
  const E = getEngine()!;
  const me = useStore((s) => s.me)!;
  if (!eng.inVoice) return null;
  const live = !!eng.presence[me.username]?.streaming;
  return (
    <button className={'cbtn' + (live ? ' danger-on' : '')} aria-pressed={live}
      data-tip={live ? 'Трансляция идёт' : 'Транслировать экран'}
      onClick={() => E.share()}>
      <Icon name={live ? 'screen-stop' : 'screen'} sm />
    </button>
  );
}

function VoiceControls() {
  const eng = useEngine();
  const E = getEngine()!;
  const mode = getSettings().mode;
  const muted = eng.localMicMuted;
  const ptt = mode === 'ptt' && !eng.deafened;
  const micClass = 'cbtn' + (muted && !ptt ? ' danger-on' : '') + (muted && ptt && !eng.pttDown ? ' ptt-idle' : '') + (eng.pttDown ? ' ptt-live' : '');
  const q = eng.voiceQuality;
  const qLabel = q === 'excellent' ? 'отличное' : q === 'good' ? 'хорошее' : q === 'poor' ? 'слабое' : q === 'lost' ? 'потеряно' : 'соединение…';
  const qTip = (eng.voicePing != null ? eng.voicePing + ' мс' : '—') + ' · ' + qLabel;
  return (
    <div className="vc-controls">
      <div className={'conn-ind q-' + q} data-tip={qTip} aria-label={'Качество связи: ' + qTip} tabIndex={0}><i /><i /><i /></div>
      <span className="conn-ms">{eng.voicePing != null ? eng.voicePing + ' мс' : ''}</span>
      <button className={micClass} aria-pressed={muted} data-tip="Микрофон · M" onClick={() => E.toggleMic()}><Icon name={muted ? 'mic-off' : 'mic'} sm /></button>
      <button className={'cbtn' + (eng.deafened ? ' danger-on' : '')} aria-pressed={eng.deafened} data-tip="Заглушить · D" onClick={() => E.toggleDeaf()}><Icon name={eng.deafened ? 'head-off' : 'head'} sm /></button>
      {isTauri ? <NativeBroadcastButton /> : <ShareButton />}
      <button className="cbtn leave-v" data-tip="Выйти из голосового" onClick={() => E.leaveVoice()}><Icon name="leave" sm /></button>
    </div>
  );
}

// Персистентный голос-док (Discord-style): живёт на уровне App, виден на ВСЕХ экранах пока ты в
// голосовом — управляй голосом с главной / любого сервера. Показывает Канал / Сервер голоса,
// клик по заголовку → возврат на голосовой сервер. Не зависит от смотримого сервера (active).
export function VoiceDock() {
  const eng = useEngine();
  const view = useStore((s) => s.view);
  const servers = useStore((s) => s.servers);
  const active = useStore((s) => s.active);
  const openServer = useStore((s) => s.openServer);
  if (!eng.inVoice || !eng.voiceServerId) return null;
  const onVoiceServer = active?.id === eng.voiceServerId; // смотрю ли сейчас свой голосовой сервер
  const srv = servers.find((s) => s.id === eng.voiceServerId);
  const srvName = srv?.name || (onVoiceServer ? active?.name : '') || 'Голосовой';
  // имя канала знаем только когда смотрим голосовой сервер (у него в сторе есть channels); иначе — общий ярлык
  const chName = onVoiceServer ? (active?.channels?.find((c) => c.id === eng.myVoiceChannel)?.name || '') : '';
  const goToVoice = () => { if (eng.voiceServerId) openServer(eng.voiceServerId); };
  return (
    <div id="voicedock" className={view === 'server' ? 'on-server' : ''}>
      <div className="vd-info" role="button" tabIndex={0} data-tip="К голосовому серверу" onClick={goToVoice}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goToVoice(); } }}>
        <span className="vd-mark"><Icon name="speaker" sm /></span>
        <div className="vd-txt"><b>{chName || 'В голосовом'}</b><span>{srvName}</span></div>
      </div>
      <VoiceControls />
    </div>
  );
}
