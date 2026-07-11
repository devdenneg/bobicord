// Виджет вещателя (натив): постоянная плашка в колонке каналов НАД «Голосовая связь
// подключена», пока идёт нативная трансляция (broadcastLive). Показывает зрителей+аватарки,
// статы стрима (компакт+раскрытие), управление (стоп/настройки/смена источника/свернуть)
// и превью-тумбнейл кадра (Шаг 2, натив). Гейт показа — isTauri && broadcastLive.
import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { useEngine } from '../hooks';
import { Icon } from '../Icon';
import { avColor, initial } from '../util';
import { resolveUploadUrl } from '../api';
import {
  isTauri, onBroadcastStats, onBroadcastPreview, setPreviewInterval, stopNativeBroadcast, setNativeBroadcastSource,
  listMonitors, listWindows,
} from '../native';
import type { BroadcastStats, MonitorInfo, WindowInfo } from '../native';
import { endAnyBroadcasterSession } from '../diag';
import { loadConfig, saveConfig, buildSource, deriveAudioPid } from '../broadcastSource';

// Мбит/с из bps, 2 знака (факт) / 1 знак (цель) — как dbgstats в BroadcastModal.
const mbps = (bps: number, digits = 2) => (bps / 1_000_000).toFixed(digits);

export function StreamerWidget() {
  const live = useStore((s) => s.broadcastLive);
  const me = useStore((s) => s.me);
  const eng = useEngine();
  const [stats, setStats] = useState<BroadcastStats | null>(null);
  const [png, setPng] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [srcOpen, setSrcOpen] = useState(false);
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  const [windows, setWindows] = useState<WindowInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const srcRef = useRef<HTMLDivElement>(null);

  // Статы вещателя (broadcast-событие широковещательное — одновременная подписка с
  // BroadcastModal безопасна). Живёт всё время показа виджета.
  useEffect(() => {
    if (!isTauri || !live) { setStats(null); return; }
    let un: (() => void) | undefined;
    onBroadcastStats(setStats).then((u) => (un = u));
    return () => un?.();
  }, [live]);

  // Превью-тумбнейл кадра (натив). Приходит по relay-broadcast-preview с интервалом,
  // которым мы же управляем (setPreviewInterval) ниже.
  useEffect(() => {
    if (!isTauri || !live) { setPng(null); return; }
    let un: (() => void) | undefined;
    onBroadcastPreview((p) => setPng(p.png)).then((u) => (un = u));
    return () => un?.();
  }, [live]);

  // Каденс превью: развёрнут → 3с, свёрнут → 0 (не гнать тумбнейл зря). Hover меняет на 1с
  // (обработчики на <img>). Размонтирование виджета (стоп трансляции) → 0.
  useEffect(() => {
    if (!isTauri || !live) return;
    setPreviewInterval(collapsed ? 0 : 3000);
  }, [live, collapsed]);
  useEffect(() => () => { if (isTauri) setPreviewInterval(0); }, []);

  // Списки источников для быстрой смены — грузим при открытии дропдауна (и на mount).
  useEffect(() => {
    if (!isTauri || !live) return;
    listMonitors().then(setMonitors).catch(() => {});
    listWindows().then(setWindows).catch(() => {});
  }, [live, srcOpen]);

  // Закрытие дропдауна источника по клику вне.
  useEffect(() => {
    if (!srcOpen) return;
    const onDoc = (e: MouseEvent) => { if (srcRef.current && !srcRef.current.contains(e.target as Node)) setSrcOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [srcOpen]);

  if (!isTauri || !live || !me) return null;

  const watchers = eng.watchers[me.username] || [];

  // Стоп — зеркало stop() из BroadcastModal: снести нативную трансляцию, сбросить флаг,
  // закрыть диаг-сессию вещателя (лог сдаётся на закрытии).
  const stop = async () => {
    setBusy(true);
    try { await stopNativeBroadcast(); useStore.getState().setBroadcastLive(false); }
    catch { /* игнор — флаг всё равно снимаем ниже через onBroadcastStopped */ }
    finally { endAnyBroadcasterSession(); setBusy(false); }
  };

  // Быстрая смена источника на лету (не рвёт трансляцию, дерево зрителей живёт).
  const pickMonitor = async (index: number) => {
    setSrcOpen(false); setBusy(true);
    try {
      const cfg = { ...loadConfig(), sourceKind: 'monitor' as const, monitorIndex: index };
      await setNativeBroadcastSource(buildSource(cfg), deriveAudioPid(cfg, windows));
      saveConfig(cfg);
    } catch { /* тост об ошибке не критичен — статы покажут результат */ }
    finally { setBusy(false); }
  };
  const pickWindow = async (w: WindowInfo) => {
    setSrcOpen(false); setBusy(true);
    try {
      const cfg = { ...loadConfig(), sourceKind: 'window' as const, windowHwnd: w.hwnd, audioPid: w.pid };
      await setNativeBroadcastSource(buildSource(cfg), deriveAudioPid(cfg, windows));
      saveConfig(cfg);
    } catch { /* см. выше */ }
    finally { setBusy(false); }
  };

  // Свёрнутый вид — одна строка: иконка + счётчик зрителей + развернуть.
  if (collapsed) {
    return (
      <div className="sw sw-collapsed">
        <button className="sw-cbar" onClick={() => setCollapsed(false)} data-tip="Развернуть виджет трансляции">
          <span className="sw-live"><Icon name="screen" sm /></span>
          <span className="sw-ctitle">Трансляция</span>
          <span className="sw-wcount"><Icon name="eye" sm />{watchers.length}</span>
          <Icon name="chevron" sm />
        </button>
      </div>
    );
  }

  return (
    <div className="sw">
      <div className="sw-head">
        <span className="sw-live"><Icon name="screen" sm /></span>
        <div className="sw-htxt"><b>Трансляция идёт</b><span title={stats?.source || ''}>{stats?.source || 'подготовка…'}</span></div>
        <button className="sw-mini" onClick={() => setCollapsed(true)} data-tip="Свернуть виджет"><Icon name="chevron" sm /></button>
      </div>

      {/* Превью-тумбнейл кадра (натив). Hover учащает эмит до 1с, уход — обратно 3с. */}
      {png ? (
        <img className="sw-thumb" src={`data:image/png;base64,${png}`} alt="Превью трансляции"
          onMouseEnter={() => setPreviewInterval(1000)} onMouseLeave={() => setPreviewInterval(3000)} />
      ) : null}

      {/* Зрители: стек аватарок + счётчик + тултип со списком (как оверлей .watchers на тайле). */}
      <div className="sw-watchers">
        <div className="sw-avstack">
          {watchers.slice(0, 4).map((w, i) => (
            <div className="sw-wa" key={i} style={{ background: w.avatarUrl ? '#0000' : avColor(w.name, w.color) }} title={w.name}>
              {w.avatarUrl ? <img className="avimg" src={resolveUploadUrl(w.avatarUrl)} alt="" /> : initial(w.name)}
            </div>
          ))}
        </div>
        <span className="sw-wc"><Icon name="eye" sm />{watchers.length} {watchers.length === 1 ? 'зритель' : 'смотрят'}</span>
        {watchers.length ? (
          <div className="sw-wtip">
            <div className="sw-wtip-h">Смотрят · {watchers.length}</div>
            {watchers.map((w, i) => (
              <div className="sw-wtip-row" key={i}>
                <span className="sw-wtip-av" style={{ background: w.avatarUrl ? '#0000' : avColor(w.name, w.color) }}>
                  {w.avatarUrl ? <img className="avimg" src={resolveUploadUrl(w.avatarUrl)} alt="" /> : initial(w.name)}
                </span>{w.name}
              </div>
            ))}
          </div>
        ) : null}
      </div>

      {/* Статы: компакт (зрители/битрейт факт-цель/fps/разрешение) + раскрытие. */}
      {stats ? (
        <div className="sw-stats">
          <div className="sw-srow">
            <span className="sw-schip" title="Битрейт факт/цель">{mbps(stats.bitrateActualBps)}/{mbps(stats.bitrateTargetBps, 1)} Мбит</span>
            <span className="sw-schip" title="FPS кодера/цель">{stats.encoderFps.toFixed(0)}/{stats.targetFps} fps</span>
            <span className="sw-schip" title="Разрешение">{stats.width}×{stats.height}</span>
            <button className="sw-more" onClick={() => setShowAll((v) => !v)} data-tip={showAll ? 'Скрыть подробности' : 'Подробнее'}>
              <Icon name="info" sm />
            </button>
          </div>
          {showAll ? (
            <div className="sw-detail">
              <div><span>Захват</span><b>{stats.captureFps.toFixed(1)} fps</b></div>
              <div><span>Потеряно кадров</span><b>{stats.droppedFrames}</b></div>
              <div><span>Детей в дереве</span><b>{stats.children}</b></div>
              <div><span>Источник</span><b title={stats.source}>{stats.source}</b></div>
            </div>
          ) : null}
        </div>
      ) : <p className="sw-collecting">Собираю статистику…</p>}

      {/* Управление: стоп · настройки · смена источника. */}
      <div className="sw-ctrls">
        <button className="sw-btn sw-stop" disabled={busy} onClick={stop} data-tip="Остановить трансляцию"><Icon name="screen-stop" sm /></button>
        <button className="sw-btn" onClick={() => useStore.getState().setModal('broadcast')} data-tip="Настройки трансляции"><Icon name="gear" sm /></button>
        <div className="sw-srcwrap" ref={srcRef}>
          <button className={'sw-btn' + (srcOpen ? ' on' : '')} disabled={busy} onClick={() => setSrcOpen((v) => !v)} data-tip="Сменить источник">
            <Icon name="screen" sm /><Icon name="chevron" sm />
          </button>
          {srcOpen ? (
            <div className="sw-srcmenu">
              <div className="sw-srch">Экран</div>
              {monitors.map((m) => <button key={'m' + m.index} className="sw-srcitem" onClick={() => pickMonitor(m.index)}>{m.name || `Монитор ${m.index}`}</button>)}
              <div className="sw-srch">Окно</div>
              {windows.length === 0 ? <div className="sw-srcempty">Нет окон</div>
                : windows.map((w) => <button key={'w' + w.hwnd} className="sw-srcitem" title={w.title} onClick={() => pickWindow(w)}>{w.title}{w.process ? ` — ${w.process}` : ''}</button>)}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
