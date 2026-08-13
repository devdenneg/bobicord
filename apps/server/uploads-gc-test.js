'use strict';
const assert = require('assert');
const { planUploadSweep, uploadUrlsOfMessageRows, normalizeUploadRef } = require('./uploadsGc');

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const NOW = 1_700_000_000_000;
const plan = (files, referenced = []) => planUploadSweep({ files, referenced, now: NOW, graceMs: DAY, legacyGraceMs: WEEK });

const tracked = (url, ageMs, size = 100) => ({ url, size, createdAt: NOW - ageMs, mtimeMs: NOW - ageMs });
const legacy = (url, ageMs, size = 100) => ({ url, size, createdAt: null, mtimeMs: NOW - ageMs });

// Ссылочный файл не удаляется никогда — ни свежий, ни древний, ни учтённый, ни легаси.
{
  const files = [tracked('/api/uploads/a.png', 10 * DAY), legacy('/api/files/b.zip', 100 * DAY)];
  const r = plan(files, ['/api/uploads/a.png', '/api/files/b.zip']);
  assert.deepStrictEqual(r.remove, [], 'файл со ссылкой обязан выжить');
  assert.strictEqual(r.keepBytes, 200);
  assert.strictEqual(r.freeBytes, 0);
}

// Учтённый файл: до конца отлёжки живёт, после — удаляется.
{
  assert.deepStrictEqual(plan([tracked('/api/uploads/fresh.png', 2 * HOUR)]).remove, [], 'свежий учтённый файл не трогаем');
  assert.deepStrictEqual(plan([tracked('/api/uploads/old.png', DAY + 1)]).remove, ['/api/uploads/old.png']);
}

// Файл вне реестра судится по mtime и с недельным сроком: суточной отлёжки ему мало.
{
  assert.deepStrictEqual(plan([legacy('/api/files/x.bin', 3 * DAY)]).remove, [], 'легаси-файл младше недели не трогаем');
  assert.deepStrictEqual(plan([legacy('/api/files/x.bin', WEEK + 1)]).remove, ['/api/files/x.bin']);
}

// Учтённая запись НЕ должна получать недельный срок легаси (иначе диск не освобождается неделю).
{
  const r = plan([tracked('/api/uploads/t.png', 2 * DAY)]);
  assert.deepStrictEqual(r.remove, ['/api/uploads/t.png'], 'учтённый файл старше суток удаляется, а не ждёт неделю');
}

// Байты считаются раздельно: оставленное и освобождённое.
{
  const r = plan([tracked('/api/uploads/keep.png', HOUR, 10), tracked('/api/uploads/gone.png', 2 * DAY, 40)]);
  assert.strictEqual(r.keepBytes, 10);
  assert.strictEqual(r.freeBytes, 40);
}

// Мусор на входе не роняет планировщик и ничего не удаляет.
{
  const r = plan([null, {}, { url: '' }, { url: '/api/uploads/no-time.png', size: 5, createdAt: null, mtimeMs: NaN }]);
  assert.deepStrictEqual(r.remove, [], 'файл без времени считаем свежим, а не мусором на удаление');
}

// Сбор ссылок из сообщений: картинка, вложения, превью цитаты; битый JSON не ломает разбор.
{
  const rows = [
    { image: '/api/uploads/i.png', attachments: '[{"url":"/api/files/f.zip"},{"nourl":1}]', reply_to: '{"thumb":"/api/uploads/t.png"}' },
    { image: '', attachments: '[]', reply_to: '' },
    { image: '', attachments: 'не json', reply_to: 'тоже не json' },
  ];
  assert.deepStrictEqual(uploadUrlsOfMessageRows(rows), ['/api/uploads/i.png', '/api/files/f.zip', '/api/uploads/t.png']);
  assert.deepStrictEqual(uploadUrlsOfMessageRows(null), []);
}

// Сквозной сценарий: сообщение удалили, но картинка осталась в чужой цитате — файл обязан выжить.
{
  const quoted = '/api/uploads/quoted.png';
  const refs = new Set(uploadUrlsOfMessageRows([{ image: '', attachments: '[]', reply_to: JSON.stringify({ thumb: quoted }) }]));
  const r = plan([tracked(quoted, 30 * DAY)], refs);
  assert.deepStrictEqual(r.remove, [], 'файл, процитированный в другом сообщении, не удаляется');
}

// Нормализация ссылок: нативный клиент писал в цитату АБСОЛЮТНЫЙ URL, и без сведения к
// относительному пути уборка считала показанную картинку мусором.
{
  assert.strictEqual(normalizeUploadRef('/api/uploads/abc.png'), '/api/uploads/abc.png');
  assert.strictEqual(normalizeUploadRef('https://reelay.online/api/uploads/abc.png'), '/api/uploads/abc.png');
  assert.strictEqual(normalizeUploadRef('https://reelay.online/api/files/doc.pdf'), '/api/files/doc.pdf');
  assert.strictEqual(normalizeUploadRef('https://example.com/hack/api/uploads/x.png'), '/api/uploads/x.png');
  assert.strictEqual(normalizeUploadRef('/api/uploads/'), null, 'без имени файла ссылки нет');
  assert.strictEqual(normalizeUploadRef('/api/uploads/../../etc/passwd'), null, 'обход каталога не является ссылкой');
  assert.strictEqual(normalizeUploadRef(''), null);
  assert.strictEqual(normalizeUploadRef(undefined), null);
  assert.strictEqual(normalizeUploadRef(42), null);
}

// Главный сценарий потери данных: цитата хранит АБСОЛЮТНУЮ ссылку, файл на диске — относительную.
{
  const abs = 'https://reelay.online/api/uploads/quoted.png';
  const rel = '/api/uploads/quoted.png';
  const refs = new Set();
  for (const url of uploadUrlsOfMessageRows([{ image: '', attachments: '[]', reply_to: JSON.stringify({ thumb: abs }) }])) {
    refs.add(url);
    const n = normalizeUploadRef(url);
    if (n) refs.add(n);
  }
  const r = plan([tracked(rel, 30 * DAY)], refs);
  assert.deepStrictEqual(r.remove, [], 'файл, процитированный абсолютной ссылкой, не удаляется');
}

console.log('uploads-gc-test: все проверки прошли');
