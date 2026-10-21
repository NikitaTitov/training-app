// Порядок массива = порядок ротации.
export const EXERCISES = [
  { id: 'pullups', name: 'Подтягивания', defaultReps: 3 },
  { id: 'dips', name: 'Отжимания на брусьях', defaultReps: 5 },
  { id: 'squats', name: 'Приседания', defaultReps: 8 },
  { id: 'rows', name: 'Тяга', note: 'австралийские подтягивания или тяга гантели', defaultReps: 6 },
  { id: 'pushups', name: 'Отжимания от пола', defaultReps: 8 },
  { id: 'lunges', name: 'Выпады', perLeg: true, defaultReps: 5 },
  { id: 'pike', name: 'Пайк-отжимания', defaultReps: 5 },
  { id: 'sl-rdl', name: 'Румынская тяга на одной ноге', perLeg: true, defaultReps: 5 },
];

export const REPS_MIN = 1;
export const REPS_MAX = 10;
export const MIN_MINUTES = 5;
export const MAX_MINUTES = 30;
export const PROGRESSION_CAP = 20; // после 20 минут: +1 повторение и обратно к 10
export const RESET_MINUTES = 10;

export const exerciseById = (id) => EXERCISES.find((e) => e.id === id);
export const exerciseIndex = (id) => EXERCISES.findIndex((e) => e.id === id);

export const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

export const totalReps = (w) => w.reps.reduce((s, r) => s + r, 0);

export function isPlanCompleted(w) {
  return !w.finishedEarly
    && w.reps.length >= w.plannedMinutes
    && w.reps.every((r) => r >= w.plannedReps);
}

/** Подсказка по прогрессии на основе последней тренировки этого упражнения. */
export function suggest(ex, last) {
  if (!last) {
    return {
      reps: ex.defaultReps, minutes: RESET_MINUTES, kind: 'first',
      text: 'Первая тренировка этого упражнения. Выберите комфортное количество повторений — к концу должно быть тяжело, но без отказа.',
    };
  }
  const r = clamp(last.plannedReps, REPS_MIN, REPS_MAX);
  const m = clamp(last.plannedMinutes, MIN_MINUTES, MAX_MINUTES);
  if (!isPlanCompleted(last)) {
    return {
      reps: r, minutes: m, kind: 'repeat',
      text: `В прошлый раз план выполнен не полностью — повторите ${r} × ${m}.`,
    };
  }
  if (m >= PROGRESSION_CAP && r < REPS_MAX) {
    return {
      reps: r + 1, minutes: RESET_MINUTES, kind: 'reps',
      text: `Отлично, ${m} минут пройдено! Добавьте повторение: ${r + 1} в минуту и вернитесь к ${RESET_MINUTES} минутам.`,
    };
  }
  if (m >= MAX_MINUTES) {
    return {
      reps: r, minutes: m, kind: 'max',
      text: 'Достигнут максимум приложения. Подумайте об усложнении: утяжеление, медленный темп или более сложный вариант.',
    };
  }
  return {
    reps: r, minutes: m + 1, kind: 'minute',
    text: `План выполнен — добавьте минуту: ${r} × ${m + 1}.`,
  };
}
