import {
  EXERCISES, exerciseById, suggest, isPlanCompleted, totalReps, clamp,
  REPS_MIN, REPS_MAX, MIN_MINUTES, MAX_MINUTES,
} from './exercises.js';
import * as store from './store.js';
import { snapshot, pause, resume } from './timer.js';
import { createFeedback, unlockAudio, vibrationSupported } from './feedback.js';
import { keepAwake, allowSleep, wakeLockSupported } from './wakelock.js';
import { chartSvg, attachChart } from './chart.js';

const APP_VERSION = '1.0.0';
const MINUTE_REPS_MAX = 30; // фактические повторения за минуту можно указать больше плана
const DIFFICULTY = ['', 'Легко', 'Умеренно', 'Нормально', 'Тяжело', 'На пределе'];

const $screen = document.getElementById('screen');
const $tabbar = document.getElementById('tabbar');
const $toast = document.getElementById('toast');

const fb = createFeedback(() => store.getState().settings);

const ui = {
  overrideIdx: null, // ручная замена упражнения на сегодня
  plan: null, // { exId, reps, minutes } — выбранное на экране «Сегодня»
  historyFilter: 'all',
  session: null, // активная тренировка: stage 'timer' | 'summary'
  ticker: null,
  lastMinute: null,
};

// ---------- утилиты ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
const fmtShort = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' });
const fmtWeekday = new Intl.DateTimeFormat('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
const dayKey = (d) => { const x = new Date(d); return `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`; };
const isToday = (iso) => dayKey(iso) === dayKey(Date.now());
const legNote = (ex) => (ex.perLeg ? ' на каждую ногу' : '');
const scheme = (w) => {
  const uniform = w.reps.every((r) => r === w.reps[0]);
  return uniform && w.reps.length ? `${w.reps[0]} × ${w.reps.length} = ${totalReps(w)}` : `${w.reps.length} мин = ${totalReps(w)}`;
};
const toISODate = (iso) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

let toastTimer = null;
function toast(msg, kind = 'info') {
  $toast.textContent = msg;
  $toast.dataset.kind = kind;
  $toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $toast.hidden = true; }, kind === 'error' ? 5000 : 2500);
}
store.setErrorHandler((e) => toast(e.message, 'error'));

const stepper = (action, key, value, min, max, label, extra = '') => `
  <div class="stepper" data-key="${key}">
    <span class="stepper-label">${label}</span>
    <div class="stepper-row">
      <button type="button" class="step-btn" data-action="${action}" data-key="${key}" data-delta="-1" ${value <= min ? 'disabled' : ''} aria-label="Меньше">−</button>
      <output class="step-val">${value}</output>
      <button type="button" class="step-btn" data-action="${action}" data-key="${key}" data-delta="1" ${value >= max ? 'disabled' : ''} aria-label="Больше">+</button>
    </div>
    ${extra}
  </div>`;

// ---------- маршрутизация ----------
const TABS = ['today', 'history', 'progress', 'settings'];
const currentTab = () => { const t = location.hash.slice(1); return TABS.includes(t) ? t : 'today'; };

function route() {
  const s = ui.session;
  document.body.dataset.mode = s ? s.stage : 'tabs';
  $tabbar.hidden = Boolean(s);
  if (s) {
    if (s.stage === 'timer') renderTimer(); else renderSummary();
    return;
  }
  const tab = currentTab();
  $tabbar.querySelectorAll('a').forEach((a) => a.setAttribute('aria-current', a.dataset.tab === tab ? 'page' : 'false'));
  ({ today: renderToday, history: renderHistory, progress: renderProgress, settings: renderSettings })[tab]();
  $screen.scrollTop = 0;
}
window.addEventListener('hashchange', () => { route(); window.scrollTo(0, 0); });

// ---------- «Сегодня» ----------
function renderToday() {
  const st = store.getState();
  const slot = st.rotationIndex;
  const idx = ui.overrideIdx ?? slot;
  const ex = EXERCISES[idx];
  const last = store.lastWorkoutOf(ex.id);
  const sug = suggest(ex, last);
  if (!ui.plan || ui.plan.exId !== ex.id) ui.plan = { exId: ex.id, reps: sug.reps, minutes: sug.minutes };
  const { reps, minutes } = ui.plan;
  const doneToday = st.workouts.find((w) => isToday(w.date));

  const lastHtml = last ? `
    <div class="card">
      <div class="card-label">Прошлый раз · ${fmtDate.format(new Date(last.date))}</div>
      <div class="big-line">${scheme(last)}</div>
      <div class="muted">${isPlanCompleted(last) ? '<span class="ok">✓ план выполнен</span>' : `<span class="warn">план выполнен не полностью</span> (план ${last.plannedReps} × ${last.plannedMinutes})`}
      ${last.reps.some((r) => r !== last.plannedReps) ? `<br>по минутам: ${last.reps.join(' · ')}` : ''}</div>
    </div>` : '';

  $screen.innerHTML = `
    <header class="page-head">
      <p class="eyebrow">${esc(fmtWeekday.format(new Date()))}</p>
      <h1 class="page-title">Сегодня</h1>
    </header>
    ${doneToday ? `<div class="banner ok-bg">✓ Сегодня уже сделано: ${esc(exerciseById(doneToday.exerciseId).name)}, ${scheme(doneToday)}. Ниже — следующая тренировка по ротации.</div>` : ''}
    <section class="hero">
      <div class="hero-top">
        <span class="badge">${ui.overrideIdx != null ? 'Замена' : `${idx + 1} из ${EXERCISES.length}`}</span>
        <button class="link-btn" data-action="pick-open">Заменить</button>
      </div>
      <h2 class="hero-title">${esc(ex.name)}</h2>
      ${ex.note ? `<p class="hero-sub">${esc(ex.note)}</p>` : ''}
      ${ex.perLeg ? '<p class="hero-sub">Повторения считаются на каждую ногу</p>' : ''}
      ${ui.overrideIdx != null ? `<p class="hero-sub">По ротации: ${slot + 1}. ${esc(EXERCISES[slot].name)} · <button class="link-btn" data-action="pick-reset">вернуть</button></p>` : ''}
    </section>
    ${lastHtml}
    <div class="card hint hint-${sug.kind}">
      <div class="card-label">Подсказка</div>
      <p>${esc(sug.text)}</p>
    </div>
    <div class="plan-grid">
      ${stepper('plan-step', 'reps', reps, REPS_MIN, REPS_MAX, ex.perLeg ? 'Повторений на ногу в минуту' : 'Повторений в минуту')}
      ${stepper('plan-step', 'minutes', minutes, MIN_MINUTES, MAX_MINUTES, 'Минут')}
    </div>
    <p class="plan-total">Всего по плану: <b>${reps * minutes}</b> повторений${legNote(ex)}</p>
    <button class="btn btn-primary btn-xl" data-action="start">Начать</button>

    <dialog id="pick" class="sheet">
      <form method="dialog">
        <h3>Выбрать упражнение</h3>
        <div class="pick-list">
          ${EXERCISES.map((e, i) => `
            <button type="button" class="pick-item ${i === idx ? 'is-current' : ''}" data-action="pick" data-idx="${i}">
              <span class="pick-num">${i + 1}</span>
              <span>${esc(e.name)}${i === slot ? ' <small class="muted">· по ротации</small>' : ''}</span>
            </button>`).join('')}
        </div>
        <button class="btn btn-ghost" value="cancel">Отмена</button>
        <p class="muted small">Замена не сбивает ротацию: после тренировки следующим будет упражнение №${(slot + 1) % EXERCISES.length + 1}.</p>
      </form>
    </dialog>`;
}

const actions = {};

actions['plan-step'] = (el) => {
  const key = el.dataset.key;
  const delta = Number(el.dataset.delta);
  const [min, max] = key === 'reps' ? [REPS_MIN, REPS_MAX] : [MIN_MINUTES, MAX_MINUTES];
  ui.plan[key] = clamp(ui.plan[key] + delta, min, max);
  renderToday();
};
actions['pick-open'] = () => document.getElementById('pick').showModal();
actions.pick = (el) => {
  const i = Number(el.dataset.idx);
  ui.overrideIdx = i === store.getState().rotationIndex ? null : i;
  document.getElementById('pick').close();
  renderToday();
};
actions['pick-reset'] = () => { ui.overrideIdx = null; renderToday(); };

actions.start = () => {
  unlockAudio(); // в обработчике нажатия — иначе iOS не даст играть звук
  const st = store.getState();
  const ex = EXERCISES[ui.overrideIdx ?? st.rotationIndex];
  ui.session = {
    stage: 'timer',
    exerciseId: ex.id,
    slotIndex: st.rotationIndex,
    plannedReps: ui.plan.reps,
    plannedMinutes: ui.plan.minutes,
    reps: Array(ui.plan.minutes).fill(ui.plan.reps),
    startedAt: Date.now(),
    pausedTotal: 0,
    pausedAt: null,
    selected: 0,
    note: '',
    difficulty: null,
    finishedEarly: false,
  };
  store.saveActive(ui.session);
  beginTimer();
};

// ---------- таймер ----------
const RING_C = 2 * Math.PI * 45;

function beginTimer() {
  ui.lastMinute = null;
  ui.lastCue = null;
  keepAwake();
  route();
  clearInterval(ui.ticker);
  ui.ticker = setInterval(tick, 200);
  tick();
}

function stopTimer() {
  clearInterval(ui.ticker);
  ui.ticker = null;
  allowSleep();
}

function renderTimer() {
  const s = ui.session;
  const ex = exerciseById(s.exerciseId);
  $screen.innerHTML = `
    <div class="timer">
      <header class="timer-head">
        <div class="timer-ex">${esc(ex.name)}</div>
        <div class="timer-min" id="t-min"></div>
      </header>
      <div class="ring-wrap">
        <svg class="ring" viewBox="0 0 100 100" aria-hidden="true">
          <circle class="ring-bg" cx="50" cy="50" r="45"/>
          <circle class="ring-fg" id="t-ring" cx="50" cy="50" r="45" stroke-dasharray="${RING_C}" stroke-dashoffset="0"/>
        </svg>
        <div class="ring-center">
          <div class="ring-caption" id="t-caption"></div>
          <div class="ring-sec" id="t-sec" aria-live="off"></div>
          <div class="ring-task" id="t-task"></div>
        </div>
      </div>
      <div class="rep-edit">
        <div class="rep-edit-label" id="t-sel-label"></div>
        <div class="rep-edit-row">
          <button type="button" class="step-btn step-xl" data-action="rep-step" data-delta="-1" aria-label="Меньше повторений">−</button>
          <output class="rep-edit-val" id="t-sel-val"></output>
          <button type="button" class="step-btn step-xl" data-action="rep-step" data-delta="1" aria-label="Больше повторений">+</button>
        </div>
      </div>
      <div class="chips" id="t-chips">
        ${s.reps.map((r, i) => `<button type="button" class="chip" data-action="chip" data-i="${i}"><small>${i + 1}</small><b>${r}</b></button>`).join('')}
      </div>
      <div class="timer-total" id="t-total"></div>
      <div class="timer-actions">
        <button class="btn btn-secondary" data-action="pause" id="t-pause">Пауза</button>
        <button class="btn btn-danger" data-action="finish-early">Завершить</button>
      </div>
    </div>`;
  ui.lastMinute = null;
  ui.lastScrolled = null;
  tick();
}

function cue(snap) {
  const s = ui.session;
  if (s.pausedAt != null) return;
  const key = `${snap.phase}:${snap.minuteIndex}:${snap.secondsLeft}`;
  if (key === ui.lastCue) return;
  const first = ui.lastCue == null;
  ui.lastCue = key;
  if (first && snap.phase === 'prep') return;
  if (snap.phase === 'work' && snap.secondsLeft === 60) fb.minuteStart();
  else if (snap.secondsLeft >= 1 && snap.secondsLeft <= 3) fb.tick();
}

function tick() {
  const s = ui.session;
  if (!s || s.stage !== 'timer') { stopTimer(); return; }
  const snap = snapshot(s, s.plannedMinutes);
  if (snap.phase === 'done') { finishWorkout(false, snap); return; }
  cue(snap);
  updateTimer(snap);
}

function updateTimer(snap) {
  const s = ui.session;
  const el = (id) => document.getElementById(id);
  if (!el('t-sec')) return;
  const paused = s.pausedAt != null;
  const ex = exerciseById(s.exerciseId);

  if (snap.phase === 'work' && snap.minuteIndex !== ui.lastMinute) {
    ui.lastMinute = snap.minuteIndex;
    s.selected = snap.minuteIndex;
  }
  const state = paused ? 'paused' : snap.phase === 'prep' ? 'prep' : snap.secondsLeft <= 3 ? 'warn' : 'work';
  $screen.querySelector('.timer').dataset.state = state;

  el('t-min').textContent = snap.phase === 'prep' ? 'Подготовка' : `Минута ${snap.minuteIndex + 1} из ${s.plannedMinutes}`;
  el('t-caption').textContent = paused ? 'Пауза' : snap.phase === 'prep' ? 'Приготовьтесь' : 'до следующей минуты';
  el('t-sec').textContent = snap.secondsLeft;
  el('t-task').textContent = snap.phase === 'prep'
    ? `Первая минута: ${s.plannedReps} повт.${legNote(ex)}`
    : `Сделайте ${s.plannedReps} повт.${legNote(ex)}`;
  el('t-ring').setAttribute('stroke-dashoffset', (RING_C * snap.fraction).toFixed(2));
  el('t-pause').textContent = paused ? 'Продолжить' : 'Пауза';

  const current = snap.phase === 'work' ? snap.minuteIndex : -1;
  const sel = Math.min(s.selected, Math.max(current, 0));
  s.selected = sel;
  el('t-chips').querySelectorAll('.chip').forEach((c, i) => {
    c.classList.toggle('is-done', i < current);
    c.classList.toggle('is-current', i === current);
    c.classList.toggle('is-selected', i === sel && current >= 0);
    c.classList.toggle('is-under', i <= current && s.reps[i] < s.plannedReps);
    c.disabled = i > current;
    c.querySelector('b').textContent = s.reps[i];
  });
  if (ui.lastScrolled !== current && current >= 0) {
    ui.lastScrolled = current;
    el('t-chips').children[current]?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  }

  const editable = current >= 0;
  el('t-sel-label').textContent = editable ? `Выполнено в минуте ${sel + 1}${legNote(ex)}` : 'Отметка повторений — после старта';
  el('t-sel-val').textContent = editable ? s.reps[sel] : s.plannedReps;
  $screen.querySelectorAll('[data-action="rep-step"]').forEach((b) => {
    const d = Number(b.dataset.delta);
    b.disabled = !editable || (d < 0 ? s.reps[sel] <= 0 : s.reps[sel] >= MINUTE_REPS_MAX);
  });
  const done = s.reps.slice(0, current + 1).reduce((a, b) => a + b, 0);
  el('t-total').textContent = `Сделано: ${done} из ${s.plannedReps * s.plannedMinutes}`;
}

actions['rep-step'] = (el) => {
  const s = ui.session;
  s.reps[s.selected] = clamp(s.reps[s.selected] + Number(el.dataset.delta), 0, MINUTE_REPS_MAX);
  store.saveActive(s);
  tick();
};
actions.chip = (el) => {
  ui.session.selected = Number(el.dataset.i);
  tick();
};
actions.pause = () => {
  const s = ui.session;
  if (s.pausedAt == null) {
    pause(s);
    allowSleep();
  } else {
    unlockAudio();
    resume(s);
    keepAwake();
    ui.lastCue = null;
  }
  store.saveActive(s);
  tick();
};
actions['finish-early'] = () => {
  const s = ui.session;
  const snap = snapshot(s, s.plannedMinutes);
  if (snap.phase === 'prep') {
    if (confirm('Тренировка ещё не началась. Отменить её?')) discardSession();
    return;
  }
  if (confirm(`Завершить досрочно? Будет засчитано минут: ${snap.minuteIndex + 1} из ${s.plannedMinutes}.`)) {
    finishWorkout(true, snapshot(s, s.plannedMinutes));
  }
};

function finishWorkout(early, snap) {
  const s = ui.session;
  const completed = early ? snap.minuteIndex + 1 : s.plannedMinutes;
  // Сигнал о финише только если завершили «вживую», а не восстановили давно закончившуюся тренировку.
  if (!early && (snap.overMs ?? 0) < 5000) fb.finish();
  s.reps = s.reps.slice(0, completed);
  s.finishedEarly = completed < s.plannedMinutes;
  s.stage = 'summary';
  stopTimer();
  store.saveActive(s);
  route();
  window.scrollTo(0, 0);
}

function discardSession() {
  stopTimer();
  ui.session = null;
  store.saveActive(null);
  route();
}

// ---------- итог ----------
function renderSummary() {
  const s = ui.session;
  const ex = exerciseById(s.exerciseId);
  const total = s.reps.reduce((a, b) => a + b, 0);
  const planOk = isPlanCompleted(s);
  $screen.innerHTML = `
    <header class="page-head">
      <p class="eyebrow">Тренировка завершена · ${fmtDate.format(new Date(s.startedAt))}</p>
      <h1 class="page-title">${esc(ex.name)}</h1>
    </header>
    <div class="stats">
      <div class="stat"><span>Минут</span><b>${s.reps.length}</b></div>
      <div class="stat"><span>План</span><b>${s.plannedReps}×${s.plannedMinutes}</b></div>
      <div class="stat"><span>Всего${ex.perLeg ? ' (на ногу)' : ''}</span><b id="sum-total">${total}</b></div>
    </div>
    <div class="banner ${planOk ? 'ok-bg' : 'warn-bg'}" id="sum-plan">${planOk ? '✓ План выполнен полностью' : 'План выполнен не полностью — в следующий раз приложение предложит повторить'}</div>
    <div class="card">
      <div class="card-label">Повторения по минутам</div>
      <div class="minute-rows">
        ${s.reps.map((r, i) => `
          <div class="minute-row">
            <span>Минута ${i + 1}</span>
            <div class="stepper-row small">
              <button type="button" class="step-btn" data-action="sum-step" data-i="${i}" data-delta="-1" aria-label="Меньше">−</button>
              <output class="step-val ${r < s.plannedReps ? 'warn' : ''}">${r}</output>
              <button type="button" class="step-btn" data-action="sum-step" data-i="${i}" data-delta="1" aria-label="Больше">+</button>
            </div>
          </div>`).join('')}
      </div>
    </div>
    <div class="card">
      <div class="card-label">Сложность</div>
      <div class="segmented" role="radiogroup" aria-label="Сложность">
        ${[1, 2, 3, 4, 5].map((d) => `<button type="button" role="radio" aria-checked="${s.difficulty === d}" data-action="difficulty" data-d="${d}"><b>${d}</b><small>${DIFFICULTY[d]}</small></button>`).join('')}
      </div>
    </div>
    <label class="card field">
      <span class="card-label">Заметка</span>
      <textarea id="sum-note" rows="3" maxlength="500" placeholder="Например: тяжело на последних минутах, использовал резинку">${esc(s.note)}</textarea>
    </label>
    <button class="btn btn-primary btn-xl" data-action="save-workout">Сохранить</button>
    <button class="btn btn-ghost" data-action="discard-workout">Не сохранять</button>`;
  document.getElementById('sum-note').addEventListener('input', (e) => {
    s.note = e.target.value;
    store.saveActive(s);
  });
}

actions['sum-step'] = (el) => {
  const s = ui.session;
  const i = Number(el.dataset.i);
  s.reps[i] = clamp(s.reps[i] + Number(el.dataset.delta), 0, MINUTE_REPS_MAX);
  store.saveActive(s);
  const y = window.scrollY;
  renderSummary();
  window.scrollTo(0, y);
};
actions.difficulty = (el) => {
  const s = ui.session;
  s.difficulty = Number(el.dataset.d);
  store.saveActive(s);
  $screen.querySelectorAll('[data-action="difficulty"]').forEach((b) => b.setAttribute('aria-checked', String(b === el)));
};
actions['save-workout'] = () => {
  const s = ui.session;
  const ok = store.addWorkout({
    id: store.newId(),
    date: new Date(s.startedAt).toISOString(),
    exerciseId: s.exerciseId,
    plannedReps: s.plannedReps,
    plannedMinutes: s.plannedMinutes,
    reps: s.reps,
    finishedEarly: s.finishedEarly,
    note: s.note.trim(),
    difficulty: s.difficulty,
  }, s.slotIndex);
  if (!ok) return; // ошибка уже показана; данные тренировки остаются на экране
  navigator.storage?.persist?.().catch(() => {});
  ui.session = null;
  ui.overrideIdx = null;
  ui.plan = null;
  store.saveActive(null);
  toast('Тренировка сохранена');
  if (location.hash !== '#today') location.hash = '#today'; else route();
};
actions['discard-workout'] = () => {
  if (confirm('Удалить результат этой тренировки без сохранения?')) discardSession();
};

// ---------- история ----------
function renderHistory() {
  const st = store.getState();
  const list = st.workouts.filter((w) => ui.historyFilter === 'all' || w.exerciseId === ui.historyFilter);
  $screen.innerHTML = `
    <header class="page-head">
      <h1 class="page-title">История</h1>
    </header>
    <label class="filter">
      <span class="sr-only">Фильтр по упражнению</span>
      <select id="h-filter">
        <option value="all">Все упражнения (${st.workouts.length})</option>
        ${EXERCISES.map((e) => {
          const n = st.workouts.filter((w) => w.exerciseId === e.id).length;
          return `<option value="${e.id}" ${ui.historyFilter === e.id ? 'selected' : ''}>${esc(e.name)} (${n})</option>`;
        }).join('')}
      </select>
    </label>
    ${list.length ? `<ul class="history">${list.map(historyItem).join('')}</ul>`
      : `<div class="empty">${st.workouts.length ? 'Нет тренировок с этим упражнением.' : 'Здесь появятся ваши тренировки.'}</div>`}
    <dialog id="edit" class="sheet"></dialog>`;
  document.getElementById('h-filter').addEventListener('change', (e) => {
    ui.historyFilter = e.target.value;
    renderHistory();
  });
}

function historyItem(w) {
  const ex = exerciseById(w.exerciseId);
  const uneven = w.reps.some((r) => r !== w.reps[0]);
  return `
    <li class="card h-item">
      <div class="h-top">
        <span class="muted">${fmtDate.format(new Date(w.date))}</span>
        ${w.difficulty ? `<span class="pill" title="Сложность">${'●'.repeat(w.difficulty)}${'○'.repeat(5 - w.difficulty)}</span>` : ''}
      </div>
      <div class="h-title">${esc(ex.name)}</div>
      <div class="h-scheme">${scheme(w)}${ex.perLeg ? ' <small>(на ногу)</small>' : ''}
        ${isPlanCompleted(w) ? '<span class="ok">✓</span>' : `<span class="warn small">план ${w.plannedReps}×${w.plannedMinutes}</span>`}</div>
      ${uneven ? `<div class="muted small">по минутам: ${w.reps.join(' · ')}</div>` : ''}
      ${w.note ? `<p class="h-note">${esc(w.note)}</p>` : ''}
      <div class="h-actions">
        <button class="link-btn" data-action="edit" data-id="${w.id}">Изменить</button>
        <button class="link-btn danger" data-action="delete" data-id="${w.id}">Удалить</button>
      </div>
    </li>`;
}

actions.delete = (el) => {
  if (!confirm('Удалить эту тренировку из истории?')) return;
  if (store.deleteWorkout(el.dataset.id)) { toast('Запись удалена'); renderHistory(); }
};

actions.edit = (el) => {
  const w = store.getState().workouts.find((x) => x.id === el.dataset.id);
  if (!w) return;
  const dlg = document.getElementById('edit');
  dlg.innerHTML = `
    <form id="edit-form" class="form">
      <h3>Изменить запись</h3>
      <label>Дата<input type="date" name="date" required value="${toISODate(w.date)}"></label>
      <label>Упражнение
        <select name="exerciseId">${EXERCISES.map((e) => `<option value="${e.id}" ${e.id === w.exerciseId ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}</select>
      </label>
      <div class="form-row">
        <label>План, повт./мин<input type="number" name="plannedReps" min="${REPS_MIN}" max="${REPS_MAX}" required value="${w.plannedReps}" inputmode="numeric"></label>
        <label>План, минут<input type="number" name="plannedMinutes" min="1" max="60" required value="${w.plannedMinutes}" inputmode="numeric"></label>
      </div>
      <label>Повторения по минутам <small class="muted">через пробел или запятую</small>
        <input type="text" name="reps" required value="${w.reps.join(' ')}" inputmode="numeric" autocomplete="off"></label>
      <label>Сложность
        <select name="difficulty">
          <option value="">не указана</option>
          ${[1, 2, 3, 4, 5].map((d) => `<option value="${d}" ${w.difficulty === d ? 'selected' : ''}>${d} — ${DIFFICULTY[d]}</option>`).join('')}
        </select>
      </label>
      <label>Заметка<textarea name="note" rows="3" maxlength="500">${esc(w.note)}</textarea></label>
      <p class="form-error" id="edit-error" hidden></p>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost" data-action="edit-cancel">Отмена</button>
        <button type="submit" class="btn btn-primary">Сохранить</button>
      </div>
    </form>`;
  dlg.querySelector('form').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const reps = String(f.get('reps')).split(/[\s,;]+/).filter(Boolean).map(Number);
    const err = document.getElementById('edit-error');
    if (!reps.length || reps.some((r) => !Number.isInteger(r) || r < 0 || r > 999)) {
      err.textContent = 'Повторения — целые числа через пробел, например: 5 5 5 4';
      err.hidden = false;
      return;
    }
    const [y, m, d] = String(f.get('date')).split('-').map(Number);
    const date = new Date(w.date);
    date.setFullYear(y, m - 1, d);
    const plannedMinutes = Number(f.get('plannedMinutes'));
    const ok = store.updateWorkout({
      ...w,
      date: date.toISOString(),
      exerciseId: f.get('exerciseId'),
      plannedReps: Number(f.get('plannedReps')),
      plannedMinutes,
      reps,
      finishedEarly: reps.length < plannedMinutes,
      difficulty: f.get('difficulty') ? Number(f.get('difficulty')) : null,
      note: String(f.get('note')).trim(),
    });
    if (ok) {
      dlg.close();
      toast('Запись обновлена');
      renderHistory();
    }
  });
  dlg.showModal();
};
actions['edit-cancel'] = () => document.getElementById('edit').close();

// ---------- прогресс ----------
function renderProgress() {
  const st = store.getState();
  const cards = EXERCISES.map((ex, i) => {
    const ws = st.workouts.filter((w) => w.exerciseId === ex.id).slice().reverse();
    if (!ws.length) {
      return `<section class="card prog"><h3><span class="pick-num">${i + 1}</span>${esc(ex.name)}</h3><p class="muted small">Пока нет тренировок</p></section>`;
    }
    const best = ws.reduce((a, b) => (totalReps(b) > totalReps(a) ? b : a));
    const bestMin = Math.max(...ws.map((w) => Math.max(0, ...w.reps)));
    return `
      <section class="card prog">
        <h3><span class="pick-num">${i + 1}</span>${esc(ex.name)}${ex.perLeg ? ' <small class="muted">(на ногу)</small>' : ''}</h3>
        <div class="stats">
          <div class="stat"><span>Рекорд за тренировку</span><b>${totalReps(best)}</b><small>${fmtShort.format(new Date(best.date))}</small></div>
          <div class="stat"><span>Макс. в минуту</span><b>${bestMin}</b></div>
          <div class="stat"><span>Тренировок</span><b>${ws.length}</b></div>
        </div>
        <div class="chart-wrap" data-ex="${ex.id}"><div class="chart-tip" hidden></div></div>
        <p class="muted small chart-caption">Всего повторений за тренировку</p>
      </section>`;
  }).join('');
  $screen.innerHTML = `
    <header class="page-head"><h1 class="page-title">Прогресс</h1></header>
    ${st.workouts.length ? '' : '<div class="empty">Графики появятся после первых тренировок.</div>'}
    ${cards}`;
  drawCharts();
}

function drawCharts() {
  const st = store.getState();
  $screen.querySelectorAll('.chart-wrap').forEach((wrap) => {
    const ws = st.workouts.filter((w) => w.exerciseId === wrap.dataset.ex).slice().reverse();
    const points = ws.map((w) => ({
      t: new Date(w.date).getTime(),
      y: totalReps(w),
      label: `${fmtShort.format(new Date(w.date))}: ${scheme(w)}`,
    }));
    wrap.querySelector('svg')?.remove();
    wrap.insertAdjacentHTML('beforeend', chartSvg(points, wrap.clientWidth));
    attachChart(wrap);
  });
}

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (!ui.session && currentTab() === 'progress') drawCharts(); }, 150);
});

// ---------- настройки ----------
function renderSettings() {
  const st = store.getState();
  const vib = vibrationSupported();
  $screen.innerHTML = `
    <header class="page-head"><h1 class="page-title">Настройки</h1></header>

    <section class="card">
      <div class="card-label">Сигналы</div>
      <label class="switch-row">
        <span>Звук</span>
        <input type="checkbox" class="switch" data-setting="sound" ${st.settings.sound ? 'checked' : ''}>
      </label>
      <label class="switch-row">
        <span>Вибрация${vib ? '' : '<br><small class="muted">не поддерживается этим браузером (например, на iPhone)</small>'}</span>
        <input type="checkbox" class="switch" data-setting="vibration" ${st.settings.vibration ? 'checked' : ''}>
      </label>
      <button class="btn btn-secondary" data-action="test-signal">Проверить сигнал</button>
      <p class="muted small">На iPhone звук не слышен, если включён беззвучный режим.
      ${wakeLockSupported() ? '' : '<br>Этот браузер не умеет блокировать затухание экрана — увеличьте время автоблокировки на время тренировки.'}</p>
    </section>

    <section class="card">
      <div class="card-label">Ротация</div>
      <p>Следующая тренировка: <b>${st.rotationIndex + 1}. ${esc(EXERCISES[st.rotationIndex].name)}</b></p>
      <label class="field">
        <span class="small muted">Начать ротацию с упражнения</span>
        <select id="rot-select">
          ${EXERCISES.map((e, i) => `<option value="${i}" ${i === st.rotationIndex ? 'selected' : ''}>${i + 1}. ${esc(e.name)}</option>`).join('')}
        </select>
      </label>
      <button class="btn btn-secondary" data-action="set-rotation">Сбросить ротацию</button>
    </section>

    <section class="card">
      <div class="card-label">Резервная копия</div>
      <p class="muted small">Все данные хранятся только на этом устройстве. Тренировок: ${st.workouts.length}.</p>
      <button class="btn btn-secondary" data-action="export">Экспорт в JSON</button>
      <button class="btn btn-secondary" data-action="import">Импорт из JSON</button>
      <input type="file" id="import-file" accept="application/json,.json" hidden>
    </section>

    <p class="muted small center">EMOM-тренировки · версия ${APP_VERSION}</p>`;

  $screen.querySelectorAll('[data-setting]').forEach((inp) => inp.addEventListener('change', () => {
    if (!store.setSetting(inp.dataset.setting, inp.checked)) inp.checked = !inp.checked;
  }));
  document.getElementById('import-file').addEventListener('change', onImportFile);
}

actions['test-signal'] = () => fb.test();
actions['set-rotation'] = () => {
  const i = Number(document.getElementById('rot-select').value);
  if (!confirm(`Следующей тренировкой будет «${EXERCISES[i].name}». Продолжить?`)) return;
  if (store.setRotation(i)) {
    ui.overrideIdx = null;
    ui.plan = null;
    toast('Ротация сброшена');
    renderSettings();
  }
};
actions.export = async () => {
  const json = store.exportData();
  const name = `emom-backup-${toISODate(new Date().toISOString())}.json`;
  const file = new File([json], name, { type: 'application/json' });
  // На iOS в режиме PWA скачивание ненадёжно — используем «Поделиться» (можно сохранить в «Файлы»).
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (ios && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  const url = URL.createObjectURL(file);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('Файл резервной копии сохранён');
};
actions.import = () => document.getElementById('import-file').click();

async function onImportFile(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const text = await file.text();
    if (!confirm('Импорт заменит все текущие данные на данные из файла. Продолжить?')) return;
    const n = store.importData(text);
    ui.plan = null;
    ui.overrideIdx = null;
    toast(`Импортировано тренировок: ${n}`);
    renderSettings();
  } catch (err) {
    toast('Ошибка импорта: ' + err.message, 'error');
  }
}

// ---------- общие обработчики ----------
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const fn = actions[el.dataset.action];
  if (fn) {
    e.preventDefault();
    fn(el, e);
  }
});

// Закрытие диалога по тапу на фон.
document.addEventListener('click', (e) => {
  if (e.target instanceof HTMLDialogElement) e.target.close();
});

// После возврата в приложение сразу пересчитываем таймер по Date.now().
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && ui.session?.stage === 'timer') tick();
});

// ---------- запуск ----------
function restoreSession() {
  const s = store.loadActive();
  if (!s || !exerciseById(s.exerciseId) || !Array.isArray(s.reps)) {
    store.saveActive(null);
    return;
  }
  ui.session = s;
}

restoreSession();
if (ui.session?.stage === 'timer') beginTimer(); else route();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('Service worker не зарегистрирован', e));
  });
}
