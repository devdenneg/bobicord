export const AV_COLORS = ['#5865f2', '#3ba55d', '#e0a423', '#eb459e', '#9b6dff', '#00a8b5', '#f47b67', '#f0b232'];
export function hueOf(s: string): number { let h = 0; for (let i = 0; i < (s || '').length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; }
export const initial = (n: string) => (n || '?').trim().charAt(0).toUpperCase() || '?';
export const avColor = (name: string, ci?: number) => AV_COLORS[(ci != null ? ci : hueOf(name)) % AV_COLORS.length];
export const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion:reduce)').matches;
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
