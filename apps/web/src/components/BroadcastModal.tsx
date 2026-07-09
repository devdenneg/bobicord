import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { useEngine } from '../hooks';
import { api } from '../api';
import { Icon } from '../Icon';
import { Backdrop } from './Backdrop';
import { listMonitors, listWindows, startNativeBroadcast, setNativeBroadcastSource, stopNativeBroadcast, onBroadcastStats } from '../native';
import type { MonitorInfo, WindowInfo, BroadcastStats, CaptureSource } from '../native';
import { pickPreset, type PresetMode } from '../presets';
import { measureUpload, getCachedProbe, clearCachedProbe, type ProbeResult } from '../transport/probe';

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
  bitrateKbps: number;
  /** Э8 ABR: авто-адаптация битрейта под сеть дерева. bitrateKbps при этом — потолок. */
  autoBitrate: boolean;
  /** auto — звук следует за источником: окно → его процесс (INCLUDE, надёжно против
   *  эха голоса войса), монитор → всё кроме RelayApp (EXCLUDE себя). Ничего выбирать руками.
   *  exclude/include — ручной override под «Дополнительно» (см. CLAUDE.md инвариант 6, audio.rs). */
  audioMode: 'auto' | 'exclude' | 'include';
  audioPid: number | null;
  /** Э8: лимит прямых зрителей корня; остальные уходят глубже через relay-узлы. */
  maxDirectChildren: number;
  /** Д5: режим пресета. 'smooth'/'quality' — из развилки после замера (CBR-пресет по таблице);
   *  'manual' — ручные слайдеры (текущее поведение). Определяет, чем стартует трансляция. */
  presetMode: PresetMode | 'manual';
}
// audioMode дефолтом 'auto': звук выбирается сам по источнику (окно → PID окна, монитор →
// EXCLUDE себя), пользователю не нужно вручную указывать процесс. Ручной выбор остаётся
// под «Дополнительно» на случай, когда нужен звук строго одного приложения.
const DEF_CONFIG: SavedConfig = { sourceKind: 'monitor', monitorIndex: 0, windowHwnd: null, resolution: '1080', fps: 30, bitrateKbps: 6000, autoBitrate: false, audioMode: 'auto', audioPid: null, maxDirectChildren: 2, presetMode: 'smooth' };
// Диапазоны слайдеров. Сохранённый в localStorage конфиг мог содержать старые
// пресеты (bitrateMbps 3/6/10, ранее 15/20; 1 прямое подключение) — мигрируем и
// клампим, иначе на бэкенд уходит невалидное значение.
const BITRATE_MIN_KBPS = 3000, BITRATE_MAX_KBPS = 10_000, BITRATE_STEP_KBPS = 1000;
const DIRECT_MIN = 1, DIRECT_MAX = 10;
function loadConfig(): SavedConfig {
  try {
    const raw = JSON.parse(localStorage.getItem('bcastConfig') || '{}');
    if (typeof raw.bitrateKbps !== 'number' && typeof raw.bitrateMbps === 'number') raw.bitrateKbps = raw.bitrateMbps * 1000;
    delete raw.bitrateMbps;
    const c: SavedConfig = { ...DEF_CONFIG, ...raw };
    c.bitrateKbps = Math.min(BITRATE_MAX_KBPS, Math.max(BITRATE_MIN_KBPS, Math.round(c.bitrateKbps / BITRATE_STEP_KBPS) * BITRATE_STEP_KBPS));
    c.maxDirectChildren = Math.min(DIRECT_MAX, Math.max(DIRECT_MIN, Math.round(c.maxDirectChildren)));
    if (c.presetMode !== 'smooth' && c.presetMode !== 'quality' && c.presetMode !== 'manual') c.presetMode = 'smooth';
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

/** base64 PNG иконки окна в data-URI (без префикса приходит из Rust) или null. */
function iconSrc(icon: string | null | undefined): string | null {
  return icon ? `data:image/png;base64,${icon}` : null;
}

/** Иконка приложения 18px или generic-глиф, если иконки нет. */
function AppIcon({ icon, size = 18 }: { icon: string | null | undefined; size?: number }) {
  const src = iconSrc(icon);
  return src
    ? <img src={src} width={size} height={size} style={{ borderRadius: 3, flexShrink: 0, objectFit: 'contain' }} alt="" />
    : <span style={{ width: size, height: size, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', opacity: 0.6 }}><Icon name="screen" /></span>;
}

/** Пикер окна с иконками. Нативный <select> картинки в опциях не умеет — кастомный
 *  листбокс: кнопка-триггер (иконка+заголовок) + выпадающий скроллируемый список.
 *  Закрытие по клику вне/Escape. */
function WindowPicker({ windows, value, onPick }: { windows: WindowInfo[]; value: number | null; onPick: (hwnd: number) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const sel = windows.find((w) => w.hwnd === value) || null;

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  return <div ref={ref} style={{ position: 'relative' }}>
    <button type="button" className="wpick-trigger" onClick={() => setOpen((o) => !o)}
      style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, textAlign: 'left', padding: '8px 10px', background: 'var(--input-bg, #1e1f22)', border: '1px solid var(--border, #333)', borderRadius: 8, color: 'inherit', cursor: 'pointer' }}>
      {sel ? <><AppIcon icon={sel.icon} /><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{sel.title}{sel.process ? ` — ${sel.process}` : ''}</span></>
           : <span style={{ flex: 1, opacity: 0.6 }}>Выбери окно</span>}
      <span style={{ opacity: 0.5, flexShrink: 0 }}>▾</span>
    </button>
    {open && <div role="listbox" className="wpick-list"
      style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 20, marginTop: 4, maxHeight: 260, overflowY: 'auto', background: 'var(--bg-float, #1e1f22)', border: '1px solid var(--border, #333)', borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,.4)' }}>
      {windows.length === 0 && <div style={{ padding: '10px 12px', opacity: 0.6 }}>Нет окон</div>}
      {windows.map((w) => <div key={w.hwnd} role="option" aria-selected={w.hwnd === value}
        onClick={() => { onPick(w.hwnd); setOpen(false); }}
        className="wpick-opt"
        style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', cursor: 'pointer', background: w.hwnd === value ? 'var(--accent-soft, rgba(88,101,242,.25))' : 'transparent' }}>
        <AppIcon icon={w.icon} />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{w.title}{w.process ? ` — ${w.process}` : ''}</span>
      </div>)}
    </div>}
  </div>;
}

export function BroadcastModal() {
  const close = () => useStore.getState().setModal(null);
  const me = useStore((s) => s.me)!;
  const active = useStore((s) => s.active)!;
  const eng = useEngine();
  const live = useStore((s) => s.broadcastLive);
  const [cfg, setCfg] = useState<SavedConfig>(loadConfig);
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  const [windows, setWindows] = useState<WindowInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [stats, setStats] = useState<BroadcastStats | null>(null);
  // Д5: замер upload (probe). Кэш переживает открытия модалки (TTL сутки).
  const [probe, setProbe] = useState<ProbeResult | null>(() => getCachedProbe());
  const [measuring, setMeasuring] = useState(false);
  const [measurePhase, setMeasurePhase] = useState('');

  // Полезный битрейт = 75% от измеренного BWE; пресет из развилки под него.
  const usefulKbps = probe ? Math.round(probe.bweKbps * 0.75) : null;
  const chosenPreset = (cfg.presetMode !== 'manual' && usefulKbps != null)
    ? pickPreset(usefulKbps, cfg.presetMode as PresetMode)
    : null;

  // Замер upload: спиннер 3-5с, затем развилка. useCache=false — принудительный ре-замер.
  async function runMeasure(useCache = true) {
    if (useCache) { const c = getCachedProbe(); if (c) { setProbe(c); return; } }
    setMeasuring(true); setMeasurePhase(''); setErr('');
    try {
      const r = await measureUpload({ onPhase: setMeasurePhase });
      setProbe(r);
    } catch (e: any) { setErr('Не удалось замерить скорость: ' + String(e?.message || e)); }
    finally { setMeasuring(false); }
  }
  function remeasure() { clearCachedProbe(); setProbe(null); runMeasure(false); }

  // Списки нужны и в live-режиме: смена источника на лету (see apply) выбирает из них.
  useEffect(() => {
    listMonitors().then(setMonitors).catch(() => {});
    listWindows().then(setWindows).catch(() => {});
  }, [live]);

  // Д5: дефолтный flow — авто-замер upload при открытии формы старта (если нет свежего кэша).
  useEffect(() => {
    if (live) return;
    if (!getCachedProbe()) runMeasure(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      // Д5: в пресет-режиме параметры кодирования берём из таблицы пресетов (CBR, autoBitrate off);
      // в ручном режиме — из слайдеров (текущее поведение). chosenPreset уже посчитан по 0.75×BWE.
      const preset = cfg.presetMode !== 'manual' ? chosenPreset : null;
      const w = preset ? preset.width : RES_MAP[cfg.resolution].w;
      const h = preset ? preset.height : RES_MAP[cfg.resolution].h;
      const fps = preset ? preset.fps : cfg.fps;
      const bitrateBps = (preset ? preset.bitrateKbps : cfg.bitrateKbps) * 1000;
      const autoBitrate = preset ? false : cfg.autoBitrate; // пресет = фиксированный CBR
      const source = buildSource(cfg);
      const audioTargetPid = deriveAudioPid(cfg, windows);
      // Трансляция идёт на ГОЛОСОВОЙ сервер (voiceServerId), а не на смотримый: вещать можно только
      // будучи в голосовом, и дерево стрима живёт на его сервере (иначе при браузинге по серверам
      // трансляция уходила бы в чужую комнату). Фолбэк на active.id — только если вне голоса (не должно).
      const bcSrv = eng.voiceServerId || active.id;
      await startNativeBroadcast(me.username, me.username, bcSrv, { source, maxWidth: w, maxHeight: h, fps, bitrateBps, autoBitrate, audioTargetPid, maxDirectChildren: cfg.maxDirectChildren, presetMode: preset ? cfg.presetMode : 'manual' });
      saveConfig(cfg);
      useStore.getState().setBroadcastLive(true);
      api.streamStart(bcSrv).catch(() => {}); // фоновый push участникам не в комнате
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
          <WindowPicker windows={windows} value={cfg.windowHwnd} onPick={(hwnd) => { const w = windows.find((x) => x.hwnd === hwnd); setCfg((c) => ({ ...c, windowHwnd: hwnd, audioPid: w ? w.pid : c.audioPid })); }} />
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

    {/* Roadmap-flow-стриминга Д5: замер upload → полезный битрейт 75% → развилка Плавность/Качество. */}
    <div className="fld"><label>Скорость отдачи</label>
      {measuring
        ? <p className="msub" style={{ margin: 0 }}>Замеряю скорость сети… (3–5 с){measurePhase ? ` · ${measurePhase}` : ''}</p>
        : probe
          ? <p className="msub" style={{ margin: 0 }}>
              ~{(probe.bweKbps / 1000).toFixed(1)} Мбит/с{probe.method === 'datachannel' ? ' (прибл.)' : ''}
              {probe.symmetricNat ? ' · ⚠ симметричный NAT (возможно занижено)' : ''}
              {usefulKbps != null ? ` · полезно ${(usefulKbps / 1000).toFixed(1)} Мбит/с` : ''}
              {' '}<button className="linklike" style={{ background: 'none', border: 'none', color: 'var(--accent, #5865f2)', cursor: 'pointer', padding: 0 }} onClick={remeasure}>повторить замер</button>
            </p>
          : <button className="ghost" style={{ margin: 0 }} onClick={() => runMeasure(false)}>Замерить скорость</button>}
    </div>
    <div className="fld"><label>Режим</label>
      <div className="seg">
        <button className={cfg.presetMode === 'smooth' ? 'active' : ''} onClick={() => setCfg((c) => ({ ...c, presetMode: 'smooth' }))}>Плавность</button>
        <button className={cfg.presetMode === 'quality' ? 'active' : ''} onClick={() => setCfg((c) => ({ ...c, presetMode: 'quality' }))}>Качество</button>
      </div>
      <p className="msub" style={{ margin: '8px 0 0' }}>{
        cfg.presetMode === 'manual'
          ? 'Ручной режим (расширенные настройки ниже). Выбери «Плавность» или «Качество» для авто-пресета.'
          : (cfg.presetMode === 'smooth'
              ? 'Плавность: 60 fps, разрешение подстраивается под скорость.'
              : 'Качество: 30 fps, максимальное разрешение под скорость.')
      }{chosenPreset ? ` → ${chosenPreset.label}, ${(chosenPreset.bitrateKbps / 1000).toFixed(1)} Мбит/с CBR` : (cfg.presetMode !== 'manual' && !measuring ? ' → нужен замер' : '')}</p>
    </div>

    {/* Расширенные настройки = текущий ручной режим (Д5). Изменение битрейт/разрешение/fps
        переключает presetMode в 'manual'; звук и прямые подключения ортогональны пресету. */}
    <div className="fld">
      <details open={cfg.presetMode === 'manual'}>
        <summary style={{ cursor: 'pointer' }} className="msub">Расширенные настройки (ручной режим)</summary>
        <div style={{ marginTop: 8 }}>
          <div className="fld"><label>Разрешение</label>
            <select value={cfg.resolution} onChange={(e) => setCfg((c) => ({ ...c, resolution: e.target.value as Resolution, presetMode: 'manual' }))}>
              {(Object.keys(RES_MAP) as Resolution[]).map((k) => <option key={k} value={k}>{RES_MAP[k].label}</option>)}
            </select>
          </div>
          <div className="fld"><label>FPS</label>
            <div className="seg">
              <button className={cfg.presetMode === 'manual' && cfg.fps === 30 ? 'active' : ''} onClick={() => setCfg((c) => ({ ...c, fps: 30, presetMode: 'manual' }))}>30</button>
              <button className={cfg.presetMode === 'manual' && cfg.fps === 60 ? 'active' : ''} onClick={() => setCfg((c) => ({ ...c, fps: 60, presetMode: 'manual' }))}>60</button>
            </div>
          </div>
          <div className="fld"><label>{cfg.autoBitrate ? 'Битрейт (макс.)' : 'Битрейт'}: {cfg.bitrateKbps / 1000} Мбит/с</label>
            <input type="range" min={BITRATE_MIN_KBPS} max={BITRATE_MAX_KBPS} step={BITRATE_STEP_KBPS} value={cfg.bitrateKbps} onChange={(e) => setCfg((c) => ({ ...c, bitrateKbps: +e.target.value, presetMode: 'manual' }))} />
          </div>
          <div className="fld"><label>Автобитрейт</label>
            <div className="seg">
              <button className={cfg.presetMode === 'manual' && cfg.autoBitrate ? 'active' : ''} onClick={() => setCfg((c) => ({ ...c, autoBitrate: true, presetMode: 'manual' }))}>Авто</button>
              <button className={cfg.presetMode === 'manual' && !cfg.autoBitrate ? 'active' : ''} onClick={() => setCfg((c) => ({ ...c, autoBitrate: false, presetMode: 'manual' }))}>Фиксированный</button>
            </div>
            <p className="msub" style={{ margin: '8px 0 0' }}>{cfg.autoBitrate
              ? 'Битрейт снижается автоматически под худший линк дерева (и восстанавливается). Значение выше — потолок.'
              : 'Битрейт фиксирован. При плохой сети у зрителей возможны потери/буферизация.'}</p>
          </div>
          <div className="fld"><label>Прямых подключений: {cfg.maxDirectChildren}</label>
            <input type="range" min={DIRECT_MIN} max={DIRECT_MAX} step={1} value={cfg.maxDirectChildren} onChange={(e) => setCfg((c) => ({ ...c, maxDirectChildren: +e.target.value }))} />
            <p className="msub" style={{ margin: '8px 0 0' }}>Сколько зрителей берут поток напрямую с тобой. Остальные — через ретранслирующих зрителей (дерево, глубже) или через сервер.</p>
          </div>
        </div>
      </details>
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
