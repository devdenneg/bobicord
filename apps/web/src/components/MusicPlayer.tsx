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
// Ползунок (0..100, «человеческий» %) → реальная громкость YT (0..100). Перцептивная кривая: слух ~логарифмический,
// а музыкальные треки громкие → линейный setVolume(1) уже отчётливо слышно. Понижаем мастер (потолок 40) и
// поджимаем низ (γ=1.4): 1% → ~0 (почти тишина), 10% (дефолт) → ~2 (тихий фон), 50% → ~15, 100% → 40 (потолок).
const ytVol = (pct: number) => Math.round(40 * Math.pow(Math.max(0, Math.min(100, pct)) / 100, 1.4));

export function MusicPlayer({ enabled }: { enabled: boolean }) {
  const m = useMusic();
  const playerRef = useRef<any>(null);
  const readyRef = useRef(false);
  const hasPlayedRef = useRef(false); // хоть раз звук пошёл со звуком (autoplay-жест уже получен) → плашку больше не показываем
  const [open, setOpen] = useState(false);
  const [addUrl, setAddUrl] = useState('');
  const [adding, setAdding] = useState(false); // идёт запрос названия трека — блокируем повторное добавление
  const [err, setErr] = useState('');
  const [playErr, setPlayErr] = useState(''); // трек не воспроизводится у ТЕБЯ (регион/встраивание/удалён) — onError YT
  const [needGesture, setNeedGesture] = useState(false);
  const [pos, setPos] = useState(0);
  const [dur, setDur] = useState(0);
  const [vol, setVol] = useState(getVol);
  const volRef = useRef(vol);

  const applyVol = (v: number) => {
    volRef.current = v; setVol(v); localStorage.setItem('musicVol', String(v));
    try { const p = playerRef.current; if (p && readyRef.current) { p.setVolume(ytVol(v)); if (v > 0 && hasPlayedRef.current) p.unMute?.(); } } catch { /**/ }
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
      p.setVolume(ytVol(volRef.current));
      if (hasPlayedRef.current) { if (volRef.current > 0) p.unMute?.(); } // звук уже разблокирован — держим unmute
      else if (volRef.current > 0) p.unMute?.();                          // оптимистично пробуем со звуком (высокий MEI разрешит)
      if (st.playing) p.playVideo?.(); else p.pauseVideo?.();
    } catch { /**/ }
    // autoplay-политика браузера. playVideo идёт в iframe через postMessage → теряет user-activation, поэтому
    // старт СО ЗВУКОМ у большинства (низкий media-engagement) блокируется, а клик по «Включить звук» напрямую
    // playVideo тоже не разблокирует. Решение: если через 2.5с звук не пошёл сам — крутим ВИДЕО ТИХО (muted-autoplay
    // активацию не требует, всегда ок) и показываем плашку; она затем лишь снимет mute (unMute у уже играющего видео
    // активацию НЕ требует). Проверка один раз и только пока звук ни разу не шёл — паузу/сик/смену трека не дёргает.
    if (st.playing && !hasPlayedRef.current) {
      window.setTimeout(() => {
        try {
          const pl = playerRef.current; if (!pl) return;
          if (!useMusic.getState().playing || hasPlayedRef.current) return;
          const state = pl.getPlayerState?.();
          if (state === 1 && !pl.isMuted?.()) { hasPlayedRef.current = true; setNeedGesture(false); return; } // MEI разрешил звук сам
          try { pl.mute?.(); pl.playVideo?.(); } catch { /**/ }  // заблокировано → гарантируем тихое проигрывание в синхроне
          setNeedGesture(true);
        } catch { /**/ }
      }, 2500);
    }
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
          onReady: () => { readyRef.current = true; try { playerRef.current.setVolume(ytVol(volRef.current)); } catch { /**/ } sync(); },
          onStateChange: (e: any) => {
            if (e.data === YT.PlayerState.ENDED) useMusic.getState().onEnded();
            // Звук реально пошёл (не форс-мьют) → жест получен, плашку прячем навсегда.
            if (e.data === YT.PlayerState.PLAYING) { const pl = playerRef.current; if (pl && !pl.isMuted?.()) { hasPlayedRef.current = true; setNeedGesture(false); } setPlayErr(''); }
          },
          // Ролик не воспроизводится У ЭТОГО юзера (у других может играть): 2 — плохой id, 5 — HTML5-сбой (транзиент,
          // повтор), 100 — удалён/приватный, 101/150 — встраивание запрещено владельцем или регион-блок. Показываем
          // причину + даём «Пропустить» (шлёт next() всем). Молча стоящий плеер (стор думает «играет») так объясняется.
          onError: (e: any) => {
            const code = e?.data;
            if (code === 5) { try { playerRef.current?.playVideo?.(); } catch { /**/ } return; }
            setPlayErr(code === 100 ? 'Трек удалён или приватный'
              : (code === 101 || code === 150) ? 'Трек недоступен у тебя (запрет встраивания или регион)'
              : 'Не удалось воспроизвести трек');
          },
        },
      });
    });
    return () => { cancelled = true; try { playerRef.current?.destroy?.(); } catch { /**/ } playerRef.current = null; readyRef.current = false; };
  }, [enabled]);

  const cur = m.current();
  const curId = cur?.id || '';
  useEffect(() => { sync(); }, [curId, m.seekTick, m.playing]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setPlayErr(''); }, [curId]); // сменился трек — гасим прошлую ошибку воспроизведения

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
    if (adding || !addUrl.trim()) return; // не даём копить клики, пока грузится название текущего
    setAdding(true);
    const e = await useMusic.getState().add(addUrl);
    setAdding(false);
    if (e) setErr(e); else { setErr(''); setAddUrl(''); }
  };
  const gesture = () => {
    // Видео к этому моменту уже крутится ТИХО (см. sync-фолбэк) → снятие mute активацию не требует и проходит.
    // Прячем плашку не сразу, а по факту размьюта (isMuted=false) — иначе спрятали бы при неудаче.
    try { const p = playerRef.current; if (p && readyRef.current) { p.unMute?.(); p.setVolume(ytVol(volRef.current)); p.seekTo(useMusic.getState().currentPos(), true); p.playVideo?.(); } } catch { /**/ }
    const confirm = () => { try { const pl = playerRef.current; if (pl && !pl.isMuted?.()) { hasPlayedRef.current = true; setNeedGesture(false); } } catch { /**/ } };
    window.setTimeout(confirm, 250); window.setTimeout(confirm, 800);
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
          <button className="mus-b" onClick={() => useMusic.getState().prev()} disabled={m.index <= 0} data-tip="Назад"><Icon name="skip-prev" sm /></button>
          <button className="mus-b play" onClick={() => useMusic.getState().toggle()} disabled={!m.queue.length} data-tip="Пауза/играть"><Icon name={m.playing ? 'pause' : 'play'} sm /></button>
          <button className="mus-b" onClick={() => useMusic.getState().next()} disabled={m.index + 1 >= m.queue.length} data-tip="Дальше"><Icon name="skip-next" sm /></button>
        </div>
        <button className={'mus-caret' + (open ? ' on' : '')} onClick={() => setOpen((o) => !o)} data-tip={open ? 'Свернуть' : 'Развернуть'}><Icon name="chevron" sm /></button>
      </div>

      {needGesture ? <button className="mus-gesture" onClick={gesture}>▶ Включить звук (браузер требует нажатие)</button> : null}

      {playErr ? <div className="mus-note"><Icon name="warn" sm /><span>{playErr}</span><button onClick={() => useMusic.getState().next()}>Пропустить</button></div> : null}

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
            <input placeholder="Ссылка YouTube…" value={addUrl} disabled={adding} onChange={(e) => { setAddUrl(e.target.value); setErr(''); }} onKeyDown={(e) => { if (e.key === 'Enter') onAdd(); }} />
            <button onClick={onAdd} disabled={adding || !addUrl.trim()} data-tip="Добавить в очередь">{adding ? <span className="mus-spin" /> : <Icon name="plus" sm />}</button>
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
