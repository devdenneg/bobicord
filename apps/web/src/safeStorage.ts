// localStorage may throw on either read or write in hardened Safari/WebView modes. Keep the exact
// current-page choice authoritative when persistence is unavailable instead of crashing React or
// resurrecting an older readable value after a quota/write failure.
const memory = new Map<string, string | null>();
const memoryAuthoritative = new Set<string>();

export function safeLocalStorageGet(key: string): string | null {
  if (memoryAuthoritative.has(key)) return memory.get(key) ?? null;
  try {
    const value = localStorage.getItem(key);
    memory.set(key, value);
    return value;
  } catch {
    return memory.get(key) ?? null;
  }
}

export function safeLocalStorageSet(key: string, value: string): boolean {
  memory.set(key, value);
  memoryAuthoritative.add(key);
  try {
    localStorage.setItem(key, value);
    memoryAuthoritative.delete(key);
    return true;
  } catch {
    return false;
  }
}

export function safeLocalStorageRemove(key: string): boolean {
  memory.set(key, null);
  memoryAuthoritative.add(key);
  try {
    localStorage.removeItem(key);
    memoryAuthoritative.delete(key);
    return true;
  } catch {
    return false;
  }
}
