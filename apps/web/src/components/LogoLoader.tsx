/** Знак «Рилэй»: «Р», чаша которой — облачко реплики с тремя полосками голоса (сетка 48, viewBox 8 4 36 40).
 *  size — высота знака в CSS-px. animate — полоски «говорят» (только transform: scaleY, без канваса и
 *  rAF); включать лишь там, где знак живёт секунды — на экранах загрузки. В шапке и карточках знак
 *  статичен: постоянная анимация на виду у игрока — лишняя работа композитора. */
export function LogoLoader({ size = 64, animate = true }: { size?: number; animate?: boolean }) {
  return (
    <svg className={'logo-mark' + (animate ? ' loading' : '')} width={Math.round(size * 0.9)} height={size} viewBox="8 4 36 40" role="img" aria-label="Рилэй">
      <path fillRule="evenodd" d="M16 6H28A14 14 0 0 1 42 20A14 14 0 0 1 28 34H18V38A4 4 0 0 1 10 38V12A6 6 0 0 1 16 6Z M20.5 13H27A7 7 0 0 1 27 27H22.5L17.5 30.5V16A3 3 0 0 1 20.5 13Z" />
      <rect x="21.2" y="17.5" width="2.6" height="5" rx="1.3" />
      <rect x="24.9" y="15.5" width="2.6" height="9" rx="1.3" />
      <rect x="28.6" y="17" width="2.6" height="6" rx="1.3" />
    </svg>
  );
}

/** Экран загрузки приложения: знак в двух кольцах, имя, бегущая полоса и подпись этапа. */
export function Splash({ label = 'Подключение…' }: { label?: string }) {
  return (
    <div className="splash" role="status" aria-live="polite" aria-label={label}>
      <div className="splash-mark">
        <span className="splash-ring outer" aria-hidden="true" />
        <span className="splash-ring inner" aria-hidden="true" />
        <LogoLoader size={71} />
      </div>
      <div className="splash-txt">
        <b>Рилэй</b>
        <span className="splash-bar" aria-hidden="true"><i /></span>
        <span>{label}</span>
      </div>
    </div>
  );
}
