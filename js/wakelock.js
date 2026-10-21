// Screen Wake Lock API: экран не гаснет во время тренировки (если браузер поддерживает).
let sentinel = null;
let wanted = false;

export const wakeLockSupported = () => 'wakeLock' in navigator;

async function acquire() {
  if (!wakeLockSupported() || document.visibilityState !== 'visible') return;
  try {
    sentinel = await navigator.wakeLock.request('screen');
    sentinel.addEventListener('release', () => { sentinel = null; });
  } catch (e) {
    console.warn('Wake Lock не получен', e);
  }
}

export async function keepAwake() {
  wanted = true;
  if (!sentinel) await acquire();
}

export async function allowSleep() {
  wanted = false;
  try {
    await sentinel?.release();
  } catch { /* уже освобождён */ }
  sentinel = null;
}

// Браузер снимает блокировку при сворачивании — запрашиваем заново при возврате.
document.addEventListener('visibilitychange', () => {
  if (wanted && !sentinel && document.visibilityState === 'visible') acquire();
});
