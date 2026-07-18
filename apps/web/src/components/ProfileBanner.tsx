import { useEffect, useMemo, useRef, useState } from 'react';
import { resolveUploadUrl } from '../api';
import { Icon } from '../Icon';

const GIPHY_KEY = String(import.meta.env.VITE_GIPHY_API_KEY || '').trim();
const GIPHY_API = 'https://api.giphy.com/v1/gifs';
const GIPHY_REF = /^giphy:([a-zA-Z0-9]{1,128})$/;

type Rendition = { url?: string; webp?: string; width?: string; height?: string };
type GiphyRaw = {
  id?: string;
  title?: string;
  alt_text?: string;
  username?: string;
  url?: string;
  source_tld?: string;
  source_post_url?: string;
  user?: { username?: string; display_name?: string; profile_url?: string };
  images?: {
    fixed_width?: Rendition;
    fixed_width_small?: Rendition;
    fixed_width_still?: Rendition;
    fixed_width_small_still?: Rendition;
    downsized?: Rendition;
    downsized_medium?: Rendition;
    original?: Rendition;
    original_still?: Rendition;
  };
  analytics?: { onload?: { url?: string }; onclick?: { url?: string }; onsent?: { url?: string } };
};

export interface GiphyAsset {
  id: string;
  previewUrl: string;
  displayUrl: string;
  compactUrl: string;
  alt: string;
  creator: string;
  source: string;
  pageUrl: string;
  sourceUrl: string;
  loadUrl?: string;
  clickUrl?: string;
  sendUrl?: string;
}

export interface ResolvedProfileBanner {
  url: string;
  source: 'upload' | 'giphy';
  alt: string;
  creator?: string;
  sourceLabel?: string;
  pageUrl?: string;
  sourceUrl?: string;
}

const LOCAL_POSTER_TTL = 10 * 60_000;
const LOCAL_POSTER_MAX = 24;

// GIPHY forbids caching media URLs. Only concurrent requests are deduplicated;
// a fulfilled asset lives solely in the mounted component state.
const assetPending = new Map<string, Promise<GiphyAsset | null>>();
const localPosterCache = new Map<string, { url: string; expires: number }>();
const localPosterPending = new Map<string, Promise<string | null>>();
let posterDecodeActive = 0;
const posterDecodeQueue: Array<() => void> = [];

function giphyId(value?: string): string | null {
  return value?.match(GIPHY_REF)?.[1] || null;
}

function readLocalPoster(source: string): string | null {
  const cached = localPosterCache.get(source);
  if (!cached) return null;
  if (cached.expires <= Date.now()) { localPosterCache.delete(source); return null; }
  localPosterCache.delete(source); localPosterCache.set(source, cached);
  return cached.url;
}

function rememberLocalPoster(source: string, url: string): string {
  localPosterCache.delete(source);
  localPosterCache.set(source, { url, expires: Date.now() + LOCAL_POSTER_TTL });
  while (localPosterCache.size > LOCAL_POSTER_MAX) localPosterCache.delete(localPosterCache.keys().next().value as string);
  return url;
}

function safeHttpUrl(value: unknown, fallback = ''): string {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : fallback;
  } catch { return fallback; }
}

function safeAnalyticsUrl(value: unknown): string | undefined {
  const normalized = safeHttpUrl(value);
  if (!normalized) return undefined;
  try { return new URL(normalized).hostname === 'giphy-analytics.giphy.com' ? normalized : undefined; }
  catch { return undefined; }
}

async function withPosterDecodeSlot<T>(work: () => Promise<T>): Promise<T> {
  if (posterDecodeActive >= 2) await new Promise<void>((resolve) => posterDecodeQueue.push(resolve));
  posterDecodeActive += 1;
  try { return await work(); }
  finally { posterDecodeActive -= 1; posterDecodeQueue.shift()?.(); }
}

function toAsset(raw: GiphyRaw): GiphyAsset | null {
  const id = String(raw.id || '');
  if (!GIPHY_REF.test(`giphy:${id}`)) return null;
  const previewUrl = raw.images?.fixed_width_small?.webp || raw.images?.fixed_width_small?.url
    || raw.images?.fixed_width?.webp || raw.images?.fixed_width?.url || '';
  const displayUrl = raw.images?.downsized_medium?.url || raw.images?.downsized?.url
    || raw.images?.original?.webp || raw.images?.original?.url || previewUrl;
  const compactUrl = raw.images?.fixed_width_small_still?.url || raw.images?.fixed_width_still?.url
    || raw.images?.original_still?.url || '';
  if (!displayUrl) return null;
  const creator = String(raw.user?.display_name || raw.username || raw.user?.username || '');
  return {
    id,
    previewUrl: previewUrl || displayUrl,
    displayUrl,
    compactUrl,
    alt: String(raw.alt_text || raw.title || 'GIF from GIPHY'),
    creator,
    source: String(raw.source_tld || ''),
    pageUrl: safeHttpUrl(raw.url, `https://giphy.com/gifs/${id}`),
    sourceUrl: safeHttpUrl(raw.source_post_url),
    loadUrl: safeAnalyticsUrl(raw.analytics?.onload?.url),
    clickUrl: safeAnalyticsUrl(raw.analytics?.onclick?.url),
    sendUrl: safeAnalyticsUrl(raw.analytics?.onsent?.url),
  };
}

async function loadAsset(id: string): Promise<GiphyAsset | null> {
  if (!GIPHY_KEY) return null;
  const pending = assetPending.get(id);
  if (pending) return pending;
  const params = new URLSearchParams({ api_key: GIPHY_KEY, rating: 'pg-13' });
  const request = fetch(`${GIPHY_API}/${encodeURIComponent(id)}?${params}`)
    .then(async (response) => {
      if (!response.ok) return null;
      const json = await response.json() as { data?: GiphyRaw };
      return json.data ? toAsset(json.data) : null;
    })
    .catch(() => null)
    .finally(() => assetPending.delete(id));
  assetPending.set(id, request);
  return request;
}

async function loadLocalCompactPoster(source: string): Promise<string | null> {
  const cached = readLocalPoster(source);
  if (cached) return cached;
  const pending = localPosterPending.get(source);
  if (pending) return pending;
  const request = (async () => {
    try {
      const response = await fetch(source);
      if (!response.ok) return null;
      const blob = await response.blob();
      if (!blob.size || blob.size > 10 * 1024 * 1024) return null;
      return await withPosterDecodeSlot(async () => {
        const bitmap = await createImageBitmap(blob);
        try {
          const scale = Math.min(1, 480 / Math.max(bitmap.width, bitmap.height));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(bitmap.width * scale));
          canvas.height = Math.max(1, Math.round(bitmap.height * scale));
          const context = canvas.getContext('2d');
          if (!context) return null;
          context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
          return rememberLocalPoster(source, canvas.toDataURL('image/webp', .76));
        } finally { bitmap.close(); }
      });
    } catch { return null; }
  })().finally(() => localPosterPending.delete(source));
  localPosterPending.set(source, request);
  return request;
}

function useLocalCompactPoster(source: string): string | null {
  const [resolved, setResolved] = useState<{ source: string; url: string | null }>(() => ({ source, url: source ? readLocalPoster(source) : null }));
  useEffect(() => {
    if (!source) { setResolved({ source: '', url: null }); return; }
    const cached = readLocalPoster(source);
    if (cached) { setResolved({ source, url: cached }); return; }
    setResolved({ source, url: null });
    let alive = true;
    loadLocalCompactPoster(source).then((url) => { if (alive) setResolved({ source, url }); });
    return () => { alive = false; };
  }, [source]);
  return resolved.source === source ? resolved.url : null;
}

export function useProfileBanner(value?: string, compact = false): ResolvedProfileBanner | null {
  const id = giphyId(value);
  const local = value && !id ? resolveUploadUrl(value) : '';
  const localAnimatedCandidate = !!(compact && local && /\.(?:gif|webp)(?:$|[?#])/i.test(local));
  const localPoster = useLocalCompactPoster(localAnimatedCandidate ? local : '');
  const [resolved, setResolved] = useState<{ id: string; asset: GiphyAsset | null }>(() => ({ id: id || '', asset: null }));

  useEffect(() => {
    if (!id) { setResolved({ id: '', asset: null }); return; }
    setResolved({ id, asset: null });
    let alive = true;
    loadAsset(id).then((asset) => { if (alive) setResolved({ id, asset }); });
    return () => { alive = false; };
  }, [id]);

  if (local) {
    if (localAnimatedCandidate) return localPoster ? { url: localPoster, source: 'upload', alt: '' } : null;
    return { url: local, source: 'upload', alt: '' };
  }
  const asset = resolved.id === (id || '') ? resolved.asset : null;
  if (!asset) return null;
  const url = compact ? asset.compactUrl : asset.displayUrl;
  if (!url) return null; // compact rows must never fall back to an animated rendition
  return { url, source: 'giphy', alt: asset.alt, creator: asset.creator, sourceLabel: asset.source, pageUrl: asset.pageUrl, sourceUrl: asset.sourceUrl };
}

export function ProfileBannerMedia({ value, className = '', attribution = true, compact = false }: {
  value?: string;
  className?: string;
  attribution?: boolean;
  compact?: boolean;
}) {
  const mediaRef = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(() => !compact || typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    if (!compact || visible || !value || typeof IntersectionObserver === 'undefined') return;
    const node = mediaRef.current;
    if (!node) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: '160px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [compact, value, visible]);
  const banner = useProfileBanner(visible ? value : undefined, compact);
  if (!value) return null;
  if (!banner) return compact ? <span ref={mediaRef} className={`profile-banner-media deferred${className ? ` ${className}` : ''}`} aria-hidden="true" /> : null;
  return (
    <span ref={mediaRef} className={`profile-banner-media ${banner.source}${className ? ` ${className}` : ''}`}>
      <img src={banner.url} alt="" draggable={false} loading={compact ? 'lazy' : undefined} decoding="async" />
      {banner.source === 'giphy' && attribution ? (
        <span className="giphy-mini" aria-hidden="true">
          <img src="/giphy-attribution.png" alt="" />
        </span>
      ) : null}
    </span>
  );
}

export function ProfileBannerAttribution({ value, className = '' }: { value?: string; className?: string }) {
  const id = giphyId(value);
  const banner = useProfileBanner(value);
  if (!id) return null;
  const creator = banner?.creator ? (banner.creator.startsWith('@') ? banner.creator : `@${banner.creator}`) : '';
  const labels = [creator, banner?.sourceLabel].filter((label, index, all): label is string => !!label && all.indexOf(label) === index).join(' · ');
  const markUrl = banner?.pageUrl || 'https://giphy.com/';
  const sourceUrl = banner?.sourceUrl || banner?.pageUrl;
  return <span className={`giphy-credit${className ? ` ${className}` : ''}`}>
    <a href={markUrl} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}><img src="/giphy-attribution.png" alt="Powered by GIPHY" /></a>
    {labels ? (sourceUrl ? <a className="giphy-credit-source" href={sourceUrl} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>{labels}</a> : <i>{labels}</i>) : null}
  </span>;
}

export function GiphyPicker({ onSelect, onClose }: { onSelect: (value: string, sendAnalyticsUrl?: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<GiphyAsset[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const normalized = query.trim().slice(0, 50);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', closeOnEscape, true);
    return () => document.removeEventListener('keydown', closeOnEscape, true);
  }, [onClose]);

  useEffect(() => {
    if (!GIPHY_KEY) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true); setError('');
      const endpoint = normalized ? 'search' : 'trending';
      const params = new URLSearchParams({
        api_key: GIPHY_KEY,
        limit: '18',
        rating: 'pg-13',
        bundle: 'messaging_non_clips',
        remove_low_contrast: 'true',
      });
      if (normalized) { params.set('q', normalized); params.set('lang', 'ru'); }
      try {
        const response = await fetch(`${GIPHY_API}/${endpoint}?${params}`, { signal: controller.signal });
        if (!response.ok) throw new Error(`GIPHY: ${response.status}`);
        const json = await response.json() as { data?: GiphyRaw[] };
        // Search results stay component-local: media URLs are not added to the resolution cache.
        setItems((json.data || []).map(toAsset).filter((item): item is GiphyAsset => !!item));
      } catch (cause) {
        if ((cause as Error)?.name !== 'AbortError') setError('Не удалось загрузить GIF. Попробуй ещё раз.');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, normalized ? 320 : 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [normalized]);

  const heading = useMemo(() => normalized ? `Поиск: ${normalized}` : 'Популярное сейчас', [normalized]);
  const resultStatus = error ? error : loading ? 'Загружаем GIF' : items.length ? `Найдено GIF: ${items.length}` : 'GIF не найдены';
  const select = (item: GiphyAsset) => {
    if (item.clickUrl) fetch(item.clickUrl, { mode: 'no-cors', keepalive: true }).catch(() => {});
    onSelect(`giphy:${item.id}`, item.sendUrl);
  };

  return (
    <section className="giphy-picker" aria-label="Выбор GIF для фона профиля">
      <header className="giphy-head">
        <div><b>Фон из GIPHY</b><span>{heading}</span></div>
        <button type="button" aria-label="Закрыть выбор GIF" onClick={onClose}><Icon name="close" sm /></button>
      </header>
      {GIPHY_KEY ? <>
        <label className="giphy-search"><Icon name="search" sm /><input autoFocus value={query} maxLength={50} placeholder="Найти GIF…" aria-label="Поиск GIF" onChange={(event) => setQuery(event.target.value)} />{loading ? <span className="spin" /> : null}</label>
        <span className="sr-only" role="status" aria-live="polite">{resultStatus}</span>
        {error ? <div className="giphy-state err">{error}</div> : null}
        {!error && !loading && !items.length ? <div className="giphy-state">Ничего не нашли</div> : null}
        <div className="giphy-grid" aria-busy={loading}>
          {items.map((item) => (
            <button type="button" key={item.id} className="giphy-item" aria-label={`Выбрать: ${item.alt}`} onClick={() => select(item)}>
              <img src={item.previewUrl} alt="" loading="lazy" onLoad={() => { if (item.loadUrl) fetch(item.loadUrl, { mode: 'no-cors', keepalive: true }).catch(() => {}); }} />
              {item.creator || item.source ? <span>{[item.creator ? (item.creator.startsWith('@') ? item.creator : `@${item.creator}`) : '', item.source].filter(Boolean).join(' · ')}</span> : null}
            </button>
          ))}
        </div>
      </> : <div className="giphy-state setup"><Icon name="warn" /><b>Нужен ключ GIPHY для Web</b><span>Добавь <code>VITE_GIPHY_API_KEY</code> в <code>.env.local</code> и перезапусти frontend.</span><a href="https://developers.giphy.com/dashboard/" target="_blank" rel="noreferrer">Создать API key</a></div>}
      <a className="giphy-powered" href="https://giphy.com/" target="_blank" rel="noreferrer" aria-label="Powered by GIPHY">
        <img src="/giphy-attribution.png" alt="Powered by GIPHY" />
      </a>
    </section>
  );
}
