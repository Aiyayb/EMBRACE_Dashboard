'use strict';
// EMBRACE Dashboard front end. No build step, no libraries. Vocabulary: GLOSSARY.md.
// Every figure comes from the API; nothing is added up here except display subtotals of lists.

// ---------------------------------------------------------------- helpers
const $ = (sel, root = document) => root.querySelector(sel);

function h(tag, attrs, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    node.append(kid.nodeType ? kid : String(kid));
  }
  return node;
}

function svg(tag, attrs, ...kids) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v != null) node.setAttribute(k, v);
  node.append(...kids);
  return node;
}

async function api(method, path, body, retried) {
  const res = await fetch(path, {
    method,
    headers: body ? {'Content-Type': 'application/json'} : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  // The page's own session key is new each time the server starts, so a page left open across a restart is no longer
  // recognised: fetch the page again (which hands out the new key) and retry the write once.
  if (res.status === 401 && method !== 'GET' && !retried) {
    await fetch('/', {cache: 'no-store'});
    return api(method, path, body, true);
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const shortBaht = (v) => {   // ฿1.00M, ฿873K
  if (v == null) return '—';
  const a = Math.abs(v), sign = v < 0 ? '−' : '';
  return a >= 1e6 ? `${sign}฿${(a / 1e6).toFixed(2)}M` : a >= 1e3 ? `${sign}฿${Math.round(a / 1e3)}K` : `${sign}฿${Math.round(a)}`;
};
const baht = (v) => (v == null ? '—' : (v < 0 ? '−฿' : '฿') + Math.abs(v).toLocaleString('en', {maximumFractionDigits: 0}));
const number = (v, digits = 2) => (v == null ? '—' : Number(v).toLocaleString('en', {maximumFractionDigits: digits}));
const pct = (v) => (v == null ? '—' : (Math.abs(v) * 100).toFixed(1) + '%');
const signedPct = (v) => (v == null ? '—' : (v > 0 ? '+' : v < 0 ? '−' : '') + (Math.abs(v) * 100).toFixed(1) + '%');
const monthLabel = (m) => (m ? `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}` : '—');
const today = () => new Date().toLocaleDateString('en-CA');
const signClass = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : '');

function toast(message, undo) {
  const box = $('#toast');
  box.replaceChildren(h('span', null, message));
  if (undo) box.append(h('button', {type: 'button', onclick: () => { box.hidden = true; undo(); }}, 'Undo'));
  box.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { box.hidden = true; }, undo ? 9000 : 4000);
}

// ---------------------------------------------------------------- number fields with thousands separators
// A text field that shows 1,234,567.5 while you type. Read it back with numberOf(); '' and a lone '-' mean no number.
const groupDigits = (v) => Number(v).toLocaleString('en', {maximumFractionDigits: 8});

function numberOf(input) {
  const s = input.value.replace(/,/g, '').trim();
  if (s === '' || s === '-') return null;
  const n = Number(s);
  return Number.isNaN(n) ? null : n;
}

function numberInput(value, attrs) {
  const input = h('input', {type: 'text', inputmode: 'decimal', autocomplete: 'off', ...attrs});
  input.value = value == null || value === '' ? '' : groupDigits(value);
  input.addEventListener('input', () => {
    const caret = input.selectionStart;
    const significant = (input.value.slice(0, caret).match(/[0-9.]/g) || []).length;     // digits and the point before the caret
    let raw = input.value.replace(/[^0-9.\-]/g, '');
    const negative = raw.startsWith('-');
    const [whole, ...rest] = raw.replace(/-/g, '').split('.');
    const grouped = whole.replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    const out = (negative ? '-' : '') + grouped + (rest.length ? '.' + rest.join('') : '');
    input.value = out;
    let i = 0;
    for (let seen = 0; i < out.length && seen < significant; i++) if (/[0-9.]/.test(out[i])) seen++;
    input.setSelectionRange(i, i);
  });
  return input;
}

// ---------------------------------------------------------------- form dialog
// fields: [{key, label, type: text|number|date|select|textarea|check, options: [[value, label]], required, hint}]
function openForm({title, fields, values = {}, submit}) {
  const dialog = $('#dialog');
  const error = h('div', {class: 'form-error'});
  const inputs = {};
  const rows = fields.map((f) => {
    let input;
    const value = values[f.key];
    if (f.type === 'select') {
      input = h('select', null, f.options.map(([v, label]) => h('option', {value: v == null ? '' : v}, label)));
      input.value = value == null ? '' : value;
    } else if (f.type === 'textarea') {
      input = h('textarea');
      input.value = value == null ? '' : value;
    } else if (f.type === 'check') {
      input = h('input', {type: 'checkbox'});
      input.checked = Boolean(value);
    } else if (f.type === 'number') {
      input = numberInput(value, {placeholder: f.placeholder});
    } else {
      input = h('input', {type: f.type === 'date' ? 'date' : 'text', placeholder: f.placeholder});
      input.value = value == null ? '' : value;
    }
    if (f.required) input.required = true;
    inputs[f.key] = input;
    if (f.type === 'check') return h('label', {class: 'field check'}, input, f.label);
    return h('label', {class: 'field'}, f.hint ? `${f.label} — ${f.hint}` : f.label, input);
  });
  const form = h('form', {class: 'form', method: 'dialog'}, h('h2', null, title), rows, error,
    h('div', {class: 'form-buttons'},
      h('button', {type: 'button', class: 'btn', onclick: () => dialog.close()}, 'Cancel'),
      h('button', {type: 'submit', class: 'btn dark'}, 'Save')));
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const body = {};
    for (const f of fields) {
      const input = inputs[f.key];
      if (f.type === 'check') body[f.key] = input.checked ? 1 : 0;
      else if (f.type === 'number') body[f.key] = numberOf(input);
      else body[f.key] = input.value === '' ? null : input.value;
    }
    try {
      await submit(body);
      dialog.close();
    } catch (e) {
      error.textContent = e.message;
    }
  });
  dialog.replaceChildren(form);
  dialog.showModal();
}

// a small read-only popup (used for notes)
function openMessage(title, message) {
  const dialog = $('#dialog');
  dialog.replaceChildren(h('form', {class: 'form', method: 'dialog'}, h('h2', null, title), h('p', {class: 'advice-body'}, message),
    h('div', {class: 'form-buttons'}, h('button', {type: 'submit', class: 'btn dark'}, 'Close'))));
  dialog.showModal();
}
$('#dialog').addEventListener('close', () => { $('#dialog').style.width = ''; });   // a wide editor resets it

// every date on screen shows the month as a short English name: 2026-09-26 -> "Sep 26" (month) or "26 Sep 2026" (day)
const yymm = (iso) => (iso ? `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(2, 4)}` : '');
const mmyy = yymm;
const fmtDay = (iso, shortYear) => (iso ? `${iso.slice(8, 10)} ${MONTHS[Number(iso.slice(5, 7)) - 1]} ${shortYear ? iso.slice(2, 4) : iso.slice(0, 4)}` : '');

function noteIcon(note, title) {
  if (!note) return '';
  return h('button', {type: 'button', class: 'note-btn', title: 'Show note', 'aria-label': 'Show note', onclick: () => openMessage(title || 'Note', note)},
    svg('svg', {viewBox: '0 0 24 24', class: 'ico', 'aria-hidden': 'true'}, svg('path', {d: 'M5 5h14v10H9l-4 4z'})));
}

// ---------------------------------------------------------------- editable list
// cfg: {title, resource, query, columns, filter(row), defaults(), onChange(), note, addLabel, canDelete}
// column: {key, label, type, options, show(row), table: false, form: false, cls, required, hint}
function crud(cfg) {
  const body = h('tbody');
  const shown = cfg.columns.filter((c) => c.table !== false);
  const editable = cfg.columns.filter((c) => c.form !== false);
  const card = h('article', {class: 'card'},
    h('div', {class: 'card-head'}, h('h2', {class: cfg.caps ? 'caps' : 'card-title'}, cfg.title),
      h('button', {type: 'button', class: 'btn small', onclick: () => edit(null)}, cfg.addLabel || '+ Add')),
    cfg.note ? h('p', {class: 'note'}, cfg.note) : null,
    h('div', {class: 'table-wrap'}, h('table', null,
      h('thead', null, h('tr', null, shown.map((c) => h('th', {class: c.cls}, c.label)), h('th'))), body)));

  const display = (c, row) => {
    if (c.show) return c.show(row);
    const v = row[c.key];
    if (v == null || v === '') return '';
    if (c.type === 'select') return (c.options.find(([value]) => String(value) === String(v)) || [null, v])[1];
    if (c.type === 'date') return fmtDay(v);
    if (c.type === 'money') return baht(v);
    if (c.type === 'number') return number(v);
    if (c.type === 'check') return v ? 'Yes' : 'No';
    return v;
  };

  async function refresh() {
    let rows;
    try {
      rows = await api('GET', `/api/${cfg.resource}${cfg.query || ''}`);
    } catch (e) {
      body.replaceChildren(h('tr', null, h('td', {class: 'empty', colspan: shown.length + 1}, e.message)));
      return;
    }
    if (cfg.filter) rows = rows.filter(cfg.filter);
    body.replaceChildren(...rows.map((row) => h('tr', null,
      shown.map((c) => h('td', {class: c.cls}, display(c, row))),
      h('td', {class: 'actions'},
        h('button', {type: 'button', class: 'btn small', onclick: () => edit(row)}, 'Edit'),
        cfg.canDelete === false ? null : h('button', {type: 'button', class: 'btn small danger', onclick: () => remove(row)}, 'Delete')))));
    if (!rows.length) body.append(h('tr', null, h('td', {class: 'empty', colspan: shown.length + 1}, 'Nothing here yet.')));
  }

  const changed = () => (cfg.onChange ? cfg.onChange() : refresh());

  function edit(row) {
    if (cfg.editor) { cfg.editor(row, changed); return; }
    openForm({
      title: `${row ? 'Edit' : 'Add'} — ${cfg.title}`,
      fields: editable.map((c) => ({...c, type: c.type === 'money' ? 'number' : c.type})),
      values: row || (cfg.defaults ? cfg.defaults() : {}),
      submit: async (values) => {
        await api(row ? 'PUT' : 'POST', `/api/${cfg.resource}${row ? '/' + row.id : ''}`, values);
        toast(row ? 'Saved.' : 'Added.');
        changed();
      },
    });
  }

  async function remove(row) {
    try {
      const out = await api('DELETE', `/api/${cfg.resource}/${row.id}`);
      toast('Deleted.', async () => { await api('POST', `/api/audit/${out.audit_id}/undo`); changed(); });
      changed();
    } catch (e) {
      toast(e.message);
    }
  }

  refresh();
  return card;
}

// ---------------------------------------------------------------- charts
function niceTicks(lo, hi, count = 5) {
  if (lo === hi) { lo -= 1; hi += 1; }
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const ticks = [];
  // count in whole steps so zero comes out as exactly 0, not a rounding remainder
  for (let n = Math.floor(lo / step); n * step <= hi + step * 0.5; n++) ticks.push(Number((n * step).toPrecision(12)));
  return ticks;
}

// rows: [{month, ...}], series: [{key, name, color, dash, width}], opts: {format, fromZero}
function lineChart(host, rows, series, opts = {}) {
  const format = opts.format || signedPct;
  host.replaceChildren();
  const values = rows.flatMap((r) => series.map((s) => r[s.key])).filter((v) => v != null);
  if (rows.length < 2 || !values.length) { host.append(h('div', {class: 'empty'}, 'Not enough months to draw yet.')); return; }
  const W = Math.max(280, host.clientWidth), H = 280;
  const ticks = niceTicks(opts.fromZero === false ? Math.min(...values) : Math.min(0, ...values),
    opts.fromZero === false ? Math.max(...values) : Math.max(0, ...values));
  const lo = ticks[0], hi = ticks[ticks.length - 1];
  const axis = opts.axisFormat || format;
  const m = {top: 14, right: 16, bottom: 28, left: Math.max(...ticks.map((t) => axis(t).length)) * 6.6 + 14};
  const x = (i) => m.left + (i * (W - m.left - m.right)) / (rows.length - 1);
  const y = (v) => H - m.bottom - ((v - lo) / (hi - lo)) * (H - m.top - m.bottom);
  const root = svg('svg', {viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': series.map((s) => s.name).join(' and ') + ' by month'});
  for (const t of ticks) {
    root.append(svg('line', {x1: m.left, x2: W - m.right, y1: y(t), y2: y(t), stroke: 'var(--grid)', 'stroke-width': 1}));
    const label = svg('text', {class: 'tick', x: m.left - 10, y: y(t), dy: '0.32em', 'text-anchor': 'end'});
    label.textContent = axis(t);
    root.append(label);
  }
  const every = Math.max(1, Math.ceil(rows.length / Math.max(2, Math.floor((W - m.left - m.right) / 56))));
  rows.forEach((r, i) => {
    const text = opts.xLabel ? opts.xLabel(r) : (i % every ? null : MONTHS[Number(r.month.slice(5, 7)) - 1]);
    if (!text) return;
    const label = svg('text', {class: 'tick', x: x(i), y: H - 8, 'text-anchor': opts.xLabel ? 'start' : 'middle'});
    label.textContent = text;
    root.append(label);
  });
  const lead0 = series[0];
  const lp = rows.map((r, i) => (r[lead0.key] == null ? null : [x(i), y(r[lead0.key])])).filter(Boolean);
  if (lp.length > 1) {
    const gid = `area-${Math.random().toString(36).slice(2, 8)}`;
    const grad = svg('linearGradient', {id: gid, x1: 0, y1: 0, x2: 0, y2: 1});
    [[0, .22], [.5, .08], [1, 0]].forEach(([o, a]) => grad.append(svg('stop', {offset: o, 'stop-color': lead0.color, 'stop-opacity': a})));
    const base = y(Math.max(lo, 0));
    root.append(svg('defs', null, grad), svg('path', {d: `M ${lp[0][0]} ${base} ` + lp.map((q) => `L ${q[0]} ${q[1]}`).join(' ') + ` L ${lp[lp.length - 1][0]} ${base} Z`, fill: `url(#${gid})`}));
  }
  [...series].reverse().forEach((s) => {
    const points = rows.map((r, i) => (r[s.key] == null ? null : `${x(i)},${y(r[s.key])}`)).filter(Boolean);
    if (points.length > 1) {
      root.append(svg('polyline', {points: points.join(' '), fill: 'none', stroke: s.color, 'stroke-width': s.width || 2,
        'stroke-dasharray': s.dash, 'stroke-linejoin': 'round', 'stroke-linecap': s.dash ? 'butt' : 'round'}));
    }
  });
  const lead = series[0];
  const rule = svg('line', {y2: H - m.bottom, stroke: lead.color, 'stroke-width': 1, visibility: 'hidden'});
  const halo = svg('circle', {r: 9, fill: lead.color, 'fill-opacity': 0.18, visibility: 'hidden'});
  const ring = svg('circle', {r: 5, fill: 'var(--card)', stroke: lead.color, 'stroke-width': 2, visibility: 'hidden'});
  root.append(rule, halo, ring);
  const tip = h('div', {class: 'tip light'});
  root.addEventListener('pointermove', (event) => {
    const box = host.getBoundingClientRect();
    const px = ((event.clientX - box.left) / box.width) * W;
    let i = Math.round(((px - m.left) / (W - m.left - m.right)) * (rows.length - 1));
    i = Math.min(rows.length - 1, Math.max(0, i));
    const r = rows[i];
    const cy = r[lead.key] == null ? H - m.bottom : y(r[lead.key]);
    rule.setAttribute('x1', x(i)); rule.setAttribute('x2', x(i)); rule.setAttribute('y1', cy);
    for (const n of [halo, ring]) { n.setAttribute('cx', x(i)); n.setAttribute('cy', cy); }
    for (const n of [rule, halo, ring]) n.setAttribute('visibility', 'visible');
    tip.replaceChildren(h('div', {class: 'tip-head'}, monthLabel(r.month)),
      ...series.map((s) => h('div', {class: 'tip-line'},
        h('span', {class: 'tip-name'}, h('i', {class: 'tip-dot', style: `background: ${s.color}`}), s.name), h('b', null, r[s.key] == null ? '—' : format(r[s.key])))),
      ...(opts.extra ? opts.extra(r).filter(Boolean).map(([label, text]) => h('div', {class: 'tip-line tip-extra'}, h('span', null, label), h('b', null, text))) : []),
      ...(opts.tipNote && opts.tipNote(r) ? [h('div', {class: 'tip-head'}, opts.tipNote(r))] : []));
    tip.style.display = 'block';
    // beside the cursor line, never on it: to the right unless there is no room, and at the top of the plot when the point is
    // low (or the bottom when it is high), so the line being read stays visible
    const scale = box.width / W, tipW = tip.offsetWidth, tipH = tip.offsetHeight, gap = 14;
    const px0 = x(i) * scale;
    const left = px0 + gap + tipW <= box.width ? px0 + gap : px0 - gap - tipW;
    const high = cy < (m.top + H - m.bottom) / 2;
    tip.style.left = `${Math.max(0, left)}px`;
    tip.style.top = `${high ? (H - m.bottom) * scale - tipH - 6 : m.top * scale + 6}px`;
  });
  root.addEventListener('pointerleave', () => {
    for (const n of [rule, halo, ring]) n.setAttribute('visibility', 'hidden');
    tip.style.display = 'none';
  });
  host.append(root, tip);
}

// parts: [{label, value, color}]
// center: {pct, total} shown in the hole (month-on-month change, and the total in short form)
function donut(host, parts, center) {
  const size = 170, R = size / 2 - 9, r = R * 0.62, c = size / 2;   // leaves room for a hovered slice to grow (x1.07) inside the box
  const total = parts.reduce((sum, p) => sum + Math.max(0, p.value), 0);
  const root = svg('svg', {viewBox: `0 0 ${size} ${size}`, role: 'img', 'aria-label': 'Share of Total Portfolio Value by allocation group'});
  const tip = h('div', {class: 'tip'});
  const point = (radius, angle) => `${c + radius * Math.sin(angle)} ${c - radius * Math.cos(angle)}`;
  let start = 0;
  const slices = [];
  for (const p of parts) {
    if (!total || p.value <= 0) continue;
    const sweep = Math.min((p.value / total) * Math.PI * 2, Math.PI * 2 - 0.001);
    const a0 = start + 0.012, a1 = Math.max(a0, start + sweep - 0.012), large = a1 - a0 > Math.PI ? 1 : 0;
    const path = svg('path', {fill: p.color, d: `M ${point(R, a0)} A ${R} ${R} 0 ${large} 1 ${point(R, a1)} L ${point(r, a1)} A ${r} ${r} 0 ${large} 0 ${point(r, a0)} Z`});
    path.addEventListener('pointermove', (event) => {
      const box = host.getBoundingClientRect();
      tip.replaceChildren(h('div', {class: 'tip-head'}, p.label), h('div', null, `${baht(p.value)} · ${pct(p.value / total)}`));
      tip.style.display = 'block';
      tip.style.left = `${Math.min(Math.max(0, event.clientX - box.left + 12), Math.max(0, box.width - tip.offsetWidth))}px`;
      tip.style.top = `${Math.max(0, event.clientY - box.top - 40)}px`;
    });
    path.addEventListener('pointerleave', () => { tip.style.display = 'none'; root.append(...slices); });   // back to the original order
    path.addEventListener('pointerenter', () => { if (root.lastChild !== path) root.append(path); });   // lift it above its neighbours
    if (p.page) {
      path.setAttribute('class', 'slice');
      path.setAttribute('role', 'link');
      path.setAttribute('tabindex', '0');
      path.setAttribute('aria-label', `${p.label}: ${pct(p.value / total)}. Open ${p.label}`);
      path.addEventListener('click', () => go(p.page));
      path.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); go(p.page); } });
    }
    root.append(path);
    slices.push(path);
    start += sweep;
  }
  host.replaceChildren(root, center ? h('div', {class: 'donut-center'},
    center.pct === undefined ? null : h('span', {class: `donut-pct ${center.pct == null ? '' : signClass(center.pct)}`}, center.pct == null ? '—' : signedPct(center.pct)),
    h('span', {class: center.pct === undefined ? 'donut-pct' : 'donut-total'}, shortBaht(center.total))) : null, tip);
}

// ---------------------------------------------------------------- shared pieces
// label, colour, page it opens. Saving and EMC are both Wealth Cards.
const GROUPS = {investment: ['Investment', 'var(--mint)', 'investment'], trading: ['Trading', 'var(--ink)', 'trading'],
  saving: ['Saving', 'var(--tan-light)', 'wealth'], emc: ['EMC', 'var(--tan)', 'wealth']};

function tile(label, value, delta, valueSign, sub) {
  return h('article', {class: 'card'},
    h('div', {class: 'tile-label'}, label),
    h('div', {class: `tile-value ${valueSign == null ? '' : signClass(valueSign)}`}, value),
    delta === undefined ? (sub ? h('div', {class: 'tile-sub'}, sub) : null)
      : h('div', {class: 'tile-sub'}, h('span', {class: `delta ${signClass(delta)}`}, signedPct(delta)), h('span', null, sub || 'MoM')));
}

// Performance Vs Benchmarks: growth in value (deposits counted) against SET. Two views: this year from the previous
// December's close, and since 2023. Used by Home (Total Portfolio) and Investment. The caller draws it once it is in the page.
function performanceCard({year, rowsYear, rowsAll, nameYear, nameAll, legend, bench = 'SET', title = 'Performance Vs Benchmarks', valueFmt = baht}) {
  const key = bench.toLowerCase();
  const modes = {return: {tab: `Since Jan ${year}`, rows: rowsYear, name: nameYear, gap: true}};
  if (rowsAll && rowsAll.length) modes.growth = {tab: 'Since 2023', rows: rowsAll, name: nameAll, gap: false};
  const tabs = h('div', {class: 'tabs', role: 'tablist'});
  const body = h('div', {class: 'stack'});
  const draw = (mode) => {
    const m = modes[mode], rows = m.rows || [];
    const last = rows[rows.length - 1] || {};
    const hasSet = rows.some((r) => r[key] != null);
    const gap = m.gap && hasSet && last[key] != null && last.portfolio != null ? last.portfolio - last[key] : null;
    const series = [{key: 'portfolio', name: m.name, color: 'var(--up)'}];
    if (hasSet) series.push({key, name: bench, color: 'var(--bench)', dash: '4 4', width: 1.5});
    const chart = h('div', {class: 'chart'});
    tabs.replaceChildren(...(Object.keys(modes).length < 2 ? [] : Object.entries(modes)).map(([id, x]) =>
      h('button', {type: 'button', role: 'tab', 'aria-selected': String(id === mode), onclick: () => draw(id)}, x.tab)));
    body.replaceChildren(...[
      h('div', {class: 'legend-row'},
        h('span', null, h('span', {class: 'dot', style: 'background: var(--up)'}), `${legend} `, h('b', {class: m.gap ? signClass(last.portfolio) : ''}, signedPct(last.portfolio))),
        hasSet ? h('span', null, h('span', {class: 'dot', style: 'background: var(--bench)'}), `${bench} `, h('b', {class: signClass(last[key])}, signedPct(last[key]))) : null,
        gap == null ? null : h('span', null, `vs ${bench} `, h('b', {class: signClass(gap)}, signedPct(gap)))),
      hasSet ? null : h('p', {class: 'note warn'}, `No ${bench} prices recorded for this period, so no comparison line.`),
      chart].filter(Boolean));
    lineChart(chart, rows, series, {
      xLabel: rows.length > 14 ? (r) => (r.month.endsWith('-01') ? r.month.slice(0, 4) : null) : null,
      extra: (r) => [r.total == null ? null : [`${legend} value`, valueFmt(r.total)], r[`${key}_level`] == null ? null : [`${bench} price`, number(r[`${key}_level`])]],
      tipNote: (r) => ((r.stale || []).length ? `Carried forward: ${r.stale.join(', ')}` : null)});
  };
  const card = h('article', {class: 'card'}, h('div', {class: 'card-head'}, h('h2', {class: 'card-title'}, title), tabs), body);
  return {card, draw};
}

// Monthly Return, YTD and CAGR of a Bucket: change in value with deposits counted (see metrics.bucket_stats)
const usdt = (v) => (v == null ? '—' : (v < 0 ? '−' : '') + Math.abs(v).toLocaleString('en', {minimumFractionDigits: 2, maximumFractionDigits: 2}));

function bucketStatTiles(st, {fmt = baht, cagrNote = 'deposits counted'} = {}) {
  if (!st) return [];
  const abbr = (short, full) => h('span', null, short, h('span', {class: 'tile-abbr'}, full));
  const dec = `Dec ${Number(st.month.slice(0, 4)) - 1}`;
  return [
    tile('Monthly Return', fmt(st.monthly_amount), st.monthly_pct, st.monthly_amount),
    tile(abbr('YTD', 'Year to date'), fmt(st.ytd_amount), st.ytd_pct, st.ytd_amount, `since ${dec} close`),
    tile(abbr('CAGR', 'Compound annual growth rate'), st.cagr == null ? '—' : signedPct(st.cagr), undefined, st.cagr,
      st.cagr == null ? (st.cagr_months === undefined ? `needs 12 months of history (since ${monthLabel(st.cagr_since)})` : `needs 3 months of trades (since ${monthLabel(st.cagr_since)})`)
        : st.cagr_months != null && st.cagr_months < 12 ? `since ${monthLabel(st.cagr_since)} · annualised from ${st.cagr_months} months, not a full year`
        : `since ${monthLabel(st.cagr_since)} · ${cagrNote}`)];
}

function pageHead(title, note) {
  return h('div', {class: 'page-head'}, h('h2', {class: 'page-title'}, title), note ? h('p', {class: 'note'}, note) : null);
}

function setChips(k) {
  const chips = $('#chips');
  chips.replaceChildren();
  if (k) statusMonth = monthLabel(k.month);
  $('#sub').textContent = k ? `Here is how everything stood at the end of ${monthLabel(k.month)}.` : '';
  if (!k) return;
  chips.append(h('span', {class: 'chip line'}, monthLabel(k.month)));
  if (!k.flows_known) chips.append(h('span', {class: 'chip warn'}, 'Flows unknown this month'));
  if (k.stale.length) chips.append(h('span', {class: 'chip warn', title: 'These Accounts have no value recorded for this month; the last one is carried forward.'}, `Carried forward: ${k.stale.join(', ')}`));
}

const accountOptions = (accounts) => accounts.map((a) => [a.id, `${a.name} (${a.currency})`]);

// ---------------------------------------------------------------- Investment Portfolio editor
// One Snapshot per Account and date, entered as a table of holdings (Market, Stock, Qty, Value in THB). The Snapshot's
// value is the sum of the Values; the server does the adding.
const MARKETS = ['SET', 'US', 'HK', 'JP', 'KR', 'CN', 'CASH', 'OTHER'];
const marketLabel = (m) => (m === 'CASH' ? 'Cash' : m === 'OTHER' ? 'Other' : m || '—');
const MARKET_COLORS = {SET: 'var(--mint)', US: 'var(--ink)', HK: 'var(--tan)', JP: 'var(--tan-light)', KR: 'var(--grey)', CN: '#c98a72',
  CASH: '#b8c7d6', OTHER: '#d9d9d4', '': '#e6e6e1'};

async function portfolioEditor(accounts, row, done) {
  const dialog = $('#dialog');
  dialog.style.width = 'min(700px, calc(100vw - 32px))';
  const error = h('div', {class: 'form-error'});
  const account = h('select', null, accounts.map((a) => h('option', {value: a.id}, a.name)));
  account.value = row ? row.account_id : accounts[0].id;
  const date = h('input', {type: 'date', required: true});
  date.value = row ? row.as_of : today();
  const note = h('input', {type: 'text', placeholder: 'Note (optional)'});
  note.value = row && row.note ? row.note : '';

  let seed = [];
  if (row && row.holdings) seed = JSON.parse(row.holdings);
  else if (row) seed = [{market: '', stock: '', qty: null, value_thb: row.value_thb}];     // an older month with only a total
  else {
    // a new month starts from the last one's holdings, with the values left blank to be filled in
    try {
      const prev = (await api('GET', `/api/snapshots?account_id=${account.value}`)).find((r) => r.holdings);
      if (prev) seed = JSON.parse(prev.holdings).map(({market, stock, qty}) => ({market, stock, qty, value_thb: null}));
    } catch (e) { /* start empty */ }
  }
  if (!seed.length) seed = [{market: 'SET', stock: '', qty: null, value_thb: null}];

  const body = h('tbody');
  const total = h('b', null, '฿0');
  const rowsData = [];
  const recount = () => {
    total.textContent = baht(rowsData.reduce((t, r) => t + (numberOf(r.value) || 0), 0));
  };
  const addRow = (hd) => {
    const market = h('select', {'aria-label': 'Market'}, [...new Set(['', ...MARKETS, hd.market])].map((m) => h('option', {value: m}, marketLabel(m))));
    market.value = hd.market == null ? 'SET' : hd.market;
    const stock = h('input', {type: 'text', 'aria-label': 'Stock', placeholder: 'e.g. VOO'});
    stock.value = hd.stock || '';
    const qty = numberInput(hd.qty, {class: 'num', 'aria-label': 'Qty'});
    const value = numberInput(hd.value_thb, {class: 'num', 'aria-label': 'Value in THB'});
    value.addEventListener('input', recount);
    const tr = h('tr', null, h('td', null, market), h('td', null, stock), h('td', null, qty), h('td', null, value),
      h('td', null, h('button', {type: 'button', class: 'x', title: 'Remove row', 'aria-label': 'Remove row', onclick: () => {
        tr.remove(); rowsData.splice(rowsData.indexOf(entry), 1); recount();
      }}, '×')));
    const entry = {market, stock, qty, value};
    rowsData.push(entry);
    body.append(tr);
    recount();
  };
  seed.forEach(addRow);

  const form = h('form', {class: 'form', method: 'dialog'}, h('h2', null, `${row ? 'Edit' : 'Add'} — Investment Portfolio`),
    h('label', {class: 'field'}, 'Account', account),
    h('label', {class: 'field'}, 'Date', date),
    h('div', {class: 'field'}, 'Holdings (values in THB)',
      h('table', {class: 'hold'}, h('thead', null, h('tr', null, h('th', null, 'Market'), h('th', null, 'Stock'), h('th', {class: 'num'}, 'Qty'), h('th', {class: 'num'}, 'Value'), h('th'))), body)),
    h('div', {class: 'hold-total'}, h('button', {type: 'button', class: 'btn small', onclick: () => addRow({market: 'SET'})}, '+ Add row'),
      h('span', null, 'Total ', total)),
    h('label', {class: 'field'}, 'Note', note),
    error,
    h('div', {class: 'form-buttons'}, h('button', {type: 'button', class: 'btn', onclick: () => dialog.close()}, 'Cancel'), h('button', {type: 'submit', class: 'btn dark'}, 'Save')));
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const holdings = rowsData.filter((r) => r.stock.value.trim() || numberOf(r.qty) != null || numberOf(r.value) != null)
      .map((r) => ({market: r.market.value, stock: r.stock.value.trim(), qty: numberOf(r.qty), value_thb: numberOf(r.value)}));
    if (!holdings.length || holdings.some((x) => !(x.value_thb > 0))) { error.textContent = 'Every row needs a Value above zero. Remove the rows you do not need.'; return; }
    try {
      await api(row ? 'PUT' : 'POST', `/api/snapshots${row ? '/' + row.id : ''}`,
        {account_id: Number(account.value), as_of: date.value, holdings, note: note.value.trim() || null});
      dialog.close();
      toast(row ? 'Saved.' : 'Added.');
      done();
    } catch (e) { error.textContent = e.message; }
  });
  dialog.replaceChildren(form);
  dialog.showModal();
}

// ---------------------------------------------------------------- trade journal sheet
// The journal laid out like Best's sheet "Trading Journal Fianl Test": one row per trade, the same columns and groups,
// and cells edited in place. Enter or Tab saves, Esc cancels. Day, Balance and Risk / Trade are worked out by the server.
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const pickList = (values) => values.map((v) => [v, v]);
const JOURNAL_COL_WIDTH = {'traded_on': 82, 'day': 92, 'session': 104, 'pair': 84, 'side': 52, 'setup': 118, 'pic_setup': 56, 'poi': 130, 'signal': 112, 'divergence': 56, 'confirm': 112, 'fib_time': 72, 'fib': 104, 'pic_entry': 56, 'exit_plan': 96, 'exit_actual': 96, 'exit_a': 96, 'pic_exit': 56, 'note': 240, 'grade': 62, 'outcome': 72, 'profit': 84, 'lost': 84, 'rr': 56, 'balance': 92, 'risk': 92};   // px; the grid is fixed-layout, so editing never moves a column
const JOURNAL_COLS = [
  {key: 'traded_on', label: 'Date', type: 'date', show: (t) => fmtDay(t.traded_on, true)},
  {key: 'day', label: 'Day', calc: true, show: (t) => WEEKDAYS[new Date(`${t.traded_on}T00:00:00`).getDay()]},
  {key: 'session', label: 'Session', type: 'select', options: pickList(['00.00-03.00', '03.00-07.00', '07.00-11.00', '11.00-15.00', '15.00-19.00', '19.00-24.00'])},
  {key: 'pair', label: 'Pair', type: 'text'},
  {key: 'side', label: 'Side', type: 'select', options: [['L', 'L'], ['S', 'S']]},
  {key: 'setup', label: 'Setup', type: 'text'},
  {key: 'pic_setup', label: 'Pic', type: 'url'},
  {key: 'poi', label: 'POI', type: 'text', group: 'War Zone'},
  {key: 'signal', label: 'Signal', type: 'text', group: 'War Zone'},
  {key: 'divergence', label: 'Div', type: 'select', options: pickList(['Yes', 'No']), group: 'War Zone'},
  {key: 'confirm', label: 'Confirm', type: 'text', group: 'Entry'},
  {key: 'fib_time', label: 'Fib time', type: 'select', options: pickList(['Yes', 'No']), group: 'Entry'},
  {key: 'fib', label: 'Fib', type: 'text', group: 'Entry'},
  {key: 'pic_entry', label: 'Pic', type: 'url', group: 'Entry'},
  {key: 'exit_plan', label: 'Plan', type: 'text', group: 'Exit'},
  {key: 'exit_actual', label: 'Actual', type: 'text', group: 'Exit'},
  {key: 'exit_a', label: '100 of A?', type: 'text', group: 'Exit'},
  {key: 'pic_exit', label: 'Pic', type: 'url', group: 'Exit'},
  {key: 'note', label: 'Note', type: 'note'},
  {key: 'grade', label: 'Grade', type: 'select', options: pickList(['A', 'B+', 'B', 'B-', 'C+', 'C', 'D', 'F'])},
  {key: 'outcome', label: 'Result', type: 'select', options: [['win', 'Win'], ['loss', 'Loss'], ['be', 'BE']],
    show: (t) => (t.outcome ? h('span', {class: t.outcome === 'win' ? 'up' : t.outcome === 'loss' ? 'down' : 'muted'}, {win: 'Win', loss: 'Loss', be: 'BE'}[t.outcome]) : '')},
  {key: 'profit', label: 'Profit', type: 'number', cls: 'r', save: (v) => ({pnl: v == null ? null : Math.abs(v)}), show: (t) => (t.profit == null ? '' : h('span', {class: 'up'}, number(t.profit)))},
  {key: 'lost', label: 'Loss', type: 'number', cls: 'r', save: (v) => ({pnl: v == null ? null : -Math.abs(v)}), show: (t) => (t.lost == null ? '' : h('span', {class: 'down'}, number(t.lost)))},
  {key: 'rr', label: 'RR', type: 'number', cls: 'r'},
  {key: 'balance', label: 'Balance', calc: true, cls: 'r', show: (t) => number(t.balance)},
  {key: 'risk', label: 'Risk / Trade', calc: true, cls: 'r', show: (t) => number(t.risk)},
];

// reload(): refetches the page's data and calls grid.setRows; returns when the new rows are drawn
function journalGrid(reload) {
  const body = h('tbody');
  const wrap = h('div', {class: 'sheet-wrap'});
  const tabs = h('div', {class: 'tabs month-tabs', role: 'tablist'});
  const box = h('div', {class: 'stack'}, tabs, wrap);
  let rows = [], month = null;                       // month: 'YYYY-MM' shown, or 'all'

  // header: grouped columns sit under a group cell, the rest span both rows
  const top = [h('th', {rowspan: 2}, '#')], second = [];
  for (let i = 0; i < JOURNAL_COLS.length; i++) {
    const c = JOURNAL_COLS[i];
    if (!c.group) { top.push(h('th', {rowspan: 2}, c.label)); continue; }
    if (i === 0 || JOURNAL_COLS[i - 1].group !== c.group) top.push(h('th', {colspan: JOURNAL_COLS.filter((x) => x.group === c.group).length}, c.group));
    second.push(h('th', {class: 'sub'}, c.label));
  }
  top.push(h('th', {rowspan: 2}));
  const head = h('thead', null, h('tr', null, top), h('tr', null, second));
  const widthOf = (c) => JOURNAL_COL_WIDTH[c.key] || 80;
  const tableWidth = 40 + JOURNAL_COLS.reduce((t, c) => t + widthOf(c), 0) + 34;
  const cols = h('colgroup', null, h('col', {style: 'width: 40px'}), JOURNAL_COLS.map((c) => h('col', {style: `width: ${widthOf(c)}px`})), h('col', {style: 'width: 34px'}));
  wrap.append(h('table', {class: 'sheet', style: `width: ${tableWidth}px`}, cols, head, body));

  const display = (c, t) => {
    if (c.show) return c.show(t);
    const v = t[c.key];
    if (v == null || v === '') return '';
    if (c.type === 'url') return h('a', {href: v, target: '_blank', rel: 'noopener noreferrer', onclick: (e) => e.stopPropagation(), title: v}, 'Pic ↗');
    if (c.type === 'number') return number(v);
    return v;
  };

  function draw() {
    // one tab per month with trades, oldest first, and All; the latest month is open until Best picks another
    const months = [...new Set(rows.map((t) => t.traded_on.slice(0, 7)))].sort();
    if (month !== 'all' && !months.includes(month)) month = months[months.length - 1] || 'all';
    tabs.replaceChildren(...months.map((m) => {
      const n = rows.filter((t) => t.traded_on.startsWith(m)).length;
      return h('button', {type: 'button', role: 'tab', 'aria-selected': String(m === month), onclick: () => { month = m; draw(); }}, `${yymm(`${m}-01`)} · ${n}`);
    }), h('button', {type: 'button', role: 'tab', 'aria-selected': String(month === 'all'), onclick: () => { month = 'all'; draw(); }}, `All · ${rows.length}`));
    body.replaceChildren(...rows.map((t, n) => [t, n]).filter(([t]) => month === 'all' || t.traded_on.startsWith(month)).map(([t, n]) => h('tr', {'data-id': t.id},
      h('td', {class: 'calc r'}, n + 1),
      JOURNAL_COLS.map((c) => h('td', {'data-key': c.key, class: `${c.calc ? 'calc' : 'edit'} ${c.cls || ''} ${c.type === 'note' ? 'note-cell' : ''}`,
        title: c.type === 'note' ? (t.note || '') : null, onclick: c.calc ? null : (e) => startEdit(e.currentTarget, t, c)}, display(c, t))),
      h('td', {class: 'calc'}, h('button', {type: 'button', class: 'x', title: 'Delete this trade', 'aria-label': 'Delete this trade', onclick: () => remove(t)}, '×')))));
    if (!rows.length) body.append(h('tr', null, h('td', {class: 'empty', colspan: JOURNAL_COLS.length + 2}, 'No trades yet. Add the first one.')));
    const first = head.firstChild.getBoundingClientRect().height;
    for (const th of head.lastChild.children) th.style.top = `${first}px`;      // second header row sticks under the first
  }

  async function save(t, payload) {
    try {
      await api('PUT', `/api/trades/${t.id}`, payload);
      await reload();
      return true;
    } catch (e) { toast(e.message); return false; }
  }

  function startEdit(td, t, c, opts = {}) {
    if (td.classList.contains('editing')) return;
    if (c.type === 'note') {
      openForm({title: `Note — ${fmtDay(t.traded_on)}`, fields: [{key: 'note', label: 'Note', type: 'textarea'}], values: {note: t.note},
        submit: async (v) => { await api('PUT', `/api/trades/${t.id}`, v); await reload(); }});
      const area = $('#dialog textarea');
      area.style.minHeight = '240px';
      return;
    }
    const current = c.key === 'profit' ? t.profit : c.key === 'lost' ? t.lost : t[c.key];
    let input, typed = true;
    if (c.type === 'select') {
      input = h('select', null, [['', '—'], ...c.options].map(([v, label]) => h('option', {value: v}, label)));
      input.value = current == null ? '' : current;
    } else if (c.type === 'number') {
      input = numberInput(current, {class: 'num'});
    } else if (c.type === 'text') {
      // a list of what has been typed in this column before, plus "+ New…" to type a new one
      const seen = [...new Set([...rows.map((r) => r[c.key]), current].filter(Boolean))].sort();
      input = h('select', null, [['', '—'], ...seen.map((v) => [v, v]), ['__new__', '+ New…']].map(([v, label]) => h('option', {value: v}, label)));
      input.value = current == null ? '' : current;
      typed = false;
    } else {
      input = h('input', {type: c.type === 'date' ? 'date' : 'text', placeholder: c.type === 'url' ? 'https://…' : null});
      input.value = current == null ? '' : current;
    }
    let done = false;
    const restore = () => { td.classList.remove('editing'); td.replaceChildren(...[display(c, t)].flat().filter((x) => x !== '')); };
    const commit = async (move) => {
      if (done) return;
      done = true;
      const value = c.type === 'number' ? numberOf(input) : (input.value.trim() === '' ? null : input.value.trim());
      const same = (value == null ? '' : String(value)) === (current == null ? '' : String(current));
      if (c.type === 'date' && value == null) { restore(); return; }                  // a trade always has a date
      const ok = same ? true : await save(t, c.save ? c.save(value) : {[c.key]: value});
      if (same || !ok) restore();
      if (ok && move) {
        const editable = JOURNAL_COLS.filter((x) => !x.calc && x.type !== 'note');
        const next = editable[editable.indexOf(c) + move];
        const cell = next && body.querySelector(`tr[data-id="${t.id}"] td[data-key="${next.key}"]`);
        const fresh = rows.find((x) => x.id === t.id);
        if (cell && fresh) startEdit(cell, fresh, next);
      }
    };
    const wire = (el) => {
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(0); }
        else if (e.key === 'Escape') { done = true; restore(); }
        else if (e.key === 'Tab') { e.preventDefault(); commit(e.shiftKey ? -1 : 1); }
      });
      el.addEventListener('blur', () => commit(0));
    };
    wire(input);
    if (c.type === 'select' || c.type === 'text') {
      input.addEventListener('change', () => {
        if (input.value !== '__new__') { commit(0); return; }
        // "+ New…": swap the list for a text box, same size, and type the new value
        const box = h('input', {type: 'text', placeholder: 'New value'});
        td.replaceChildren(box);
        input = box;
        typed = true;
        wire(box);
        box.focus();
      });
    }
    td.classList.add('editing');
    td.replaceChildren(input);
    input.focus();
    if (input.select && typed && c.type !== 'date') input.select();
    if (opts.open && input.showPicker) { try { input.showPicker(); } catch (e) { /* not allowed without a click */ } }
  }

  async function remove(t) {
    try {
      const out = await api('DELETE', `/api/trades/${t.id}`);
      toast('Trade deleted.', async () => { await api('POST', `/api/audit/${out.audit_id}/undo`); await reload(); });
      await reload();
    } catch (e) { toast(e.message); }
  }

  async function add() {
    try {
      const last = rows[rows.length - 1];
      const made = await api('POST', '/api/trades', {traded_on: today(), pair: last ? last.pair : 'BTC/USDT'});
      month = made.traded_on ? made.traded_on.slice(0, 7) : today().slice(0, 7);          // show the month the new trade is in
      await reload();
      wrap.scrollTop = wrap.scrollHeight;
      const t = rows.find((x) => x.id === made.id);
      const cell = body.querySelector(`tr[data-id="${made.id}"] td[data-key="session"]`);
      if (t && cell) startEdit(cell, t, JOURNAL_COLS.find((x) => x.key === 'session'));
    } catch (e) { toast(e.message); }
  }

  return {wrap: box, add, setRows: (next) => { rows = next; draw(); }};
}

// the sheet's summary block (rows 23 to 25): Start / Return / Net Balance, Profit / Loss / PNL, Win / Loss / BE,
// PF Factor / Win Rate, Risk Per Trade, and what each Grade means
function journalSummary(s) {
  const block = (...lines) => h('div', {class: 'stat-block'}, lines.map(([label, value, cls]) =>
    h('div', {class: 'stat-line'}, h('span', {class: 'stat-label'}, label), h('span', {class: `stat-value ${cls || ''}`}, value))));
  return h('div', {class: 'statgrid'},
    block(['Win Rate', pct(s.win_rate)], ['PF Factor', number(s.profit_factor)], [`Risk Per Trade (${number(s.risk_pct * 100, 1)}%)`, number(s.risk_amount)]),
    block(['Start', number(s.start)], ['Return', signedPct(s.return), signClass(s.return)], ['Net Balance', number(s.net_balance)]),
    block(['Profit', number(s.profit), 'up'], ['Loss', number(s.loss), 'down'], ['PNL', number(s.pnl), signClass(s.pnl)]),
    block(['Win', s.win], ['Loss', s.loss_count], ['BE', s.be]));
}

// ---------------------------------------------------------------- EMBRACE Shop: typing one month of the P&L
const SHOP_SECTIONS = [['revenue', 'Revenue'], ['cogs', 'Cost of goods (COGS)'], ['sga', 'Fees and overheads'], ['tax', 'Interest and tax'],
  ['dividend', 'Dividend (% of revenue minus fees)']];

// existing: {'YYYY-M': {section: {line: amount}}} for every month typed so far, used to fill the form when a month is picked
function shopMonthEditor({standard, existing, year, month, payout, done}) {
  const dialog = $('#dialog');
  dialog.style.width = 'min(640px, calc(100vw - 32px))';
  const error = h('div', {class: 'form-error'});
  const yearInput = h('input', {type: 'number', min: 2000, max: 2100, required: true});
  yearInput.value = year;
  const monthInput = h('select', null, MONTHS.map((m, i) => h('option', {value: i + 1}, m)));
  monthInput.value = month;
  const body = h('div', {class: 'stack'});
  let rows = [];          // {section, name: input|null, label, amount: input}

  const lineRow = (section, label, amount, custom) => {
    const name = custom ? h('input', {type: 'text', placeholder: 'Line name', 'aria-label': 'Line name'}) : null;
    if (name) name.value = label;
    const amountInput = numberInput(amount, {class: 'num', 'aria-label': `${label || 'New line'} amount`, placeholder: '—'});
    const entry = {section, name, label, amount: amountInput};
    rows.push(entry);
    return h('div', {class: 'shop-line'}, name || h('span', null, label), amountInput);
  };
  const fill = () => {
    rows = [];
    const have = existing[`${yearInput.value}-${monthInput.value}`] || {};
    body.replaceChildren(...SHOP_SECTIONS.map(([id, title]) => {
      const names = [...standard[id], ...Object.keys(have[id] || {}).filter((n) => !standard[id].includes(n))];
      const typed = (n) => ((have[id] || {})[n] == null && id === 'dividend' && !Object.keys(have).length ? payout : (have[id] || {})[n]);   // a new month starts from the last rate
      const box = h('fieldset', {class: 'fin-sec'}, h('legend', null, title), ...names.map((n, i) => lineRow(id, n, typed(n), i >= standard[id].length)));
      if (id !== 'dividend') box.append(h('button', {type: 'button', class: 'btn small', onclick: (e) => e.currentTarget.before(lineRow(id, '', null, true))}, '+ Add line'));
      return box;
    }));
  };
  yearInput.addEventListener('change', fill);
  monthInput.addEventListener('change', fill);
  fill();

  const form = h('form', {class: 'form', method: 'dialog'}, h('h2', null, 'EMBRACE Shop — one month'),
    h('div', {class: 'shop-when'}, h('label', {class: 'field'}, 'Year', yearInput), h('label', {class: 'field'}, 'Month', monthInput)),
    h('p', {class: 'note'}, 'Leave a box empty for no data (it is not counted as 0). Type 0 when the amount really was zero. Clear every box to remove the month.'),
    body, error,
    h('div', {class: 'form-buttons'}, h('button', {type: 'button', class: 'btn', onclick: () => dialog.close()}, 'Cancel'), h('button', {type: 'submit', class: 'btn dark'}, 'Save')));
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const entries = rows.map((r) => ({section: r.section, line: (r.name ? r.name.value : r.label).trim(), amount: numberOf(r.amount)}))
      .filter((e) => e.amount != null);
    try {
      await api('PUT', '/api/shop/month', {year: Number(yearInput.value), month: Number(monthInput.value), entries});
      dialog.close();
      toast(entries.length ? 'Saved.' : 'Month removed.');
      done(Number(yearInput.value));
    } catch (e) { error.textContent = e.message; }
  });
  dialog.replaceChildren(form);
  dialog.showModal();
}

// Snapshots and Flows lists for a set of Accounts (used by Investment, Trading and Wealth)
function accountLists(accounts, rerender) {
  const manual = accounts.filter((a) => a.source === 'manual');
  const ids = new Set(manual.map((a) => a.id));
  const byId = new Map(manual.map((a) => [a.id, a]));
  const name = (row) => (byId.get(row.account_id) || {}).name || '';
  const options = accountOptions(manual);
  if (!manual.length) return [];
  return [
    crud({
      title: 'Monthly values', resource: 'snapshots', filter: (r) => ids.has(r.account_id), onChange: rerender,
      note: 'One value per Account per date. For an Account not in THB, enter the FX rate used.',
      defaults: () => ({account_id: manual[0].id, as_of: today()}),
      columns: [
        {key: 'account_id', label: 'Account', type: 'select', options, show: name, required: true},
        {key: 'as_of', label: 'Date', type: 'date', required: true, cls: 'nowrap'},
        {key: 'value_native', label: 'Value', type: 'number', required: true, cls: 'r',
          show: (r) => `${number(r.value_native)} ${(byId.get(r.account_id) || {}).currency || ''}`},
        {key: 'fx_rate', label: 'FX rate', type: 'number', hint: 'THB per 1 unit; leave blank for THB', cls: 'r'},
        {key: 'value_thb', label: 'THB', type: 'money', form: false, cls: 'r'},
        {key: 'note', label: 'Note', type: 'text'},
        {key: 'entered_by', label: 'By', form: false, cls: 'muted'},
      ],
    }),
    crud({
      title: 'Deposits and withdrawals', resource: 'flows', filter: (r) => ids.has(r.account_id), onChange: rerender,
      note: 'Record every deposit (+) and withdrawal (−) in the month it happened, or that month’s return is wrong.',
      defaults: () => ({account_id: manual[0].id, on_date: today()}),
      columns: [
        {key: 'account_id', label: 'Account', type: 'select', options, show: name, required: true},
        {key: 'on_date', label: 'Date', type: 'date', required: true, cls: 'nowrap'},
        {key: 'amount_thb', label: 'Amount (THB)', type: 'money', required: true, hint: '+ deposit, − withdrawal', cls: 'r'},
        {key: 'kind', label: 'Kind', form: false},
        {key: 'note', label: 'Note', type: 'text'},
        {key: 'entered_by', label: 'By', form: false, cls: 'muted'},
      ],
    }),
  ];
}

function accountCards(accounts) {
  return h('div', {class: 'cards'}, accounts.map((a) => {
    const value = a.live ? a.live.value_thb : a.snapshot && a.snapshot.value_thb;
    const asOf = a.live ? a.live.as_of : a.snapshot && a.snapshot.as_of;
    return h('article', {class: 'card'},
      h('div', {class: 'tile-label'}, a.name),
      h('div', {class: 'tile-value'}, baht(value)),
      h('div', {class: 'tile-sub'}, asOf ? `as of ${asOf}` : 'no value yet',
        a.snapshot && a.currency !== 'THB' ? ` · ${number(a.snapshot.value_native)} ${a.currency}` : ''));
  }));
}

// ---------------------------------------------------------------- pages
const pages = {
  async home(host) {
    const d = await api('GET', '/api/home');
    const k = d.kpis;
    setChips(k);
    if (!k) { host.append(h('article', {class: 'card'}, h('p', {class: 'note'}, 'No values recorded yet. Run scripts/import_fund_management.py, or add values under Investment.'))); return; }
    host.append(h('div', {class: 'tiles'},
      tile('Total Portfolio Value', baht(k.total), k.total_mom),
      tile('Monthly Return', baht(k.monthly_return), k.monthly_return_pct, k.monthly_return),
      tile('Investment', baht(k.investment), k.investment_mom),
      tile('Trading', baht(k.trading_pnl), k.trading_pnl_pct, k.trading_pnl),
      tile('SHOP Revenue', d.shop.available ? baht(k.shop_revenue) : '—', k.shop_mom)));

    const year = k.month.slice(0, 4);   // this year, as far as the data goes
    const perf = performanceCard({year, rowsYear: d.growth_year, rowsAll: d.growth, legend: 'Total Portfolio',
      nameYear: 'Total Portfolio (incl. deposits)', nameAll: 'Total Portfolio (value growth)'});
    const perfCard = perf.card;

    const donutBox = h('div', {class: 'donut'});
    const parts = d.allocation.map((a) => ({label: GROUPS[a.group][0], value: a.value_thb, color: GROUPS[a.group][1], share: a.share, page: GROUPS[a.group][2]}));
    const allocCard = h('article', {class: 'card'}, h('h2', {class: 'caps'}, 'Asset Allocation'),
      h('div', {class: 'donut-wrap'}, donutBox,
        h('div', {class: 'legend'}, parts.map((p) => h('a', {href: `#${p.page}`}, h('span', null, h('span', {class: 'dot', style: `background: ${p.color}`}), p.label), h('span', null, pct(p.share)))))),
      h('button', {type: 'button', class: 'btn wide', onclick: () => go('assets')}, 'View full breakdown →'));
    host.append(h('div', {class: 'row2'}, perfCard, allocCard));
    perf.draw('return');
    donut(donutBox, parts, {pct: k.total_mom, total: k.total});

    const goals = h('article', {class: 'card'}, h('div', {class: 'card-head'}, h('h2', {class: 'caps'}, 'Investment Goals'),
      h('button', {type: 'button', class: 'btn small', onclick: () => go('plan')}, 'Edit')),
      h('div', {class: 'goals'}, d.goals.length ? d.goals.map((g) => h('div', null,
        h('div', {class: 'goal-top'}, h('span', {class: 'goal-name'}, GROUPS[g.bucket] ? GROUPS[g.bucket][0] : 'Wealth'), h('span', null, `${baht(g.actual_thb)} of ${baht(g.goal_thb)}`)),
        h('div', {class: 'goal-sub'}, h('span', null, `Target: Dec ${g.year}`)),
        h('div', {class: 'mini'}, h('div', {class: 'bar'}, h('span', {style: `width: ${Math.min(1, Math.max(0, g.progress || 0)) * 100}%`})), h('span', null, `${Math.round((g.progress || 0) * 100)}%`))))
        : h('p', {class: 'note'}, 'No Goals for this year yet.')));
    const upcoming = crud({
      title: 'Upcoming', caps: true, resource: 'upcoming', query: '?open=1',
      defaults: () => ({due_date: today(), kind: 'Bill'}),
      columns: [
        {key: 'due_date', label: 'Due', type: 'date', required: true, cls: 'nowrap'},
        {key: 'item', label: 'Item', type: 'text', required: true},
        {key: 'kind', label: 'Kind', type: 'select', options: ['Bill', 'Dividend', 'Restock', 'Rebalance', 'Entry', 'Other'].map((v) => [v, v]), table: false},
        {key: 'amount_thb', label: 'Amount', type: 'money', cls: 'r'},
        {key: 'done', label: 'Done', type: 'check', table: false},
      ],
    });
    const projects = crud({
      title: 'Ongoing Projects', caps: true, resource: 'projects',
      columns: [
        {key: 'name', label: 'Project', type: 'text', required: true},
        {key: 'track', label: 'Track', type: 'text', table: false},
        {key: 'status', label: 'Status', type: 'text', table: false},
        {key: 'progress', label: 'Progress', type: 'number', hint: '0 to 1',
          show: (r) => h('div', {class: 'mini'}, h('div', {class: 'bar'}, h('span', {style: `width: ${Math.min(1, Math.max(0, r.progress)) * 100}%`})), h('span', null, `${Math.round(r.progress * 100)}%`))},
        {key: 'next_step', label: 'Next step', type: 'text', table: false},
      ],
    });
    host.append(h('div', {class: 'row3'}, goals, upcoming, projects));
  },

  async investment(host) {
    const d = await api('GET', '/api/investment');
    const st = d.stats;
    const manual = d.accounts.filter((a) => a.source === 'manual');
    const ids = new Set(manual.map((a) => a.id));
    const names = new Map(manual.map((a) => [a.id, a.name]));
    const again = () => go('investment');
    host.append(pageHead('Investment Portfolio', 'Stock Accounts held for the long term. Values are monthly figures in THB; there is no live price feed.'));

    // Monthly Return, YTD and CAGR are all change in value with deposits counted, like the chart below.
    host.append(h('div', {class: 'tiles'}, ...accountCards(d.accounts).children, ...bucketStatTiles(st)));

    const perf = performanceCard({year: st ? st.month.slice(0, 4) : String(new Date().getFullYear()), rowsYear: d.growth_year, rowsAll: d.growth,
      legend: 'Investment', nameYear: 'Investment (incl. deposits)', nameAll: 'Investment (value growth)'});
    host.append(perf.card);
    perf.draw('return');

    const markets = (r) => {
      if (!r.holdings) return h('span', {class: 'muted'}, '—');
      return [...new Set(JSON.parse(r.holdings).map((x) => marketLabel(x.market)))].join(' · ');
    };
    const portfolio = crud({
      title: 'Investment Portfolio', resource: 'snapshots', filter: (r) => ids.has(r.account_id), onChange: again,
      editor: (row, done) => portfolioEditor(manual, row, done),
      note: 'One row per month. Add or edit it to enter the holdings by Market and Stock.',
      columns: [
        {key: 'holdings', label: 'Market', show: markets, cls: 'nowrap'},
        {key: 'as_of', label: 'Date', show: (r) => mmyy(r.as_of), cls: 'nowrap'},
        {key: 'value_thb', label: 'Value (THB)', type: 'money', cls: 'r'},
        {key: 'note', label: 'Note', show: (r) => noteIcon(r.note, `Note — ${mmyy(r.as_of)}`)},
      ],
    });

    const donutBox = h('div', {class: 'donut'});
    const parts = d.markets.markets.map((m) => ({label: m.market ? marketLabel(m.market) : 'No market', value: m.value_thb, color: MARKET_COLORS[m.market] || MARKET_COLORS.OTHER, share: m.share}));
    const marketCard = h('article', {class: 'card'},
      h('div', {class: 'card-head'}, h('h2', {class: 'caps'}, 'By market'), d.markets.as_of ? h('span', {class: 'chip'}, `as of ${mmyy(d.markets.as_of)}`) : null),
      parts.length
        ? h('div', {class: 'donut-wrap'}, donutBox,
          h('div', {class: 'legend'}, parts.map((p) => h('div', {class: 'legend-item'}, h('span', null, h('span', {class: 'dot', style: `background: ${p.color}`}), p.label), h('span', null, pct(p.share))))))
        : h('p', {class: 'note'}, 'No holdings by market yet. Add a month in Investment Portfolio with a Market on each row and the split appears here.'));
    const top = d.markets.top || [];
    const topCard = h('article', {class: 'card'}, h('h2', {class: 'caps'}, 'Top 10 holdings'),
      top.length ? h('div', {class: 'table-wrap'}, h('table', null,
        h('thead', null, h('tr', null, h('th', null, '#'), h('th', null, 'Stock'), h('th', null, 'Market'), h('th', {class: 'r'}, 'Value (THB)'), h('th', {class: 'r'}, '% of port'))),
        h('tbody', null, top.map((t, n) => h('tr', null, h('td', {class: 'muted'}, n + 1), h('td', null, t.stock || '—'), h('td', null, marketLabel(t.market)),
          h('td', {class: 'r'}, baht(t.value_thb)), h('td', {class: 'r'}, pct(t.share)))))))
        : h('p', {class: 'note'}, 'Shown once a month has holdings entered. Cash is not counted as a stock.'),
      top.length ? h('p', {class: 'note'}, 'Share is of the whole Investment value, cash included.') : null);
    host.append(h('div', {class: 'pair'}, h('div', {class: 'stack'}, marketCard, topCard), portfolio));
    if (parts.length) donut(donutBox, parts, {total: parts.reduce((t, p) => t + p.value, 0)});

    const flows = crud({
      title: 'Deposits and withdrawals', resource: 'flows', filter: (r) => ids.has(r.account_id), onChange: again,
      note: 'Record every deposit (+) and withdrawal (−) in the month it happened.',
      defaults: () => ({account_id: manual[0].id, on_date: today()}),
      columns: [
        {key: 'account_id', label: 'Account', type: 'select', options: manual.map((a) => [a.id, a.name]), show: (r) => names.get(r.account_id) || '', required: true},
        {key: 'on_date', label: 'Date', type: 'date', required: true, show: (r) => mmyy(r.on_date), cls: 'nowrap'},
        {key: 'amount_thb', label: 'Amount (THB)', type: 'money', required: true, hint: '+ deposit, − withdrawal', cls: 'r'},
        {key: 'kind', label: 'Kind', form: false},
        {key: 'note', label: 'Note', type: 'text', show: (r) => noteIcon(r.note, `Note — ${mmyy(r.on_date)}`)},
      ],
    });
    const benchmarks = crud({
      title: 'Benchmark prices', resource: 'benchmarks', onChange: again,
      note: 'Month-end closing price of the Benchmark.',
      defaults: () => ({name: 'SET', as_of: today()}),
      columns: [
        {key: 'name', label: 'Benchmark', type: 'select', options: [['BTC', 'BTC'], ['SET', 'SET']], required: true},
        {key: 'as_of', label: 'Date', type: 'date', required: true, cls: 'nowrap'},
        {key: 'value', label: 'Close', type: 'number', required: true, cls: 'r'},
      ],
    });
    host.append(h('div', {class: 'pair'}, flows, benchmarks));
  },

  async trading(host, year) {
    const url = () => `/api/trading${year ? `?year=${year}` : ''}`;
    let d = await api('GET', url());
    host.append(pageHead('Trading Portfolio', 'The trade journal is the source: the figures below come from it, in USDT, and do not include deposits or withdrawals. This system never places an order.'),
      h('div', {class: 'tiles'},
        d.stats ? (d.stats.fx
          ? tile('Trading Portfolio', baht(d.stats.value * d.stats.fx), undefined, undefined, `${usdt(d.stats.value)} USDT × ${number(d.stats.fx)} (FX ${yymm(d.stats.fx_as_of)})`)
          : tile('Trading Portfolio', `${usdt(d.stats.value)} USDT`, undefined, undefined, 'Net Balance · no FX rate entered yet')) : null,
        ...bucketStatTiles(d.stats, {fmt: usdt, cagrNote: 'trades only'})));

    // the journal's summary block and sheet share one reload, so an edit in a cell updates both
    const summaryHost = h('div');
    const grid = journalGrid(async () => { d = await api('GET', url()); render(); });
    const editSettings = () => openForm({
      title: 'Trade journal — Start and Risk',
      fields: [{key: 'start_balance', label: 'Start', type: 'number', hint: 'balance before the first trade, in USDT', required: true},
        {key: 'start_date', label: 'Start date', type: 'date', hint: 'the day it was in the account; CAGR counts from here', required: true},
        {key: 'risk', label: 'Risk Per Trade', type: 'number', hint: '% of Net Balance', required: true}],
      values: {start_balance: d.sheet.summary.start, start_date: d.journal_start_date, risk: d.sheet.summary.risk_pct * 100},
      submit: async (v) => {
        await api('PUT', '/api/journal/settings', {start_balance: v.start_balance, start_date: v.start_date, risk_pct: v.risk == null ? null : v.risk / 100});
        d = await api('GET', url());
        render();
      },
    });
    // what each Grade means, in one row under the description; Edit changes the wording
    const gradesRow = h('div', {class: 'grade-row'});
    const drawGrades = () => gradesRow.replaceChildren(...['A', 'B', 'C'].map((g) =>
      h('span', {class: 'grade-item'}, h('b', null, g), h('span', null, d.grades[g] || '—'))),
      h('button', {type: 'button', class: 'btn small', onclick: () => openForm({
        title: 'What each Grade means', fields: ['A', 'B', 'C'].map((g) => ({key: g, label: `Grade ${g}`, type: 'text'})), values: d.grades,
        submit: async (v) => { d.grades = await api('PUT', '/api/journal/grades', v); drawGrades(); },
      })}, 'Edit'));
    function render() {
      drawGrades();
      summaryHost.replaceChildren(journalSummary(d.sheet.summary));
      grid.setRows(d.sheet.trades);
    }
    const jYear = d.sheet.year, jYears = d.sheet.years.length ? d.sheet.years : [jYear];
    const yearTabs = h('div', {class: 'tabs', role: 'tablist'}, jYears.map((y) =>
      h('button', {type: 'button', role: 'tab', 'aria-selected': String(y === jYear), onclick: () => go('trading', y)}, y)));
    host.append(h('article', {class: 'card'}, h('div', {class: 'card-head'},
      h('h2', {class: 'card-title'}, 'Trade journal summary'),
      h('span', {class: 'row-gap'}, jYears.length > 1 ? yearTabs : h('span', {class: 'chip line'}, `Year ${jYear}`), h('span', {class: 'chip'}, 'USDT'),
        h('button', {type: 'button', class: 'btn small', onclick: editSettings}, 'Edit Start and Risk'))), summaryHost));

    const perfYear = d.growth_year.length ? d.growth_year[d.growth_year.length - 1].month.slice(0, 4) : String(new Date().getFullYear());
    const perf = performanceCard({year: perfYear, rowsYear: d.growth_year, rowsAll: d.growth, legend: 'Trading', bench: 'BTC', title: 'Trading Portfolio', valueFmt: (v) => `${usdt(v)} USDT`,
      nameYear: 'Trading (journal)', nameAll: 'Trading'});
    host.append(perf.card);
    perf.draw('return');

    host.append(h('article', {class: 'card'},
      h('div', {class: 'card-head'}, h('h2', {class: 'card-title'}, 'Trade journal'),
        h('button', {type: 'button', class: 'btn small dark', onclick: () => grid.add()}, '+ Add trade')),
      h('p', {class: 'note'}, 'Click a cell to edit it. Enter or Tab saves, Esc cancels. Day, Balance and Risk / Trade are worked out for you; type a result in Profit or in Loss.'),
      gradesRow,
      h('details', {class: 'rules'}, h('summary', null, 'Setup checklist'),
        h('div', {class: 'table-wrap'}, h('table', null,
          h('thead', null, h('tr', null, ['Setup', 'POI', 'Signal', 'Div', 'Confirm', 'Fib time', 'Fib', 'Exit plan'].map((t) => h('th', null, t)))),
          h('tbody', null,
            h('tr', null, ['Battle Field (EMA)', 'EMA 8/26/50/99/200', 'RSI Strong · DD ไม่ขยาย · ย้ำหัวไปต่อ', 'RSI Divergence', 'Choch/Bos · ไป 2X HB', 'Passed', 'Fib 0.5 / 0.68 / 0.78', '3R · 100 of A'].map((t) => h('td', null, t))),
            h('tr', null, ['Hua Taew (Divergence)', 'RSI Div 4H', 'RSI Div · DD ขยาย · ซอยเท้า', 'RSI Divergence', 'Choch/Bos', 'Passed', 'Fib 0.5 / 0.68 / 0.78', '3R · 100 of A'].map((t) => h('td', null, t))))))),
      grid.wrap));
    render();

    // by month, from the journal: trades, P&L, P&L against the month's opening balance, and the balance at month end
    const monthsCard = h('article', {class: 'card'}, h('h2', {class: 'card-title'}, 'Trading by month'),
      h('p', {class: 'note'}, 'From the trade journal, in USDT. No deposits or withdrawals.'),
      d.journal_months.length ? h('div', {class: 'table-wrap'}, h('table', null,
        h('thead', null, h('tr', null, [['Month', ''], ['Trades', 'r'], ['P&L', 'r'], ['% of month start', 'r'], ['Balance', 'r']].map(([t, cls]) => h('th', {class: cls}, t)))),
        h('tbody', null, [...d.journal_months].reverse().map((m) => h('tr', null,
          h('td', {class: 'nowrap'}, monthLabel(m.month)), h('td', {class: 'r'}, m.trades || ''),
          h('td', {class: `r ${signClass(m.pnl)}`}, m.trades ? usdt(m.pnl) : ''),
          h('td', {class: `r ${signClass(m.pnl_pct)}`}, m.trades ? signedPct(m.pnl_pct) : ''), h('td', {class: 'r'}, usdt(m.balance)))))))
        : h('p', {class: 'empty'}, 'No trades in the journal yet.'));
    const manual = d.accounts.filter((a) => a.source === 'manual');
    const ids = new Set(manual.map((a) => a.id));
    const names = new Map(manual.map((a) => [a.id, a]));
    const again = () => go('trading');
    const accountOpts = manual.map((a) => [a.id, `${a.name} (${a.currency})`]);
    const monthlyValues = crud({
      title: 'Monthly values', resource: 'snapshots', filter: (r) => ids.has(r.account_id), onChange: again,
      note: 'Account balance at month end. For an Account not in THB, enter the FX rate used.',
      defaults: () => ({account_id: manual[0].id, as_of: today()}),
      columns: [
        {key: 'account_id', label: 'Account', type: 'select', options: accountOpts, show: (r) => (names.get(r.account_id) || {}).name || '', required: true},
        {key: 'as_of', label: 'Date', type: 'date', required: true, show: (r) => yymm(r.as_of), cls: 'nowrap'},
        {key: 'value_native', label: 'Value', type: 'number', required: true, cls: 'r',
          show: (r) => `${number(r.value_native)} ${(names.get(r.account_id) || {}).currency || ''}`},
        {key: 'fx_rate', label: 'FX rate', type: 'number', hint: 'THB per 1 unit; leave blank for THB', cls: 'r'},
        {key: 'value_thb', label: 'THB', type: 'money', form: false, cls: 'r'},
        {key: 'note', label: 'Note', type: 'text', show: (r) => noteIcon(r.note, `Note — ${yymm(r.as_of)}`)},
      ],
    });
    const deposits = crud({
      title: 'Deposits and withdrawals', resource: 'flows', filter: (r) => ids.has(r.account_id), onChange: again,
      note: 'Record every deposit (+) and withdrawal (−) in the month it happened, or that month’s return is wrong.',
      defaults: () => ({account_id: manual[0].id, on_date: today()}),
      columns: [
        {key: 'account_id', label: 'Account', type: 'select', options: accountOpts, show: (r) => (names.get(r.account_id) || {}).name || '', required: true},
        {key: 'on_date', label: 'Date', type: 'date', required: true, show: (r) => yymm(r.on_date), cls: 'nowrap'},
        {key: 'amount_thb', label: 'Amount (THB)', type: 'money', required: true, hint: '+ deposit, − withdrawal', cls: 'r'},
        {key: 'kind', label: 'Kind', form: false},
        {key: 'note', label: 'Note', type: 'text', show: (r) => noteIcon(r.note, `Note — ${yymm(r.on_date)}`)},
      ],
    });
    host.append(h('div', {class: 'pair'}, h('div', {class: 'stack'}, monthsCard, deposits), monthlyValues));   // Deposits sits right under Trading by month
  },

  async shop(host, year) {
    const d = await api('GET', '/api/shop/finance');
    const intro = 'Monthly profit and loss, typed here. Revenue is whole-shop sales; it is not Best’s share.';
    if (!d.available) {
      host.append(pageHead('EMBRACE Shop', intro)); host.append(h('article', {class: 'card'}, h('p', {class: 'note warn'}, d.reason))); return; }
    const years = d.years;
    // every month typed so far, for filling the editor
    const existing = {};
    for (const yr of years) for (const m of yr.months) {
      if (m.manual || m.tax) existing[`${yr.year}-${m.month}`] = {revenue: m.revenue_lines, cogs: m.cogs_lines, sga: m.sga_lines, tax: m.tax_lines,
        dividend: m.payout_pct == null ? {} : {'Payout %': m.payout_pct}};
    }
    const latestPayout = years.map((yr) => yr.months.filter((m) => m.payout_pct != null).pop()).find(Boolean)?.payout_pct ?? 33;   // newest year first, newest month in it
    const openEditor = (yy, mm0) => shopMonthEditor({standard: d.lines, existing, year: yy, month: mm0, payout: latestPayout, done: (saved) => go('shop', saved)});
    const nextMonth = () => {
      const newest = years.find((x) => x.months.some((m) => m.manual));
      const last = newest && newest.months.filter((m) => m.manual).pop();
      return last ? (last.month === 12 ? [newest.year + 1, 1] : [newest.year, last.month + 1]) : [new Date().getFullYear(), new Date().getMonth() + 1];
    };
    if (!years.length) {
      host.append(pageHead('EMBRACE Shop', intro));
      host.append(h('article', {class: 'card'}, h('p', {class: 'note'}, 'No shop figures yet. Add the first month: Revenue by platform, cost of goods and fees.'),
        h('div', null, h('button', {type: 'button', class: 'btn dark', onclick: () => openEditor(...nextMonth())}, '+ Add month'))));
      return;
    }
    const y = years.find((x) => x.year === Number(year)) || years.find((x) => x.months.some((m) => m.manual)) || years[0];
    const ms = y.months, mm = ms.filter((m) => m.manual);
    const by = Object.fromEntries(ms.map((m) => [m.month, m]));
    const sum = (list, f) => list.reduce((t, m) => t + f(m), 0);
    const ytd = sum(mm, (m) => m.revenue), fees = sum(mm, (m) => m.sga), cogs = sum(mm, (m) => m.cogs);
    const names = (key) => [...new Set(mm.flatMap((m) => Object.keys(m[key])))];

    const tabs = h('div', {class: 'tabs', role: 'tablist'}, years.map((x) =>
      h('button', {type: 'button', role: 'tab', 'aria-selected': String(x.year === y.year), onclick: () => go('shop', x.year)}, String(x.year))));
    host.append(h('div', {class: 'page-head'}, h('h2', {class: 'page-title'}, 'EMBRACE Shop'), tabs));

    host.append(h('div', {class: 'tiles'},
      h('article', {class: 'card'}, h('div', {class: 'tile-label'}, `Revenue ${y.year}`), h('div', {class: 'tile-value'}, baht(ytd)), h('div', {class: 'tile-sub'}, `${mm.length} months with data`)),
      h('article', {class: 'card'}, h('div', {class: 'tile-label'}, 'Fees, shipping and ads'), h('div', {class: 'tile-value'}, baht(fees)), h('div', {class: 'tile-sub'}, ytd ? `${(fees / ytd * 100).toFixed(1)}% of revenue` : '')),
      h('article', {class: 'card'}, h('div', {class: 'tile-label'}, 'After fees'), h('div', {class: 'tile-value'}, baht(ytd - fees)), h('div', {class: 'tile-sub'}, 'before cost of goods')),
      h('article', {class: 'card'}, h('div', {class: 'tile-label'}, 'Cost of goods (COGS)'), h('div', {class: 'tile-value'}, cogs ? baht(cogs) : '–'), h('div', {class: 'tile-sub'}, cogs ? '' : 'not entered'))));

    if (mm.length) {
      const chart = h('div', {class: 'chart'});
      host.append(h('article', {class: 'card'}, h('h2', {class: 'card-title'}, 'Revenue by month'), chart));
      lineChart(chart, mm.map((m) => ({month: `${y.year}-${String(m.month).padStart(2, '0')}`, revenue: m.revenue})),
        [{key: 'revenue', name: 'Revenue', color: 'var(--up)'}], {format: baht});
    }

    const dash = () => h('td', {class: 'r muted'}, '–');
    const row = (label, get, opt = {}) => {
      const fmt = opt.fmt || baht;
      const cells = Array.from({length: 12}, (_, i) => {
        const m = by[i + 1]; const v = m && m.manual ? get(m) : null;
        if (v == null) return dash();
        const flagged = opt.flag && opt.flag(m);          // e.g. a net profit worked out with no cost of goods typed
        return h('td', {class: `r ${flagged ? 'flagged' : ''}`, title: flagged ? opt.flagNote : null}, fmt(v));
      });
      const vals = mm.map(get).filter((v) => v != null);
      return h('tr', {class: opt.strong ? 'strong' : ''}, h('td', {class: 'nowrap', style: opt.indent ? 'padding-left: 14px' : ''}, label), ...cells,
        h('td', {class: 'r'}, opt.noTotal ? '' : h('b', null, vals.length ? fmt(vals.reduce((a, b) => a + b, 0)) : '–')));
    };
    const lines = (key) => names(key).map((n) => row(n, (m) => (n in m[key] ? m[key][n] : null), {indent: true}));
    host.append(h('article', {class: 'card'}, h('div', {class: 'card-head'}, h('h2', {class: 'card-title'}, `Month by month ${y.year}`),
      h('button', {type: 'button', class: 'btn small', onclick: () => openEditor(...nextMonth())}, '+ Add')), h('div', {class: 'table-wrap fit'}, h('table', null,
      h('thead', null, h('tr', null, h('th', null, ''), MONTHS.map((m, i) => h('th', {class: 'r'},
        h('button', {type: 'button', class: 'th-btn', title: `Add or change ${m} ${y.year}`, onclick: () => openEditor(y.year, i + 1)}, m))), h('th', {class: 'r'}, 'Total'))),
      h('tbody', null, ...lines('revenue_lines'), row('Total revenue', (m) => m.revenue, {strong: true}),
        ...lines('cogs_lines'), row('Total cost of goods (COGS)', (m) => (m.has_cogs ? m.cogs : null), {strong: true}),
        ...lines('sga_lines'), row('Total fees and overheads', (m) => m.sga, {strong: true}),
        ...lines('tax_lines'),
        row('After fees (before COGS)', (m) => m.after_fees, {strong: true}),
        row('Net profit', (m) => m.net_profit, {strong: true, flag: (m) => !m.has_cogs, flagNote: 'No cost of goods typed for this month, so it is counted as 0'}))))));

    // dividend: the sheet's rule, (revenue - fees) x the month's payout rate, shared ออน / เบส; cost of goods is not taken off
    const onnPct = Math.round(d.split_onn * 100);
    host.append(h('article', {class: 'card'}, h('div', {class: 'card-head'}, h('h2', {class: 'card-title'}, `Dividend ${y.year}`)),
      h('div', {class: 'table-wrap'}, h('table', null,
        h('thead', null, h('tr', null, h('th', null, ''), MONTHS.map((m) => h('th', {class: 'r'}, m)), h('th', {class: 'r'}, 'Total'))),
        h('tbody', null,
          row('Payout rate', (m) => m.payout_pct, {fmt: (v) => `${number(v, 1)}%`, noTotal: true}),
          row('Profit for dividend', (m) => m.dividend_pool, {strong: true}),
          row('ออน', (m) => m.dividend_onn, {indent: true}),
          row('เบส', (m) => m.dividend_bes, {indent: true})))),
      h('div', {class: 'card-foot'}, h('span', {class: 'chip'}, `ออน ${onnPct}% · เบส ${100 - onnPct}%`),
        h('span', {class: 'chip line'}, `All years: ออน ${baht(d.dividend_total.onn)} · เบส ${baht(d.dividend_total.bes)}`))));

    const cmp = ms.filter((m) => m.orders);
    const cmpRow = (label, key, kind) => {
      const cells = Array.from({length: 12}, (_, i) => {
        const m = by[i + 1];
        if (!m || !m.orders) return dash();
        const man = m.revenue_lines[label] ?? null, app = m.orders[key];
        if (kind === 'manual') return man == null ? dash() : h('td', {class: 'r'}, baht(man));
        if (kind === 'app') return h('td', {class: 'r'}, baht(app));
        if (man == null) return h('td', {class: 'r muted'}, 'not entered');
        const diff = man - app;
        return h('td', {class: 'r'}, Math.abs(diff) < 0.5 ? h('span', {class: 'up'}, 'matches') : h('span', {class: 'down'}, `${diff > 0 ? '+' : '−'}${baht(Math.abs(diff))}`));
      });
      const name = kind === 'manual' ? `${label} · entered` : kind === 'app' ? `${label} · synced orders` : `${label} difference`;
      return h('tr', {class: kind === 'diff' ? 'strong' : ''}, h('td', {class: 'nowrap'}, name), ...cells);
    };
    const est = cmp.filter((m) => m.orders.estimated > 0).map((m) => MONTHS[m.month - 1]);
    host.append(h('article', {class: 'card'}, h('h2', {class: 'card-title'}, 'Entered figures against synced orders'),
      cmp.length ? h('div', {class: 'stack'},
        h('div', {class: 'table-wrap'}, h('table', null,
          h('thead', null, h('tr', null, h('th', null, ''), MONTHS.map((m) => h('th', {class: 'r'}, m)))),
          h('tbody', null, cmpRow('Lazada', 'lazada', 'manual'), cmpRow('Lazada', 'lazada', 'app'), cmpRow('Lazada', 'lazada', 'diff'),
            cmpRow('Shopee', 'shopee', 'manual'), cmpRow('Shopee', 'shopee', 'app'), cmpRow('Shopee', 'shopee', 'diff')))),
        h('p', {class: 'note'}, 'Synced orders are counted before fees, by order date, without cancelled or returned orders. The first month of syncing may be partial. A difference does not always mean one side is wrong (the entered figure may follow the payout date), but it is worth checking.'
          + (est.length ? ` ${est.join(', ')} include estimated amounts.` : '')))
        : h('p', {class: 'empty'}, 'No synced orders for this year.')));
  },

  async wealth(host, tab = 'cards') {
    const tabs = h('div', {class: 'tabs', role: 'tablist'}, [['cards', 'Wealth Cards'], ['family', 'Family Statement']].map(([id, label]) =>
      h('button', {type: 'button', role: 'tab', 'aria-selected': String(id === tab), onclick: () => go('wealth', id)}, label)));
    host.append(h('div', {class: 'page-head'}, h('h2', {class: 'page-title'}, 'Wealth'), tabs));
    if (tab === 'family') {
      const f = await api('GET', '/api/family');
      if (!f.available) { host.append(h('article', {class: 'card'}, h('p', {class: 'note warn'}, f.reason))); return; }
      host.append(h('p', {class: 'note'}, 'The family’s joint account, read from the ledger Maki keeps. Its balance is Counted under EMC; every change in it is treated as a deposit or withdrawal, so it never shows as return. Entries are added in the ledger, not here.'),
        h('div', {class: 'tiles'}, tile('Balance', baht(f.balance)), tile('Last entry', fmtDay(f.last_date) || '—')),
        h('article', {class: 'card'}, h('h2', {class: 'card-title'}, 'By month'), h('div', {class: 'table-wrap'}, h('table', null,
          h('thead', null, h('tr', null, ['Month', 'Income', 'Expense', 'Net', 'Entries'].map((t, i) => h('th', {class: i ? 'r' : ''}, t)))),
          h('tbody', null, [...f.months].reverse().map((m) => h('tr', null, h('td', null, monthLabel(m.month)), h('td', {class: 'r'}, baht(m.income)),
            h('td', {class: 'r'}, baht(m.expense)), h('td', {class: `r ${signClass(m.net)}`}, baht(m.net)), h('td', {class: 'r'}, m.count))))))),
        h('article', {class: 'card'}, h('h2', {class: 'card-title'}, 'Ledger'), h('div', {class: 'table-wrap'}, h('table', null,
          h('thead', null, h('tr', null, ['Date', 'Category', 'Detail', 'Income', 'Expense', 'Balance', 'By'].map((t, i) => h('th', {class: i > 2 && i < 6 ? 'r' : ''}, t)))),
          h('tbody', null, [...f.transactions].reverse().map((t) => h('tr', null, h('td', {class: 'nowrap'}, fmtDay(t.date)), h('td', null, t.category), h('td', {class: 'wrap'}, t.detail),
            h('td', {class: 'r'}, t.income ? baht(t.income) : ''), h('td', {class: 'r'}, t.expense ? baht(t.expense) : ''), h('td', {class: 'r'}, baht(t.balance)), h('td', {class: 'muted'}, t.recorded_by))))))));
      return;
    }
    const cards = (await api('GET', '/api/accounts')).filter((a) => a.bucket === 'wealth');
    const again = () => go('wealth');
    const cardFields = [
      {key: 'name', label: 'Name', type: 'text', required: true},
      {key: 'allocation', label: 'Shown in Asset Allocation as', type: 'select', options: [['saving', 'Saving'], ['emc', 'EMC']]},
      {key: 'counts_in_total', label: 'Counted in Total Portfolio Value', type: 'check'},
      {key: 'note', label: 'Note', type: 'text'},
    ];
    const addCard = () => openForm({
      title: 'Add Wealth Card', values: {currency: 'THB', allocation: 'saving', counts_in_total: 1, opening_date: today()},
      fields: [cardFields[0], {key: 'currency', label: 'Currency', type: 'text', hint: 'THB, USDT, USD …'}, ...cardFields.slice(1),
        {key: 'opening_value', label: 'Opening value', type: 'number', hint: 'in the card’s currency; recorded as a deposit so it never shows as return'},
        {key: 'opening_fx_rate', label: 'FX rate', type: 'number', hint: 'THB per 1 unit; leave blank for THB'},
        {key: 'opening_date', label: 'Opening date', type: 'date'}],
      submit: async (values) => { await api('POST', '/api/accounts', {...values, bucket: 'wealth'}); toast('Card added.'); again(); },
    });
    const editCard = (a) => openForm({
      title: `Edit — ${a.name}`, values: a, fields: [...cardFields, {key: 'active', label: 'Active', type: 'check'}],
      submit: async (values) => { await api('PUT', `/api/accounts/${a.id}`, values); toast('Saved.'); again(); },
    });
    host.append(h('div', {class: 'card-head'}, h('p', {class: 'note'}, 'Cards Best adds and values by hand. Each one is either Counted in Total Portfolio Value or Display-only.'),
      h('button', {type: 'button', class: 'btn dark', onclick: addCard}, '+ Add card')),
      h('div', {class: 'cards'}, cards.map((a) => {
        const value = a.live ? a.live.value_thb : a.snapshot && a.snapshot.value_thb;
        const asOf = a.live ? a.live.as_of : a.snapshot && a.snapshot.as_of;
        return h('article', {class: 'card'},
          h('div', {class: 'card-head'}, h('div', {class: 'tile-label'}, a.name), h('button', {type: 'button', class: 'btn small', onclick: () => editCard(a)}, 'Edit')),
          h('div', {class: 'tile-value'}, baht(value)),
          h('div', {class: 'tile-sub'}, asOf ? `as of ${asOf}` : 'no value yet', a.snapshot && a.currency !== 'THB' ? ` · ${number(a.snapshot.value_native)} ${a.currency}` : ''),
          h('div', {class: 'tile-sub'}, h('span', {class: `badge ${a.counts_in_total ? 'on' : ''}`}, a.counts_in_total ? 'Counted' : 'Display-only'),
            h('span', {class: 'badge'}, GROUPS[a.group][0]), a.source === 'manual' ? null : h('span', {class: 'badge'}, 'from ledger')));
      })), ...accountLists(cards, again));
  },

  async expense(host) {
    const lines = await api('GET', '/api/cashflow');
    host.append(pageHead('Expense', 'Best’s own Cash Flow by month: income by source, fixed costs, and what went to each Bucket.'));
    const months = [...new Set(lines.map((l) => l.month))].sort().reverse();
    const sum = (month, section) => lines.filter((l) => l.month === month && l.section === section).reduce((t, l) => t + l.amount_thb, 0);
    if (months.length) {
      host.append(h('article', {class: 'card'}, h('h2', {class: 'card-title'}, 'By month'), h('div', {class: 'table-wrap'}, h('table', null,
        h('thead', null, h('tr', null, ['Month', 'Income', 'Fixed costs', 'To Buckets', 'Left over'].map((t, i) => h('th', {class: i ? 'r' : ''}, t)))),
        h('tbody', null, months.map((m) => {
          const left = sum(m, 'income') - sum(m, 'fixed_cost') - sum(m, 'allocation');
          return h('tr', null, h('td', null, monthLabel(m)), h('td', {class: 'r'}, baht(sum(m, 'income'))), h('td', {class: 'r'}, baht(sum(m, 'fixed_cost'))),
            h('td', {class: 'r'}, baht(sum(m, 'allocation'))), h('td', {class: `r ${signClass(left)}`}, baht(left)));
        }))))));
    }
    host.append(crud({
      title: 'Cash Flow lines', resource: 'cashflow', onChange: () => go('expense'),
      note: 'Money sent to the family account is one fixed-cost line here.',
      defaults: () => ({month: today().slice(0, 7), section: 'fixed_cost'}),
      columns: [
        {key: 'month', label: 'Month', type: 'text', required: true, hint: 'YYYY-MM', show: (r) => monthLabel(r.month), cls: 'nowrap'},
        {key: 'section', label: 'Section', type: 'select', options: [['income', 'Income'], ['fixed_cost', 'Fixed cost'], ['allocation', 'To a Bucket']]},
        {key: 'line', label: 'Line', type: 'text', required: true},
        {key: 'amount_thb', label: 'Amount', type: 'money', required: true, cls: 'r'},
        {key: 'note', label: 'Note', type: 'text'},
        {key: 'entered_by', label: 'By', form: false, cls: 'muted'},
      ],
    }));
  },

  async plan(host) {
    const d = await api('GET', '/api/home');
    host.append(pageHead('Plan', 'Goal for each Bucket by year, against its current value.'));
    if (d.goals.length) {
      host.append(h('article', {class: 'card'}, h('h2', {class: 'card-title'}, `${d.goals[0].year} so far`), h('div', {class: 'table-wrap'}, h('table', null,
        h('thead', null, h('tr', null, ['Bucket', 'Now', 'Goal', 'Progress'].map((t, i) => h('th', {class: i ? 'r' : ''}, t)))),
        h('tbody', null, d.goals.map((g) => h('tr', null, h('td', null, g.bucket[0].toUpperCase() + g.bucket.slice(1)), h('td', {class: 'r'}, baht(g.actual_thb)),
          h('td', {class: 'r'}, baht(g.goal_thb)), h('td', {class: 'r'}, pct(g.progress)))))))));
    }
    host.append(crud({
      title: 'Goals', resource: 'goals', onChange: () => go('plan'),
      note: 'A Goal with no Bucket (such as OnTheWall) is kept for the record and is outside Total Portfolio Value.',
      defaults: () => ({year: new Date().getFullYear(), bucket: 'investment'}),
      columns: [
        {key: 'year', label: 'Year', type: 'number', required: true, show: (r) => r.year},
        {key: 'name', label: 'Name', type: 'text', required: true},
        {key: 'bucket', label: 'Bucket', type: 'select', options: [['investment', 'Investment'], ['trading', 'Trading'], ['wealth', 'Wealth'], ['', 'None']]},
        {key: 'goal_thb', label: 'Goal', type: 'money', required: true, cls: 'r'},
      ],
    }));
  },

  async assets(host) {
    const d = await api('GET', '/api/networth');
    host.append(pageHead('All Asset Class', 'Everything Best owns and owes. Values here are Best’s own estimates and never affect Monthly Return.'),
      h('div', {class: 'tiles'}, tile('Total Portfolio Value', baht(d.portfolio_thb)), tile('Other assets', baht(d.other_assets_thb)),
        tile('Debts', baht(d.debt_thb)), tile('Net Worth', baht(d.net_worth_thb))),
      crud({
        title: 'Assets', resource: 'assets', onChange: () => go('assets'),
        defaults: () => ({valued_on: today(), asset_class: 'Property', debt_thb: 0}),
        columns: [
          {key: 'name', label: 'Asset', type: 'text', required: true},
          {key: 'asset_class', label: 'Class', type: 'text', required: true, hint: 'Property, Land, Business, Vehicle …'},
          {key: 'value_thb', label: 'Value', type: 'money', required: true, cls: 'r'},
          {key: 'valued_on', label: 'Valued on', type: 'date', required: true, cls: 'nowrap'},
          {key: 'debt_thb', label: 'Debt against it', type: 'money', cls: 'r'},
          {key: 'monthly_income_thb', label: 'Monthly income', type: 'money', table: false},
          {key: 'monthly_cost_thb', label: 'Monthly cost', type: 'money', table: false},
          {key: 'note', label: 'Note', type: 'text', cls: 'wrap'},
        ],
      }));
  },

  async advise(host) {
    host.append(pageHead('Maki Advise', 'Observations Maki records, comparing actual figures with Best’s own plan and rules. Never a call to buy or sell.'), crud({
      title: 'Advice Notes', resource: 'advice',
      defaults: () => ({noted_on: today()}),
      columns: [
        {key: 'noted_on', label: 'Date', type: 'date', required: true, cls: 'nowrap'},
        {key: 'topic', label: 'Topic', type: 'text', required: true},
        {key: 'body', label: 'Note', type: 'textarea', required: true, cls: 'wrap', show: (r) => h('span', {class: 'advice-body'}, r.body)},
        {key: 'entered_by', label: 'By', form: false, cls: 'muted'},
      ],
    }));
  },

  async history(host) {
    const entries = await api('GET', '/api/audit?limit=200');
    const brief = (e) => {
      const row = JSON.parse(e.after || e.before || '{}');
      return Object.entries(row).filter(([k]) => !['id', 'created_at', 'updated_at', 'entered_by'].includes(k)).slice(0, 5).map(([k, v]) => `${k}: ${v}`).join(' · ');
    };
    const undo = async (e) => {
      try { await api('POST', `/api/audit/${e.id}/undo`); toast('Undone.'); go('history'); } catch (err) { toast(err.message); }
    };
    host.append(pageHead('History', 'Every change made through the dashboard or by Maki, newest first. Any of them can be undone.'),
      h('article', {class: 'card'}, h('div', {class: 'table-wrap'}, h('table', null,
        h('thead', null, h('tr', null, ['When', 'Who', 'Change', 'What'].map((t) => h('th', null, t)), h('th'))),
        h('tbody', null, entries.length ? entries.map((e) => h('tr', null, h('td', {class: 'nowrap'}, e.at), h('td', null, e.actor),
          h('td', {class: 'nowrap'}, `${e.action} ${e.tbl} #${e.row_id}`), h('td', {class: 'wrap muted'}, brief(e)),
          h('td', {class: 'actions'}, e.undone_by ? h('span', {class: 'muted'}, 'undone') : h('button', {type: 'button', class: 'btn small', onclick: () => undo(e)}, 'Undo'))))
          : h('tr', null, h('td', {class: 'empty', colspan: 5}, 'No changes yet.')))))));
  },
};

// ---------------------------------------------------------------- routing
let renderToken = 0;
let resizeTimer;
window.addEventListener('resize', () => {           // charts are drawn at their box width, so redraw after a resize
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (!$('#dialog').open) go(location.hash.slice(1) || 'home'); }, 250);
});
// the line after the logo in the top bar: what this page is and how fresh its figures are (Home writes its own sentence)
let statusMonth = '';
const PAGE_NAMES = {investment: 'Investment Portfolio', trading: 'Trading Portfolio', shop: 'EMBRACE Shop', wealth: 'Wealth', expense: 'Expense',
  plan: 'Plan', assets: 'All Asset Class', advise: 'Maki Advise', history: 'History'};
function setStatus(name) {
  if (name === 'home') { if (statusMonth) $('#sub').textContent = `Here is how everything stood at the end of ${statusMonth}.`; return; }
  const month = name === 'history' || name === 'advise' ? '' : statusMonth;
  $('#sub').textContent = `${PAGE_NAMES[name] || name}${month ? ` · figures to the end of ${month}` : ''}`;
}

async function go(name, arg) {
  if (!pages[name]) name = 'home';
  setStatus(name);
  if (location.hash.slice(1) !== name) history.replaceState(null, '', `#${name}`);
  for (const b of document.querySelectorAll('#nav button, #nav-advise button')) {
    if (b.dataset.page === name) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  const token = ++renderToken;
  // the page renders into a host that is already in the document, because charts size themselves from their box;
  // a slower, older navigation keeps writing to its own detached host and is never shown
  const host = h('div', {class: 'stack'});
  $('#page').replaceChildren(host);
  try {
    await pages[name](host, arg);
  } catch (e) {
    if (token === renderToken) host.replaceChildren(h('article', {class: 'card'}, h('p', {class: 'note warn'}, `Could not load this page: ${e.message}`)));
  }
}

// ---------------------------------------------------------------- profile photo (the avatar before "Welcome")
function showAvatar(image) {
  const box = $('#avatar');
  box.style.backgroundImage = image ? `url("${image}")` : '';
  box.classList.toggle('has-photo', Boolean(image));
}

// shrink to a 256 px square (centre crop) so the stored photo stays small
function shrinkPhoto(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const side = Math.min(img.naturalWidth, img.naturalHeight), size = 256;
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      canvas.getContext('2d').drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file is not an image the browser can open.')); };
    img.src = url;
  });
}

async function editAvatar() {
  const dialog = $('#dialog');
  const error = h('div', {class: 'form-error'});
  const preview = h('div', {class: 'avatar-preview'});
  const current = $('#avatar').classList.contains('has-photo') ? $('#avatar').style.backgroundImage : '';
  preview.style.backgroundImage = current;
  let picked = null;
  const file = h('input', {type: 'file', accept: 'image/*', hidden: true});
  file.addEventListener('change', async () => {
    error.textContent = '';
    if (!file.files[0]) return;
    try {
      picked = await shrinkPhoto(file.files[0]);
      preview.style.backgroundImage = `url("${picked}")`;
      save.disabled = false;
    } catch (e) { error.textContent = e.message; }
  });
  const save = h('button', {type: 'submit', class: 'btn dark', disabled: true}, 'Save');
  const remove = h('button', {type: 'button', class: 'btn danger', onclick: async () => {
    try { await api('PUT', '/api/avatar', {image: null}); showAvatar(null); dialog.close(); toast('Photo removed.'); } catch (e) { error.textContent = e.message; }
  }}, 'Remove photo');
  const form = h('form', {class: 'form', method: 'dialog'}, h('h2', null, 'Profile photo'), preview, file,
    h('button', {type: 'button', class: 'btn', onclick: () => file.click()}, 'Choose a photo…'),
    h('p', {class: 'note'}, 'The photo is cropped to a square and shrunk before it is saved. It stays on this computer, in the dashboard’s data folder.'),
    error,
    h('div', {class: 'form-buttons'}, current ? remove : null, h('button', {type: 'button', class: 'btn', onclick: () => dialog.close()}, 'Cancel'), save));
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!picked) return;
    try { await api('PUT', '/api/avatar', {image: picked}); showAvatar(picked); dialog.close(); toast('Photo saved.'); } catch (e) { error.textContent = e.message; }
  });
  dialog.replaceChildren(form);
  dialog.showModal();
}
$('#avatar').addEventListener('click', editAvatar);
api('GET', '/api/avatar').then((a) => showAvatar(a.image)).catch(() => {});

// ---------------------------------------------------------------- sidebar links (Discord, Telegram)
const LINK_ICON = {
  Discord: '<path d="M6 7c2-1 4-1.500 6-1.500S16 6 18 7c1.500 3 2 6 2 9-1.500 1-3 1.500-4.500 1.700l-1-1.700a9 9 0 01-5 0l-1 1.700C7 17.500 5.500 17 4 16c0-3 .5-6 2-9z"/><circle cx="9.500" cy="12" r="1"/><circle cx="14.500" cy="12" r="1"/>',
  Telegram: '<path d="M21 4L3 11l6 2 2 6 3-4 4 3z"/><path d="M9 13l8-6"/>',
};
async function renderLinks() {
  const box = $('#side-links');
  let links = [];
  try { links = await api('GET', '/api/links'); } catch (e) { return; }
  box.replaceChildren(...links.map((l) => {
    const icon = () => { const n = svg('svg', {viewBox: '0 0 24 24', 'aria-hidden': 'true'}); n.innerHTML = LINK_ICON[l.name] || LINK_ICON.Telegram; return n; };
    const edit = () => openForm({
      title: `${l.name} link`, values: l,
      fields: [{key: 'url', label: 'Address', type: 'text', placeholder: 'https://discord.gg/… or https://t.me/…', hint: 'must start with https://'}],
      submit: async (values) => { await api('PUT', `/api/links/${l.id}`, values); renderLinks(); },
    });
    return h('span', {class: 'link-wrap'},
      l.url ? h('a', {class: 'link', href: l.url, target: '_blank', rel: 'noopener noreferrer'}, icon(), l.name)
            : h('button', {type: 'button', class: 'link unset', onclick: edit, title: 'Set the address'}, icon(), l.name),
      h('button', {type: 'button', class: 'edit', onclick: edit, 'aria-label': `Edit ${l.name} link`}, 'Edit'));
  }));
}
renderLinks();
api('GET', '/api/home').then((d) => { if (d.kpis) { statusMonth = monthLabel(d.kpis.month); setStatus((location.hash.slice(1) || 'home')); } }).catch(() => {});

for (const nav of [$('#nav'), $('#nav-advise')]) {
  nav.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-page]');
    if (button) go(button.dataset.page);
  });
}
window.addEventListener('hashchange', () => go(location.hash.slice(1)));
go(location.hash.slice(1) || 'home');
