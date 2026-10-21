// Лёгкий SVG-график «итого повторений за тренировку» без внешних библиотек.
const PAD = { top: 16, right: 14, bottom: 24, left: 34 };
const HEIGHT = 170;
const fmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' });

function niceMax(v) {
  if (v <= 5) return 5;
  const pow = 10 ** Math.floor(Math.log10(v));
  const step = [1, 2, 2.5, 5, 10].find((s) => s * pow * 4 >= v) * pow;
  return Math.ceil(v / step) * step;
}

/**
 * points: [{ t: ms, y: number, label: string }] в хронологическом порядке.
 * Возвращает SVG-разметку; интерактивность подключается attachChart().
 */
export function chartSvg(points, width) {
  const w = Math.max(220, width);
  const iw = w - PAD.left - PAD.right;
  const ih = HEIGHT - PAD.top - PAD.bottom;
  const maxY = niceMax(Math.max(...points.map((p) => p.y)));
  const t0 = points[0].t;
  const t1 = points[points.length - 1].t;
  const span = t1 - t0 || 1;
  const x = (t) => (points.length === 1 ? PAD.left + iw / 2 : PAD.left + ((t - t0) / span) * iw);
  const y = (v) => PAD.top + ih - (v / maxY) * ih;

  const grid = [0, 0.5, 1].map((f) => {
    const gy = y(maxY * f);
    return `<line class="grid" x1="${PAD.left}" x2="${w - PAD.right}" y1="${gy}" y2="${gy}"/>`
      + `<text class="axis" x="${PAD.left - 6}" y="${gy + 4}" text-anchor="end">${Math.round(maxY * f)}</text>`;
  }).join('');

  const xs = points.length === 1 ? [points[0]] : [points[0], points[points.length - 1]];
  const xLabels = xs.map((p, i) => {
    const anchor = points.length === 1 ? 'middle' : i === 0 ? 'start' : 'end';
    return `<text class="axis" x="${x(p.t)}" y="${HEIGHT - 6}" text-anchor="${anchor}">${fmt.format(p.t)}</text>`;
  }).join('');

  const coords = points.map((p) => [x(p.t), y(p.y)]);
  const path = coords.map(([cx, cy], i) => `${i ? 'L' : 'M'}${cx.toFixed(1)},${cy.toFixed(1)}`).join('');
  const dots = coords.map(([cx, cy]) => `<circle class="dot" cx="${cx}" cy="${cy}" r="4"/>`).join('');
  const data = JSON.stringify(points.map((p, i) => ({ x: coords[i][0], y: coords[i][1], label: p.label })));

  return `<svg class="chart" viewBox="0 0 ${w} ${HEIGHT}" width="${w}" height="${HEIGHT}" role="img" data-points='${data.replace(/'/g, '&#39;')}'>
    ${grid}${xLabels}
    <path class="line" d="${path}"/>
    ${dots}
    <line class="cross" y1="${PAD.top}" y2="${PAD.top + ih}" visibility="hidden"/>
    <circle class="focus" r="6" visibility="hidden"/>
  </svg>`;
}

/** Ближайшая по X точка показывается при касании/наведении. */
export function attachChart(wrap) {
  const svg = wrap.querySelector('svg.chart');
  const tip = wrap.querySelector('.chart-tip');
  if (!svg || !tip) return;
  const pts = JSON.parse(svg.dataset.points);
  const cross = svg.querySelector('.cross');
  const focus = svg.querySelector('.focus');

  const show = (ev) => {
    const rect = svg.getBoundingClientRect();
    const scale = svg.viewBox.baseVal.width / rect.width;
    const px = (ev.clientX - rect.left) * scale;
    const p = pts.reduce((best, q) => (Math.abs(q.x - px) < Math.abs(best.x - px) ? q : best));
    cross.setAttribute('x1', p.x); cross.setAttribute('x2', p.x);
    focus.setAttribute('cx', p.x); focus.setAttribute('cy', p.y);
    cross.setAttribute('visibility', 'visible');
    focus.setAttribute('visibility', 'visible');
    tip.textContent = p.label;
    tip.hidden = false;
    const left = Math.min(Math.max(p.x / scale, 70), rect.width - 70);
    tip.style.left = `${left}px`;
  };
  svg.addEventListener('pointerdown', show);
  svg.addEventListener('pointermove', show);
  // На тач-экранах pointerleave приходит сразу после касания — там подсказку скрывает касание вне графика.
  svg.addEventListener('pointerleave', (ev) => { if (ev.pointerType === 'mouse') hideTip(wrap); });
}

function hideTip(wrap) {
  wrap.querySelectorAll('.cross, .focus').forEach((el) => el.setAttribute('visibility', 'hidden'));
  wrap.querySelector('.chart-tip').hidden = true;
}

document.addEventListener('pointerdown', (ev) => {
  document.querySelectorAll('.chart-wrap').forEach((wrap) => { if (!wrap.contains(ev.target)) hideTip(wrap); });
});
