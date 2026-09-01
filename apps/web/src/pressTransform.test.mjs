import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Регрессия: глобальный отклик нажатия не должен подменять transform у кнопки.
//
// Кнопки, позиционированные через transform (центрированная «Нажми, чтобы запустить видео
// и звук», мобильный переключатель «Открыть чат»), теряли это позиционирование на :active,
// потому что `button:active{transform:scale(.97)}` перезаписывает ВСЁ свойство transform.
// На mousedown кнопка прыгала на половину своей ширины из-под курсора — до 150px — и click
// не доходил вовсе. У стрима это приводило ко второй, куда более пугающей поломке: дедлайн
// watch (20 с) снимается только подтверждением воспроизведения, поэтому ненажатая кнопка
// через 20 секунд рвала ИСПРАВНОЕ соединение с ошибкой «Не удалось подключиться к трансляции».
//
// Лечится независимыми свойствами scale/translate: они складываются с transform, а не
// заменяют его. Этот тест держит инвариант.

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, 'styles.css'), 'utf8');

// 1. Ни одно ГЛОБАЛЬНОЕ правило для button:active не смеет трогать transform.
const globalActiveRules = [...css.matchAll(/(^|[\s,}])button:active(:not\([^)]*\))?\s*\{([^}]*)\}/g)];
assert.ok(globalActiveRules.length > 0, 'глобальное правило button:active исчезло — тест потерял предмет');
for (const rule of globalActiveRules) {
  const body = rule[3];
  assert.ok(
    !/(^|;)\s*transform\s*:/.test(body),
    'button:active задаёт transform и затрёт позиционирование центрированных кнопок; '
    + 'используй независимые scale/translate. Найдено: ' + body.trim(),
  );
  assert.ok(
    /(^|;)\s*(scale|translate)\s*:/.test(body),
    'button:active должен давать отклик через scale/translate. Найдено: ' + body.trim(),
  );
}

// 2. Переходы обязаны знать про новые свойства, иначе нажатие станет мгновенным.
const baseButton = css.match(/(^|\s)button\s*\{([^}]*)\}/);
assert.ok(baseButton, 'базовое правило button не найдено');
assert.ok(
  /transition:[^;}]*\bscale\b/.test(baseButton[2]),
  'в transition базовой кнопки нет scale — отклик нажатия станет мгновенным',
);

// 3. Кнопки, которые позиционируются transform-ом, продолжают это делать: если их
//    центрирование однажды переедет на что-то другое, инвариант выше потеряет смысл.
for (const selector of ['.vwrap .stream-play-unlock', '#content.split .mob-chat-toggle']) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = css.match(new RegExp(escaped + '\\s*\\{([^}]*)\\}'));
  assert.ok(rule, 'правило ' + selector + ' не найдено');
  assert.ok(
    /transform:\s*translate/.test(rule[1]),
    selector + ' больше не центрируется через transform — проверь, актуален ли инвариант',
  );
}

console.log('pressTransform: ок — отклик нажатия не ломает позиционирование кнопок');
