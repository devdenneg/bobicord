export const CAT_WALLPAPER_STORAGE_KEY = 'chatWallpaper:cats';

type ReadableStorage = Pick<Storage, 'getItem'>;
type WritableStorage = Pick<Storage, 'setItem' | 'removeItem'>;

export function readCatWallpaper(storage?: ReadableStorage): boolean {
  try {
    return (storage ?? localStorage).getItem(CAT_WALLPAPER_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeCatWallpaper(enabled: boolean, storage?: WritableStorage): void {
  try {
    const target = storage ?? localStorage;
    if (enabled) target.setItem(CAT_WALLPAPER_STORAGE_KEY, '1');
    else target.removeItem(CAT_WALLPAPER_STORAGE_KEY);
  } catch {
    // Wallpaper persistence is optional; the current session can still use it.
  }
}
