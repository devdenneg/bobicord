const FILES = {
  msg: '/msg.wav',       // кто-то написал в чат
  join: '/join.wav',     // кто-то зашёл в голосовой (восходящий)
  stream: '/stream.wav', // кто-то включил трансляцию
  leave: '/leave.wav',   // кто-то вышел из голосового (нисходящий)
  mute: '/mute.wav',     // кто-то замутился
  system: '/system.wav', // системное уведомление (напр. надо обновиться)
  mention: '/mention.wav', // тебя упомянули (@ник)
} as const;
import { getSettings } from './settings';

type SoundName = keyof typeof FILES;
const cache: Partial<Record<SoundName, HTMLAudioElement>> = {};

export function playSound(name: SoundName): void {
  try {
    const vol = Math.max(0, Math.min(1, (getSettings().notifyVolume ?? 60) / 100));
    if (vol <= 0) return;
    let a = cache[name];
    if (!a) { a = new Audio(FILES[name]); cache[name] = a; }
    a.volume = vol;
    a.currentTime = 0;
    a.play().catch(() => {});
  } catch { /* ignore */ }
}
