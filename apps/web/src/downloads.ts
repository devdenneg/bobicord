// Локальный (per-устройство) журнал скачанных вложений чата — аналог "Загрузки" в Chrome.
// Ведётся и в вебе, и в нативе; путь на диске (path) есть только в нативе (там, где мы сами
// пишем байты через saveFileDialog и знаем, куда). Дубли — отдельными строками (как в Chrome):
// каждое реальное сохранение = новая запись, ничего не схлопываем.

export interface DownloadItem {
  id: string;
  url: string;       // источник вложения — сопоставление "уже скачан?" в нативе + повторное скачивание в вебе
  name: string;
  size: number;
  mime: string;
  savedAt: number;   // ms
  path?: string;      // натив: реальный путь на диске (веб его не знает)
  missingSince?: number; // натив: когда впервые не найден на диске (для авто-удаления при следующем открытии)
}

const KEY = 'downloads';
const MAX_ITEMS = 200;

function load(): DownloadItem[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(raw) ? raw : [];
  } catch { return []; }
}

let items: DownloadItem[] = load();
const subs = new Set<() => void>();

function persist() {
  localStorage.setItem(KEY, JSON.stringify(items));
  subs.forEach((f) => f());
}

export const getDownloads = (): DownloadItem[] => items;

export function addDownload(item: Omit<DownloadItem, 'id'>): void {
  const entry: DownloadItem = { ...item, id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}` };
  items = [entry, ...items].slice(0, MAX_ITEMS);
  persist();
}

export function removeDownload(id: string): void {
  items = items.filter((d) => d.id !== id);
  persist();
}

// Патч набора записей (напр. missingSince при проверке существования файлов) — по id.
export function patchDownloads(patches: Record<string, Partial<DownloadItem>>): void {
  items = items.map((d) => (patches[d.id] ? { ...d, ...patches[d.id] } : d));
  persist();
}

export function subscribeDownloads(f: () => void): () => void { subs.add(f); return () => { subs.delete(f); }; }
