import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { Icon } from '../Icon';
import { Backdrop } from './Backdrop';
import { listMonitors, listWindows, startNativeBroadcast, setNativeBroadcastSource, stopNativeBroadcast, onBroadcastStats } from '../native';
import type { MonitorInfo, WindowInfo, BroadcastStats, CaptureSource } from '../native';

type Resolution = '1080' | '720' | '480' | 'source';
const RES_MAP: Record<Resolution, { w: number; h: number; label: string }> = {
  '1080': { w: 1920, h: 1080, label: '1080p' },
  '720': { w: 1280, h: 720, label: '720p' },
  '480': { w: 854, h: 480, label: '480p' },
  source: { w: 3840, h: 2160, label: 'Как в источнике' },
};

interface SavedConfig {
  sourceKind: 'monitor' | 'window';
  monitorIndex: number;
  windowHwnd: number | null;
  resolution: Resolution;
  fps: 30 | 60;
  bitrateMbps: 3 | 6 | 10;
  /** Э8 ABR: авто-адаптация битрейта под сеть дерева. bitrateMbps при этом — потолок. */
  autoBitrate: boolean;
  /** auto — звук следует за источником: окно → его процесс (INCLUDE, надёжно против
   *  эха голоса войса), монитор → всё кроме RelayApp (EXCLUDE себя). Ничего выбирать руками.
   *  exclude/include — ручной override под «Дополнительно» (см. CLAUDE.md инвариант 6, audio.rs). */
  audioMode: 'auto' | 'exclude' | 'include';
  audioPid: number | null;
  /** Э8: лимит прямых зрителей корня; остальные уходят глубже через relay-узлы. */
  maxDirectChildren: number;
}
// audioMode дефолтом 'auto': звук выбирается сам по источнику (окно → PID окна, монитор →
// EXCLUDE себя), пользователю не нужно вручную указывать процесс. Ручной выбор остаётся
// под «Дополнительно» на случай, когда нужен звук строго одного приложения.
const DEF_CONFIG: SavedConfig = { sourceKind: 'monitor', monitorIndex: 0, windowHwnd: null, resolution: '1080', fps: 30, bitrateMbps: 6, autoBitrate: false, audioMode: 'auto', audioPid: null, maxDirectChildren: 2 };
// Допустимые значения опций (UI-кнопки). Сохранённый в localStorage конфиг мог
// содержать старые варианты (битрейт 15/20, 1 прямое подключение) — клампим, иначе
// <select>/кнопки ни на что не мапятся, а на бэкенд уходит невалидное значение.
const BITRATE_OPTS: (3 | 6 | 10)[] = [3, 6, 10];
const DIRECT_OPTS = [2, 4, 6, 8];
function loadConfig(): SavedConfig {
  try {
    const c: SavedConfig = { ...DEF_CONFIG, ...JSON.parse(localStorage.getItem('bcastConfig') || '{}') };
    if (!BITRATE_OPTS.includes(c.bitrateMbps)) c.bitrateMbps = c.bitrateMbps > 10 ? 10 : DEF_CONFIG.bitrateMbps;
    if (c.maxDirectChildren < 2) c.maxDirectChildren = 2;
    return c;
  } catch { return DEF_CONFIG; }
}
function saveConfig(c: SavedConfig) { localStorage.setItem('bcastConfig', JSON.stringify(c)); }

// Источник видео из текущего конфига (окно, если выбрано валидное; иначе монитор).
function buildSource(cfg: SavedConfig): CaptureSource {
  return cfg.sourceKind === 'window' && cfg.windowHwnd != null
    ? { kind: 'window', hwnd: cfg.windowHwnd }
    : { kind: 'monitor', index: cfg.monitorIndex };
}

// PID для WASAPI INCLUDE, либо undefined = EXCLUDE-режим. auto: окно → PID окна,
// монитор → EXCLUDE себя. Ручные режимы — как выбрано.
function deriveAudioPid(cfg: SavedConfig, windows: WindowInfo[]): number | undefined {
  if (cfg.audioMode === 'include') return cfg.audioPid ?? undefined;
  if (cfg.audioMode === 'exclude') return undefined;
  // auto:
  if (cfg.sourceKind === 'window' && cfg.windowHwnd != null)
    return windows.find((x) => x.hwnd === cfg.windowHwnd)?.pid;
  return undefined; // монитор в auto = EXCLUDE себя
}

export function BroadcastModal() {
  const close = () => useStore.getState().setModal(null);
  const me = useStore((s) => s.me)!;
  const active = useStore((s) => s.active)!;
  const live = useStore((s) => s.broadcastLive);
  const [cfg, setCfg] = useState<SavedConfig>(loadConfig);
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  const [windows, setWindows] = useState<WindowInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [stats, setStats] = useState<BroadcastStats | null>(null);

  // Списки нужны и в live-режиме: смена источника на лету (see apply) выбирает из них.
  useEffect(() => {
    listMonitors().then(setMonitors).catch(() => {});
    listWindows().then(setWindows).catch(() => {});
  }, [live]);

  // Индексы мониторов из windows-capture 1-based (Monitor::from_index требует index > 0).
  // Дефолт/сохранённый monitorIndex мог быть 0 (или указывать на отвалившийся монитор) —
  // тогда <select> ни на что не мапится, а Старт шлёт невалидный индекс ("monitor 0").
  // Подставляем первый доступный монитор, чтобы выбор всегда соответствовал списку.
  useEffect(() => {
    if (monitors.length === 0) return;
    if (!monitors.some((m) => m.index === cfg.monitorIndex))
      setCfg((c) => ({ ...c, monitorIndex: monitors[0].index }));
  }, [monitors]);

  useEffect(() => {
    if (!live) { setStats(null); return; }
    let unStats: (() => void) | undefined;
    onBroadcastStats(setStats).then((u) => (unStats = u));
    return () => unStats?.();
  }, [live]);

  // Автопривязка audio-PID к захватываемому окну: при захвате окна надёжный INCLUDE — это
  // звук того же процесса, что и картинка. Синхронизируем, когда выбрано окно (или подгрузился
  // список окон под сохранённый hwnd), чтобы пользователю не приходилось выбирать процесс дважды.
  useEffect(() => {
    if (cfg.sourceKind !== 'window' || cfg.windowHwnd == null) return;
    const w = windows.find((x) => x.hwnd === cfg.windowHwnd);
    if (w && cfg.audioPid !== w.pid) setCfg((c) => ({ ...c, audioPid: w.pid }));
  }, [cfg.sourceKind, cfg.windowHwnd, windows]);

  async function start() {
    setBusy(true); setErr('');
    try {
      const res = RES_MAP[cfg.resolution];
      const source = buildSource(cfg);
      const audioTargetPid = deriveAudioPid(cfg, windows);
      await startNativeBroadcast(me.username, me.username, active.id, { source, maxWidth: res.w, maxHeight: res.h, fps: cfg.fps, bitrateBps: cfg.bitrateMbps * 1_000_000, autoBitrate: cfg.autoBitrate, audioTargetPid, maxDirectChildren: cfg.maxDirectChildren });
      saveConfig(cfg);
      useStore.getState().setBroadcastLive(true);
    } catch (e: any) { setErr(String(e?.message || e)); } finally { setBusy(false); }
  }

  // Смена источника (и звука) на лету — трансляция не рвётся, дерево зрителей живёт.
  async function apply() {
    setBusy(true); setErr('');
    try {
      await setNativeBroadcastSource(buildSource(cfg), deriveAudioPid(cfg, windows));
      saveConfig(cfg);
    } catch (e: any) { setErr(String(e?.message || e)); } finally { setBusy(false); }
  }

  async function stop() {
    setBusy(true);
    try { await stopNativeBroadcast(); useStore.getState().setBroadcastLive(false); close(); }
    catch (e: any) { setErr(String(e?.message || e)); } finally { setBusy(false); }
  }

  // Пикер источника (сегмент Экран/Окно + монитор/окно) — общий для формы старта и
  // для смены источника на лету в live-режиме.
  const sourceFields = <>
    <div className="fld"><label>Источник</label>
      <div className="seg">
        <button className={cfg.sourceKind === 'monitor' ? 'active' : ''} onClick={() => setCfg((c) => ({ ...c, sourceKind: 'monitor' }))}>Экран</button>
        <button className={cfg.sourceKind === 'window' ? 'active' : ''} onClick={() => setCfg((c) => ({ ...c, sourceKind: 'window' }))}>Окно</button>
      </div>
    </div>
    {cfg.sourceKind === 'monitor'
      ? <div className="fld"><label>Монитор</label>
          <select value={cfg.monitorIndex} onChange={(e) => setCfg((c) => ({ ...c, monitorIndex: +e.target.value }))}>
            {monitors.map((m) => <option key={m.index} value={m.index}>{m.name || `Монитор ${m.index}`}</option>)}
          </select>
        </div>
      : <div className="fld"><label>Окно</label>
          <select value={cfg.windowHwnd ?? ''} onChange={(e) => { const hwnd = +e.target.value; const w = windows.find((x) => x.hwnd === hwnd); setCfg((c) => ({ ...c, windowHwnd: hwnd, audioPid: w ? w.pid : c.audioPid })); }}>
            <option value="" disabled>Выбери окно</option>
            {windows.map((w) => <option key={w.hwnd} value={w.hwnd}>{w.title}{w.process ? ` — ${w.process}` : ''}</option>)}
          </select>
        </div>}
  </>;

  if (live) {
    const canApply = !busy && !(cfg.sourceKind === 'window' && cfg.windowHwnd == null) && !(cfg.audioMode === 'include' && cfg.audioPid == null);
    return <Backdrop onClose={close} label="Трансляция">
      <h2><Icon name="screen" />Трансляция идёт</h2>
      {stats ? <div className="dbgstats">
        <div><span>Источник</span><b title={stats.source}>{stats.source}</b></div>
        <div><span>Разрешение</span><b>{stats.width}×{stats.height}</b></div>
        <div><span>Захват</span><b>{stats.captureFps.toFixed(1)} fps</b></div>
        <div><span>Кодер</span><b>{stats.encoderFps.toFixed(1)} / {stats.targetFps} fps</b></div>
        <div><span>Битрейт</span><b>{(stats.bitrateActualBps / 1_000_000).toFixed(2)} / {(stats.bitrateTargetBps / 1_000_000).toFixed(1)} Мбит/с</b></div>
        <div><span>Потеряно кадров</span><b>{stats.droppedFrames}</b></div>
        <div><span>Детей в дереве</span><b>{stats.children}</b></div>
      </div> : <p className="msub">Собираю статистику...</p>}
      <details style={{ marginTop: 12 }}>
        <summary style={{ cursor: 'pointer' }}>Сменить источник</summary>
        <div style={{ marginTop: 8 }}>
          {sourceFields}
          <p className="msub" style={{ margin: '0 0 8px' }}>Смена не рвёт трансляцию — зрители остаются подключёнными. Звук переключится на новый источник автоматически.</p>
          <button className="primary" style={{ margin: 0 }} disabled={!canApply} onClick={apply}>Применить</button>
        </div>
      </details>
      <div className="rowbtns">
        <button className="ghost" style={{ margin: 0 }} onClick={close}>Свернуть</button>
        <button className="primary" style={{ margin: 0, background: 'var(--red-fill)' }} disabled={busy} onClick={stop}>Остановить трансляцию</button>
      </div>
      <div className="err">{err}</div>
    </Backdrop>;
  }

  return <Backdrop onClose={close} label="Начать трансляцию">
    <h2><Icon name="screen" />Трансляция экрана</h2>
    {sourceFields}
    <div className="fld"><label>Разрешение</label>
      <select value={cfg.resolution} onChange={(e) => setCfg((c) => ({ ...c, resolution: e.target.value as Resolution }))}>
        {(Object.keys(RES_MAP) as Resolution[]).map((k) => <option key={k} value={k}>{RES_MAP[k].label}</option>)}
      </select>
    </div>
    <div className="fld"><label>FPS</label>
      <div className="seg">
        <button className={cfg.fps === 30 ? 'active' : ''} onClick={() => setCfg((c) => ({ ...c, fps: 30 }))}>30</button>
        <button className={cfg.fps === 60 ? 'active' : ''} onClick={() => setCfg((c) => ({ ...c, fps: 60 }))}>60</button>
      </div>
    </div>
    <div className="fld"><label>{cfg.autoBitrate ? 'Битрейт (макс.)' : 'Битрейт'}</label>
      <div className="seg">{BITRATE_OPTS.map((b) => <button key={b} className={cfg.bitrateMbps === b ? 'active' : ''} onClick={() => setCfg((c) => ({ ...c, bitrateMbps: b }))}>{b} Мбит/с</button>)}</div>
    </div>
    <div className="fld"><label>Автобитрейт</label>
      <div className="seg">
        <button className={cfg.autoBitrate ? 'active' : ''} onClick={() => setCfg((c) => ({ ...c, autoBitrate: true }))}>Авто</button>
        <button className={!cfg.autoBitrate ? 'active' : ''} onClick={() => setCfg((c) => ({ ...c, autoBitrate: false }))}>Фиксированный</button>
      </div>
      <p className="msub" style={{ margin: '8px 0 0' }}>{cfg.autoBitrate
        ? 'Битрейт снижается автоматически под худший линк дерева (и восстанавливается). Значение выше — потолок.'
        : 'Битрейт фиксирован. При плохой сети у зрителей возможны потери/буферизация.'}</p>
    </div>
    <div className="fld"><label>Прямых подключений</label>
      <div className="seg">{DIRECT_OPTS.map((n) => <button key={n} className={cfg.maxDirectChildren === n ? 'active' : ''} onClick={() => setCfg((c) => ({ ...c, maxDirectChildren: n }))}>{n}</button>)}</div>
      <p className="msub" style={{ margin: '8px 0 0' }}>Сколько зрителей берут поток напрямую с тебя. Остальные — через ретранслирующих зрителей (дерево, глубже).</p>
    </div>
    <div className="fld"><label>Звук</label>
      <div className="seg">
        <button className={cfg.audioMode === 'auto' ? 'active' : ''} onClick={() => setCfg((c) => ({ ...c, audioMode: 'auto' }))}>Авто (по источнику)</button>
      </div>
      <p className="msub" style={{ margin: '8px 0 0' }}>{cfg.audioMode === 'auto'
        ? (cfg.sourceKind === 'window'
            ? 'Звук берётся из процесса захватываемого окна — голос войса в стрим не попадёт.'
            : 'Захват экрана: в стрим уходит звук всех приложений/игр, кроме самого RelayApp (голос войса не попадёт).')
        : cfg.audioMode === 'include'
            ? 'Ручной режим: только звук выбранного процесса.'
            : 'Ручной режим: весь звук, кроме RelayApp.'}</p>
      <details style={{ marginTop: 8 }}>
        <summary style={{ cursor: 'pointer' }} className="msub">Дополнительно</summary>
        <div style={{ marginTop: 8 }}>
          <div className="seg">
            <button className={cfg.audioMode === 'auto' ? 'active' : ''} onClick={() => setCfg((c) => ({ ...c, audioMode: 'auto' }))}>Авто</button>
            <button className={cfg.audioMode === 'exclude' ? 'active' : ''} onClick={() => setCfg((c) => ({ ...c, audioMode: 'exclude' }))}>Всё, кроме RelayApp</button>
            <button className={cfg.audioMode === 'include' ? 'active' : ''} onClick={() => setCfg((c) => ({ ...c, audioMode: 'include' }))}>Только процесс</button>
          </div>
          {cfg.audioMode === 'include' && <select style={{ marginTop: 8 }} value={cfg.audioPid ?? ''} onChange={(e) => setCfg((c) => ({ ...c, audioPid: +e.target.value }))}>
            <option value="" disabled>Выбери процесс</option>
            {windows.map((w) => <option key={w.hwnd} value={w.pid}>{w.title}{w.process ? ` — ${w.process}` : ''}</option>)}
          </select>}
          <p className="msub" style={{ margin: '8px 0 0' }}>⚠ «Всё кроме RelayApp» на части ПК всё равно пропускает голос войса в запись (ограничение WebView2). Надёжно — «Только процесс» или «Авто» при захвате окна.</p>
        </div>
      </details>
    </div>
    <div className="rowbtns">
      <button className="ghost" style={{ margin: 0 }} onClick={close}>Отмена</button>
      <button className="primary" style={{ margin: 0 }} disabled={busy || (cfg.sourceKind === 'window' && cfg.windowHwnd == null) || (cfg.audioMode === 'include' && cfg.audioPid == null)} onClick={start}>Начать трансляцию</button>
    </div>
    <div className="err">{err}</div>
  </Backdrop>;
}
