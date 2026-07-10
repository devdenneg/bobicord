// Бюджет аплинка vrelay (serverBudget/abrTick) — ad-hoc тест. Запуск: node apps/server/dfix-budget-test.js
//
// Разбор прода 2026-07-09: vrelay раздавал 4 зрителям по 4.7 Мбит ≈ 19 Мбит при реальном
// аплинке VPS 14-20 Мбит. AIMD по потерям срабатывает ПОСЛЕ того, как линк уже посыпался
// (и в тот раз не сработал вовсе: в пресет-режиме abr был выключен). serverBudget не даёт
// въехать в потолок: делит объявленную полосу узла на число прямых детей.
//
// Ёмкость (число детей) при этом НЕ режем — браузер не ретранслирует, лишний зритель стал
// бы сиротой. Проверяем именно это: детей 4 остаётся, падает битрейт.

const http = require('http');
const { attachTreeServer, treeKey } = require('./tree');

let failed = 0;
function ok(name, cond, extra) { console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}${extra ? ' — ' + extra : ''}`); if (!cond) failed++; }

const server = http.createServer((_q, r) => { r.writeHead(404); r.end(); });
const api = attachTreeServer(server, { sessionSecret: 'test' });
for (const k of ['abrTimer', 'hbTimer', 'drainTimer', 'renditionTimer']) { try { clearInterval(api[k]); } catch { /**/ } }
const { mgr } = api;
const KEY = treeKey('S', 'source');
const MB = 1_000_000;

// Дерево: вещатель -> vrelay(virtual) -> N зрителей. Ровно то, что даёт server-first.
function build(viewers, outMbps) {
  mgr.trees.clear();
  const t = mgr.tree(KEY);
  t.serverFirst = true;
  const mk = (id, over) => Object.assign({
    id, identity: id, role: 'viewer', native: true, virtual: false, children: [], parent: null,
    depth: 0, availableOutgoing: 0, treeKey: KEY, rendition: 'source', streamId: 'S',
    symmetricNat: false, maxBitrate: 0, reparentCooldownUntil: 0,
  }, over);

  const bc = mk('bc', { role: 'broadcaster', abr: true, maxBitrate: 6 * MB, depth: 0 });
  const vr = mk('vr', { virtual: true, maxChildren: 4, availableOutgoing: outMbps * MB, parent: 'bc', depth: 1 });
  bc.children = ['vr'];
  t.nodes.set('bc', bc); t.nodes.set('vr', vr);
  t.broadcasterId = 'bc';
  for (let i = 0; i < viewers; i++) {
    const v = mk('v' + i, { parent: 'vr', depth: 2, native: i === 0 ? false : true }); // v0 — браузер
    vr.children.push(v.id);
    t.nodes.set(v.id, v);
  }
  return t;
}

/* (a) 4 зрителя, аплинк 15 Мбит: бюджет = 15×0.7/4 = 2.625 Мбит на ребёнка. */
{
  const t = build(4, 15);
  const budget = mgr.serverBudget(KEY);
  ok('(a) бюджет = out×0.7/дети', budget === Math.floor(15 * MB * 0.7 / 4), `${budget}`);

  // Линки чистые: AIMD пробует ВВЕРХ от потолка 6 Мбит, но бюджет обязан прижать.
  const cmd = mgr.abrTick(KEY);
  ok('(a) цель прижата бюджетом, не потолком', t.targetBitrate === budget, `${t.targetBitrate}`);
  ok('(a) корню ушёл set-bitrate', !!cmd && cmd.bitrate === budget);
  ok('(a) ёмкость vrelay НЕ урезана (браузер не станет сиротой)', mgr.capacityOf(t.nodes.get('vr')) === 4);
}

/* (b) Тот же аплинк, но зритель один: бюджет вчетверо больше, потолок вещателя снова главный. */
{
  const t = build(1, 15);
  const budget = mgr.serverBudget(KEY);
  ok('(b) бюджет на одного', budget === Math.floor(15 * MB * 0.7 / 1), `${budget}`);
  mgr.abrTick(KEY);
  ok('(b) бюджет (10.5М) > потолка (6М) → цель = потолок', t.targetBitrate === 6 * MB, `${t.targetBitrate}`);
}

/* (c) Полоса не объявлена — не выдумываем: бюджета нет, поведение как раньше. */
{
  build(4, 0);
  ok('(c) availableOutgoing=0 → бюджета нет', mgr.serverBudget(KEY) === null);
}

/* (d) Детей нет — делить не на что. */
{
  const t = build(0, 15);
  ok('(d) нет прямых детей → бюджета нет', mgr.serverBudget(KEY) === null);
  mgr.abrTick(KEY);
  ok('(d) цель = потолок вещателя', t.targetBitrate === 6 * MB, `${t.targetBitrate}`);
}

/* (e) Бюджет не проваливает цель ниже ABR_FLOOR (800 kbps): 10 зрителей на 1 Мбит. */
{
  const t = build(10, 1);
  mgr.abrTick(KEY);
  ok('(e) пол ABR_FLOOR уважается', t.targetBitrate === 800_000, `${t.targetBitrate}`);
}

server.close();
try { api.wss.close(); } catch { /**/ }
console.log(failed ? `\n${failed} проверок УПАЛО` : '\nВсе проверки бюджета зелёные');
process.exit(failed ? 1 : 0);
