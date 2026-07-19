export interface HttpLinkPart {
  kind: 'link';
  href: string;
  label: string;
}

export type LinkifiedTextPart = string | HttpLinkPart;

// Intentionally limit chat links to HTTP(S). Other schemes (javascript:, file:,
// data:, custom protocol handlers) stay plain text and never reach the native opener.
// A comma/semicolon immediately followed by another scheme is treated as a
// separator. This keeps pasted `https://one,https://two` links independent
// without forbidding those punctuation characters inside ordinary URLs.
const HTTP_URL = /https?:\/\/(?:(?![,;]https?:\/\/)[^\s<>"'`\u0000-\u001f])+/giu;
const SIMPLE_TRAILING_PUNCTUATION = new Set(['.', ',', '!', '?', ':', ';', '\u2026', '\u00bb', '\u201d', '\u2019']);
const CLOSING_PAIR: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
const LEFT_WORD_CHAR = /[\p{L}\p{N}_@]/u;

function countChar(value: string, char: string): number {
  let count = 0;
  for (const current of value) if (current === char) count++;
  return count;
}

/** Removes sentence punctuation without breaking balanced brackets inside a URL. */
export function trimUrlPunctuation(candidate: string): string {
  let value = candidate;
  while (value) {
    const last = value[value.length - 1];
    if (SIMPLE_TRAILING_PUNCTUATION.has(last)) {
      value = value.slice(0, -1);
      continue;
    }
    const opener = CLOSING_PAIR[last];
    if (opener && countChar(value, last) > countChar(value, opener)) {
      value = value.slice(0, -1);
      continue;
    }
    break;
  }
  return value;
}

/** Returns a normalized safe HTTP(S) URL or null for unsupported/malformed input. */
export function normalizeExternalHttpUrl(value: string): string | null {
  if (!value || value.length > 8192) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (!parsed.hostname || parsed.username || parsed.password) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

/**
 * Splits arbitrary chat text into text and safe HTTP(S) links. The original label is
 * preserved while href is normalized. Sentence punctuation remains outside the link.
 */
export function linkifyHttpUrls(text: string): LinkifiedTextPart[] {
  const parts: LinkifiedTextPart[] = [];
  let cursor = 0;

  for (const match of text.matchAll(HTTP_URL)) {
    const start = match.index;
    if (start > 0 && LEFT_WORD_CHAR.test(text[start - 1])) continue;

    const label = trimUrlPunctuation(match[0]);
    const href = normalizeExternalHttpUrl(label);
    if (!label || !href) continue;

    if (start > cursor) parts.push(text.slice(cursor, start));
    parts.push({ kind: 'link', href, label });
    cursor = start + label.length;
  }

  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts.length ? parts : [text];
}
