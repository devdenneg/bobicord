// YouTube IFrame API — для совместного прослушивания в голосовом канале (Watch Together, ToS-ок:
// официальный плеер, реклама/подсчёт просмотров сохраняются, без ре-стриминга). Каждый участник
// голосового канала играет один и тот же трек синхронно у себя; синхронизация — через data-канал.

let apiReady: Promise<void> | null = null;

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
  const s = (input || '').trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s);
    const host = u.hostname.replace(/^www\./, '');
    if (host === 'youtu.be') { const id = u.pathname.slice(1, 12); return /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null; }
    if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
      const v = u.searchParams.get('v'); if (v && /^[a-zA-Z0-9_-]{11}$/.test(v.slice(0, 11))) return v.slice(0, 11);
      const m = u.pathname.match(/\/(embed|shorts|live|v)\/([a-zA-Z0-9_-]{11})/); if (m) return m[2];
    }
  } catch { /**/ }
  return null;
}

/** Название трека без API-ключа (oEmbed, CORS-разрешён). Фолбэк — сам id. */
export async function fetchTitle(videoId: string): Promise<string> {
  try {
    const r = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`);
    if (r.ok) { const d = await r.json(); if (d && d.title) return String(d.title); }
  } catch { /**/ }
  return videoId;
}
