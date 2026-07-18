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
      aria-label={live ? 'Трансляция идёт' : 'Транслировать экран'}
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
      aria-label={live ? 'Остановить трансляцию' : 'Транслировать экран'}
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
  const [activeIndex, setActiveIndex] = useState(0);
  const cur = kind === 'input' ? getSettings().input : getSettings().output;
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionCount = devs.length + 1;
  const focusOption = (index: number) => {
    const next = Math.max(0, Math.min(optionCount - 1, index));
    setActiveIndex(next);
    requestAnimationFrame(() => menuRef.current?.querySelector<HTMLElement>(`[data-menu-index="${next}"]`)?.focus());
  };
  const closeMenu = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  };
  const openMenu = (initial: 'selected' | 'first' | 'last' = 'selected') => {
    const selected = cur ? devs.findIndex((device) => device.deviceId === cur) + 1 : 0;
    const next = initial === 'first' ? 0 : initial === 'last' ? optionCount - 1 : Math.max(0, selected);
    setActiveIndex(next);
    setOpen(true);
    requestAnimationFrame(() => menuRef.current?.querySelector<HTMLElement>(`[data-menu-index="${next}"]`)?.focus());
  };
  useEffect(() => {
    if (!open) return;
    const load = () => Room.getLocalDevices(kind === 'input' ? 'audioinput' : 'audiooutput').then((d) => setDevs(d as MediaDeviceInfo[])).catch(() => {});
    load();
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) closeMenu(); };
    document.addEventListener('mousedown', onDoc);
    navigator.mediaDevices?.addEventListener?.('devicechange', load);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      navigator.mediaDevices?.removeEventListener?.('devicechange', load);
    };
  }, [open, kind]);
  useEffect(() => {
    if (open && activeIndex >= optionCount) focusOption(optionCount - 1);
  }, [activeIndex, open, optionCount]);
  const pick = (id: string) => {
    setSettings(kind === 'input' ? { input: id } : { output: id });
    if (kind === 'input') E?.reapplyMic(); else E?.applyOutput();
    closeMenu(true);
  };
  const onTriggerKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      openMenu(e.key === 'ArrowDown' ? 'first' : 'last');
    } else if (e.key === 'Escape' && open) {
      e.preventDefault();
      closeMenu(true);
    }
  };
  const onMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      focusOption((activeIndex + delta + optionCount) % optionCount);
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      focusOption(e.key === 'Home' ? 0 : optionCount - 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeMenu(true);
    } else if (e.key === 'Tab') {
      closeMenu();
    }
  };
  return (
    <div className="vd-devwrap" ref={ref}>
      <button ref={triggerRef} className={'vd-caret' + (open ? ' on' : '')} aria-expanded={open} aria-haspopup="menu" aria-controls={`vd-device-${kind}`}
        aria-label={kind === 'input' ? 'Выбрать микрофон' : 'Выбрать устройство вывода'}
        data-tip={kind === 'input' ? 'Выбрать микрофон' : 'Выбрать устройство вывода'}
        onKeyDown={onTriggerKeyDown}
        onClick={() => open ? closeMenu() : openMenu()}><Icon name="chevron" sm /></button>
      {open ? (
        <div ref={menuRef} id={`vd-device-${kind}`} className={'vd-devmenu' + (up ? ' up' : '')} role="menu"
          aria-label={kind === 'input' ? 'Микрофоны' : 'Устройства вывода'} onKeyDown={onMenuKeyDown}>
          <div className="vd-devh" aria-hidden="true">{kind === 'input' ? 'МИКРОФОН' : 'ВЫВОД ЗВУКА'}</div>
          <button role="menuitemradio" aria-checked={!cur} tabIndex={activeIndex === 0 ? 0 : -1} data-menu-index="0"
            className={'vd-devitem' + (!cur ? ' on' : '')} onFocus={() => setActiveIndex(0)} onClick={() => pick('')}>По умолчанию</button>
          {devs.map((d, index) => (
            <button role="menuitemradio" aria-checked={cur === d.deviceId} tabIndex={activeIndex === index + 1 ? 0 : -1}
              data-menu-index={index + 1} key={d.deviceId} className={'vd-devitem' + (cur === d.deviceId ? ' on' : '')}
              onFocus={() => setActiveIndex(index + 1)} onClick={() => pick(d.deviceId)}>
              {d.label || 'Устройство ' + d.deviceId.slice(0, 6)}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// Ряд контролов: мик (+▾ вход), наушники/оглох (+▾ вывод), трансляция, настройки. up — меню вверх (для дока внизу).
export function VoiceControls({ up }: { up?: boolean }) {
  const eng = useEngine();
  const E = getEngine()!;
  const mode = getSettings().mode;
  const muted = eng.localMicMuted;
  const ptt = mode === 'ptt' && !eng.deafened;
  const micClass = 'vd-btn' + (muted && !ptt ? ' danger-on' : '') + (muted && ptt && !eng.pttDown ? ' ptt-idle' : '') + (eng.pttDown ? ' ptt-live' : '');
  return (
    <div className="vd-controls">
      <div className="vd-grp">
        <button className={micClass} aria-pressed={muted} aria-label={muted ? 'Включить микрофон' : 'Выключить микрофон'} data-tip="Микрофон · M" onClick={() => E.toggleMic()}><Icon name={muted ? 'mic-off' : 'mic'} sm /></button>
        <DeviceMenu kind="input" up={up} />
      </div>
      <div className="vd-grp">
        <button className={'vd-btn' + (eng.deafened ? ' danger-on' : '')} aria-pressed={eng.deafened} aria-label={eng.deafened ? 'Включить звук' : 'Заглушить звук'} data-tip="Заглушить · D" onClick={() => E.toggleDeaf()}><Icon name={eng.deafened ? 'head-off' : 'head'} sm /></button>
        <DeviceMenu kind="output" up={up} />
      </div>
      {isTauri ? <NativeBroadcastButton /> : <ShareButton />}
      <button className="vd-btn vd-set" aria-label="Настройки звука" data-tip="Настройки звука" onClick={() => useStore.getState().setModal('settings')}><Icon name="gear" sm /></button>
    </div>
  );
}

// Общая панель голоса (внутри колонки каналов на сервере И в плавающем углу на главной).
// controls — рисовать ли ряд контролов (mic/наушники/трансляция/настройки). В server-view (inline)
// контролы живут в нижней аккаунт-панели (.user-panel), поэтому тут НЕ дублируем; на главной
// (floating) аккаунт-панели нет — контролы нужны здесь.
function VoicePanel({ controls }: { controls?: boolean }) {
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
        <button className="vd-btn vd-leave" aria-label="Выйти из голосового канала" data-tip="Выйти из голосового" onClick={() => E.leaveVoice()}><Icon name="leave" sm /></button>
      </div>
      {controls ? <VoiceControls up /> : null}
      <MusicPlayer enabled={!!srv?.musicEnabled} />
    </div>
  );
}

// variant: 'inline' — внутри колонки каналов (server-view), адаптируется по её ширине;
//          'floating' — компактный плавающий в левом нижнем углу (главная). Оба зовут одну VoicePanel.
export function VoiceDock({ variant }: { variant: 'inline' | 'floating' }) {
  const eng = useEngine();
  if (!eng.inVoice || !eng.voiceServerId) return null;
  // inline (server-view): контролы в нижней аккаунт-панели, тут только статус+выход+музыка.
  // floating (главная): аккаунт-панели нет → контролы здесь.
  if (variant === 'inline') return <div className="vd-inline"><VoicePanel controls={false} /></div>;
  return <div id="voicedock"><VoicePanel controls /></div>;
}
