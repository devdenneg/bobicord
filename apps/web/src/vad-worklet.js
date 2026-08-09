// VAD/level RMS-метр на аудио-потоке. Считает RMS предгейтового сигнала микрофона в
// AudioWorkletProcessor (реальный аудио-поток рендера) и шлёт значение в главный поток, который
// владеет гейтом «активации голосом». Смысл: requestAnimationFrame замораживается в фоновой
// вкладке, а аудио-поток — нет; поэтому rAF-анализатор переставал обновлять vadOpen в фоне и
// микрофон молча гейтился в тишину (пиры не слышали, пока не вернёшься на вкладку). Нода с
// numberOfOutputs:0 — чистый лист вне тракта публикации: она физически не может испортить звук.
// Плейн-JS (грузится через ?url в AudioWorkletGlobalScope, вне бандла) — без импортов/TS.
class VadRmsProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._acc = 0; // сумма квадратов
    this._n = 0;   // число сэмплов
    this._q = 0;   // счётчик render-квантов
  }
  process(inputs) {
    const input = inputs[0];
    const ch = input && input[0]; // канал 0 (после денойза — чистый моно, см. engine.startMic)
    if (ch) {
      for (let i = 0; i < ch.length; i++) { const v = ch[i]; this._acc += v * v; }
      this._n += ch.length;
    }
    // ~18 квантов по 128 сэмплов @48кГц ≈ 48 мс — совпадает с прежним тактом spLoop (каждый 3-й
    // кадр rAF при 60fps), чтобы адаптация шумового фона/порога осталась прежней.
    if (++this._q >= 18) {
      this.port.postMessage(this._n ? Math.sqrt(this._acc / this._n) : 0);
      this._acc = 0; this._n = 0; this._q = 0;
    }
    return true; // держим лист живым (иначе движок остановит обработку)
  }
}
registerProcessor('vad-rms', VadRmsProcessor);
