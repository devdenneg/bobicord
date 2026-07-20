import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, 'chatScroll.ts'), 'utf8');
const code = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const {
  CHAT_BOTTOM_ENTER_PX,
  CHAT_BOTTOM_LEAVE_PX,
  chatBottomDistance,
  reduceChatScrollState,
} = await import('data:text/javascript,' + encodeURIComponent(code));

let passed = 0;
let failed = 0;

function equal(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) console.log('  actual:', actual, '\n  expected:', expected);
  ok ? passed++ : failed++;
}

equal('distance is measured from the physical tail', chatBottomDistance({
  scrollHeight: 1000,
  clientHeight: 400,
  scrollTop: 575,
}), 25);
equal('rubber-band overscroll is clamped', chatBottomDistance({
  scrollHeight: 1000,
  clientHeight: 400,
  scrollTop: 604,
}), 0);

equal('a detached reader re-arms inside the enter zone', reduceChatScrollState(
  { atBottom: false, following: false },
  CHAT_BOTTOM_ENTER_PX,
  'down',
), { atBottom: true, following: true });

equal('being just outside the enter zone does not clear unread', reduceChatScrollState(
  { atBottom: false, following: false },
  CHAT_BOTTOM_ENTER_PX + 0.1,
  'down',
), { atBottom: false, following: false });

equal('one-pixel upward movement keeps the stable tail state', reduceChatScrollState(
  { atBottom: true, following: true },
  1,
  'up',
), { atBottom: true, following: true });

equal('fractional resize inside hysteresis does not flicker', reduceChatScrollState(
  { atBottom: true, following: true },
  CHAT_BOTTOM_ENTER_PX + 0.5,
  'none',
), { atBottom: true, following: true });

equal('an intentional upward scroll beyond the leave zone detaches', reduceChatScrollState(
  { atBottom: true, following: true },
  CHAT_BOTTOM_LEAVE_PX + 1,
  'up',
), { atBottom: false, following: false });

equal('a late resize cannot detach follow intent by itself', reduceChatScrollState(
  { atBottom: true, following: true },
  500,
  'none',
), { atBottom: false, following: true });

equal('history reading remains detached away from the tail', reduceChatScrollState(
  { atBottom: false, following: false },
  500,
  'none',
), { atBottom: false, following: false });

equal('a smooth jump to history cannot re-arm on its first near-bottom frame', reduceChatScrollState(
  { atBottom: false, following: false },
  1,
  'none',
  true,
), { atBottom: false, following: false });

equal('an explicit downward intent can re-arm after the history-jump fence is cleared', reduceChatScrollState(
  { atBottom: false, following: false },
  CHAT_BOTTOM_ENTER_PX,
  'down',
  false,
), { atBottom: true, following: true });

console.log(`\n${passed}/${passed + failed} PASS`);
process.exit(failed ? 1 : 0);
