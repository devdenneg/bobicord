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
  const updateSensitivity = (patch: { sensitivityAuto?: boolean; sensitivity?: number }) => {
    setSettings(patch);
    // Settings persistence is synchronous, so the existing voice graph can apply the new gate in
    // the same input event instead of waiting for the next VAD/audio-meter sample.
    getEngine()?.onVoiceActivationSettingsChanged();
    rerender();
  };

  // Колбэк уровня приходит 20-60 раз в секунду. Писать сюда `width` и `left` — значит
  // заказывать пересчёт раскладки на каждом кадре, пока микрофон открыт; на машине, которая
  // делит кадры с полноэкранной игрой, это заметная плата за декоративную шкалу.
  // Заливка едет transform'ом (композитор, без раскладки), а порог переставляется только
  // когда реально изменился — он двигается лишь при перетаскивании ползунка.
  const lastThreshold = useRef(-1);
  useEffect(() => {
    const E = getEngine();
    if (!E) return;
    return E.onInputLevel((level, open, threshold) => {
      if (fillRef.current) {
        fillRef.current.style.transform = 'scaleX(' + Math.max(0, Math.min(1, level)) + ')';
        fillRef.current.classList.toggle('open', open);
      }
      if (markerRef.current && threshold !== lastThreshold.current) {
        lastThreshold.current = threshold;
        markerRef.current.style.left = threshold * 100 + '%';
      }
    });
  }, []);

  return (
    <div className="fld" style={{ marginTop: 10 }}>
      <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span>Чувствительность ввода</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, textTransform: 'none', fontWeight: 400 }}>
          Авто
          <div className={'sw' + (s.sensitivityAuto ? ' on' : '')} role="switch" aria-checked={s.sensitivityAuto} aria-label="Определять автоматически" tabIndex={0}
            onClick={() => updateSensitivity({ sensitivityAuto: !s.sensitivityAuto })}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); updateSensitivity({ sensitivityAuto: !s.sensitivityAuto }); } }} />
        </span>
      </label>
      <div className={'micmeter' + (s.sensitivityAuto ? ' auto' : '')}>
        <div className="mm-fill" ref={fillRef} />
        <div className="mm-marker" ref={markerRef} />
        {!s.sensitivityAuto ? (
          <input type="range" min={0} max={100} value={s.sensitivity}
            aria-label="Порог чувствительности ввода"
            onChange={(e) => updateSensitivity({ sensitivity: +e.target.value })} />
        ) : null}
      </div>
      <div className="mm-hint">
        {s.sensitivityAuto ? 'Порог подбирается автоматически по шуму фона.' : 'Потяни ползунок — звук ниже порога не будет передаваться.'}
        {' '}Работает в режиме «Активация голосом».
      </div>
    </div>
  );
}
