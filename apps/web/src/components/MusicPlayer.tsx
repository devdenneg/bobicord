import { useEffect, useRef, useState } from 'react';
import { useMusic } from '../music';
import { api } from '../api';
import { Icon } from '../Icon';

// Мини-плеер совместного прослушивания (в VoiceDock, если фича включена на сервере и ты в голосовом).
// Аудио приходит через медиа-релей (deploy/media-relay) — обход блокировки YouTube: <audio> тянет поток
// с релея (браузер↔релей напрямую, мимо основного VPS). Текущий трек синхронен у всех (music-store через
// data-канал). Громкость — ЛОКАЛЬНАЯ у каждого (localStorage 'musicVol'), дефолт 10%.
const fmt = (s: number) => { s = Math.max(0, Math.floor(s || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const getVol = () => { const v = parseInt(localStorage.getItem('musicVol') || '10', 10); return isNaN(v) ? 10 : Math.max(0, Math.min(100, v)); };
// Ползунок (0..100 «человеческих» %) → <audio>.volume (0..1). Перцептивная кривая (слух ~логарифмический,
// треки громкие): мастер-потолок 0.4 + γ=1.4. 1% → ~0 (тишина), 10% (дефолт) → ~0.016 (тихий фон), 100% → 0.4.
const audioVol = (pct: number) => Math.pow(Math.max(0, Math.min(100, pct)) / 100, 1.4) * 0.4;

export function MusicPlayer({ enabled }: { enabled: boolean }) {
  const m = useMusic();
  const audioRef = useRef<HTMLAudioElement>(null);
  const [open, setOpen] = useState(false);
  const [addUrl, setAddUrl] = useState('');
  const [adding, setAdding] = useState(false); // идёт запрос названия трека — блокируем повторное добавление
  const [err, setErr] = useState('');
  const [playErr, setPlayErr] = useState('');   // трек не воспроизводится у ТЕБЯ (релей/сеть)
  const [needGesture, setNeedGesture] = useState(false); // браузер заблокировал автоплей со звуком
  const [pos, setPos] = useState(0);
  const [dur, setDur] = useState(0);
  const [vol, setVol] = useState(getVol);
  const volRef = useRef(vol);
  const resolvedFor = useRef('');   // videoId, для которого сейчас выставлен src (защита от гонок резолва)
  const [resolving, setResolving] = useState(false);

  const applyVol = (v: number) => {
    volRef.current = v; setVol(v); localStorage.setItem('musicVol', String(v));
    const a = audioRef.current; if (a) a.volume = audioVol(v);
  };
  // Пытаемся играть; браузер блокирует автоплей со звуком без жеста → показываем плашку.
  const tryPlay = () => { const a = audioRef.current; if (!a) return; a.play().then(() => setNeedGesture(false)).catch(() => setNeedGesture(true)); };

  const cur = m.current();
  const curId = cur?.id || '';

  // Резолв аудио-URL при смене трека (через медиа-релей). src применяется здесь, позиция/старт — в
  // onLoadedMetadata (currentTime до метаданных не выставить).
  useEffect(() => {
    if (!enabled) return;
    const a = audioRef.current;
    if (!curId) { resolvedFor.current = ''; if (a) { a.removeAttribute('src'); a.load(); } setDur(0); return; }
    if (resolvedFor.current === curId) return;
    let cancelled = false;
    setResolving(true); setPlayErr('');
    api.musicResolve(curId).then((d) => {
      if (cancelled) return;
      resolvedFor.current = curId;
      if (d.duration) setDur(d.duration);
      const el = audioRef.current; if (!el) return;
      el.src = d.url; el.load(); // → onLoadedMetadata выставит позицию и запустит при playing
    }).catch(() => { if (!cancelled) setPlayErr('Не удалось получить аудио (релей недоступен?)'); })
      .finally(() => { if (!cancelled) setResolving(false); });
    return () => { cancelled = true; };
  }, [curId, enabled]);

  // Синк play/pause/seek: состояние стора → <audio>. Ждём, пока src выставлен для текущего трека.
  useEffect(() => {
    const a = audioRef.current; if (!a || !enabled || resolving) return;
    if (resolvedFor.current !== curId || !curId) return;
    const st = useMusic.getState();
    if (isFinite(a.duration) && a.duration > 0) {
      const target = st.currentPos();
      if (Math.abs(a.currentTime - target) > 1.5) { try { a.currentTime = target; } catch { /**/ } }
    }
    if (st.playing) tryPlay(); else a.pause();
  }, [m.playing, m.seekTick, curId, enabled, resolving]);

  // Прогресс-тик (позиция синхронна через стор) + дрейф-коррекция локального аудио.
  useEffect(() => {
    if (!enabled) return;
    const t = window.setInterval(() => {
      const st = useMusic.getState();
      setPos(st.currentPos());
      const a = audioRef.current;
      if (a && isFinite(a.duration) && a.duration > 0) {
        setDur(a.duration);
        if (st.playing) { const d = Math.abs(a.currentTime - st.currentPos()); if (d > 2) { try { a.currentTime = st.currentPos(); } catch { /**/ } } }
      }
    }, 1000);
    return () => clearInterval(t);
  }, [enabled]);

  const onAdd = async () => {
    if (adding || !addUrl.trim()) return; // не даём копить клики, пока грузится название
    setAdding(true);
    const e = await useMusic.getState().add(addUrl);
    setAdding(false);
    if (e) setErr(e); else { setErr(''); setAddUrl(''); }
  };
  // Клик по плашке = user-activation → play() со звуком проходит.
  const gesture = () => {
    const a = audioRef.current; if (!a) return;
    a.volume = audioVol(volRef.current);
    try { a.currentTime = useMusic.getState().currentPos(); } catch { /**/ }
    tryPlay();
  };

  if (!enabled) return null;

  return (
    <div className={'music' + (open ? ' open' : '')}>
      <audio
        ref={audioRef}
        preload="auto"
        onLoadedMetadata={() => {
          const a = audioRef.current; if (!a) return;
          a.volume = audioVol(volRef.current);
          const st = useMusic.getState();
          try { a.currentTime = st.currentPos(); } catch { /**/ }
          if (st.playing) tryPlay();
        }}
        onEnded={() => useMusic.getState().onEnded()}
        onPlaying={() => { setNeedGesture(false); setPlayErr(''); }}
        onError={() => { if (resolvedFor.current === curId && curId) setPlayErr('Не удалось воспроизвести трек'); }}
      />
      <div className="mus-bar">
        <span className="mus-thumb mus-thumb-audio">{resolving ? <span className="mus-spin" /> : <Icon name="speaker" />}</span>
        <div className="mus-meta" onClick={() => setOpen((o) => !o)}>
          <div className="mus-title">{cur ? cur.title : 'Совместное прослушивание'}</div>
          <div className="mus-sub">{cur ? (m.playing ? '♪ играет' : 'пауза') + (cur.by ? ' · ' + cur.by : '') : 'вставь ссылку YouTube'}</div>
        </div>
        <div className="mus-ctrls">
          <button className="mus-b" aria-label="Предыдущий трек" onClick={() => useMusic.getState().prev()} disabled={m.index <= 0} data-tip="Назад"><Icon name="skip-prev" sm /></button>
          <button className="mus-b play" aria-label={m.playing ? 'Пауза' : 'Воспроизвести'} aria-pressed={m.playing} onClick={() => useMusic.getState().toggle()} disabled={!m.queue.length} data-tip="Пауза/играть"><Icon name={m.playing ? 'pause' : 'play'} sm /></button>
          <button className="mus-b" aria-label="Следующий трек" onClick={() => useMusic.getState().next()} disabled={m.index + 1 >= m.queue.length} data-tip="Дальше"><Icon name="skip-next" sm /></button>
        </div>
        <button className={'mus-caret' + (open ? ' on' : '')} aria-label={open ? 'Свернуть плеер' : 'Развернуть плеер'} aria-expanded={open} onClick={() => setOpen((o) => !o)} data-tip={open ? 'Свернуть' : 'Развернуть'}><Icon name="chevron" sm /></button>
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
            <input type="range" min={0} max={100} value={vol} aria-label="Громкость музыки" onChange={(e) => applyVol(+e.target.value)} data-tip="Громкость (только у тебя)" />
            <span className="mus-t">{vol}%</span>
          </div>
          <div className="mus-add">
            <input placeholder="Ссылка YouTube…" value={addUrl} disabled={adding} onChange={(e) => { setAddUrl(e.target.value); setErr(''); }} onKeyDown={(e) => { if (e.key === 'Enter') onAdd(); }} />
            <button aria-label="Добавить ссылку в очередь" onClick={onAdd} disabled={adding || !addUrl.trim()} data-tip="Добавить в очередь">{adding ? <span className="mus-spin" /> : <Icon name="plus" sm />}</button>
          </div>
          {err ? <div className="mus-err">{err}</div> : null}
          <div className="mus-queue">
            {m.queue.length === 0 ? <div className="mus-empty">Очередь пуста — добавь трек</div> : null}
            {m.queue.map((t, i) => (
              <div key={i} className={'mus-q' + (i === m.index ? ' cur' : '')}>
                <button className="mus-q-i" aria-label={`Воспроизвести ${t.title}`} onClick={() => useMusic.getState().jump(i)} data-tip="Играть">{i === m.index && m.playing ? '♪' : i + 1}</button>
                <span className="mus-q-t" title={t.title}>{t.title}</span>
                <button className="mus-q-x" aria-label={`Убрать ${t.title} из очереди`} onClick={() => useMusic.getState().remove(i)} data-tip="Убрать">×</button>
              </div>
            ))}
          </div>
          {m.queue.length ? <button className="mus-clear" onClick={() => useMusic.getState().clear()}>Очистить очередь</button> : null}
        </div></div>
      </div>
    </div>
  );
}
