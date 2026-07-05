export const AV_COLORS = ['#5865f2', '#3ba55d', '#e0a423', '#eb459e', '#9b6dff', '#00a8b5', '#f47b67', '#f0b232'];
export function hueOf(s: string): number { let h = 0; for (let i = 0; i < (s || '').length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; }
export const initial = (n: string) => (n || '?').trim().charAt(0).toUpperCase() || '?';
export const avColor = (name: string, ci?: number) => AV_COLORS[(ci != null ? ci : hueOf(name)) % AV_COLORS.length];
export const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion:reduce)').matches;
export const keyLabel = (c: string) => c.replace('Key', '').replace('Digit', '').replace('Space', 'Пробел');
