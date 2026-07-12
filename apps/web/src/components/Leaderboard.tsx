import { useEffect, useMemo, useState } from 'react';
import { api, resolveUploadUrl } from '../api';
import { useStore } from '../store';
import { Icon } from '../Icon';
import { avColor, initial } from '../util';
import { Backdrop } from './Backdrop';
import { fmtCatValue, fmtDuration } from '../leveling';
import type { Leaderboard, LeaderRow } from '../types';

type Cat = 'level' | 'voice' | 'stream';
const CATS: { id: Cat; label: string; icon: string; hint: string }[] = [
  { id: 'level', label: 'Уровень', icon: 'trophy', hint: 'Общий опыт: время в голосовом + эфир' },
  { id: 'voice', label: 'Голосовой', icon: 'mic', hint: 'Больше всех времени в голосовых каналах' },
  { id: 'stream', label: 'Эфир', icon: 'screen', hint: 'Больше всех времени в трансляциях' },
];
const MEDAL = ['🥇', '🥈', '🥉'];

function LbAvatar({ r, size = 36 }: { r: LeaderRow; size?: number }) {
  const url = r.avatarUrl ? resolveUploadUrl(r.avatarUrl) : '';
  return (
    <div className="lb-av" style={{ width: size, height: size, fontSize: size * 0.42, background: url ? '#0000' : avColor(r.displayName, r.avatarColor) }}>
      {url ? <img className="avimg" src={url} alt="" /> : initial(r.displayName)}
    </div>
  );
}

export function LeaderboardModal() {
  const close = () => useStore.getState().setModal(null);
  const active = useStore((s) => s.active)!;
  const me = useStore((s) => s.me)!;
  const [tab, setTab] = useState<Cat>('level');
  const [data, setData] = useState<Leaderboard | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    let live = true;
    api.getLeaderboard(active.id).then((d) => { if (live) setData(d); }).catch((e) => { if (live) setErr(e?.message || 'Не удалось загрузить'); });
    return () => { live = false; };
  }, [active.id]);

  const rows = data?.categories?.[tab] || [];
  const meVal = useMemo(() => {
    if (!data?.me) return 0;
    return tab === 'level' ? data.me.xp : tab === 'voice' ? data.me.voiceSec : data.me.streamSec;
  }, [data, tab]);
  const myRank = data?.me?.ranks?.[tab] || 0;
  // «почему я тут»: разрыв до места выше (climb) по текущей категории.
  const why = useMemo(() => {
    if (!data?.me) return null;
    if (myRank === 0) return { kind: 'none' as const };
    if (myRank === 1) return { kind: 'lead' as const };
    const above = rows[myRank - 2]; // 0-based: место выше моего
    const gap = above ? above.value - meVal : 0;
    return { kind: 'climb' as const, gap, aboveName: above?.displayName || '' };
  }, [data, rows, myRank, meVal]);

  const catLabel = CATS.find((c) => c.id === tab)!.label;

  return (
    <Backdrop onClose={close} label="Рейтинг сервера" boxClass="box-lb" wide>
      <div className="lb">
        <div className="lb-head">
          <div className="lb-title"><Icon name="trophy" /><span>Рейтинг · {active.name}</span><span className="lb-exp">ЭКСПЕРИМЕНТ</span></div>
          <button className="settings-x" onClick={close} aria-label="Закрыть"><Icon name="close" /></button>
        </div>

        {err ? <div className="lb-empty">{err}</div> : !data ? <div className="lb-empty"><span className="spin" /> Загрузка…</div> : data.enabled === false ? (
          <div className="lb-empty">Рейтинг на этом сервере выключен. Владелец может включить его в настройках сервера.</div>
        ) : (
          <>
            {/* Моя сводка: уровень + прогресс до следующего + мои ранги */}
            {data.me ? <MeCard me={data.me} /> : null}

            <div className="lb-tabs">
              {CATS.map((c) => (
                <button key={c.id} className={'lb-tab' + (tab === c.id ? ' on' : '')} onClick={() => setTab(c.id)} data-tip={c.hint}>
                  <Icon name={c.icon} sm />{c.label}
                </button>
              ))}
            </div>

            {/* «Почему я на этом месте» по текущей категории */}
            {why ? (
              <div className="lb-why">
                {why.kind === 'none' ? (
                  <>Тебя тут пока нет. {tab === 'voice' ? 'Побудь в голосовом канале' : tab === 'stream' ? 'Проведи трансляцию' : 'Побудь в голосовом или включи эфир'} — данные начнут копиться.</>
                ) : why.kind === 'lead' ? (
                  <><b>#1 — ты лидируешь</b> в категории «{catLabel}». {tab === 'level' ? `${fmtCatValue('level', meVal)}` : fmtDuration(meVal)}.</>
                ) : (
                  <><b>#{myRank}</b> · у тебя {tab === 'level' ? fmtCatValue('level', meVal) : fmtDuration(meVal)}. До <b>#{myRank - 1}</b>{why.aboveName ? ` (${why.aboveName})` : ''} не хватает <b>{tab === 'level' ? fmtCatValue('level', why.gap) : fmtDuration(why.gap)}</b>.</>
                )}
              </div>
            ) : null}

            {/* Рейтинг-лист */}
            {rows.length === 0 ? (
              <div className="lb-empty">Пока пусто — статистика копится с момента включения фичи.</div>
            ) : (
              <div className="lb-list">
                {rows.map((r, i) => (
                  <div key={r.uid} className={'lb-row' + (r.uid === me.id ? ' mine' : '') + (i < 3 ? ' top' : '')}>
                    <div className="lb-rank">{i < 3 ? <span className="lb-medal">{MEDAL[i]}</span> : <span className="lb-num">{i + 1}</span>}</div>
                    <LbAvatar r={r} />
                    <div className="lb-who">
                      <span className="lb-nm">{r.displayName}{r.uid === me.id ? ' (ты)' : ''}</span>
                      <span className="lb-lvl">ур. {r.level}</span>
                    </div>
                    <div className="lb-val">{fmtCatValue(tab, r.value)}</div>
                  </div>
                ))}
              </div>
            )}
            <div className="lb-foot">Считается сервером с момента включения. Голос ×{5}/мин · эфир ×{8}/мин XP. Анонс уровня в чате — на каждой 5-й вехе.</div>
          </>
        )}
      </div>
    </Backdrop>
  );
}

function MeCard({ me }: { me: NonNullable<Leaderboard['me']> }) {
  const p = me.progress;
  const pct = p.span > 0 ? Math.min(100, Math.round((p.into / p.span) * 100)) : 0;
  const toNext = Math.max(0, p.span - p.into);
  return (
    <div className="lb-me">
      <div className="lb-me-lvl"><span className="lb-me-num">{p.level}</span><span className="lb-me-cap">уровень</span></div>
      <div className="lb-me-body">
        <div className="lb-me-top">
          <span className="lb-me-xp">{p.xp.toLocaleString('ru-RU')} XP</span>
          <span className="lb-me-next">до {p.level + 1} ур. — {toNext.toLocaleString('ru-RU')} XP</span>
        </div>
        <div className="lb-bar"><i style={{ width: pct + '%' }} /></div>
        <div className="lb-me-ranks">
          <RankChip icon="trophy" label="Уровень" rank={me.ranks.level} total={me.total} />
          <RankChip icon="mic" label="Голос" rank={me.ranks.voice} total={me.total} val={fmtDuration(me.voiceSec)} />
          <RankChip icon="screen" label="Эфир" rank={me.ranks.stream} total={me.total} val={fmtDuration(me.streamSec)} />
        </div>
      </div>
    </div>
  );
}

function RankChip({ icon, label, rank, total, val }: { icon: string; label: string; rank: number; total: number; val?: string }) {
  return (
    <span className="lb-chip" data-tip={rank ? `${label}: #${rank} из ${total}` : `${label}: нет данных`}>
      <Icon name={icon} sm />
      <b>{rank ? '#' + rank : '—'}</b>
      {val ? <i>{val}</i> : null}
    </span>
  );
}
