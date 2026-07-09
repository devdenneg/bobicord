import { useEffect, useRef, useState } from 'react';
import { useMusic } from '../music';
import { loadYT } from '../youtube';
import { Icon } from '../Icon';

// Мини-плеер совместного прослушивания (в VoiceDock, только когда ты в голосовом). YouTube IFrame играет
// текущий трек синхронно у всех в канале; управление идёт через music-store (рассылается по data-каналу).
// Видео держим маленьким, но ВИДИМЫМ (ToS Watch Together). Автоплей у пиров может требовать жеста → «Включить».
const YT_ELEM = 'yt-music-player';
const fmt = (s: number) => { s = Math.max(0, Math.floor(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };

export function MusicPlayer() {
  const m = useMusic();
  const playerRef = useRef<any>(null);
  const readyRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [addUrl, setAddUrl] = useState('');
  const [err, setErr] = useState('');
  const [needGesture, setNeedGesture] = useState(false);
  const [pos, setPos] = useState(0);
  const [dur, setDur] = useState(0);
  // vc-lifecycle сессии — в глобальном вотчере (music.ts initMusic), чтобы не сбрасывалось при ремонте дока.

  // создать IFrame-плеер один раз
  useEffect(() => {
    let cancelled = false;
    loadYT().then(() => {
      if (cancelled || playerRef.current) return;
      const YT = (window as any).YT;
      playerRef.current = new YT.Player(YT_ELEM, {
        width: '132', height: '74',
        playerVars: { controls: 0, disablekb: 1, modestbranding: 1, rel: 0, playsinline: 1, iv_load_policy: 3 },
        events: {
          onReady: () => { readyRef.current = true; sync(); },
          onStateChange: (e: any) => {
            if (e.data === YT.PlayerState.ENDED) useMusic.getState().onEnded();
            if (e.data === YT.PlayerState.PLAYING) setNeedGesture(false);
          },
        },
      });
    });
    return () => { cancelled = true; try { playerRef.current?.destroy?.(); } catch { /**/ } playerRef.current = null; readyRef.current = false; };
  }, []);

  // синхронизируем плеер с состоянием сессии (трек / позиция / пауза)
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
      if (st.playing) p.playVideo?.(); else p.pauseVideo?.();
    } catch { /**/ }
    window.setTimeout(() => { try { if (useMusic.getState().playing && playerRef.current?.getPlayerState?.() !== 1) setNeedGesture(true); } catch { /**/ } }, 900);
  };
  const cur = m.current();
  const curId = cur?.id || '';
  useEffect(() => { sync(); }, [curId, m.seekTick, m.playing]); // eslint-disable-line react-hooks/exhaustive-deps

  // прогресс-тик + дрейф-коррекция (сик, если разошлось >2с)
  useEffect(() => {
    const t = window.setInterval(() => {
      const st = useMusic.getState();
      setPos(st.currentPos());
      const p = playerRef.current;
      if (p && readyRef.current) {
        try { setDur(p.getDuration?.() || 0); if (st.playing) { const d = Math.abs((p.getCurrentTime?.() || 0) - st.currentPos()); if (d > 2) p.seekTo(st.currentPos(), true); } } catch { /**/ }
      }
    }, 1000);
    return () => clearInterval(t);
  }, []);

  const onAdd = async () => {
    if (!addUrl.trim()) return;
    const e = await useMusic.getState().add(addUrl);
    if (e) setErr(e); else { setErr(''); setAddUrl(''); }
  };

  return (
    <div className={'music' + (open ? ' open' : '')}>
      <div className="mus-head">
        <div className="mus-vid"><div id={YT_ELEM} /></div>
        <div className="mus-info" onClick={() => setOpen((o) => !o)}>
          <div className="mus-title">{cur ? cur.title : 'Совместное прослушивание'}</div>
          <div className="mus-sub">{cur ? (m.playing ? 'играет' : 'пауза') + (cur.by ? ' · ' + cur.by : '') : 'вставь ссылку YouTube'}</div>
        </div>
        <button className="mus-b" onClick={() => useMusic.getState().prev()} disabled={m.index <= 0} data-tip="Назад">⏮</button>
        <button className="mus-b play" onClick={() => useMusic.getState().toggle()} disabled={!m.queue.length} data-tip="Пауза/играть">{m.playing ? '⏸' : '▶'}</button>
        <button className="mus-b" onClick={() => useMusic.getState().next()} disabled={m.index + 1 >= m.queue.length} data-tip="Дальше">⏭</button>
        <button className={'mus-b caret' + (open ? ' on' : '')} onClick={() => setOpen((o) => !o)} data-tip="Очередь"><Icon name="chevron" sm /></button>
      </div>

      {needGesture ? <button className="mus-gesture" onClick={() => { try { playerRef.current?.playVideo?.(); } catch { /**/ } setNeedGesture(false); }}>▶ Включить звук (браузер требует нажатие)</button> : null}

      {open ? (
        <div className="mus-body">
          <div className="mus-prog">
            <span>{fmt(pos)}</span>
            <input type="range" min={0} max={Math.max(1, dur)} value={Math.min(pos, dur || pos)} onChange={(e) => useMusic.getState().seek(+e.target.value)} disabled={!cur} />
            <span>{dur ? fmt(dur) : '—'}</span>
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
        </div>
      ) : null}
    </div>
  );
}
