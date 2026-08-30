// Тем две: тёмная (по умолчанию) и светлая. Тема = набор CSS-переменных через
// :root[data-theme=...] в styles.css. Тёмная живёт на голом :root, поэтому её
// атрибут ничего не переопределяет — он нужен только чтобы селектор в настройках
// знал, что выбрано, и чтобы будущая тема не унаследовала чужие значения.
export interface ThemeDef { id: string; name: string; description: string; swatch: [string, string, string] }

export const THEMES: ThemeDef[] = [
  { id: 'dark', name: 'Тёмная', description: 'Для вечера и для игры рядом', swatch: ['#191d21', '#3d84f5', '#2ea55c'] },
  { id: 'light', name: 'Светлая', description: 'Для дня и рабочего созвона', swatch: ['#f7f8fa', '#1663d6', '#1a7f43'] },
];

const KEY = 'theme';
const DEFAULT = 'dark';
const THEME_COLORS: Record<string, string> = { dark: '#0d0f12', light: '#e9ebef' };
// Прежние 14 тем сокращены до двух. У тех, кто сидел на любой тёмной вариации,
// в localStorage лежит её id — все они тёмные, поэтому молча уводим их в 'dark',
// а не сбрасываем в дефолт через ошибку.
const isValid = (id: string) => THEMES.some((t) => t.id === id);

export function getTheme(): string {
  try {
    const id = localStorage.getItem(KEY) || DEFAULT;
    return isValid(id) ? id : DEFAULT;
  } catch { return DEFAULT; }
}

export function setTheme(id: string): void {
  if (!isValid(id)) return;
  try { localStorage.setItem(KEY, id); } catch { /** current page still applies the choice */ }
  applyTheme(id);
}

export function applyTheme(id: string): void {
  document.documentElement.setAttribute('data-theme', id);
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    ?.setAttribute('content', THEME_COLORS[id] || THEME_COLORS[DEFAULT]);
}

// применить сохранённую тему как можно раньше (до рендера) — без вспышки дефолта
export function applyStoredTheme(): void { applyTheme(getTheme()); }
