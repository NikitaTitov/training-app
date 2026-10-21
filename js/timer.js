export const PREP_MS = 10_000;
export const MINUTE_MS = 60_000;

/**
 * Состояние таймера вычисляется только из меток времени (Date.now()),
 * поэтому подтормаживание или ненадолго погасший экран не сбивают отсчёт.
 */
export function elapsed(t, now = Date.now()) {
  const ref = t.pausedAt ?? now;
  return Math.max(0, ref - t.startedAt - t.pausedTotal);
}

export function pause(t, now = Date.now()) {
  if (t.pausedAt == null) t.pausedAt = now;
}

export function resume(t, now = Date.now()) {
  if (t.pausedAt != null) {
    t.pausedTotal += now - t.pausedAt;
    t.pausedAt = null;
  }
}

/**
 * phase: 'prep' | 'work' | 'done'
 * secondsLeft — секунд до конца текущего отрезка (60…1 в рабочей минуте, 10…1 в подготовке)
 * fraction — доля прошедшего времени текущего отрезка (0…1)
 */
export function snapshot(t, minutes, now = Date.now()) {
  const e = elapsed(t, now);
  if (e < PREP_MS) {
    return { phase: 'prep', minuteIndex: -1, secondsLeft: Math.ceil((PREP_MS - e) / 1000), fraction: e / PREP_MS };
  }
  const work = e - PREP_MS;
  if (work >= minutes * MINUTE_MS) {
    return { phase: 'done', minuteIndex: minutes - 1, secondsLeft: 0, fraction: 1, overMs: work - minutes * MINUTE_MS };
  }
  const minuteIndex = Math.floor(work / MINUTE_MS);
  const inMinute = work - minuteIndex * MINUTE_MS;
  return { phase: 'work', minuteIndex, secondsLeft: Math.ceil((MINUTE_MS - inMinute) / 1000), fraction: inMinute / MINUTE_MS };
}
