// Тёмные вариации палитры. Тема = набор CSS-переменных через :root[data-theme=...] в styles.css.
export interface ThemeDef { id: string; name: string; description: string; swatch: [string, string, string] }

export const THEMES: ThemeDef[] = [
  { id: 'default', name: 'Оникс', description: 'Нейтральная тёмная', swatch: ['#1e1f22', '#5865f2', '#23a559'] },
  { id: 'oled', name: 'OLED', description: 'Абсолютный чёрный', swatch: ['#000000', '#7657ff', '#21c16b'] },
  { id: 'midnight', name: 'Полночь', description: 'Холодный синий', swatch: ['#161c2b', '#3b82f6', '#84b4ff'] },
  { id: 'graphite', name: 'Графит', description: 'Строгий бирюзовый', swatch: ['#191a1d', '#14b8a6', '#4fd6c6'] },
  { id: 'plum', name: 'Аметист', description: 'Глубокий фиолетовый', swatch: ['#201827', '#a855f7', '#c891ff'] },
  { id: 'forest', name: 'Хвоя', description: 'Спокойный зелёный', swatch: ['#161d18', '#22c55e', '#5ee08a'] },
  { id: 'crimson', name: 'Кармин', description: 'Контрастный красный', swatch: ['#1f1518', '#f43f5e', '#ff8095'] },
  { id: 'catppuccin', name: 'Catppuccin Mocha', description: 'Мягкая пастель', swatch: ['#1e1e2e', '#cba6f7', '#a6e3a1'] },
  { id: 'tokyo-night', name: 'Tokyo Night', description: 'Неоновая ночь', swatch: ['#1a1b26', '#7aa2f7', '#9ece6a'] },
  { id: 'nord', name: 'Nord', description: 'Северная прохлада', swatch: ['#3b4252', '#88c0d0', '#a3be8c'] },
  { id: 'rose-pine', name: 'Rosé Pine', description: 'Тёплая элегантность', swatch: ['#1f1d2e', '#c4a7e7', '#eb6f92'] },
  { id: 'dracula', name: 'Dracula', description: 'Классический контраст', swatch: ['#282a36', '#bd93f9', '#50fa7b'] },
  { id: 'gruvbox', name: 'Gruvbox', description: 'Тёплое ретро', swatch: ['#282828', '#fabd2f', '#8ec07c'] },
  { id: 'solarized', name: 'Solarized Dark', description: 'Выверенный контраст', swatch: ['#002b36', '#2aa198', '#b58900'] },
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
