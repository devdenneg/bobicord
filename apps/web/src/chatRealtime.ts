import type { Attachment, HistoryMessage, Reaction, ReleaseNote, ReplyRef } from './types';

// A canonical chat event is normally only a few kilobytes. Keeping a hard wire
// bound prevents a broken or compromised endpoint from making every tab parse a
// multi-megabyte websocket frame; the server sends chat-resync when its own
// backpressure/size guard cannot deliver an event.
export const MAX_CHAT_REALTIME_FRAME_BYTES = 64 * 1024;

export interface ChatReadyFrame {
  t: 'chat-ready';
  v: 1;
}

export type ChatCanonicalEvent =
  | { type: 'message.created'; message: HistoryMessage; mkey?: string }
  | { type: 'message.updated'; messageId: number; text: string; edited: true }
  | { type: 'message.deleted'; messageId: number }
  | { type: 'reaction.updated'; messageId: number; reactions: Reaction[] }
  | { type: 'chat.cleared' };

export interface ChatEventFrame {
  t: 'chat-event';
  v: 1;
  serverId: string;
  rev: number;
  event: ChatCanonicalEvent;
}

export interface ChatResyncFrame {
  t: 'chat-resync';
  v: 1;
  serverId: string;
  reason: 'backpressure' | 'reconnect';
}

export type ChatRealtimeFrame = ChatReadyFrame | ChatEventFrame | ChatResyncFrame;

type ObjectRecord = Record<string, unknown>;

function record(value: unknown): ObjectRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as ObjectRecord
    : null;
}

function exactKeys(value: ObjectRecord, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && keys.every((key) => allowed.has(key));
}

function boundedString(value: unknown, max: number, allowEmpty = true): value is string {
  return typeof value === 'string' && value.length <= max && (allowEmpty || value.length > 0);
}

function positiveId(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function boundedInteger(value: unknown, min: number, max: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;
}

function parseReaction(value: unknown): Reaction | null {
  const item = record(value);
  if (!item || !exactKeys(item, ['id', 'name', 'count', 'mine'])) return null;
  if (!boundedString(item.id, 64, false) || !boundedString(item.name, 64, false)) return null;
  if (!boundedInteger(item.count, 1, 1000) || typeof item.mine !== 'boolean') return null;
  return { id: item.id, name: item.name, count: item.count, mine: item.mine };
}

function parseReactions(value: unknown): Reaction[] | null {
  if (!Array.isArray(value) || value.length > 1000) return null;
  const result: Reaction[] = [];
  const ids = new Set<string>();
  for (const valueItem of value) {
    const item = parseReaction(valueItem);
    if (!item || ids.has(item.id)) return null;
    ids.add(item.id);
    result.push(item);
  }
  return result;
}

function parseAttachment(value: unknown): Attachment | null {
  const item = record(value);
  if (!item || !exactKeys(item, ['url', 'name', 'size', 'mime', 'kind'], ['width', 'height'])) return null;
  if (!boundedString(item.url, 256, false) || !boundedString(item.name, 255)) return null;
  if (!boundedInteger(item.size, 0, 10 * 1024 * 1024) || !boundedString(item.mime, 100)) return null;
  if (item.kind !== 'image' && item.kind !== 'file') return null;
  if (item.width !== undefined && !boundedInteger(item.width, 1, 4096)) return null;
  if (item.height !== undefined && !boundedInteger(item.height, 1, 4096)) return null;
  if ((item.width === undefined) !== (item.height === undefined)) return null;
  return {
    url: item.url,
    name: item.name,
    size: item.size,
    mime: item.mime,
    kind: item.kind,
    ...(item.width !== undefined ? { width: item.width } : {}),
    ...(item.height !== undefined ? { height: item.height } : {}),
  };
}

function parseAttachments(value: unknown): Attachment[] | null {
  if (!Array.isArray(value) || value.length > 5) return null;
  const result: Attachment[] = [];
  for (const valueItem of value) {
    const item = parseAttachment(valueItem);
    if (!item) return null;
    result.push(item);
  }
  return result;
}

function parseReply(value: unknown): ReplyRef | null {
  const item = record(value);
  if (!item || !exactKeys(item, ['author', 'text'], ['uid', 'sid', 'img', 'hasFile', 'thumb'])) return null;
  if (!boundedString(item.author, 80, false) || !boundedString(item.text, 160)) return null;
  if (item.uid !== undefined && !boundedString(item.uid, 64, false)) return null;
  if (item.sid !== undefined && !positiveId(item.sid)) return null;
  if (item.img !== undefined && typeof item.img !== 'boolean') return null;
  if (item.hasFile !== undefined && typeof item.hasFile !== 'boolean') return null;
  if (item.thumb !== undefined && !boundedString(item.thumb, 256, false)) return null;
  return {
    author: item.author,
    text: item.text,
    ...(item.uid !== undefined ? { uid: item.uid } : {}),
    ...(item.sid !== undefined ? { sid: item.sid } : {}),
    ...(item.img !== undefined ? { img: item.img } : {}),
    ...(item.hasFile !== undefined ? { hasFile: item.hasFile } : {}),
    ...(item.thumb !== undefined ? { thumb: item.thumb } : {}),
  };
}

function parseEmotes(value: unknown): Record<string, string> | null {
  const source = record(value);
  if (!source) return null;
  const entries = Object.entries(source);
  if (entries.length > 64) return null;
  const result: Record<string, string> = {};
  for (const [name, id] of entries) {
    if (!boundedString(name, 64, false) || /[\u0000-\u001f\u007f]/u.test(name)) return null;
    if (!boundedString(id, 128, false) || !/^[a-z0-9_-]+$/iu.test(id)) return null;
    result[name] = id;
  }
  return result;
}

function parseRelease(value: unknown): ReleaseNote | null {
  const item = record(value);
  if (!item || !exactKeys(item, ['sha', 'title', 'notes'], ['version', 'publishedAt'])) return null;
  if (!boundedString(item.sha, 64, false) || !/^[0-9a-f]{7,64}$/iu.test(item.sha)) return null;
  if (!boundedString(item.title, 80, false) || !Array.isArray(item.notes) || item.notes.length < 1 || item.notes.length > 30) return null;
  if (!item.notes.every((note) => boundedString(note, 200, false))) return null;
  if (item.version !== undefined && !boundedString(item.version, 48, false)) return null;
  if (item.publishedAt !== undefined
    && !(boundedInteger(item.publishedAt, 1, 8_640_000_000_000_000) || boundedString(item.publishedAt, 64, false))) return null;
  return {
    sha: item.sha,
    title: item.title,
    notes: [...item.notes] as string[],
    ...(item.version !== undefined ? { version: item.version } : {}),
    ...(item.publishedAt !== undefined ? { publishedAt: item.publishedAt } : {}),
  };
}

function parseHistoryMessage(value: unknown): HistoryMessage | null {
  const item = record(value);
  if (!item || !exactKeys(
    item,
    ['id', 'uid', 'name', 'color', 'text', 'em', 'img', 'files', 'ts', 'edited'],
    ['reply', 'reactions', 'kind', 'level', 'release', 'mkey'],
  )) return null;
  if (!positiveId(item.id) || !boundedString(item.uid, 64, false) || !boundedString(item.name, 80, false)) return null;
  if (!boundedInteger(item.color, 0, 0xffffff) || !boundedString(item.text, 1000)) return null;
  const em = parseEmotes(item.em);
  const files = parseAttachments(item.files);
  if (!em || !files || !boundedString(item.img, 256)) return null;
  if (!boundedInteger(item.ts, 1, 8_640_000_000_000_000) || typeof item.edited !== 'boolean') return null;
  const reply = item.reply === undefined ? undefined : parseReply(item.reply);
  if (item.reply !== undefined && !reply) return null;
  const reactions = item.reactions === undefined ? undefined : parseReactions(item.reactions);
  if (item.reactions !== undefined && !reactions) return null;
  if (item.kind !== undefined && item.kind !== 'levelup' && item.kind !== 'release') return null;
  if (item.level !== undefined && !boundedInteger(item.level, 1, 1_000_000)) return null;
  const release = item.release === undefined ? undefined : parseRelease(item.release);
  if (item.release !== undefined && !release) return null;
  if (item.kind === 'levelup' && item.level === undefined) return null;
  if (item.kind === 'release' && !release) return null;
  if (item.kind !== 'levelup' && item.level !== undefined) return null;
  if (item.kind !== 'release' && item.release !== undefined) return null;
  if (item.mkey !== undefined && !boundedString(item.mkey, 64, false)) return null;
  return {
    id: item.id,
    uid: item.uid,
    name: item.name,
    color: item.color,
    text: item.text,
    em,
    img: item.img,
    files,
    ts: item.ts,
    edited: item.edited,
    ...(reply ? { reply } : {}),
    ...(reactions ? { reactions } : {}),
    ...(item.kind !== undefined ? { kind: item.kind } : {}),
    ...(item.level !== undefined ? { level: item.level } : {}),
    ...(release ? { release } : {}),
    ...(item.mkey !== undefined ? { mkey: item.mkey } : {}),
  };
}

function parseCanonicalEvent(value: unknown): ChatCanonicalEvent | null {
  const event = record(value);
  if (!event || typeof event.type !== 'string') return null;
  switch (event.type) {
    case 'message.created': {
      if (!exactKeys(event, ['type', 'message'], ['mkey'])) return null;
      if (event.mkey !== undefined && !boundedString(event.mkey, 64, false)) return null;
      const message = parseHistoryMessage(event.message);
      if (message && event.mkey !== undefined && message.mkey !== undefined && event.mkey !== message.mkey) return null;
      return message ? {
        type: event.type,
        message,
        ...((event.mkey ?? message.mkey) !== undefined ? { mkey: event.mkey ?? message.mkey } : {}),
      } : null;
    }
    case 'message.updated':
      return exactKeys(event, ['type', 'messageId', 'text', 'edited'])
        && positiveId(event.messageId) && boundedString(event.text, 1000, false) && event.edited === true
        ? { type: event.type, messageId: event.messageId, text: event.text, edited: true }
        : null;
    case 'message.deleted':
      return exactKeys(event, ['type', 'messageId']) && positiveId(event.messageId)
        ? { type: event.type, messageId: event.messageId }
        : null;
    case 'reaction.updated': {
      if (!exactKeys(event, ['type', 'messageId', 'reactions']) || !positiveId(event.messageId)) return null;
      const reactions = parseReactions(event.reactions);
      return reactions ? { type: event.type, messageId: event.messageId, reactions } : null;
    }
    case 'chat.cleared':
      return exactKeys(event, ['type']) ? { type: event.type } : null;
    default:
      return null;
  }
}

export function parseChatRealtimeFrame(raw: unknown): ChatRealtimeFrame | null {
  if (typeof raw !== 'string' || raw.length > MAX_CHAT_REALTIME_FRAME_BYTES) return null;
  if (new TextEncoder().encode(raw).byteLength > MAX_CHAT_REALTIME_FRAME_BYTES) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  const frame = record(value);
  if (!frame || frame.v !== 1) return null;
  if (frame.t === 'chat-ready') {
    return exactKeys(frame, ['t', 'v']) ? { t: 'chat-ready', v: 1 } : null;
  }
  if (!boundedString(frame.serverId, 80, false) || !/^[a-z0-9_-]+$/iu.test(frame.serverId)) return null;
  if (frame.t === 'chat-resync') {
    return exactKeys(frame, ['t', 'v', 'serverId', 'reason'])
      && (frame.reason === 'backpressure' || frame.reason === 'reconnect')
      ? { t: 'chat-resync', v: 1, serverId: frame.serverId, reason: frame.reason }
      : null;
  }
  if (frame.t !== 'chat-event' || !exactKeys(frame, ['t', 'v', 'serverId', 'rev', 'event']) || !positiveId(frame.rev)) return null;
  const event = parseCanonicalEvent(frame.event);
  return event ? { t: 'chat-event', v: 1, serverId: frame.serverId, rev: frame.rev, event } : null;
}

export function chatRealtimeTargetsServer(
  frame: ChatEventFrame | ChatResyncFrame,
  currentServerId: string | null | undefined,
): boolean {
  return typeof currentServerId === 'string' && currentServerId.length > 0 && frame.serverId === currentServerId;
}

export function validChatSnapshotRevisions(revision: unknown, lastClearRevision: unknown): boolean {
  return Number.isSafeInteger(revision) && Number(revision) >= 0
    && Number.isSafeInteger(lastClearRevision) && Number(lastClearRevision) >= 0
    && Number(lastClearRevision) <= Number(revision);
}

export function chatProtocolPresence(v1Ready: boolean): { chatProtocol?: 1 } {
  return v1Ready ? { chatProtocol: 1 } : {};
}

export function claimBoundedMessageId(claims: Set<number>, messageId: number, maxClaims = 1024): boolean {
  if (!Number.isSafeInteger(messageId) || messageId <= 0 || !Number.isSafeInteger(maxClaims) || maxClaims < 1) return false;
  if (claims.has(messageId)) return false;
  claims.add(messageId);
  while (claims.size > maxClaims) {
    const oldest = claims.values().next().value;
    if (typeof oldest !== 'number') break;
    claims.delete(oldest);
  }
  return true;
}

export function canReconcileUnchangedChatSnapshot(
  canonicalSnapshotEstablished: boolean,
  revisionKnown: boolean,
  currentRevision: number,
  currentLastClearRevision: number,
  snapshotRevision: number,
  snapshotLastClearRevision: number,
  bufferedRevisions: readonly number[],
  bufferOverflow = false,
): boolean {
  return canonicalSnapshotEstablished
    && revisionKnown
    && snapshotRevision === currentRevision
    && snapshotLastClearRevision === currentLastClearRevision
    && !bufferOverflow
    && !bufferedRevisions.some((revision) => revision > snapshotRevision);
}

// Exact uid+mkey adoption is decided before this helper. An unmatched local
// send survives unless the server can prove that a clear committed strictly
// after the revision on which that send was based. Unknown bases fail open for
// retry UX; an explicit clear event still removes them immediately.
export function preserveOptimisticAtSnapshot(
  exactMatch: boolean,
  baseRevision: number | null | undefined,
  lastClearRevision: number,
): boolean {
  if (exactMatch) return true;
  return baseRevision == null || !Number.isSafeInteger(baseRevision)
    || lastClearRevision <= baseRevision;
}

export function planChatEventReplay<T>(
  snapshotRevision: number,
  buffered: Array<{ rev: number; event: T }>,
  overflow = false,
): { events: Array<{ rev: number; event: T }>; revision: number; gap: boolean } {
  let revision = snapshotRevision;
  const events: Array<{ rev: number; event: T }> = [];
  const seen = new Set<number>();
  const ordered = buffered.slice().sort((a, b) => a.rev - b.rev);
  for (const item of ordered) {
    if (!Number.isSafeInteger(item.rev) || item.rev <= snapshotRevision || seen.has(item.rev)) continue;
    seen.add(item.rev);
    if (item.rev !== revision + 1) return { events, revision, gap: true };
    events.push(item);
    revision = item.rev;
  }
  return { events, revision, gap: overflow };
}
