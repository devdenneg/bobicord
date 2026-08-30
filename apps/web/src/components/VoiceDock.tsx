import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Room } from 'livekit-client';
import { useStore, getEngine } from '../store';
import { useEngine } from '../hooks';
import { Icon } from '../Icon';
import { getSettings, setSettings } from '../settings';
import { isTauri, onBroadcastStopped, stopNativeBroadcast } from '../native';
import { endAnyBroadcasterSession } from '../diag';
import {
  audioDeviceSelectionMissing,
  audioDeviceChoices,
  audioOutputChoices,
  currentAppleMobilePlatform,
  directAudioOutputSelectionSupported,
  loadAudioDevices,
  type AudioDeviceChoice,
} from '../audioDevices';
import { latchRejectedPttHold, PrimaryPointerHold, suppressPointerToggleWhilePtt, webScreenShareSupported } from '../mobileControls';

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
  const supported = webScreenShareSupported(typeof navigator === 'undefined' ? null : navigator.mediaDevices);
  // iOS/unsupported browsers cannot satisfy this action. Do not render a dead control that only
  // produces an error toast; if a live stream outlives capability detection, keep its Stop action.
  if (!live && !supported) return null;
  return (
    <button className={'vd-btn' + (live ? ' danger-on' : '')} aria-pressed={live}
      aria-label={live ? 'Остановить трансляцию' : 'Транслировать экран'}
      data-tip={live ? 'Трансляция идёт' : 'Транслировать экран'}
      onClick={() => live ? E.stopShare() : E.share()}>
      <Icon name={live ? 'screen-stop' : 'screen'} sm />
    </button>
  );
}

// Дропдаун выбора устройства (как в Discord: ▾ у мика = выбор входа, у наушников = выбор вывода).
function DeviceMenu({ kind, up }: { kind: 'input' | 'output'; up?: boolean }) {
  const E = getEngine();
  const [open, setOpen] = useState(false);
  const [devs, setDevs] = useState<AudioDeviceChoice[]>([]);
  const [outputViaInput, setOutputViaInput] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [partial, setPartial] = useState(false);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [position, setPosition] = useState<{ left: number; top: number; maxHeight: number; above: boolean } | null>(null);
  const appleMobile = currentAppleMobilePlatform();
  const cur = kind === 'input' || outputViaInput ? getSettings().input : getSettings().output;
  const selectionMissing = loaded && !loading && audioDeviceSelectionMissing(cur, devs);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const reloadRef = useRef<(forcePermission?: boolean) => void>(() => {});
  const openFocusRef = useRef<'selected' | 'first' | 'last'>('selected');
  const optionCount = devs.length + 1;
  const focusOption = (index: number) => {
    const next = Math.max(0, Math.min(optionCount - 1, index));
    setActiveIndex(next);
    requestAnimationFrame(() => menuRef.current?.querySelector<HTMLElement>(`[data-menu-index="${next}"]`)?.focus());
  };
  const closeMenu = (restoreFocus = false) => {
    setOpen(false);
    setPosition(null);
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  };
  const openMenu = (initial: 'selected' | 'first' | 'last' = 'selected') => {
    openFocusRef.current = initial;
    const selected = cur ? devs.findIndex((device) => device.id === cur) + 1 : 0;
    const next = initial === 'first' ? 0 : initial === 'last' ? optionCount - 1 : Math.max(0, selected);
    setActiveIndex(next);
    setPosition(null);
    setDevs([]);
    setLoaded(false);
    setLoadFailed(false);
    setPartial(false);
    setPermissionDenied(false);
    setOpen(true);
    requestAnimationFrame(() => menuRef.current?.querySelector<HTMLElement>(`[data-menu-index="${next}"]`)?.focus());
  };
  useEffect(() => {
    if (!open) return;
    let disposed = false;
    let requestId = 0;
    let timer: number | null = null;
    const load = (forcePermission = false) => {
      const id = ++requestId;
      setLoading(true);
      setLoaded(false);
      setLoadFailed(false);
      const request = loadAudioDevices(
        (deviceKind, requestPermissions) => Room.getLocalDevices(deviceKind, requestPermissions),
        { forcePermission },
      );
      const apply = (result: Awaited<typeof request.bounded>) => {
        if (disposed || id !== requestId) return;
        const output = audioOutputChoices(
          appleMobile,
          result.inputs,
          result.outputs,
          directAudioOutputSelectionSupported(),
        );
        const viaInput = kind === 'output' && output.viaInput;
        const choices = kind === 'input'
          ? audioDeviceChoices(result.inputs, 'Микрофон')
          : output.choices;
        const failed = kind === 'input'
          ? result.inputFailed
          : (viaInput ? result.inputFailed : result.outputFailed);
        if (!failed) {
          setDevs(choices);
          setOutputViaInput(viaInput);
        }
        setLoadFailed(failed);
        setPartial(result.partial);
        setPermissionDenied(result.permissionDenied);
        setLoading(false);
        setLoaded(!failed && !result.partial);
        const selectedId = kind === 'input' || viaInput ? getSettings().input : getSettings().output;
        const selected = selectedId ? choices.findIndex((device) => device.id === selectedId) + 1 : 0;
        const intent = openFocusRef.current;
        const next = intent === 'first' ? 0 : intent === 'last' ? choices.length : Math.max(0, selected);
        openFocusRef.current = 'selected';
        setActiveIndex(next);
        requestAnimationFrame(() => menuRef.current?.querySelector<HTMLElement>(`[data-menu-index="${next}"]`)?.focus());
      };
      void request.bounded.then(apply);
      void request.settled.then(apply);
    };
    reloadRef.current = load;
    const onDeviceChange = () => {
      if (timer != null) window.clearTimeout(timer);
      setDevs([]);
      setLoaded(false);
      setLoadFailed(false);
      setLoading(true);
      timer = window.setTimeout(() => { timer = null; load(false); }, 150);
    };
    load(false);
    const onDoc = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target || ref.current?.contains(target) || menuRef.current?.contains(target)) return;
      closeMenu();
    };
    document.addEventListener('pointerdown', onDoc, true);
    navigator.mediaDevices?.addEventListener?.('devicechange', onDeviceChange);
    return () => {
      disposed = true;
      requestId++;
      if (timer != null) window.clearTimeout(timer);
      if (reloadRef.current === load) reloadRef.current = () => {};
      document.removeEventListener('pointerdown', onDoc, true);
      navigator.mediaDevices?.removeEventListener?.('devicechange', onDeviceChange);
    };
  }, [appleMobile, open, kind]);
  useLayoutEffect(() => {
    if (!open) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const trigger = triggerRef.current;
      const menu = menuRef.current;
      if (!trigger || !menu) return;

      const triggerRect = trigger.getBoundingClientRect();
      const menuWidth = menu.offsetWidth || 210;
      const naturalHeight = Math.min(menu.scrollHeight || menu.offsetHeight || 250, 250);
      const viewportWidth = document.documentElement.clientWidth;
      const viewportHeight = document.documentElement.clientHeight;
      const gutter = 8;
      const gap = 6;
      const availableAbove = Math.max(0, triggerRect.top - gap - gutter);
      const availableBelow = Math.max(0, viewportHeight - gutter - triggerRect.bottom - gap);
      const preferredSpace = up ? availableAbove : availableBelow;
      const fallbackSpace = up ? availableBelow : availableAbove;
      const usePreferredSide = preferredSpace >= naturalHeight || preferredSpace >= fallbackSpace;
      const placeAbove = usePreferredSide ? !!up : !up;
      const available = placeAbove ? availableAbove : availableBelow;
      const maxHeight = Math.max(1, Math.min(250, available));
      const renderedHeight = Math.min(naturalHeight, maxHeight);
      const maxLeft = Math.max(gutter, viewportWidth - gutter - menuWidth);
      const left = Math.min(Math.max(triggerRect.left, gutter), maxLeft);
      const desiredTop = placeAbove ? triggerRect.top - gap - renderedHeight : triggerRect.bottom + gap;
      const maxTop = Math.max(gutter, viewportHeight - gutter - renderedHeight);
      const top = Math.min(Math.max(desiredTop, gutter), maxTop);

      setPosition((current) => current
        && Math.abs(current.left - left) < .5
        && Math.abs(current.top - top) < .5
        && Math.abs(current.maxHeight - maxHeight) < .5
        && current.above === placeAbove
        ? current
        : { left, top, maxHeight, above: placeAbove });
    };
    const scheduleUpdate = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };

    update();
    window.addEventListener('resize', scheduleUpdate);
    window.addEventListener('scroll', scheduleUpdate, true);
    window.visualViewport?.addEventListener('resize', scheduleUpdate);
    window.visualViewport?.addEventListener('scroll', scheduleUpdate);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(scheduleUpdate);
    if (menuRef.current) observer?.observe(menuRef.current);
    if (triggerRef.current) observer?.observe(triggerRef.current);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('resize', scheduleUpdate);
      window.removeEventListener('scroll', scheduleUpdate, true);
      window.visualViewport?.removeEventListener('resize', scheduleUpdate);
      window.visualViewport?.removeEventListener('scroll', scheduleUpdate);
      observer?.disconnect();
    };
  }, [devs.length, open, up]);
  useEffect(() => {
    if (open && activeIndex >= optionCount) focusOption(optionCount - 1);
  }, [activeIndex, open, optionCount]);
  const pick = (id: string) => {
    if (kind === 'input') {
      setSettings({ input: id });
      if (E) void E.reapplyMic().finally(() => E.restartLevelMeter());
    } else if (outputViaInput) {
      // iOS/iPadOS связывает Speakerphone/earpiece с audioinput, хотя для пользователя это
      // именно маршрут вывода. Переснимаем мик один раз и затем возобновляем удалённый звук.
      setSettings({ input: id, output: '' });
      if (E) void E.reapplyMic('route').finally(() => {
        void E.applyOutput();
        E.restartLevelMeter();
      });
    } else {
      setSettings({ output: id });
      void E?.applyOutput();
    }
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
  const menu = open && typeof document !== 'undefined' ? createPortal(
    <div ref={menuRef} id={`vd-device-${kind}`}
      className={'vd-devmenu' + ((position?.above ?? up) ? ' up' : '') + (position ? ' ready' : '')}
      style={position ? {
        '--vd-menu-left': `${position.left}px`,
        '--vd-menu-top': `${position.top}px`,
        '--vd-menu-max-height': `${position.maxHeight}px`,
      } as React.CSSProperties : undefined}
      role="menu" aria-label={kind === 'input' ? 'Микрофоны' : 'Устройства вывода'} aria-busy={loading} onKeyDown={onMenuKeyDown}>
      <div className="vd-devh" aria-hidden="true">{kind === 'input' ? 'МИКРОФОН' : (outputViaInput ? 'МАРШРУТ ЗВУКА' : 'ВЫВОД ЗВУКА')}</div>
      {loading ? <div className="vd-devstatus" role="status" aria-live="polite">Обновляем список…</div> : null}
      {loadFailed ? <div className="vd-devstatus is-error" role="status">Не удалось получить устройства</div> : null}
      {!loading && permissionDenied ? <div className="vd-devstatus is-error" role="status">Доступ к микрофону запрещён</div> : null}
      {!loading && partial && !permissionDenied && !loadFailed ? <div className="vd-devstatus" role="status">Показан неполный список</div> : null}
      {!loading && (partial || loadFailed) ? <button type="button" className="vd-devitem" onClick={() => reloadRef.current(true)}>Повторить поиск</button> : null}
      {selectionMissing ? <div className="vd-devstatus warn" role="status">Выбранное устройство отключено</div> : null}
      <button role="menuitemradio" aria-checked={!cur || selectionMissing} tabIndex={activeIndex === 0 ? 0 : -1} data-menu-index="0"
        className={'vd-devitem' + (!cur || selectionMissing ? ' on' : '')} onFocus={() => setActiveIndex(0)} onClick={() => pick('')}>{outputViaInput ? 'Автоматически' : 'По умолчанию'}</button>
      {devs.map((d, index) => (
        <button role="menuitemradio" aria-checked={cur === d.id} tabIndex={activeIndex === index + 1 ? 0 : -1}
          data-menu-index={index + 1} key={d.id} className={'vd-devitem' + (cur === d.id ? ' on' : '')}
          onFocus={() => setActiveIndex(index + 1)} onClick={() => pick(d.id)}>
          {d.label}
        </button>
      ))}
    </div>,
    document.body,
  ) : null;
  // На iPhone/iPad встроенные «микрофоны» Speakerphone/earpiece на самом деле являются
  // системными аудиомаршрутами. Показываем их только у вывода, чтобы не провоцировать
  // бессмысленное переключение микрофона по кругу.
  if (kind === 'input' && appleMobile) return null;
  const selectedLabel = devs.find((device) => device.id === cur)?.label;
  const triggerLabel = kind === 'input' ? 'Выбрать микрофон' : 'Выбрать устройство вывода';
  return <>
    <div className="vd-devwrap" ref={ref}>
      <button ref={triggerRef} className={'vd-caret' + (open ? ' on' : '')} aria-expanded={open} aria-haspopup="menu" aria-controls={`vd-device-${kind}`}
        aria-label={`${triggerLabel}: ${selectionMissing ? 'выбранное устройство отключено' : (selectedLabel || (cur ? 'выбранное устройство' : (outputViaInput ? 'автоматически' : 'по умолчанию')))}`}
        data-tip={open ? undefined : (kind === 'input' ? 'Выбрать микрофон' : 'Выбрать устройство вывода')}
        onKeyDown={onTriggerKeyDown}
        onClick={() => open ? closeMenu() : openMenu()}><Icon name="chevron" sm /></button>
    </div>
    {menu}
  </>;
}

// Ряд контролов: мик (+▾ вход), наушники/оглох (+▾ вывод), трансляция, настройки. up — меню вверх (для дока внизу).
export function VoiceControls({ up }: { up?: boolean }) {
  const eng = useEngine();
  const E = getEngine()!;
  const mode = getSettings().mode;
  const muted = eng.localMicMuted;
  const recovering = !!eng.micRecovering;
  const ptt = mode === 'ptt' && !eng.deafened;
  const connection = eng.voiceConnection ?? (eng.reconnecting ? 'reconnecting' : (eng.voiceConnecting ? 'connecting' : (eng.inVoice ? 'connected' : 'disconnected')));
  const pttLive = ptt && eng.pttDown && !muted && connection === 'connected';
  const pttIdle = ptt && !pttLive;
  const pttHoldReady = ptt && !muted && !recovering && connection === 'connected';
  const micClosed = muted || pttIdle;
  const micClass = 'vd-btn' + (muted ? ' danger-on' : (pttLive ? ' ptt-live' : (pttIdle ? ' ptt-idle' : '')))
    + (pttHoldReady ? ' vd-ptt-hold' : '');
  const pttPointer = useRef(new PrimaryPointerHold());
  const suppressPttClick = useRef(false);
  const releasePttPointer = (pointerId?: number) => {
    const released = pointerId === undefined
      ? pttPointer.current.cancel()
      : pttPointer.current.end(pointerId);
    if (released) E.pttRelease();
  };
  useEffect(() => {
    if (!pttHoldReady) releasePttPointer();
    const releaseWhenHidden = () => { if (document.hidden) releasePttPointer(); };
    const releaseOnPageHide = () => releasePttPointer();
    document.addEventListener('visibilitychange', releaseWhenHidden);
    window.addEventListener('pagehide', releaseOnPageHide);
    return () => {
      document.removeEventListener('visibilitychange', releaseWhenHidden);
      window.removeEventListener('pagehide', releaseOnPageHide);
      releasePttPointer();
    };
  }, [pttHoldReady, E]);
  // «Недоступен» и «я себя замутил» — разные состояния: раньше оба выглядели как обычный мут, и когда
  // микрофон пропадал и возвращался сам, это читалось как «кнопка переключается сама по себе».
  const micLabel = eng.micUnavailable
    ? 'Микрофон недоступен — нажми, чтобы подключить'
    : (muted ? 'Включить микрофон' : (recovering ? 'Микрофон восстанавливается'
      : (pttIdle ? 'PTT: микрофон закрыт' : (pttLive ? 'PTT: идёт передача' : 'Выключить микрофон'))));
  return (
    <div className="vd-controls">
      <div className="vd-grp">
        <button className={micClass} aria-pressed={ptt ? pttLive : muted} aria-busy={recovering || undefined}
          aria-label={micLabel} data-tip={ptt || eng.micUnavailable || recovering ? micLabel : 'Микрофон · M'}
          onPointerDown={(event) => {
            if (!pttHoldReady) {
              // Capture this decision now: recovery may finish and rerender before the browser
              // emits click for the same pointer, but that rejected hold must still be consumed.
              suppressPttClick.current = latchRejectedPttHold(ptt, recovering, muted);
              return;
            }
            if (!pttPointer.current.begin(event.pointerId, event.isPrimary, event.button)) return;
            suppressPttClick.current = true;
            try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /** implicit touch capture remains */ }
            E.pttPress();
          }}
          onPointerUp={(event) => releasePttPointer(event.pointerId)}
          onPointerCancel={(event) => releasePttPointer(event.pointerId)}
          onLostPointerCapture={(event) => releasePttPointer(event.pointerId)}
          onContextMenu={(event) => { if (pttHoldReady) event.preventDefault(); }}
          onClick={(event) => {
            // A recovering PTT pipeline is temporarily unable to accept a hold. Do not reinterpret
            // the synthetic click following that rejected pointer-down as a persistent mute toggle.
            if (ptt && recovering && !muted) {
              event.preventDefault();
              return;
            }
            if (suppressPttClick.current && suppressPointerToggleWhilePtt(true, event.detail)) {
              suppressPttClick.current = false;
              event.preventDefault();
              return;
            }
            E.toggleMic();
          }}><Icon name={micClosed ? 'mic-off' : 'mic'} sm /></button>
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
  const voiceServerId = eng.voiceServerId || eng.lostVoiceServerId || null;
  const voiceChannel = eng.myVoiceChannel || eng.lostVoiceChannel || null;
  const connection = eng.voiceConnection ?? (eng.reconnecting ? 'reconnecting' : (eng.voiceConnecting ? 'connecting' : (eng.inVoice ? 'connected' : 'disconnected')));
  const disconnected = connection === 'disconnected';
  const onVoiceServer = active?.id === voiceServerId;
  const srv = servers.find((s) => s.id === voiceServerId);
  const srvName = srv?.name || (onVoiceServer ? active?.name : '') || 'Голосовой сервер';
  const chName = onVoiceServer ? (active?.channels?.find((c) => c.id === voiceChannel)?.name || '') : '';
  const canReconnect = disconnected && onVoiceServer && !!voiceChannel && eng.roomReady;
  const goToVoice = () => {
    if (canReconnect && voiceChannel) { void E.joinVoice(voiceChannel); return; }
    if (voiceServerId) openServer(voiceServerId);
  };
  const q = connection === 'connected' ? eng.voiceQuality : (connection === 'connecting' ? 'unknown' : 'lost');
  const qLabel = connection === 'reconnecting' ? 'переподключение'
    : disconnected ? 'нет соединения'
      : q === 'excellent' ? 'отличное' : q === 'good' ? 'хорошее' : q === 'poor' ? 'слабое' : q === 'lost' ? 'потеряно' : 'соединение…';
  const qTip = (connection === 'connected' && eng.voicePing != null ? eng.voicePing + ' мс' : '—') + ' · ' + qLabel;
  const status = connection === 'reconnecting' ? 'Переподключение…'
    : disconnected ? 'Нет соединения'
      : connection === 'connecting' ? 'Подключение…' : 'Голосовая связь подключена';
  return (
    <div className="vd-panel">
      <div className="vd-status">
        <button className="vd-info" onClick={goToVoice} data-tip={canReconnect ? 'Переподключиться' : 'К голосовому серверу'}>
          <span className="vd-mark"><Icon name="speaker" sm /></span>
          <div className="vd-txt"><b>{status}</b><span>{chName ? chName + ' · ' : ''}{srvName}</span></div>
        </button>
        <div className={'conn-ind q-' + q} data-tip={qTip} aria-label={'Качество связи: ' + qTip} tabIndex={0}><i /><i /><i /></div>
        <button className="vd-btn vd-leave" aria-label={disconnected ? 'Скрыть отключённый голосовой канал' : 'Выйти из голосового канала'} data-tip={disconnected ? 'Скрыть' : 'Выйти из голосового'} onClick={() => disconnected ? E.dismissLostVoice() : E.leaveVoice()}><Icon name="leave" sm /></button>
      </div>
      {controls && eng.inVoice ? <VoiceControls up /> : null}
    </div>
  );
}

// variant: 'inline' — внутри колонки каналов (server-view), адаптируется по её ширине;
//          'floating' — компактный плавающий в левом нижнем углу (главная). Оба зовут одну VoicePanel.
export function VoiceDock({ variant }: { variant: 'inline' | 'floating' }) {
  const eng = useEngine();
  if ((!eng.inVoice || !eng.voiceServerId) && !eng.lostVoiceServerId) return null;
  // inline (server-view): контролы в нижней аккаунт-панели, тут только статус+выход+музыка.
  // floating (главная): аккаунт-панели нет → контролы здесь.
  if (variant === 'inline') return <div className="vd-inline"><VoicePanel controls={false} /></div>;
  return <div id="voicedock"><VoicePanel controls /></div>;
}
