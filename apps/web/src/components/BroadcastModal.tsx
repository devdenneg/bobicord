import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { useEngine } from '../hooks';
import { api } from '../api';
import { Icon } from '../Icon';
import { Backdrop } from './Backdrop';
import { listMonitors, listWindows, startNativeBroadcast, setNativeBroadcastSource, stopNativeBroadcast, onBroadcastStats } from '../native';
import { startBroadcasterSession, endAnyBroadcasterSession } from '../diag';
import type { MonitorInfo, WindowInfo, BroadcastStats } from '../native';
import { pickPreset, PRESETS, widthCapForHeight } from '../presets';
import { measureUpload, getCachedProbe, clearCachedProbe, type ProbeResult } from '../transport/probe';
import { FIXED_LABELS, QUALITY_FIXED, DIRECT_MIN, DIRECT_MAX, loadConfig, saveConfig, buildSource, deriveAudioPid, type SavedConfig } from '../broadcastSource';

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
  // Замер upload (probe) — нужен для 'auto' (пресет по 0.75×BWE). Кэш переживает открытия (TTL сутки).
  const [probe, setProbe] = useState<ProbeResult | null>(() => getCachedProbe());
  const [measuring, setMeasuring] = useState(false);
  const [measurePhase, setMeasurePhase] = useState('');

  const usefulKbps = probe ? Math.round(probe.bweKbps * 0.75) : null;
  // Итоговые параметры кодирования по выбранному качеству. 'auto' → пресет по замеру (без замера —
  // самый нижний, floor). Фикс — из таблицы. Битрейт ВЕЗДЕ становится потолком auto-адаптации.
  function resolveEncode() {
    if (cfg.quality === 'auto') {
      // 'quality' = 30fps-лестница. Дефолт «Авто» больше не предлагает 60fps: диаг 2026-07-10 —
      // CPU-путь захвата на 60fps не успевал (фризы всем зрителям); 60fps — явный выбор.
      const p = (usefulKbps != null ? pickPreset(usefulKbps, 'quality') : null) || PRESETS[PRESETS.length - 1];
      return { w: p.width, h: p.height, fps: p.fps, bitrateKbps: p.bitrateKbps, label: p.label };
    }
    return QUALITY_FIXED[cfg.quality];
  }
  const enc = resolveEncode();
  const summary = cfg.quality === 'auto' && usefulKbps == null && measuring
    ? 'Будет: подберу после замера скорости · битрейт авто'
    : `Будет: ${enc.label} · битрейт авто (сервер подстроит под сеть)`;

  // Замер upload: спиннер 3-5с. useCache=false — принудительный ре-замер.
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

  // Авто-замер upload при открытии формы старта (если нет свежего кэша) — нужен режиму «Авто».
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
      const e = resolveEncode();
      const bitrateBps = e.bitrateKbps * 1000;
      // Битрейт ВСЕГДА адаптивный (потолок = e.bitrateKbps). presetMode !== 'manual' держит
      // клиентскую лестницу fps/разрешения ВЫКЛ (адаптация зрителей — через серверные рендишны, Д4);
      // сервер шлёт set-bitrate, вещатель снижает под худший линк. Ручного CBR больше нет.
      const source = buildSource(cfg);
      const audioTargetPid = deriveAudioPid(cfg, windows);
      // Трансляция идёт на ГОЛОСОВОЙ сервер (voiceServerId), а не на смотримый: вещать можно только
      // будучи в голосовом, и дерево стрима живёт на его сервере (иначе при браузинге по серверам
      // трансляция уходила бы в чужую комнату). Фолбэк на active.id — только если вне голоса (не должно).
      const bcSrv = eng.voiceServerId || active.id;
      // Д8: server-first — единственный слот корня отдан vrelay (maxChildren=1). Opt-in
      // «прямые подключения» открывает N слотов вещателя: maxChildren = 1 (vrelay) + N.
      const directSlots = cfg.allowDirectPeers ? 1 + cfg.maxDirectChildren : 1;
      // maxWidth — кап под 32:9 (widthCapForHeight), не 16:9-ширина пресета: иначе ultrawide
      // резался по вертикали (21:9 → 2560×1070 вместо 3440×1440). Высота (e.h) остаётся целью.
      await startNativeBroadcast(me.username, me.username, bcSrv, { source, maxWidth: widthCapForHeight(e.h), maxHeight: e.h, fps: e.fps, bitrateBps, autoBitrate: true, audioTargetPid, maxDirectChildren: directSlots, presetMode: 'smooth' });
      // streamId вещателя == me.username. Сессия закроется в любой из трёх точек стопа.
      startBroadcasterSession(me.username);
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
    catch (e: any) { setErr(String(e?.message || e)); }
    // ПОСЛЕ остановки: stop_broadcast джойнит потоки, и самые ценные строки (почему
    // энкодер встал, как рвались ICE-кандидаты) пишутся именно на закрытии.
    finally { endAnyBroadcasterSession(); setBusy(false); }
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
        <div><span>Кодер</span><b>{stats.encoderFps.toFixed(1)} / {stats.targetFps} fps{stats.cpuCapped ? ' (CPU)' : ''}</b></div>
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

    {/* Дискорд-стиль: маленький выбор качества. Битрейт всегда авто (сервер адаптирует), слайдера нет. */}
    <div className="fld"><label>Качество</label>
      <div className="seg seg-quality">
        <button className={cfg.quality === 'auto' ? 'active' : ''} onClick={() => setCfg((c) => ({ ...c, quality: 'auto' }))}>Авто</button>
        {FIXED_LABELS.map((l) => (
          <button key={l} className={cfg.quality === l ? 'active' : ''} onClick={() => setCfg((c) => ({ ...c, quality: l }))}>{l}</button>
        ))}
      </div>
      <p className="msub" style={{ margin: '8px 0 0' }}>{cfg.quality === 'auto'
        ? 'Авто (рекомендуется): подбираем разрешение под твою скорость, битрейт держит сервер.'
        : 'Битрейт подстраивается автоматически; слабым зрителям сервер отдаёт качество пониже.'}</p>
      {cfg.quality === 'auto' && <div style={{ marginTop: 6 }}>
        {measuring
          ? <span className="msub">Замеряю скорость сети… (3–5 с){measurePhase ? ` · ${measurePhase}` : ''}</span>
          : probe
            ? <span className="msub">
                ~{(probe.bweKbps / 1000).toFixed(1)} Мбит/с отдача{probe.symmetricNat ? ' · ⚠ симметричный NAT' : ''}
                {' '}<button className="linklike" style={{ background: 'none', border: 'none', color: 'var(--accent, #5865f2)', cursor: 'pointer', padding: 0 }} onClick={remeasure}>повторить замер</button>
              </span>
            : <button className="ghost" style={{ margin: 0 }} onClick={() => runMeasure(false)}>Замерить скорость</button>}
      </div>}
    </div>
    <div style={{ marginTop: 10, padding: '8px 10px', borderRadius: 8, background: 'var(--accent-soft, rgba(88,101,242,.18))', fontSize: 13, fontWeight: 600 }}>{summary}</div>

    <div className="fld"><label>Звук</label>
      <p className="msub" style={{ margin: 0 }}>{cfg.audioMode === 'auto'
        ? (cfg.sourceKind === 'window'
            ? 'Авто: звук процесса захватываемого окна — голос войса в стрим не попадёт.'
            : 'Авто: звук всех приложений/игр, кроме самого RelayApp (голос войса не попадёт).')
        : cfg.audioMode === 'include'
            ? 'Ручной режим: только звук выбранного процесса.'
            : 'Ручной режим: весь звук, кроме RelayApp.'}</p>
    </div>

    {/* Дополнительно: звук вручную + прямые подключения (топология). Спрятано ради простоты. */}
    <details style={{ marginTop: 6 }}>
      <summary style={{ cursor: 'pointer' }} className="msub">Дополнительно</summary>
      <div style={{ marginTop: 10 }}>
        <div className="fld"><label>Источник звука</label>
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
        <div className="fld"><label>Прямые подключения к тебе</label>
          <div className="seg">
            <button className={!cfg.allowDirectPeers ? 'active' : ''} onClick={() => setCfg((c) => ({ ...c, allowDirectPeers: false }))}>Только через сервер</button>
            <button className={cfg.allowDirectPeers ? 'active' : ''} onClick={() => setCfg((c) => ({ ...c, allowDirectPeers: true }))}>Разрешить ({cfg.maxDirectChildren} слот.)</button>
          </div>
          <p className="msub" style={{ margin: '8px 0 0' }}>{cfg.allowDirectPeers
            ? `Зрители могут брать поток напрямую с тебя (до ${cfg.maxDirectChildren} прямых слотов). Остальные — через сервер.`
            : 'Все зрители получают поток через сервер (меньше нагрузки на твою отдачу, стабильнее).'}</p>
          {cfg.allowDirectPeers && <div style={{ marginTop: 8 }}>
            <label className="msub">Прямых слотов: {cfg.maxDirectChildren}</label>
            <input type="range" min={DIRECT_MIN} max={DIRECT_MAX} step={1} value={cfg.maxDirectChildren} onChange={(e) => setCfg((c) => ({ ...c, maxDirectChildren: +e.target.value }))} />
          </div>}
        </div>
      </div>
    </details>

    <div className="rowbtns">
      <button className="ghost" style={{ margin: 0 }} onClick={close}>Отмена</button>
      <button className="primary" style={{ margin: 0 }} disabled={busy || (cfg.sourceKind === 'window' && cfg.windowHwnd == null) || (cfg.audioMode === 'include' && cfg.audioPid == null)} onClick={start}>Начать трансляцию</button>
    </div>
    <div className="err">{err}</div>
  </Backdrop>;
}
