import { useEffect, useRef, useState } from 'react';
import { getEngine } from '../store';
import { getSettings, setSettings } from '../settings';

// Живой индикатор уровня микрофона + порог чувствительности ввода (как в Discord).
// Уровень/открытость гейта пишутся напрямую в DOM через ref (без setState) — апдейты идут ~20-60 раз/сек.
export function MicMeter() {
  const fillRef = useRef<HTMLDivElement>(null);
  const markerRef = useRef<HTMLDivElement>(null);
  const [, force] = useState(0);
  const rerender = () => force((n) => n + 1);
  const s = getSettings();

  useEffect(() => {
    const E = getEngine();
    if (!E) return;
    return E.onInputLevel((level, open, threshold) => {
      if (fillRef.current) { fillRef.current.style.width = level * 100 + '%'; fillRef.current.classList.toggle('open', open); }
      if (markerRef.current) markerRef.current.style.left = threshold * 100 + '%';
    });
  }, []);

  const toggleAuto = () => { setSettings({ sensitivityAuto: !s.sensitivityAuto }); rerender(); };
  return (
    <div className="mic-test">
      <div className="mic-test-h">
        <span>Проверка микрофона — скажи что-нибудь</span>
        <span className="mic-auto">
          Авто-порог
          <div className={'sw' + (s.sensitivityAuto ? ' on' : '')} role="switch" aria-checked={s.sensitivityAuto} aria-label="Определять порог автоматически" tabIndex={0}
            onClick={toggleAuto}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleAuto(); } }} />
        </span>
      </div>
      <div className={'micmeter' + (s.sensitivityAuto ? ' auto' : '')}>
        <div className="mm-fill" ref={fillRef} />
        <div className="mm-marker" ref={markerRef} />
        {!s.sensitivityAuto ? (
          <input type="range" min={0} max={100} value={s.sensitivity}
            aria-label="Порог чувствительности ввода"
            onChange={(e) => { setSettings({ sensitivity: +e.target.value }); rerender(); }} />
        ) : null}
      </div>
      <div className="mm-hint">
        {s.sensitivityAuto ? 'Порог подбирается по шуму фона.' : 'Всё, что тише белой метки, собеседники не услышат — потяни, чтобы сдвинуть.'}
        {' '}Работает, когда микрофон включается голосом.
      </div>
    </div>
  );
}
