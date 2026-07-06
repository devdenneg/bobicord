// Тёмные вариации палитры. Тема = набор CSS-переменных через :root[data-theme=...] в styles.css.
export interface ThemeDef { id: string; name: string; swatch: [string, string, string] }

export const THEMES: ThemeDef[] = [
  { id: 'default', name: 'Оникс', swatch: ['#1e1f22', '#5865f2', '#23a559'] },
  { id: 'midnight', name: 'Полночь', swatch: ['#161c2b', '#3b82f6', '#84b4ff'] },
  { id: 'graphite', name: 'Графит', swatch: ['#191a1d', '#14b8a6', '#4fd6c6'] },
  { id: 'plum', name: 'Аметист', swatch: ['#201827', '#a855f7', '#c891ff'] },
  { id: 'forest', name: 'Хвоя', swatch: ['#161d18', '#22c55e', '#5ee08a'] },
  { id: 'crimson', name: 'Кармин', swatch: ['#1f1518', '#f43f5e', '#ff8095'] },
];

const KEY = 'theme';
const isValid = (id: string) => THEMES.some((t) => t.id === id);

export function getTheme(): string {
  const id = localStorage.getItem(KEY) || 'default';
  return isValid(id) ? id : 'default';
}

export function setTheme(id: string): void {
  if (!isValid(id)) return;
  localStorage.setItem(KEY, id);
  applyTheme(id);
}

export function applyTheme(id: string): void {
  document.documentElement.setAttribute('data-theme', id);
}

// применить сохранённую тему как можно раньше (до рендера) — без вспышки дефолта
export function applyStoredTheme(): void { applyTheme(getTheme()); }
