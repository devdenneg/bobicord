import type { AudioSettings } from './types';

const DEF: AudioSettings = { input: '', output: '', ns: true, ec: true, agc: true, mode: 'voice', pttKey: 'KeyV', master: 100, micVolume: 100 };
let s: AudioSettings = { ...DEF, ...JSON.parse(localStorage.getItem('audioSettings') || '{}') };
const subs = new Set<() => void>();

export const getSettings = (): AudioSettings => s;
export function setSettings(patch: Partial<AudioSettings>): void {
  s = { ...s, ...patch };
  localStorage.setItem('audioSettings', JSON.stringify(s));
  subs.forEach((f) => f());
}
export function subscribeSettings(f: () => void): () => void { subs.add(f); return () => { subs.delete(f); }; }
