// Зеркало apps/server/stats.js — ТОЛЬКО для отображения (прогресс, «почему такой уровень»).
// Авторитетный расчёт всегда серверный. Меняешь веса/кривую тут — синхронь stats.js.

// Веса XP (сообщения в XP НЕ входят — рейтинг только по голосу+эфиру).
export const XP = { voicePerMin: 5, streamPerMin: 8 };

export function levelCost(L: number): number { return 5 * L * L + 50 * L + 100; }
export function xpForLevel(L: number): number { let need = 0; for (let i = 0; i < L; i++) need += levelCost(i); return need; }
export function levelFromXp(xp: number): number {
  let lvl = 0, need = 0;
  while (lvl < 10000) { const c = levelCost(lvl); if (xp < need + c) break; need += c; lvl++; }
  return lvl;
}
export function levelProgress(xp: number) {
  const level = levelFromXp(xp);
  const cur = xpForLevel(level), next = xpForLevel(level + 1);
  return { level, xp, into: xp - cur, span: next - cur, next };
}

export const MILESTONE_STEP = 5;

// «Ч:М» из секунд (компактно: 12ч 30м / 45м / 0м). Для карточек рейтинга.
export function fmtDuration(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}ч ${m}м`;
  if (m > 0) return `${m}м`;
  return `${s}с`;
}

// Значение категории → человекочитаемо. level-категория = XP-очки, время — Ч:М.
export function fmtCatValue(cat: 'level' | 'voice' | 'stream', value: number): string {
  if (cat === 'level') return `${value.toLocaleString('ru-RU')} XP`;
  return fmtDuration(value);
}
