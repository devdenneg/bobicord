import { getToken, isTerminalSessionError, refreshAccessSession } from './api';
import {
  accessTokenNeedsRefresh,
  accessTokenStillUsable,
  persistentSessionActive,
} from './authSession';

const PROD_TREE_WS_URL = 'wss://reelay.online/tree';
const TREE_REFRESH_RETRY_BASE_MS = 10_000;
const TREE_REFRESH_RETRY_MAX_MS = 300_000;

let rejectedTreeAccessToken: string | null = null;
let transientTreeRefreshFailure: { token: string; retryAt: number; error: unknown } | null = null;
let treeRefreshInFlight: Promise<void> | null = null;

function isTauriRenderer(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function refreshTreeSession(): Promise<void> {
  if (treeRefreshInFlight) return treeRefreshInFlight;
  treeRefreshInFlight = refreshAccessSession()
    .then(() => undefined)
    .finally(() => { treeRefreshInFlight = null; });
  return treeRefreshInFlight;
}

/**
 * Builds a tree-signalling URL only after a short-lived persistent access JWT is fresh enough to
 * survive the handshake. Refresh credentials stay in their normal HttpOnly/Credential Manager
 * transport; this helper sees only the same short-lived access value already held by the renderer.
 */
export async function freshTreeWsUrl(nativeDefault = PROD_TREE_WS_URL): Promise<string> {
  const tokenBeforeRefresh = getToken();
  if (transientTreeRefreshFailure
    && (transientTreeRefreshFailure.token !== tokenBeforeRefresh
      || transientTreeRefreshFailure.retryAt <= Date.now())) {
    transientTreeRefreshFailure = null;
  }
  if (rejectedTreeAccessToken && rejectedTreeAccessToken !== tokenBeforeRefresh) {
    rejectedTreeAccessToken = null;
  }
  const forceRefresh = !!tokenBeforeRefresh && rejectedTreeAccessToken === tokenBeforeRefresh;
  if (persistentSessionActive() && (forceRefresh || accessTokenNeedsRefresh())) {
    if (transientTreeRefreshFailure?.token === tokenBeforeRefresh) {
      // A still-valid JWT remains useful during a transient auth outage, unless /tree explicitly
      // rejected this exact generation with 4001. Once expired/rejected, all callers share the
      // same negative result until its bounded retry_at instead of stampeding /refresh.
      if (forceRefresh || !accessTokenStillUsable()) throw transientTreeRefreshFailure.error;
    } else {
      try {
        await refreshTreeSession();
        transientTreeRefreshFailure = null;
      } catch (error) {
        if (!isTerminalSessionError(error) && tokenBeforeRefresh) {
          const rawRetrySeconds = Number((error as { retryAfter?: unknown } | null)?.retryAfter);
          const requestedMs = Number.isFinite(rawRetrySeconds) && rawRetrySeconds > 0
            ? rawRetrySeconds * 1_000 : 0;
          const delay = Math.min(
            TREE_REFRESH_RETRY_MAX_MS,
            Math.max(TREE_REFRESH_RETRY_BASE_MS, requestedMs),
          );
          transientTreeRefreshFailure = {
            token: tokenBeforeRefresh,
            retryAt: Date.now() + delay,
            error,
          };
        }
        // A transient refresh failure may reuse an access token which is still valid right now.
        // An exact rejected generation may never be reused, regardless of its encoded expiry.
        if (forceRefresh || !accessTokenStillUsable()) throw error;
      }
    }
  }
  const token = getToken();
  if (rejectedTreeAccessToken && rejectedTreeAccessToken !== token) rejectedTreeAccessToken = null;
  if (forceRefresh && token === tokenBeforeRefresh) {
    throw new Error('Сервер не обновил доступ к медиасерверу');
  }
  if (!token) throw new Error('Сессия не готова к подключению');
  const override = (import.meta as any).env?.VITE_TREE_WS_URL as string | undefined;
  const base = override
    || (isTauriRenderer() ? nativeDefault : null)
    || ((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/tree');
  return base + (base.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token);
}

/**
 * Records an authoritative /tree 4001 against the exact access generation used by that socket.
 * A delayed close from token A cannot invalidate token B which another tab/socket already minted.
 */
export function markTreeAccessRejected(wsUrl: string): void {
  if (!persistentSessionActive()) return;
  let rejected: string | null = null;
  try {
    const parsed = new URL(wsUrl);
    const tokens = parsed.searchParams.getAll('token');
    if (tokens.length === 1 && tokens[0]) rejected = tokens[0];
  } catch { return; }
  const current = getToken();
  if (!rejected || rejected !== current) return;
  rejectedTreeAccessToken = rejected;
  // An authoritative rejection bypasses any cached outage cooldown so the next socket can obtain
  // a genuinely new access generation immediately.
  transientTreeRefreshFailure = null;
}
