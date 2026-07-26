const ASSET_SCRIPT_PATH = /^\/assets\/[^/?#]+\.js$/;
const SCRIPT_TAG = /<script\b[^>]*>/giu;
const MODULE_TYPE = /\stype\s*=\s*["']module["']/iu;
const SCRIPT_SRC = /\ssrc\s*=\s*["']([^"']+)["']/iu;

function assetScriptPath(source: string): string | null {
  if (!source) return null;
  try {
    const path = new URL(source, 'https://relay.invalid').pathname;
    return ASSET_SCRIPT_PATH.test(path) ? path : null;
  } catch { return null; }
}

// Главная страница содержит одну исполняемую Vite-точку входа. Имя файла намеренно не
// фиксируем: при single-entry Vite называл её index-*, после добавления notif.html — main-*.
export function appEntryFromSources(sources: string[]): string | null {
  for (const source of sources) {
    const path = assetScriptPath(source);
    if (path) return path;
  }
  return null;
}

export function appEntryFromHtml(html: string): string | null {
  SCRIPT_TAG.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SCRIPT_TAG.exec(html))) {
    if (!MODULE_TYPE.test(match[0])) continue;
    const source = match[0].match(SCRIPT_SRC)?.[1] || '';
    const path = assetScriptPath(source);
    if (path) return path;
  }
  return null;
}
