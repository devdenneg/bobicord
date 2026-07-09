// Совместное прослушивание YouTube в голосовом канале (Watch Together). Состояние сессии (очередь,
// текущий трек, позиция, пауза) живёт в data-канале голосовой комнаты (engine.sendMusic/onMusicMessage),
// scoped по vc. Позиция синхронизируется timestamp-based (posRef на момент startedAt), пере-сик по seekTick.
// Автопереключение и ответ на req делает КОНТРОЛЛЕР — участник канала с наименьшим username (дедуп шума).
import { create } from 'zustand';
import { getEngine, useStore } from './store';
import { parseVideoId, fetchTitle } from './youtube';

export interface MTrack { id: string; title: string; by: string }

interface MusicState {
  vc: string | null;
  queue: MTrack[];
  index: number;      // -1 = ничего не выбрано
  playing: boolean;
  posRef: number;     // позиция трека (сек) на момент startedAt
  startedAt: number;  // Date.now(), когда зафиксирован posRef (при playing позиция «идёт» от него)
  rev: number;        // Date.now() последнего изменения — last-writer-wins при синке
  seekTick: number;   // ++ → плееру пере-синхронизироваться к позиции (внешний set / seek)
  currentPos: () => number;
  current: () => MTrack | null;
  isController: () => boolean;
  enterVc: (vc: string) => void;
  leaveVc: () => void;
  apply: (d: any) => void;
  add: (url: string) => Promise<string | null>; // null — ок, строка — ошибка
  toggle: () => void;
  next: (auto?: boolean) => void;
  prev: () => void;
  jump: (i: number) => void;
  seek: (sec: number) => void;
  remove: (i: number) => void;
  clear: () => void;
  onEnded: () => void;
}

const myName = () => useStore.getState().me?.username || '';
function membersInVc(vc: string | null): string[] {
  if (!vc) return [];
  const snap = getEngine()?.getSnapshot();
  const vch = snap?.voiceChannels || {};
  const set = new Set<string>(Object.keys(vch).filter((u) => vch[u] === vc));
  if (snap?.myVoiceChannel === vc) set.add(myName());
  return [...set];
}
function pack(s: MusicState) {
  return { queue: s.queue, index: s.index, playing: s.playing, posRef: s.currentPos(), startedAt: Date.now(), rev: s.rev };
}

export const useMusic = create<MusicState>((set, get) => {
  // локальное изменение → rev + рассылка полного состояния + пере-сик плеера
  const commit = (patch: Partial<MusicState>) => {
    const rev = Date.now();
    set({ ...patch, rev, seekTick: get().seekTick + 1 } as any);
    const s = get();
    if (s.vc) getEngine()?.sendMusic({ a: 'set', vc: s.vc, s: pack(s) });
  };
  return {
    vc: null, queue: [], index: -1, playing: false, posRef: 0, startedAt: 0, rev: 0, seekTick: 0,

    currentPos: () => { const s = get(); return s.playing ? s.posRef + (Date.now() - s.startedAt) / 1000 : s.posRef; },
    current: () => { const s = get(); return s.index >= 0 && s.index < s.queue.length ? s.queue[s.index] : null; },
    isController: () => { const s = get(); const m = membersInVc(s.vc); return m.length > 0 && m.sort()[0] === myName(); },

    enterVc: (vc) => {
      set({ vc, queue: [], index: -1, playing: false, posRef: 0, startedAt: 0, rev: 0, seekTick: get().seekTick + 1 });
      getEngine()?.sendMusic({ a: 'req', vc }); // подтянуть уже идущую сессию у тех, кто в канале
    },
    leaveVc: () => set({ vc: null, queue: [], index: -1, playing: false, posRef: 0 }),

    apply: (d) => {
      const s = get();
      if (d.a === 'req') {
        if (d.vc === s.vc && s.queue.length && get().isController()) getEngine()?.sendMusic({ a: 'set', vc: s.vc, s: pack(s) });
        return;
      }
      if (d.a === 'set') {
        if (!d.s || d.vc !== s.vc || d.s.rev <= s.rev) return; // чужой канал или старее (last-writer-wins)
        set({ queue: d.s.queue || [], index: d.s.index ?? -1, playing: !!d.s.playing, posRef: d.s.posRef || 0, startedAt: d.s.startedAt || Date.now(), rev: d.s.rev, seekTick: s.seekTick + 1 });
      }
    },

    add: async (url) => {
      const id = parseVideoId(url);
      if (!id) return 'Не похоже на ссылку YouTube';
      const title = await fetchTitle(id);
      const s = get();
      const track: MTrack = { id, title, by: useStore.getState().me?.displayName || '' };
      const queue = [...s.queue, track];
      if (s.index < 0) commit({ queue, index: queue.length - 1, playing: true, posRef: 0, startedAt: Date.now() });
      else commit({ queue });
      return null;
    },
    toggle: () => {
      const s = get();
      if (s.index < 0) { if (s.queue.length) commit({ index: 0, playing: true, posRef: 0, startedAt: Date.now() }); return; }
      if (s.playing) commit({ playing: false, posRef: s.currentPos() });
      else commit({ playing: true, startedAt: Date.now() });
    },
    next: (auto) => {
      const s = get();
      const ni = s.index + 1;
      if (ni < s.queue.length) commit({ index: ni, playing: true, posRef: 0, startedAt: Date.now() });
      else commit({ playing: false, posRef: 0, index: auto ? -1 : s.index }); // очередь кончилась
    },
    prev: () => { const s = get(); if (s.index > 0) commit({ index: s.index - 1, playing: true, posRef: 0, startedAt: Date.now() }); },
    jump: (i) => { const s = get(); if (i >= 0 && i < s.queue.length) commit({ index: i, playing: true, posRef: 0, startedAt: Date.now() }); },
    seek: (sec) => commit({ posRef: Math.max(0, sec), startedAt: Date.now() }),
    remove: (i) => {
      const s = get();
      const queue = s.queue.filter((_, k) => k !== i);
      let index = s.index;
      if (i < s.index) index = s.index - 1;
      else if (i === s.index) index = queue.length ? Math.min(s.index, queue.length - 1) : -1;
      commit({ queue, index, posRef: i === s.index ? 0 : s.posRef, startedAt: Date.now(), playing: index < 0 ? false : s.playing });
    },
    clear: () => commit({ queue: [], index: -1, playing: false, posRef: 0 }),
    onEnded: () => { if (get().isController()) get().next(true); },
  };
});

let inited = false;
export function initMusic(): void {
  if (inited) return; inited = true;
  const eng = getEngine(); if (!eng) return;
  eng.onMusicMessage = (d) => useMusic.getState().apply(d);
  // Глобальный вотчер голосового канала: вход/выход/смена vc → сессия прослушивания живёт в сторе и
  // НЕ сбрасывается при ремонте VoiceDock (переключение server↔home, пока ты в том же голосовом).
  let lastVc: string | null = null;
  const check = () => {
    const vc = eng.getSnapshot().myVoiceChannel;
    if (vc === lastVc) return;
    lastVc = vc;
    if (vc) useMusic.getState().enterVc(vc); else useMusic.getState().leaveVc();
  };
  eng.subscribe(check);
  check();
}
