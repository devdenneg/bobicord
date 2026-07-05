const FILES = {
  msg: '/msg.wav',       // кто-то написал в чат
  join: '/join.wav',     // кто-то зашёл в голосовой (восходящий)
  stream: '/stream.wav', // кто-то включил трансляцию
  leave: '/leave.wav',   // кто-то вышел из голосового (нисходящий)
  mute: '/mute.wav',     // кто-то замутился
  system: '/system.wav', // системное уведомление (напр. надо обновиться)
} as const;
type SoundName = keyof typeof FILES;
const cache: Partial<Record<SoundName, HTMLAudioElement>> = {};

export function playSound(name: SoundName): void {
  try {
    let a = cache[name];
    if (!a) { a = new Audio(FILES[name]); a.volume = 0.5; cache[name] = a; }
    a.currentTime = 0;
    a.play().catch(() => {});
  } catch { /* ignore */ }
}
