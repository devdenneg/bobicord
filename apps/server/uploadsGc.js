'use strict';
/* Чистая (без БД и файловой системы) часть уборки пользовательских загрузок.
 *
 * Здесь живёт единственное решение, которое реально опасно ошибиться: КАКИЕ файлы удалять. Логика
 * вынесена из index.js именно ради тестов — index.js завязан на /app/data и не запускается вне
 * контейнера, а цена регрессии тут — безвозвратно удалённые картинки и вложения пользователей.
 *
 * Правила:
 *   1) на файл кто-то ссылается (аватар, иконка сервера, картинка/вложение сообщения, превью в
 *      цитате) — не удаляем НИКОГДА, даже если хранилище переполнено: испортить историю хуже;
 *   2) отлёжка — свежий файл мог быть загружен, но ещё не отправлен сообщением;
 *   3) файл вне реестра (загружен до появления учёта) судится по времени на диске и с бОльшим
 *      сроком: про него мы не знаем даже, кто владелец.
 */

/* Ссылка на загрузку может лежать в БД и АБСОЛЮТНОЙ: нативный клиент собран с абсолютным API_BASE и
 * до этой правки писал в reply.thumb полный https://…/api/uploads/… — единственное поле с URL, которое
 * сервер не валидировал. Уборка сверяет ссылки точным совпадением, поэтому без нормализации такая
 * картинка считалась мусором и удалялась, пока цитата её показывает. */
const UPLOAD_REF_RE = /\/api\/(?:uploads|files)\/[a-zA-Z0-9._-]+$/;

/** Относительный путь загрузки из любой формы ссылки, либо null. */
function normalizeUploadRef(value) {
  const m = typeof value === 'string' ? value.match(UPLOAD_REF_RE) : null;
  return m ? m[0] : null;
}

/** @param {{url:string,size:number,createdAt:number|null,mtimeMs:number}[]} files */
function planUploadSweep({ files, referenced, now, graceMs, legacyGraceMs }) {
  const refs = referenced instanceof Set ? referenced : new Set(referenced || []);
  const remove = [];
  let keepBytes = 0;
  let freeBytes = 0;
  for (const f of files || []) {
    if (!f || typeof f.url !== 'string' || !f.url) continue;
    const size = Number.isFinite(f.size) ? f.size : 0;
    if (refs.has(f.url)) { keepBytes += size; continue; }
    const tracked = Number.isFinite(f.createdAt);
    const stamp = tracked ? f.createdAt : f.mtimeMs;
    const age = Number.isFinite(stamp) ? now - stamp : 0; // нет времени вовсе — считаем свежим
    if (age < (tracked ? graceMs : legacyGraceMs)) { keepBytes += size; continue; }
    remove.push(f.url);
    freeBytes += size;
  }
  return { remove, keepBytes, freeBytes };
}

/** URL загрузок, упомянутые в строках сообщений: картинка, вложения, превью в цитате. */
function uploadUrlsOfMessageRows(rows) {
  const urls = [];
  for (const row of rows || []) {
    if (!row) continue;
    if (row.image) urls.push(row.image);
    try { for (const a of JSON.parse(row.attachments || '[]') || []) if (a && a.url) urls.push(a.url); } catch (e) { /* битый JSON в старой записи */ }
    try { const rp = row.reply_to ? JSON.parse(row.reply_to) : null; if (rp && rp.thumb) urls.push(rp.thumb); } catch (e) { /* битый JSON в старой записи */ }
  }
  return urls;
}

module.exports = { planUploadSweep, uploadUrlsOfMessageRows, normalizeUploadRef, UPLOAD_REF_RE };
