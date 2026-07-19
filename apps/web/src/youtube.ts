// YouTube IFrame API — для совместного прослушивания в голосовом канале (Watch Together, ToS-ок:
// официальный плеер, реклама/подсчёт просмотров сохраняются, без ре-стриминга). Каждый участник
// голосового канала играет один и тот же трек синхронно у себя; синхронизация — через data-канал.

let apiReady: Promise<void> | null = null;

const VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com']);
const YOUTU_BE_HOSTS = new Set(['youtu.be', 'www.youtu.be']);

export interface YouTubeVideoRef {
  videoId: string;
  canonicalUrl: string;
  thumbnailUrl: string;
}

function validVideoId(value: string | null | undefined): string | null {
  return value && VIDEO_ID_RE.test(value) ? value : null;
}

/**
 * Parses only known YouTube URL shapes. Exact host and id checks are intentional:
 * `youtube.com.evil.example` and ids with an appended payload must never become previews.
 */
export function parseYouTubeVideo(input: string): YouTubeVideoRef | null {
  const value = (input || '').trim();
  let videoId = validVideoId(value);

  if (!videoId) {
    let url: URL;
    try { url = new URL(value); } catch { return null; }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;

    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (YOUTU_BE_HOSTS.has(host)) {
      const match = url.pathname.match(/^\/([a-zA-Z0-9_-]{11})\/?$/);
      videoId = validVideoId(match?.[1]);
    } else if (YOUTUBE_HOSTS.has(host)) {
      const path = url.pathname.replace(/\/$/, '') || '/';
      if (path === '/watch') {
        videoId = validVideoId(url.searchParams.get('v'));
      } else {
        const match = path.match(/^\/(?:embed|shorts|live|v)\/([a-zA-Z0-9_-]{11})$/);
        videoId = validVideoId(match?.[1]);
      }
    } else {
      return null;
    }
  }

  if (!videoId) return null;
  return {
    videoId,
    canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
    // hqdefault is available much more consistently than maxresdefault. The card
    // reserves a 16:9 frame, so a late image cannot move the chat scroll anchor.
    thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
  };
}

/** Ленивая загрузка IFrame API (один раз). Резолвится, когда window.YT.Player готов. */
export function loadYT(): Promise<void> {
  if (apiReady) return apiReady;
  apiReady = new Promise<void>((resolve) => {
    const w = window as any;
    if (w.YT && w.YT.Player) { resolve(); return; }
    const prev = w.onYouTubeIframeAPIReady;
    w.onYouTubeIframeAPIReady = () => { try { prev?.(); } catch { /**/ } resolve(); };
    if (!document.getElementById('yt-iframe-api')) {
      const s = document.createElement('script');
      s.id = 'yt-iframe-api';
      s.src = 'https://www.youtube.com/iframe_api';
      document.head.appendChild(s);
    }
  });
  return apiReady;
}

/** videoId (11 симв.) из ссылки youtube/youtu.be/shorts/embed/live или голого id. null — не распознано. */
export function parseVideoId(input: string): string | null {
  return parseYouTubeVideo(input)?.videoId || null;
}

/** Название трека без API-ключа (oEmbed, CORS-разрешён). Фолбэк — сам id. Таймаут 6с — иначе зависший
 *  запрос держал бы лоадер добавления вечно. */
const TITLE_CACHE_LIMIT = 100;
const titleRequests = new Map<string, Promise<string>>();

export async function fetchTitle(videoId: string): Promise<string> {
  if (!VIDEO_ID_RE.test(videoId)) return videoId;
  const cached = titleRequests.get(videoId);
  if (cached) {
    // Refresh insertion order so the bounded map behaves like a small LRU.
    titleRequests.delete(videoId);
    titleRequests.set(videoId, cached);
    return cached;
  }

  const request = fetchTitleUncached(videoId).then((title) => {
    // A transient timeout/HTTP error must not poison the cache for the whole session.
    if (title === videoId) titleRequests.delete(videoId);
    return title;
  });
  if (titleRequests.size >= TITLE_CACHE_LIMIT) {
    const oldest = titleRequests.keys().next().value as string | undefined;
    if (oldest) titleRequests.delete(oldest);
  }
  titleRequests.set(videoId, request);
  return request;
}

async function fetchTitleUncached(videoId: string): Promise<string> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 6000);
  try {
    const r = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`, { signal: ctl.signal });
    if (r.ok) { const d = await r.json(); if (d && d.title) return String(d.title); }
  } catch { /**/ } finally { clearTimeout(t); }
  return videoId;
}
