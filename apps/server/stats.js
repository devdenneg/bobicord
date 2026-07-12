// Рейтинг + бесконечные уровни (экспериментальная фича, по умолчанию выключена на сервере).
// ЕДИНЫЙ источник истины по весам XP и кривой уровней. Клиент дублирует те же формулы в
// apps/web/src/leveling.ts ТОЛЬКО для отображения (прогресс-бар, «почему такой уровень») —
// авторитетный расчёт всегда серверный. Меняешь тут — синхронь leveling.ts.

// Веса XP. Стрим ценнее голоса (сложнее/полезнее для канала). Сообщения В XP НЕ ВХОДЯТ (сознательно
// исключены — рейтинг только по «живому» присутствию: голос + эфир).
const XP = { voicePerMin: 5, streamPerMin: 8 };

// XP из сырых счётчиков (секунды). floor — уровни целочисленны, дробный хвост не теряем на смысле.
function computeXp(s) {
  return Math.floor(
    (s.voice_sec || 0) / 60 * XP.voicePerMin +
    (s.stream_sec || 0) / 60 * XP.streamPerMin
  );
}

// Стоимость перехода L→L+1. Квадратичный рост → «чем выше уровень, тем больше надо» (бесконечно).
function levelCost(L) { return 5 * L * L + 50 * L + 100; }

// Кумулятивный порог XP для достижения уровня L (сумма стоимостей 0..L-1).
function xpForLevel(L) { let need = 0; for (let i = 0; i < L; i++) need += levelCost(i); return need; }

// Уровень по накопленному XP. Итеративно (уровни малы: 1000ч голоса ≈ 55 lvl — цикл дёшев).
function levelFromXp(xp) {
  let lvl = 0, need = 0;
  // кап 10000 итераций — страховка от бесконечного цикла на мусорном xp (реально недостижимо).
  while (lvl < 10000) {
    const cost = levelCost(lvl);
    if (xp < need + cost) break;
    need += cost; lvl++;
  }
  return lvl;
}

// Прогресс до следующего уровня — для прогресс-бара {level, into, span, next}.
function levelProgress(xp) {
  const level = levelFromXp(xp);
  const cur = xpForLevel(level);
  const next = xpForLevel(level + 1);
  return { level, xp, into: xp - cur, span: next - cur, next };
}

// Веха анонса level-up: кратные MILESTONE_STEP. Пересечение вехи (старый уровень < веха ≤ новый) →
// один анонс на самую высокую пройденную веху (схлопывает мульти-прыжки). 0 = вехи не пройдено.
const MILESTONE_STEP = 5;
function milestoneCrossed(oldLevel, newLevel) {
  const oldM = Math.floor(oldLevel / MILESTONE_STEP) * MILESTONE_STEP;
  const newM = Math.floor(newLevel / MILESTONE_STEP) * MILESTONE_STEP;
  return newM > oldM && newM >= MILESTONE_STEP ? newM : 0;
}

module.exports = { XP, computeXp, levelCost, xpForLevel, levelFromXp, levelProgress, MILESTONE_STEP, milestoneCrossed };
