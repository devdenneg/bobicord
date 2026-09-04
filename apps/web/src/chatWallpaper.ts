export const CAT_WALLPAPER_STORAGE_KEY = 'chatWallpaper:cats';

type ReadableStorage = Pick<Storage, 'getItem'>;
type WritableStorage = Pick<Storage, 'setItem' | 'removeItem'>;

export function readCatWallpaper(storage: ReadableStorage = localStorage): boolean {
  try {
    return storage.getItem(CAT_WALLPAPER_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeCatWallpaper(enabled: boolean, storage: WritableStorage = localStorage): void {
  try {
    if (enabled) storage.setItem(CAT_WALLPAPER_STORAGE_KEY, '1');
    else storage.removeItem(CAT_WALLPAPER_STORAGE_KEY);
  } catch {
    // Wallpaper persistence is optional; the current session can still use it.
  }
}
