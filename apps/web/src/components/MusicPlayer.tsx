import { useEffect, useRef, useState } from 'react';
import { useMusic } from '../music';
import { loadYT } from '../youtube';
import { Icon } from '../Icon';

// Мини-плеер совместного прослушивания (в VoiceDock, только если фича включена в настройках сервера и ты
// в голосовом). YouTube IFrame играет текущий трек синхронно у всех (music-store через data-канал).
// Громкость — ЛОКАЛЬНАЯ у каждого (localStorage 'musicVol'), дефолт 10%. Видео маленькое, но видимое (ToS).
const YT_ELEM = 'yt-music-player';
const fmt = (s: number) => { s = Math.max(0, Math.floor(s || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const getVol = () => { const v = parseInt(localStorage.getItem('musicVol') || '10', 10); return isNaN(v) ? 10 : Math.max(0, Math.min(100, v)); };

export function MusicPlayer({ enabled }: { enabled: boolean }) {
  const m = useMusic();
  const playerRef = useRef<any>(null);
  const readyRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [addUrl, setAddUrl] = useState('');
  const [err, setErr] = useState('');
  const [needGesture, setNeedGesture] = useState(false);
  const [pos, setPos] = useState(0);
  const [dur, setDur] = useState(0);
  const [vol, setVol] = useState(getVol);
  const volRef = useRef(vol);

  const applyVol = (v: number) => {
    volRef.current = v; setVol(v); localStorage.setItem('musicVol', String(v));
    try { const p = playerRef.current; if (p && readyRef.current) { p.setVolume(v); if (v > 0) p.unMute?.(); } } catch { /**/ }
  };

  // синхронизируем плеер с состоянием сессии (трек / позиция / пауза) + громкость
  const sync = () => {
    const p = playerRef.current; if (!p || !readyRef.current) return;
    const st = useMusic.getState();
    const c = st.current();
    if (!c) { try { p.stopVideo?.(); } catch { /**/ } return; }
    const posSec = st.currentPos();
    try {
      const loaded = p.getVideoData?.()?.video_id || '';
      if (loaded !== c.id) p.loadVideoById({ videoId: c.id, startSeconds: posSec });
      else { const d = Math.abs((p.getCurrentTime?.() || 0) - posSec); if (d > 1.5) p.seekTo(posSec, true); }
      p.setVolume(volRef.current); if (volRef.current > 0) p.unMute?.();
      if (st.playing) p.playVideo?.(); else p.pauseVideo?.();
    } catch { /**/ }
    // autoplay-политика у пиров: если должно играть, а не играет / замьючено — просим жест
    window.setTimeout(() => { try { const pl = playerRef.current; if (useMusic.getState().playing && (pl?.getPlayerState?.() !== 1 || pl?.isMuted?.())) setNeedGesture(true); } catch { /**/ } }, 900);
  };

  // создать IFrame-плеер один раз (только когда фича включена)
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    loadYT().then(() => {
      if (cancelled || playerRef.current) return;
      const YT = (window as any).YT;
      playerRef.current = new YT.Player(YT_ELEM, {
        width: '256', height: '144',
        playerVars: { controls: 0, disablekb: 1, modestbranding: 1, rel: 0, playsinline: 1, iv_load_policy: 3 },
        events: {
          onReady: () => { readyRef.current = true; try { playerRef.current.setVolume(volRef.current); } catch { /**/ } sync(); },
          onStateChange: (e: any) => {
            if (e.data === YT.PlayerState.ENDED) useMusic.getState().onEnded();
            if (e.data === YT.PlayerState.PLAYING) setNeedGesture(false);
          },
        },
      });
    });
    return () => { cancelled = true; try { playerRef.current?.destroy?.(); } catch { /**/ } playerRef.current = null; readyRef.current = false; };
  }, [enabled]);

  const cur = m.current();
  const curId = cur?.id || '';
  useEffect(() => { sync(); }, [curId, m.seekTick, m.playing]); // eslint-disable-line react-hooks/exhaustive-deps

  // прогресс-тик + дрейф-коррекция
  useEffect(() => {
    if (!enabled) return;
    const t = window.setInterval(() => {
      const st = useMusic.getState();
      setPos(st.currentPos());
      const p = playerRef.current;
      if (p && readyRef.current) { try { setDur(p.getDuration?.() || 0); if (st.playing) { const d = Math.abs((p.getCurrentTime?.() || 0) - st.currentPos()); if (d > 2) p.seekTo(st.currentPos(), true); } } catch { /**/ } }
    }, 1000);
    return () => clearInterval(t);
  }, [enabled]);

  const onAdd = async () => {
    if (!addUrl.trim()) return;
    const e = await useMusic.getState().add(addUrl);
    if (e) setErr(e); else { setErr(''); setAddUrl(''); }
  };
  const gesture = () => {
    try { const p = playerRef.current; if (p && readyRef.current) { p.unMute?.(); p.setVolume(volRef.current); p.seekTo(useMusic.getState().currentPos(), true); p.playVideo?.(); } } catch { /**/ }
    setNeedGesture(false);
  };

  if (!enabled) return null;

  return (
    <div className={'music' + (open ? ' open' : '')}>
      <div className="mus-bar">
        <span className="mus-thumb"><div id={YT_ELEM} /></span>
        <div className="mus-meta" onClick={() => setOpen((o) => !o)}>
          <div className="mus-title">{cur ? cur.title : 'Совместное прослушивание'}</div>
          <div className="mus-sub">{cur ? (m.playing ? '♪ играет' : 'пауза') + (cur.by ? ' · ' + cur.by : '') : 'вставь ссылку YouTube'}</div>
        </div>
        <div className="mus-ctrls">
          <button className="mus-b" onClick={() => useMusic.getState().prev()} disabled={m.index <= 0} data-tip="Назад">⏮</button>
          <button className="mus-b play" onClick={() => useMusic.getState().toggle()} disabled={!m.queue.length} data-tip="Пауза/играть">{m.playing ? '⏸' : '▶'}</button>
          <button className="mus-b" onClick={() => useMusic.getState().next()} disabled={m.index + 1 >= m.queue.length} data-tip="Дальше">⏭</button>
        </div>
        <button className={'mus-caret' + (open ? ' on' : '')} onClick={() => setOpen((o) => !o)} data-tip={open ? 'Свернуть' : 'Развернуть'}><Icon name="chevron" sm /></button>
      </div>

      {needGesture ? <button className="mus-gesture" onClick={gesture}>▶ Включить звук (браузер требует нажатие)</button> : null}

      <div className="mus-panel-wrap">
        <div className="mus-panel"><div className="mus-panel-in">
          <div className="mus-prog">
            <span className="mus-t">{fmt(pos)}</span>
            <input type="range" min={0} max={Math.max(1, dur)} value={Math.min(pos, dur || pos)} onChange={(e) => useMusic.getState().seek(+e.target.value)} disabled={!cur} />
            <span className="mus-t">{dur ? fmt(dur) : '—'}</span>
          </div>
          <div className="mus-vol">
            <Icon name="speaker" sm />
            <input type="range" min={0} max={100} value={vol} onChange={(e) => applyVol(+e.target.value)} data-tip="Громкость (только у тебя)" />
            <span className="mus-t">{vol}%</span>
          </div>
          <div className="mus-add">
            <input placeholder="Ссылка YouTube…" value={addUrl} onChange={(e) => { setAddUrl(e.target.value); setErr(''); }} onKeyDown={(e) => { if (e.key === 'Enter') onAdd(); }} />
            <button onClick={onAdd} data-tip="Добавить в очередь"><Icon name="plus" sm /></button>
          </div>
          {err ? <div className="mus-err">{err}</div> : null}
          <div className="mus-queue">
            {m.queue.length === 0 ? <div className="mus-empty">Очередь пуста — добавь трек</div> : null}
            {m.queue.map((t, i) => (
              <div key={i} className={'mus-q' + (i === m.index ? ' cur' : '')}>
                <button className="mus-q-i" onClick={() => useMusic.getState().jump(i)} data-tip="Играть">{i === m.index && m.playing ? '♪' : i + 1}</button>
                <span className="mus-q-t" title={t.title}>{t.title}</span>
                <button className="mus-q-x" onClick={() => useMusic.getState().remove(i)} data-tip="Убрать">×</button>
              </div>
            ))}
          </div>
          {m.queue.length ? <button className="mus-clear" onClick={() => useMusic.getState().clear()}>Очистить очередь</button> : null}
        </div></div>
      </div>
    </div>
  );
}
