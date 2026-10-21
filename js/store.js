import { EXERCISES, exerciseById, clamp, REPS_MAX } from './exercises.js';

const KEY = 'emom.data.v1';
const ACTIVE_KEY = 'emom.active.v1';
const FORMAT = 'emom-tracker';

let onError = (err) => console.error(err);
export const setErrorHandler = (fn) => { onError = fn; };

const defaults = () => ({
  rotationIndex: 0,
  settings: { sound: true, vibration: true },
  workouts: [],
});

function storageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch (e) {
    onError(new Error('Хранилище недоступно: ' + e.message));
    return null;
  }
}

function storageSet(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
    return true;
  } catch (e) {
    const full = e && (e.name === 'QuotaExceededError' || e.code === 22);
    onError(new Error(full ? 'Недостаточно места для сохранения данных' : 'Не удалось сохранить данные: ' + e.message));
    return false;
  }
}

const int = (v, fallback) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : fallback);

function normalizeWorkout(w) {
  if (!w || typeof w !== 'object') throw new Error('Некорректная запись тренировки');
  if (!exerciseById(w.exerciseId)) throw new Error(`Неизвестное упражнение: ${w.exerciseId}`);
  const date = new Date(w.date);
  if (Number.isNaN(date.getTime())) throw new Error('Некорректная дата тренировки');
  if (!Array.isArray(w.reps)) throw new Error('Нет повторений по минутам');
  const reps = w.reps.map((r) => clamp(int(r, 0), 0, 999));
  return {
    id: String(w.id || newId()),
    date: date.toISOString(),
    exerciseId: w.exerciseId,
    plannedReps: clamp(int(w.plannedReps, 1), 1, REPS_MAX),
    plannedMinutes: clamp(int(w.plannedMinutes, reps.length || 1), 1, 60),
    reps,
    finishedEarly: Boolean(w.finishedEarly),
    note: typeof w.note === 'string' ? w.note.slice(0, 500) : '',
    difficulty: w.difficulty == null ? null : clamp(int(w.difficulty, 3), 1, 5),
  };
}

/** Проверяет и приводит к схеме данные (из localStorage или из файла импорта). */
export function normalize(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Файл не содержит данных приложения');
  const base = defaults();
  const workouts = Array.isArray(raw.workouts) ? raw.workouts.map(normalizeWorkout) : [];
  return {
    rotationIndex: clamp(int(raw.rotationIndex, 0), 0, EXERCISES.length - 1),
    settings: {
      sound: raw.settings?.sound ?? base.settings.sound,
      vibration: raw.settings?.vibration ?? base.settings.vibration,
    },
    workouts: sortWorkouts(workouts),
  };
}

const sortWorkouts = (list) => list.sort((a, b) => b.date.localeCompare(a.date));

function load() {
  const raw = storageGet(KEY);
  if (!raw) return defaults();
  try {
    return normalize(JSON.parse(raw));
  } catch (e) {
    // Не перетираем повреждённые данные: сохраняем копию, чтобы их можно было восстановить вручную.
    storageSet(KEY + '.corrupted.' + Date.now(), raw);
    onError(new Error('Сохранённые данные повреждены, создана резервная копия. ' + e.message));
    return defaults();
  }
}

let state = null;
export function getState() {
  if (!state) state = load();
  return state;
}

function persist() {
  return storageSet(KEY, JSON.stringify(state));
}

export const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export function setSetting(name, value) {
  getState().settings[name] = value;
  return persist();
}

export function setRotation(index) {
  getState().rotationIndex = clamp(index, 0, EXERCISES.length - 1);
  return persist();
}

/** Сохраняет новую тренировку и сдвигает ротацию на слот после того, что был «сегодняшним». */
export function addWorkout(workout, slotIndex) {
  const s = getState();
  s.workouts.push(normalizeWorkout(workout));
  sortWorkouts(s.workouts);
  s.rotationIndex = (slotIndex + 1) % EXERCISES.length;
  return persist();
}

export function updateWorkout(workout) {
  const s = getState();
  const i = s.workouts.findIndex((w) => w.id === workout.id);
  if (i < 0) return false;
  s.workouts[i] = normalizeWorkout(workout);
  sortWorkouts(s.workouts);
  return persist();
}

export function deleteWorkout(id) {
  const s = getState();
  s.workouts = s.workouts.filter((w) => w.id !== id);
  return persist();
}

export const lastWorkoutOf = (exerciseId) => getState().workouts.find((w) => w.exerciseId === exerciseId) || null;

export function exportData() {
  return JSON.stringify({ format: FORMAT, version: 1, exportedAt: new Date().toISOString(), ...getState() }, null, 2);
}

/** Полностью заменяет данные содержимым файла. Бросает исключение, если файл некорректен. */
export function importData(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Файл не является корректным JSON');
  }
  if (parsed.format && parsed.format !== FORMAT) throw new Error('Это резервная копия другого приложения');
  const next = normalize(parsed);
  const prev = state;
  state = next;
  if (!persist()) {
    state = prev;
    throw new Error('Не удалось записать импортированные данные');
  }
  return next.workouts.length;
}

// Активная (незавершённая) тренировка — отдельно, чтобы пережить перезапуск приложения.
export function loadActive() {
  const raw = storageGet(ACTIVE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    storageSet(ACTIVE_KEY, null);
    return null;
  }
}

export const saveActive = (session) => storageSet(ACTIVE_KEY, session ? JSON.stringify(session) : null);
