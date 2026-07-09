import { useEffect, useRef, useState } from 'react';
import { Room } from 'livekit-client';
import { useStore, getEngine } from '../store';
import { useEngine } from '../hooks';
import { Icon } from '../Icon';
import { MusicPlayer } from './MusicPlayer';
import { getSettings, setSettings } from '../settings';
import { isTauri, onBroadcastStopped, stopNativeBroadcast } from '../native';
import { endAnyBroadcasterSession } from '../diag';

/* Вещание — только из нативного клиента (CLAUDE.md инвариант 2). Конфиг/статистика — в BroadcastModal. */
function NativeBroadcastButton() {
  const eng = useEngine();
  const live = useStore((s) => s.broadcastLive);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    onBroadcastStopped((info) => {
      useStore.getState().setBroadcastLive(false);
      if (info.reason) useStore.getState().toast('Трансляция остановлена: ' + info.reason, 'err');
      // Трансляция умерла сама — самый интересный случай для разбора: сдаём лог сессии,
      // где причина (`reason`) уже записана строками энкодера/захвата.
      stopNativeBroadcast().catch(() => {}).finally(() => endAnyBroadcasterSession());
    }).then((u) => (unlisten = u));
    return () => unlisten?.();
  }, []);
  if (!eng.inVoice) return null;
  return (
    <button className={'vd-btn' + (live ? ' danger-on' : '')} aria-pressed={live}
      data-tip={live ? 'Трансляция идёт' : 'Транслировать экран'}
      onClick={() => useStore.getState().setModal('broadcast')}>
      <Icon name={live ? 'screen-stop' : 'screen'} sm />
    </button>
  );
}

/* Веб-вещание — LiveKit-путь (VP8/SFU). */
function ShareButton() {
  const eng = useEngine();
  const E = getEngine()!;
  const me = useStore((s) => s.me)!;
  if (!eng.inVoice) return null;
  const live = !!eng.presence[me.username]?.streaming;
  return (
    <button className={'vd-btn' + (live ? ' danger-on' : '')} aria-pressed={live}
      data-tip={live ? 'Трансляция идёт' : 'Транслировать экран'}
      onClick={() => E.share()}>
      <Icon name={live ? 'screen-stop' : 'screen'} sm />
    </button>
  );
}

// Дропдаун выбора устройства (как в Discord: ▾ у мика = выбор входа, у наушников = выбор вывода).
function DeviceMenu({ kind, up }: { kind: 'input' | 'output'; up?: boolean }) {
  const E = getEngine();
  const [open, setOpen] = useState(false);
  const [devs, setDevs] = useState<MediaDeviceInfo[]>([]);
  const cur = kind === 'input' ? getSettings().input : getSettings().output;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    Room.getLocalDevices(kind === 'input' ? 'audioinput' : 'audiooutput').then((d) => setDevs(d as MediaDeviceInfo[])).catch(() => {});
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open, kind]);
  const pick = (id: string) => {
    setSettings(kind === 'input' ? { input: id } : { output: id });
    if (kind === 'input') E?.reapplyMic(); else E?.applyOutput();
    setOpen(false);
  };
  return (
    <div className="vd-devwrap" ref={ref}>
      <button className={'vd-caret' + (open ? ' on' : '')} aria-expanded={open}
        data-tip={kind === 'input' ? 'Выбрать микрофон' : 'Выбрать устройство вывода'}
        onClick={() => setOpen((o) => !o)}><Icon name="chevron" sm /></button>
      {open ? (
        <div className={'vd-devmenu' + (up ? ' up' : '')}>
          <div className="vd-devh">{kind === 'input' ? 'МИКРОФОН' : 'ВЫВОД ЗВУКА'}</div>
          <button className={'vd-devitem' + (!cur ? ' on' : '')} onClick={() => pick('')}>По умолчанию</button>
          {devs.map((d) => (
            <button key={d.deviceId} className={'vd-devitem' + (cur === d.deviceId ? ' on' : '')} onClick={() => pick(d.deviceId)}>
              {d.label || 'Устройство ' + d.deviceId.slice(0, 6)}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// Ряд контролов: мик (+▾ вход), наушники/оглох (+▾ вывод), трансляция, настройки. up — меню вверх (для дока внизу).
function VoiceControls({ up }: { up?: boolean }) {
  const eng = useEngine();
  const E = getEngine()!;
  const mode = getSettings().mode;
  const muted = eng.localMicMuted;
  const ptt = mode === 'ptt' && !eng.deafened;
  const micClass = 'vd-btn' + (muted && !ptt ? ' danger-on' : '') + (muted && ptt && !eng.pttDown ? ' ptt-idle' : '') + (eng.pttDown ? ' ptt-live' : '');
  return (
    <div className="vd-controls">
      <div className="vd-grp">
        <button className={micClass} aria-pressed={muted} data-tip="Микрофон · M" onClick={() => E.toggleMic()}><Icon name={muted ? 'mic-off' : 'mic'} sm /></button>
        <DeviceMenu kind="input" up={up} />
      </div>
      <div className="vd-grp">
        <button className={'vd-btn' + (eng.deafened ? ' danger-on' : '')} aria-pressed={eng.deafened} data-tip="Заглушить · D" onClick={() => E.toggleDeaf()}><Icon name={eng.deafened ? 'head-off' : 'head'} sm /></button>
        <DeviceMenu kind="output" up={up} />
      </div>
      {isTauri ? <NativeBroadcastButton /> : <ShareButton />}
      <button className="vd-btn vd-set" data-tip="Настройки звука" onClick={() => useStore.getState().setModal('settings')}><Icon name="gear" sm /></button>
    </div>
  );
}

// Общая панель голоса (внутри колонки каналов на сервере И в плавающем углу на главной).
function VoicePanel() {
  const eng = useEngine();
  const E = getEngine()!;
  const servers = useStore((s) => s.servers);
  const active = useStore((s) => s.active);
  const openServer = useStore((s) => s.openServer);
  const onVoiceServer = active?.id === eng.voiceServerId;
  const srv = servers.find((s) => s.id === eng.voiceServerId);
  const srvName = srv?.name || (onVoiceServer ? active?.name : '') || 'Голосовой сервер';
  const chName = onVoiceServer ? (active?.channels?.find((c) => c.id === eng.myVoiceChannel)?.name || '') : '';
  const goToVoice = () => { if (eng.voiceServerId) openServer(eng.voiceServerId); };
  const q = eng.voiceQuality;
  const qLabel = q === 'excellent' ? 'отличное' : q === 'good' ? 'хорошее' : q === 'poor' ? 'слабое' : q === 'lost' ? 'потеряно' : 'соединение…';
  const qTip = (eng.voicePing != null ? eng.voicePing + ' мс' : '—') + ' · ' + qLabel;
  const status = eng.voiceConnecting ? 'Подключение…' : 'Голосовая связь подключена';
  return (
    <div className="vd-panel">
      <div className="vd-status">
        <button className="vd-info" onClick={goToVoice} data-tip="К голосовому серверу">
          <span className="vd-mark"><Icon name="speaker" sm /></span>
          <div className="vd-txt"><b>{status}</b><span>{chName ? chName + ' · ' : ''}{srvName}</span></div>
        </button>
        <div className={'conn-ind q-' + q} data-tip={qTip} aria-label={'Качество связи: ' + qTip} tabIndex={0}><i /><i /><i /></div>
        <button className="vd-btn vd-leave" data-tip="Выйти из голосового" onClick={() => E.leaveVoice()}><Icon name="leave" sm /></button>
      </div>
      <VoiceControls up />
      <MusicPlayer />
    </div>
  );
}

// variant: 'inline' — внутри колонки каналов (server-view), адаптируется по её ширине;
//          'floating' — компактный плавающий в левом нижнем углу (главная). Оба зовут одну VoicePanel.
export function VoiceDock({ variant }: { variant: 'inline' | 'floating' }) {
  const eng = useEngine();
  if (!eng.inVoice || !eng.voiceServerId) return null;
  if (variant === 'inline') return <div className="vd-inline"><VoicePanel /></div>;
  return <div id="voicedock"><VoicePanel /></div>;
}
