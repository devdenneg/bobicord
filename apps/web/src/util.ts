export const AV_COLORS = ['#5865f2', '#3ba55d', '#e0a423', '#eb459e', '#9b6dff', '#00a8b5', '#f47b67', '#f0b232'];
export function hueOf(s: string): number { let h = 0; for (let i = 0; i < (s || '').length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; }
export const initial = (n: string) => (n || '?').trim().charAt(0).toUpperCase() || '?';
export const avColor = (name: string, ci?: number) => AV_COLORS[(ci != null ? ci : hueOf(name)) % AV_COLORS.length];
export const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion:reduce)').matches;
// LiveKit identity = `username#<nonce>` (уникально на сессию). Базовый username = ключ юзера в UI/presence.
export const baseUid = (id: string) => { const i = (id || '').indexOf('#'); return i < 0 ? (id || '') : id.slice(0, i); };
// Человекочитаемая метка одной клавиши по KeyboardEvent.code.
const KEY_LABELS: Record<string, string> = {
  ControlLeft: 'Ctrl', ControlRight: 'Ctrl', ShiftLeft: 'Shift', ShiftRight: 'Shift',
  AltLeft: 'Alt', AltRight: 'Alt', MetaLeft: 'Win', MetaRight: 'Win',
  Space: 'Пробел', Enter: 'Enter', Escape: 'Esc', Tab: 'Tab', Backspace: 'Backspace',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  CapsLock: 'CapsLock', Backquote: '`', Minus: '-', Equal: '=',
  BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'",
  Comma: ',', Period: '.', Slash: '/',
};
export const keyLabel = (c: string): string => KEY_LABELS[c] || c.replace('Key', '').replace('Digit', '');
export const comboLabel = (codes: string[]): string => (codes.length ? codes.map(keyLabel).join(' + ') : '—');
// левый/правый модификатор — один и тот же бинд (Ctrl слева и справа не различаем)
export const normKey = (c: string): string => c.replace(/^(Control|Shift|Alt|Meta)(Left|Right)$/, '$1');

// Даунскейл картинки перед аплоадом в чат: длинная сторона ≤1920px, ре-энкод в WebP (все форматы —
// единый путь, лучшее сжатие). GIF не трогаем (canvas убивает анимацию). Если результат вдруг
// тяжелее оригинала (мелкие/уже сжатые картинки) — возвращаем оригинал как есть.
export async function downscaleImage(file: File, maxSide = 1920, quality = 0.82): Promise<File> {
  if (file.type === 'image/gif') return file;
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return file;
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) { bitmap.close(); return file; }
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const blob: Blob | null = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', quality));
  if (!blob || blob.size >= file.size) return file;
  const name = file.name.replace(/\.[^.]+$/, '') + '.webp';
  return new File([blob], name, { type: 'image/webp' });
}
