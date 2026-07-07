import type { AudioSettings } from './types';

const DEF: AudioSettings = { input: '', output: '', ns: true, ec: true, agc: true, mode: 'voice', pttKey: 'KeyV', master: 100, sensitivity: 10, sensitivityAuto: true, notifyVolume: 60, keybinds: { muteMic: ['KeyM'], deafen: ['KeyD'] }, disableGlobalHotkeys: false };
const stored = JSON.parse(localStorage.getItem('audioSettings') || '{}');
// keybinds — вложенный объект: спред верхнего уровня его бы целиком заменил (потеряв дефолты
// действий, которых нет в сохранёнке), поэтому мержим отдельно.
let s: AudioSettings = { ...DEF, ...stored, keybinds: { ...DEF.keybinds, ...(stored.keybinds || {}) } };
const subs = new Set<() => void>();

export const getSettings = (): AudioSettings => s;
export function setSettings(patch: Partial<AudioSettings>): void {
  s = { ...s, ...patch };
  localStorage.setItem('audioSettings', JSON.stringify(s));
  subs.forEach((f) => f());
}
export function subscribeSettings(f: () => void): () => void { subs.add(f); return () => { subs.delete(f); }; }
