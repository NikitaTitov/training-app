// Звук через Web Audio API (без аудиофайлов) и вибрация.
let ctx = null;

/** Вызывать из обработчика нажатия: iOS разрешает звук только после жеста пользователя. */
export function unlockAudio() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!ctx) ctx = new AC();
    if (ctx.state === 'suspended') ctx.resume();
    const buf = ctx.createBuffer(1, 1, 22050);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start(0);
  } catch (e) {
    console.warn('Web Audio недоступен', e);
  }
}

function tone(freq, duration, delay = 0, volume = 0.35, type = 'sine') {
  if (!ctx) return;
  if (ctx.state === 'suspended') ctx.resume();
  const t0 = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(volume, t0 + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.02);
}

const canVibrate = () => typeof navigator.vibrate === 'function';
export const vibrationSupported = canVibrate;

function vibrate(pattern) {
  try {
    if (canVibrate()) navigator.vibrate(pattern);
  } catch { /* игнорируем */ }
}

export function createFeedback(getSettings) {
  const sound = (fn) => { if (getSettings().sound) fn(); };
  const vib = (p) => { if (getSettings().vibration) vibrate(p); };
  return {
    /** Короткий сигнал за 3…1 секунды до начала минуты. */
    tick() {
      sound(() => tone(880, 0.12, 0, 0.25));
      vib(60);
    },
    /** Начало новой минуты. */
    minuteStart() {
      sound(() => { tone(1175, 0.18, 0, 0.4, 'square'); tone(1568, 0.35, 0.16, 0.4, 'square'); });
      vib([250, 80, 250]);
    },
    finish() {
      sound(() => { tone(784, 0.2); tone(988, 0.2, 0.2); tone(1319, 0.5, 0.4); });
      vib([300, 100, 300, 100, 500]);
    },
    test() {
      unlockAudio();
      this.minuteStart();
    },
  };
}
