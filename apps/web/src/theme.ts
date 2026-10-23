// Оформление: режим (тёмная/светлая/как в системе) + акцент. Применяется атрибутами
// data-theme / data-accent на <html>; сами цвета — CSS-переменные в styles.css.
// Ранняя установка до первого кадра — public/theme-boot.js (та же логика, без бандла).
export type ThemeMode = 'dark' | 'light' | 'system';
export type Accent = 'sage' | 'lavender' | 'sky' | 'peach';

export const THEME_MODES: { id: ThemeMode; name: string }[] = [
  { id: 'dark', name: 'Тёмная' },
  { id: 'light', name: 'Светлая' },
  { id: 'system', name: 'Как в системе' },
];

export const ACCENTS: { id: Accent; name: string; swatch: string }[] = [
  { id: 'sage', name: 'Шалфей', swatch: '#8cc2ae' },
  { id: 'lavender', name: 'Лаванда', swatch: '#b4a7e0' },
  { id: 'sky', name: 'Небо', swatch: '#92b4e3' },
  { id: 'peach', name: 'Персик', swatch: '#e8b08f' },
];

const MODE_KEY = 'theme';
const ACCENT_KEY = 'accent';
const META_BG: Record<'dark' | 'light', string> = { dark: '#111312', light: '#f3f4f1' };

function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* приватный режим — тема просто не запомнится */ }
}

// Прежние темы (оникс, OLED, полночь…) были тёмными — их сохранённые id читаем как «тёмная».
export function getThemeMode(): ThemeMode {
  const id = read(MODE_KEY);
  return id === 'light' || id === 'system' ? id : 'dark';
}

export function getAccent(): Accent {
  const id = read(ACCENT_KEY);
  return ACCENTS.some((a) => a.id === id) ? id as Accent : 'sage';
}

const systemQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: light)') : null;

function resolve(mode: ThemeMode): 'dark' | 'light' {
  if (mode === 'system') return systemQuery?.matches ? 'light' : 'dark';
  return mode;
}

function apply(): void {
  const root = document.documentElement;
  const resolved = resolve(getThemeMode());
  root.setAttribute('data-theme', resolved);
  root.setAttribute('data-accent', getAccent());
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', META_BG[resolved]);
}

export function setThemeMode(mode: ThemeMode): void {
  write(MODE_KEY, mode);
  apply();
}

export function setAccent(accent: Accent): void {
  write(ACCENT_KEY, accent);
  apply();
}

let listening = false;
export function applyStoredTheme(): void {
  apply();
  if (!listening && systemQuery) {
    listening = true;
    systemQuery.addEventListener('change', () => { if (getThemeMode() === 'system') apply(); });
  }
}
