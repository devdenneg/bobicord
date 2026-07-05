const FILES = { join: '/1.mp3', msg: '/3.mp3', stream: '/2.mp3' } as const;
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
