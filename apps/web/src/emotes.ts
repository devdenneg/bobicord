import type { Emote } from './types';
import { api, resolveUploadUrl } from './api';

export const emoteMap = new Map<string, string>(); // name -> id

/* --- Обход блокировки 7TV (7tv.io API + cdn.7tv.app картинки режутся у части RU-провайдеров
 *     независимо друг от друга; сам апп reelay.online при этом доступен). Стратегия:
 *     direct-first + авто-детект блока → фолбэк на серверный прокси /api/7tv/*. Два раздельных
 *     флага (домены блокируются порознь), каждый с ts для обратной ре-пробы (само­исцеление при
 *     смене сети/разблокировке — не сидим на прокси VPS вечно после разового сбоя). Детект
 *     картинок — через sentinel-пробу с СОБСТВЕННЫМ таймаутом (у <img> таймаута нет: под блэкхолом
 *     без RST он висел бы десятки секунд), НЕ по onError контентной картинки (одиночный 404
 *     удалённого эмоута иначе увёл бы весь трафик на VPS навсегда). --- */

const API_FLAG = 'emoteApiProxy';
const IMG_FLAG = 'emoteImgProxy';
const REPROBE_MS = 6 * 3600 * 1000; // как давно на прокси, чтобы снова попробовать direct
const PROBE_MS = 4000;              // таймаут проб (direct-fetch API и sentinel-картинки)

type Flag = { proxy: boolean; ts: number };
function readFlag(key: string): Flag {
  try { const v = JSON.parse(localStorage.getItem(key) || 'null'); if (v && typeof v.proxy === 'boolean') return { proxy: v.proxy, ts: v.ts || 0 }; } catch { /**/ }
  return { proxy: false, ts: 0 };
}
function writeFlag(key: string, proxy: boolean): void { try { localStorage.setItem(key, JSON.stringify({ proxy, ts: Date.now() })); } catch { /**/ } }

let apiProxy = readFlag(API_FLAG).proxy;
let imgProxy = readFlag(IMG_FLAG).proxy;

// Реактивность imgProxy: EmoteImg подписан → уже смонтированные картинки перерисуются на прокси-src,
// когда проба доехала уже ПОСЛЕ первого рендера (блэкхол) или ре-проба вернула direct.
const imgSubs = new Set<() => void>();
export function subscribeImgProxy(cb: () => void): () => void { imgSubs.add(cb); return () => { imgSubs.delete(cb); }; }
export function isImgProxy(): boolean { return imgProxy; }
function setImgProxy(on: boolean): void {
  writeFlag(IMG_FLAG, on); // всегда обновляем ts (свежесть ре-пробы), даже если значение то же
  if (imgProxy === on) return;
  imgProxy = on;
  imgSubs.forEach((cb) => { try { cb(); } catch { /**/ } });
}
function setApiProxy(on: boolean): void { apiProxy = on; writeFlag(API_FLAG, on); }

// URL картинки: direct cdn ИЛИ наш прокси. В нативе (origin tauri://localhost) resolveUploadUrl
// префиксует относительный /api/... прод-хостом; absolute direct-URL он не трогает.
export function emoteUrl(id: string): string {
  return imgProxy ? resolveUploadUrl(`/api/7tv/emote/${id}/2x.webp`) : `https://cdn.7tv.app/emote/${id}/2x.webp`;
}
export function emoteUrlSm(id: string): string {
  return imgProxy ? resolveUploadUrl(`/api/7tv/emote/${id}/1x.webp`) : `https://cdn.7tv.app/emote/${id}/1x.webp`;
}

/* --- Пробы достижимости --- */
let sentinelId: string | null = null; // заведомо ЖИВОЙ id (первый из глобального сета) — иначе 404 неотличим от блока
let imgProbeRunning = false;
// Проба cdn.7tv.app: грузим sentinel-картинку с собственным таймаутом. force=true — ре-проба, когда
// сидим на прокси (успех → возвращаемся на direct, разгружая VPS).
function probeImgReachability(force = false): void {
  if (!sentinelId) return;                 // нет живого id — не гадаем
  if ((imgProxy && !force) || imgProbeRunning) return;
  imgProbeRunning = true;
  const img = new Image();
  let done = false;
  const finish = (blocked: boolean) => {
    if (done) return; done = true; imgProbeRunning = false; clearTimeout(timer);
    if (blocked) setImgProxy(true);
    else if (force) setImgProxy(false);    // direct снова жив → назад с прокси
  };
  const timer = setTimeout(() => finish(true), PROBE_MS);
  img.onload = () => finish(false);
  img.onerror = () => finish(true);
  img.src = `https://cdn.7tv.app/emote/${sentinelId}/1x.webp` + (force ? `?_=${Date.now()}` : '');
}
// onError любой контентной картинки — только ТРИГГЕР пробы (флаг флипнет сама проба по sentinel).
export function onEmoteImgError(): void { probeImgReachability(); }

function fetchTimeout(url: string, ms: number, opt?: RequestInit): Promise<Response> {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const t = ctrl ? setTimeout(() => ctrl.abort(), ms) : null;
  return fetch(url, { ...opt, signal: ctrl?.signal }).finally(() => { if (t) clearTimeout(t); });
}

// Если давно на прокси — тихо пробуем direct: разблокировали/сменил сеть → сбрасываем флаг.
function reprobeIfStale(): void {
  const imgF = readFlag(IMG_FLAG);
  if (imgF.proxy && Date.now() - imgF.ts > REPROBE_MS) probeImgReachability(true);
  const apiF = readFlag(API_FLAG);
  if (apiF.proxy && Date.now() - apiF.ts > REPROBE_MS) {
    fetchTimeout('https://7tv.io/v3/emote-sets/global', PROBE_MS)
      .then((r) => r.json()).then((d) => { if (d && Array.isArray(d.emotes)) setApiProxy(false); }).catch(() => { /* всё ещё блок */ });
  }
}
if (typeof window !== 'undefined') window.addEventListener('online', reprobeIfStale);

/* --- Недавние эмоуты (Telegram-стиль): 15 последних, most-recent-first (localStorage). --- */
const RECENT_KEY = 'emoteRecent';
const RECENT_MAX = 15;
export function getRecentEmotes(): Emote[] {
  try { const a = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); return Array.isArray(a) ? a.filter((e) => e && e.id && e.name).slice(0, RECENT_MAX) : []; } catch { return []; }
}
export function pushRecentEmote(e: Emote): void {
  try {
    const cur = getRecentEmotes().filter((x) => x.id !== e.id);
    cur.unshift({ id: e.id, name: e.name });
    localStorage.setItem(RECENT_KEY, JSON.stringify(cur.slice(0, RECENT_MAX)));
    emoteMap.set(e.name, e.id); // держим маппинг для рендера в чате
  } catch { /**/ }
}

export async function loadGlobalEmotes(): Promise<void> {
  let data: any = null;
  // direct-first: при блоке 7tv.io (reject/таймаут ИЛИ 200+HTML-заглушка → провал r.json()) → apiProxy.
  if (!apiProxy) {
    try { data = await (await fetchTimeout('https://7tv.io/v3/emote-sets/global', PROBE_MS)).json(); }
    catch { setApiProxy(true); }
  }
  if (!data) { try { data = await api.sevenGlobal(); } catch { /* оба пути мертвы */ } }
  const emotes: any[] = (data && data.emotes) || [];
  emotes.forEach((e) => emoteMap.set(e.name, e.id));
  if (emotes.length && emotes[0].id) sentinelId = emotes[0].id; // живой id для пробы картинок
  probeImgReachability();  // определить достижимость cdn.7tv.app
  reprobeIfStale();        // само­исцеление залипшего флага
}

export async function searchEmotes(query: string, page: number): Promise<Emote[]> {
  if (!apiProxy) {
    try {
      const body = {
        query: 'query($q:String!,$p:Int){emotes(query:$q,page:$p,limit:100,sort:{value:"popularity",order:DESCENDING}){items{id name}}}',
        variables: { q: query, p: page },
      };
      const r = await fetchTimeout('https://7tv.io/v3/gql', PROBE_MS, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await r.json();
      const items: Emote[] = ((d.data && d.data.emotes && d.data.emotes.items) || []).map((e: any) => ({ id: e.id, name: e.name }));
      items.forEach((e) => emoteMap.set(e.name, e.id));
      return items;
    } catch { setApiProxy(true); }
  }
  try {
    const items = await api.sevenSearch(query, page);
    items.forEach((e) => emoteMap.set(e.name, e.id));
    return items;
  } catch { return []; }
}
