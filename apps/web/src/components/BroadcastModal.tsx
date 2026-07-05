import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { Icon } from '../Icon';
import { Backdrop } from './Backdrop';
import { listMonitors, listWindows, startNativeBroadcast, stopNativeBroadcast, onBroadcastStats } from '../native';
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
  /** exclude — весь звук кроме RelayApp (WASAPI EXCLUDE себя, не всегда надёжно
   *  фильтрует наш многопроцессный WebView2, см. CLAUDE.md инвариант 6 и audio.rs).
   *  include — только звук выбранного процесса (надёжнее). */
  audioMode: 'exclude' | 'include';
  audioPid: number | null;
}
const DEF_CONFIG: SavedConfig = { sourceKind: 'monitor', monitorIndex: 0, windowHwnd: null, resolution: '1080', fps: 30, bitrateMbps: 6, audioMode: 'exclude', audioPid: null };
function loadConfig(): SavedConfig {
  try { return { ...DEF_CONFIG, ...JSON.parse(localStorage.getItem('bcastConfig') || '{}') }; } catch { return DEF_CONFIG; }
}
function saveConfig(c: SavedConfig) { localStorage.setItem('bcastConfig', JSON.stringify(c)); }

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

  useEffect(() => {
    if (live) return;
    listMonitors().then(setMonitors).catch(() => {});
    listWindows().then(setWindows).catch(() => {});
  }, [live]);

  useEffect(() => {
    if (!live) { setStats(null); return; }
    let unStats: (() => void) | undefined;
    onBroadcastStats(setStats).then((u) => (unStats = u));
    return () => unStats?.();
  }, [live]);

  async function start() {
    setBusy(true); setErr('');
    try {
      const res = RES_MAP[cfg.resolution];
      const source: CaptureSource = cfg.sourceKind === 'window' && cfg.windowHwnd != null
        ? { kind: 'window', hwnd: cfg.windowHwnd }
        : { kind: 'monitor', index: cfg.monitorIndex };
      const audioTargetPid = cfg.audioMode === 'include' && cfg.audioPid != null ? cfg.audioPid : undefined;
      await startNativeBroadcast(me.username, me.username, active.id, { source, maxWidth: res.w, maxHeight: res.h, fps: cfg.fps, bitrateBps: cfg.bitrateMbps * 1_000_000, audioTargetPid });
      saveConfig(cfg);
      useStore.getState().setBroadcastLive(true);
    } catch (e: any) { setErr(String(e?.message || e)); } finally { setBusy(false); }
  }

  async function stop() {
    setBusy(true);
    try { await stopNativeBroadcast(); useStore.getState().setBroadcastLive(false); close(); }
    catch (e: any) { setErr(String(e?.message || e)); } finally { setBusy(false); }
  }

  if (live) {
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
      <div className="rowbtns">
        <button className="ghost" style={{ margin: 0 }} onClick={close}>Свернуть</button>
        <button className="primary" style={{ margin: 0, background: 'var(--red-fill)' }} disabled={busy} onClick={stop}>Остановить трансляцию</button>
      </div>
      <div className="err">{err}</div>
    </Backdrop>;
  }

  return <Backdrop onClose={close} label="Начать трансляцию">
    <h2><Icon name="screen" />Трансляция экрана</h2>
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
          <select value={cfg.windowHwnd ?? ''} onChange={(e) => setCfg((c) => ({ ...c, windowHwnd: +e.target.value }))}>
            <option value="" disabled>Выбери окно</option>
            {windows.map((w) => <option key={w.hwnd} value={w.hwnd}>{w.title}{w.process ? ` — ${w.process}` : ''}</option>)}
          </select>
        </div>}
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
    <div className="fld"><label>Битрейт</label>
      <div className="seg">{[3, 6, 10].map((b) => <button key={b} className={cfg.bitrateMbps === b ? 'active' : ''} onClick={() => setCfg((c) => ({ ...c, bitrateMbps: b as 3 | 6 | 10 }))}>{b} Мбит/с</button>)}</div>
    </div>
    <div className="fld"><label>Звук</label>
      <div className="seg">
        <button className={cfg.audioMode === 'exclude' ? 'active' : ''} onClick={() => setCfg((c) => ({ ...c, audioMode: 'exclude' }))}>Всё, кроме RelayApp</button>
        <button className={cfg.audioMode === 'include' ? 'active' : ''} onClick={() => setCfg((c) => ({ ...c, audioMode: 'include' }))}>Только процесс</button>
      </div>
      {cfg.audioMode === 'include'
        ? <select style={{ marginTop: 8 }} value={cfg.audioPid ?? ''} onChange={(e) => setCfg((c) => ({ ...c, audioPid: +e.target.value }))}>
            <option value="" disabled>Выбери процесс</option>
            {windows.map((w) => <option key={w.hwnd} value={w.pid}>{w.title}{w.process ? ` — ${w.process}` : ''}</option>)}
          </select>
        : <p className="msub" style={{ margin: '8px 0 0' }}>Если слышен свой голос/чужие стримы в записи — переключи на «Только процесс» и выбери игру.</p>}
    </div>
    <div className="rowbtns">
      <button className="ghost" style={{ margin: 0 }} onClick={close}>Отмена</button>
      <button className="primary" style={{ margin: 0 }} disabled={busy || (cfg.sourceKind === 'window' && cfg.windowHwnd == null) || (cfg.audioMode === 'include' && cfg.audioPid == null)} onClick={start}>Начать трансляцию</button>
    </div>
    <div className="err">{err}</div>
  </Backdrop>;
}
