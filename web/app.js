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
// extra: [{label, class, onclick}] more buttons beside Cancel (the dialog closes when onclick succeeds)
function openForm({title, fields, values = {}, submit, extra = []}) {
  const dialog = $('#dialog');
  const error = h('div', {class: 'form-error'});
  const inputs = {};
  const rows = fields.map((f) => {
    let input;
    const value = values[f.key];
    if (f.type === 'select') {
      input = h('select', null, f.options.map(([v, label]) => h('option', {value: v == null ? '' : v}, label)));
      input.value = value == null ? '' : value;
    } else if (f.type === 'pick') {          // a list of names, and "Other…" to type a new one
      input = h('select', null, [...f.options.map((o) => h('option', {value: o}, o)), h('option', {value: '__other'}, 'Other…')]);
      const known = f.options.includes(value);
      input.value = known ? value : (value ? '__other' : f.options[0]);
      input.other = h('input', {type: 'text', placeholder: f.otherPlaceholder || 'Type the name'});
      input.other.value = value && !known ? value : '';
      input.other.hidden = input.value !== '__other';
      input.addEventListener('change', () => { input.other.hidden = input.value !== '__other'; if (!input.other.hidden) input.other.focus(); });
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
    return h('label', {class: 'field'}, f.hint ? `${f.label} — ${f.hint}` : f.label, input, input.other || null);
  });
  const form = h('form', {class: 'form', method: 'dialog'}, h('h2', null, title), rows, error,
    h('div', {class: 'form-buttons'},
      extra.map((x) => h('button', {type: 'button', class: x.class || 'btn', onclick: async () => {
        try { await x.onclick(); dialog.close(); } catch (e) { error.textContent = e.message; }
      }}, x.label)),
      h('button', {type: 'button', class: 'btn', onclick: () => dialog.close()}, 'Cancel'),
      h('button', {type: 'submit', class: 'btn dark'}, 'Save')));
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const body = {};
    for (const f of fields) {
      const input = inputs[f.key];
      if (f.type === 'check') body[f.key] = input.checked ? 1 : 0;
      else if (f.type === 'number') body[f.key] = numberOf(input);
      else if (f.type === 'pick') body[f.key] = (input.value === '__other' ? input.other.value.trim() : input.value) || null;
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
// the year a list was last shown for, so an edit that redraws the page does not jump back to the newest year
const crudYear = {};

// cfg.byYear: (row) => 'YYYY' puts year tabs in the card head and lists one year at a time (newest first)
function crud(cfg) {
  const body = h('tbody');
  const yearBox = h('div', {class: 'tabs year-tabs', role: 'tablist'});
  const shown = cfg.columns.filter((c) => c.table !== false);
  const editable = cfg.columns.filter((c) => c.form !== false);
  const card = h('article', {class: 'card'},
    h('div', {class: 'card-head'}, h('h2', {class: cfg.caps ? 'caps' : 'card-title'}, cfg.title),
      h('span', {class: 'row-gap'}, cfg.headExtra || null, cfg.byYear ? yearBox : null, cfg.noAdd ? null : h('button', {type: 'button', class: 'btn small add', onclick: () => edit(null)}, cfg.addLabel || '+ Add'))),
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
    if (cfg.sort) rows = [...rows].sort(cfg.sort);
    if (cfg.byYear) {
      const years = [...new Set(rows.map(cfg.byYear))].sort().reverse();
      const key = cfg.title, year = years.includes(crudYear[key]) ? crudYear[key] : years[0];
      yearBox.replaceChildren(...(years.length > 1 ? years.map((y) => h('button', {type: 'button', role: 'tab', 'aria-selected': String(y === year),
        onclick: () => { crudYear[key] = y; refresh(); }}, y)) : []));
      rows = rows.filter((r) => cfg.byYear(r) === year);
    }
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

// rows: [{month, ...}], series: [{key, name, color, dash, width}], opts: {format, fromZero, bars: {key, name, color}}
// bars draw one column per row behind the lines, on the same scale; the first series stays the one the hover rule follows
function lineChart(host, rows, series, opts = {}) {
  const format = opts.format || signedPct;
  host.replaceChildren();
  const bars = opts.bars;
  const values = rows.flatMap((r) => [...series.map((s) => r[s.key]), bars ? r[bars.key] : null]).filter((v) => v != null);
  if (rows.length < 2 || !values.length) { host.append(h('div', {class: 'empty'}, 'Not enough months to draw yet.')); return; }
  const W = Math.max(280, host.clientWidth), H = 280;
  const ticks = niceTicks(opts.fromZero === false ? Math.min(...values) : Math.min(0, ...values),
    opts.fromZero === false ? Math.max(...values) : Math.max(0, ...values));
  const lo = ticks[0], hi = ticks[ticks.length - 1];
  const axis = opts.axisFormat || format;
  const m = {top: 14, right: 16, bottom: 28, left: Math.max(...ticks.map((t) => axis(t).length)) * 6.6 + 14};
  const slot = (W - m.left - m.right) / rows.length;       // with bars every row owns a slot and its column is centred in it
  const x = (i) => (bars ? m.left + (i + 0.5) * slot : m.left + (i * (W - m.left - m.right)) / (rows.length - 1));
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
    const anchor = opts.xAnchor === 'fit' ? (i === 0 ? 'start' : i === rows.length - 1 ? 'end' : 'middle') : opts.xLabel ? 'start' : 'middle';
    const label = svg('text', {class: 'tick', x: x(i), y: H - 8, 'text-anchor': anchor});
    label.textContent = text;
    root.append(label);
  });
  if (bars) {
    rows.forEach((r, i) => {
      if (r[bars.key] == null) return;
      const top = y(Math.max(r[bars.key], 0)), bottom = y(Math.min(r[bars.key], 0)), w = Math.min(46, slot * 0.56);
      root.append(svg('rect', {x: x(i) - w / 2, y: top, width: w, height: Math.max(1, bottom - top), rx: 4, fill: bars.color}));
    });
  }
  const lead0 = series[0];
  const lp = rows.map((r, i) => (r[lead0.key] == null ? null : [x(i), y(r[lead0.key])])).filter(Boolean);
  if (lp.length > 1 && !bars) {
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
    let i = bars ? Math.floor((px - m.left) / slot) : Math.round(((px - m.left) / (W - m.left - m.right)) * (rows.length - 1));
    i = Math.min(rows.length - 1, Math.max(0, i));
    const r = rows[i];
    const cy = r[lead.key] == null ? H - m.bottom : y(r[lead.key]);
    rule.setAttribute('x1', x(i)); rule.setAttribute('x2', x(i)); rule.setAttribute('y1', cy);
    for (const n of [halo, ring]) { n.setAttribute('cx', x(i)); n.setAttribute('cy', cy); }
    for (const n of [rule, halo, ring]) n.setAttribute('visibility', 'visible');
    tip.replaceChildren(h('div', {class: 'tip-head'}, monthLabel(r.month)),
      ...series.map((s) => h('div', {class: 'tip-line'},
        h('span', {class: 'tip-name'}, h('i', {class: 'tip-dot', style: `background: ${s.color}`}), s.name), h('b', null, r[s.key] == null ? '—' : format(r[s.key])))),
      ...(bars ? [h('div', {class: 'tip-line'}, h('span', {class: 'tip-name'}, h('i', {class: 'tip-dot', style: `background: ${bars.color}`}), bars.name), h('b', null, r[bars.key] == null ? '—' : format(r[bars.key])))] : []),
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
const GROUPS = {investment: ['Stock', 'var(--mint)', 'investment'], trading: ['Trading', 'var(--ink)', 'trading'],
  saving: ['Bitcoin', 'var(--tan-light)', 'wealth'], emc: ['Cash', 'var(--tan)', 'wealth']};     // shown as Cash (Family Statement) and Bitcoin (Crypto)

function tile(label, value, delta, valueSign, sub, change, badge) {
  // change: the same move in baht, shown between the % and the caption ("−1.1%  −฿11,192  MoM")
  // badge: a small box in the top right corner (the FX rate on the Trading tiles)
  return h('article', {class: 'card', style: badge ? 'position:relative' : null},
    badge ? h('span', {class: 'chip', style: 'position:absolute;top:10px;right:10px;font-size:11px'}, badge) : null,
    h('div', {class: 'tile-label'}, label),
    h('div', {class: `tile-value ${valueSign == null ? '' : signClass(valueSign)}`}, value),
    delta === undefined ? (sub ? h('div', {class: 'tile-sub'}, sub) : null)
      : h('div', {class: 'tile-sub'}, h('span', {class: `delta ${signClass(delta)}`}, signedPct(delta)),
        change == null ? null : h('b', {class: `tile-return-val ${signClass(change)}`}, baht(change)), h('span', null, sub || 'MoM')));
}

// Performance Vs Benchmarks: growth in value (deposits counted) against SET. Two views: this year from the previous
// December's close, and since 2023. Used by Home (Total Portfolio) and Stock. The caller draws it once it is in the page.
function performanceCard({year, rowsYear, rowsAll, nameYear, nameAll, legend, bench = 'SET', title = 'Performance Vs Benchmarks', valueFmt = baht, yearTab}) {
  const key = bench.toLowerCase();
  const modes = {return: {tab: yearTab || `Since Jan ${year}`, rows: rowsYear, name: nameYear, gap: true}};
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

const prevMonth = (m) => { const y = Number(m.slice(0, 4)), n = Number(m.slice(5, 7)); return n === 1 ? `${y - 1}-12` : `${y}-${String(n - 1).padStart(2, '0')}`; };

function bucketStatTiles(st, {fmt = baht, cagrNote = 'deposits counted', badge, drawdown} = {}) {
  if (!st) return [];
  const abbr = (short, full) => h('span', null, short, h('span', {class: 'tile-abbr'}, full));
  const dec = `Dec ${Number(st.month.slice(0, 4)) - 1}`;
  return [
    tile('Monthly Return', fmt(st.monthly_amount), st.monthly_pct, st.monthly_amount, undefined, undefined, badge),
    tile(abbr('YTD', 'Year to date'), fmt(st.ytd_amount), st.ytd_pct, st.ytd_amount, `since ${dec} close`, undefined, badge),
    tile(abbr('CAGR', 'Compound annual growth rate'), st.cagr == null ? '—' : signedPct(st.cagr), undefined, st.cagr,
      st.cagr == null ? (st.cagr_months === undefined ? `needs 12 months of history (since ${monthLabel(st.cagr_since)})` : `needs 3 months of trades (since ${monthLabel(st.cagr_since)})`)
        : st.cagr_months != null && st.cagr_months < 12 ? h('span', {title: `Annualised from ${st.cagr_months} months, not a full year`}, `since ${monthLabel(st.cagr_since)}`)
        : `since ${monthLabel(st.cagr_since)} · ${cagrNote}`),
    ...(drawdown && st.mdd != null ? [tile('Max Drawdown', st.mdd ? `−${pct(st.mdd)}` : '0.0%', st.mdd - st.mdd_prev, st.mdd, `vs ${monthLabel(prevMonth(st.month))} (${st.mdd_prev ? `−${pct(st.mdd_prev)}` : '0.0%'})`)] : [])];
}

// tabs (optional): the year tabs at the top right; the note then drops to its own line
function pageHead(title, note, tabs) {
  if (tabs) return h('div', {class: 'page-head'}, h('h2', {class: 'page-title'}, title), tabs, note ? h('p', {class: 'note', style: 'flex-basis: 100%; margin: 0'}, note) : null);
  return h('div', {class: 'page-head'}, h('h2', {class: 'page-title'}, title), note ? h('p', {class: 'note'}, note) : null);
}

// year tabs for a page: `go(page, year)` on click
function yearTabs(page, years, current) {
  return h('div', {class: 'tabs', role: 'tablist'}, years.map((y) =>
    h('button', {type: 'button', role: 'tab', 'aria-selected': String(y === current), onclick: () => go(page, y)}, y)));
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

// ---------------------------------------------------------------- benchmark prices inside a month's form
// A table of the month's benchmark prices (names: which benchmarks this page may enter), saved as Benchmark rows. A price
// left empty is no price; clearing one that was saved removes it. Existing prices keep their own date, new ones take `date`.
function benchmarkField({all, row, date, names, defaults}) {
  const monthOf = (iso) => (iso || '').slice(0, 7);
  const inMonth = (b) => row && names.includes(b.name) && monthOf(b.as_of) === monthOf(row.as_of);
  const rows = [], removed = [];
  const body = h('tbody');
  const addBench = (b) => {
    const name = h('select', {'aria-label': 'Benchmark'}, [...new Set([...names, b.name])].map((n) => h('option', {value: n}, n)));
    name.value = b.name;
    const price = numberInput(b.value, {class: 'num', 'aria-label': 'Price', placeholder: '—'});
    const entry = {id: b.id || null, as_of: b.as_of || null, name, price};
    const tr = h('tr', null, h('td', null, name), h('td', null, price), h('td', {class: 'muted small'}, b.as_of ? fmtDay(b.as_of) : ''),
      h('td', null, h('button', {type: 'button', class: 'x', title: 'Remove row', 'aria-label': 'Remove row', onclick: () => {
        tr.remove(); rows.splice(rows.indexOf(entry), 1); if (entry.id) removed.push(entry.id);
      }}, '×')));
    rows.push(entry);
    body.append(tr);
  };
  const have = all.filter(inMonth);
  have.forEach(addBench);
  for (const n of defaults) if (!have.some((b) => b.name === n)) addBench({name: n});      // an empty row to type into
  return {
    nodes: [h('div', {class: 'field'}, 'Benchmark prices (month-end close)',
      h('table', {class: 'hold'}, h('thead', null, h('tr', null, h('th', null, 'Benchmark'), h('th', {class: 'num'}, 'Price'), h('th', null, ''), h('th'))), body)),
    h('div', {class: 'hold-total'}, h('button', {type: 'button', class: 'btn small add', onclick: () => addBench({name: names[0]})}, '+ Add benchmark'), h('span'))],
    validate() {
      const typed = rows.filter((b) => numberOf(b.price) != null);
      if (typed.some((b) => numberOf(b.price) <= 0)) return 'A benchmark price must be above zero (leave it empty for none).';
      if (new Set(typed.map((b) => `${b.name.value}|${b.as_of || date.value}`)).size !== typed.length) return 'The same benchmark appears twice for one date.';
      return '';
    },
    async save() {       // after the snapshot is saved; one audited write each. Returns a message if one failed.
      try {
        for (const id of removed) await api('DELETE', `/api/benchmarks/${id}`);
        for (const b of rows) {
          const price = numberOf(b.price);
          if (b.id && price == null) await api('DELETE', `/api/benchmarks/${b.id}`);
          else if (b.id) await api('PUT', `/api/benchmarks/${b.id}`, {name: b.name.value, as_of: b.as_of, value: price});
          else if (price != null) await api('POST', '/api/benchmarks', {name: b.name.value, as_of: date.value, value: price});
        }
        return '';
      } catch (e) { return e.message; }
    },
  };
}

// the Note icon of a month opens the benchmark prices recorded that month (of these names) with its note
function monthNote(r, all, names) {
  const prices = all.filter((b) => names.includes(b.name) && b.as_of.slice(0, 7) === r.as_of.slice(0, 7))
    .map((b) => `${b.name}: ${number(b.value)}${b.as_of === r.as_of ? '' : ` (${fmtDay(b.as_of)})`}`);
  return [prices.length ? `Benchmark prices\n${prices.join('\n')}` : '', r.note || ''].filter(Boolean).join('\n\n');
}

// ---------------------------------------------------------------- Stock Portfolio editor
// One Snapshot per Account and date, entered as a table of holdings (Market, Stock, Qty, Value in THB). The Snapshot's
// value is the sum of the Values; the server does the adding.
const MARKETS = ['SET', 'US', 'HK', 'JP', 'KR', 'CN', 'CASH', 'OTHER'];
const marketLabel = (m) => (m === 'CASH' ? 'Cash' : m === 'OTHER' ? 'Other' : m || '—');
const MARKET_COLORS = {SET: 'var(--mint)', US: 'var(--ink)', HK: 'var(--tan)', JP: 'var(--tan-light)', KR: 'var(--grey)', CN: '#c98a72',
  CASH: '#b8c7d6', OTHER: '#d9d9d4', '': '#e6e6e1'};

async function portfolioEditor(accounts, row, done, allBenchmarks = []) {
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

  const bench = benchmarkField({all: allBenchmarks, row, date, names: ['SET'], defaults: ['SET']});

  const form = h('form', {class: 'form', method: 'dialog'}, h('h2', null, `${row ? 'Edit' : 'Add'} — Stock Portfolio`),
    h('label', {class: 'field'}, 'Account', account),
    h('label', {class: 'field'}, 'Date', date),
    h('div', {class: 'field'}, 'Holdings (values in THB)',
      h('table', {class: 'hold'}, h('thead', null, h('tr', null, h('th', null, 'Market'), h('th', null, 'Stock'), h('th', {class: 'num'}, 'Qty'), h('th', {class: 'num'}, 'Value'), h('th'))), body)),
    h('div', {class: 'hold-total'}, h('button', {type: 'button', class: 'btn small add', onclick: () => addRow({market: 'SET'})}, '+ Add row'),
      h('span', null, 'Total ', total)),
    ...bench.nodes,
    h('label', {class: 'field'}, 'Note', note),
    error,
    h('div', {class: 'form-buttons'}, h('button', {type: 'button', class: 'btn', onclick: () => dialog.close()}, 'Cancel'), h('button', {type: 'submit', class: 'btn dark'}, 'Save')));
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const badPrice = bench.validate();
    if (badPrice) { error.textContent = badPrice; return; }
    const holdings = rowsData.filter((r) => r.stock.value.trim() || numberOf(r.qty) != null || numberOf(r.value) != null)
      .map((r) => ({market: r.market.value, stock: r.stock.value.trim(), qty: numberOf(r.qty), value_thb: numberOf(r.value)}));
    if (!holdings.length || holdings.some((x) => !(x.value_thb > 0))) { error.textContent = 'Every row needs a Value above zero. Remove the rows you do not need.'; return; }
    try {
      await api(row ? 'PUT' : 'POST', `/api/snapshots${row ? '/' + row.id : ''}`,
        {account_id: Number(account.value), as_of: date.value, holdings, note: note.value.trim() || null});
    } catch (e) { error.textContent = e.message; return; }
    const failed = await bench.save();
    dialog.close();
    toast(failed ? `Saved, but a benchmark price was not: ${failed}` : (row ? 'Saved.' : 'Added.'));
    done();
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

// a read-only popup for a long text
function showText(title, text) {
  const dialog = $('#dialog');
  dialog.style.width = 'min(520px, calc(100vw - 32px))';
  dialog.replaceChildren(h('div', {class: 'form'}, h('h2', null, title), h('p', {style: 'white-space: pre-wrap; margin: 0'}, text),
    h('div', {class: 'form-buttons'}, h('button', {type: 'button', class: 'btn', onclick: () => dialog.close()}, 'Close'))));
  dialog.showModal();
}

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
      JOURNAL_COLS.map((c) => h('td', {'data-key': c.key, class: `${c.calc ? 'calc' : ''} ${c.cls || ''} ${c.type === 'note' ? 'note-cell' : ''}`,
        title: c.type === 'note' ? (t.note || '') : null, onclick: c.type === 'note' && t.note ? () => showText(`Note — ${fmtDay(t.traded_on)}`, t.note) : null}, display(c, t))),
      h('td', {class: 'calc'}))));
    if (!rows.length) body.append(h('tr', null, h('td', {class: 'empty', colspan: JOURNAL_COLS.length + 2}, 'No trades yet. Add them in the Excel journal, then press Sync Excel.')));
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
      if (id !== 'dividend') box.append(h('button', {type: 'button', class: 'btn small add', onclick: (e) => e.currentTarget.before(lineRow(id, '', null, true))}, '+ Add line'));
      return box;
    }));
  };
  yearInput.addEventListener('change', fill);
  monthInput.addEventListener('change', fill);
  fill();

  const form = h('form', {class: 'form', method: 'dialog'}, h('h2', null, 'Online Shop — one month'),
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

// ---------------------------------------------------------------- Trading Portfolio editor
// Same idea as the Stock Portfolio form, with the Trading detail kept: Account, Date, Value, FX rate, Note, and the BTC price.
async function tradingEditor(accounts, row, done, allBenchmarks = []) {
  const dialog = $('#dialog');
  dialog.style.width = 'min(560px, calc(100vw - 32px))';
  const error = h('div', {class: 'form-error'});
  const account = h('select', null, accounts.map((a) => h('option', {value: a.id}, `${a.name} (${a.currency})`)));
  account.value = row ? row.account_id : accounts[0].id;
  const date = h('input', {type: 'date', required: true});
  date.value = row ? row.as_of : today();
  const value = numberInput(row ? row.value_native : null, {class: 'num', required: true});
  const fx = numberInput(row && row.fx_rate !== 1 ? row.fx_rate : null, {class: 'num'});
  const fxField = h('label', {class: 'field'}, 'FX rate — THB per 1 unit of the Account’s currency', fx);
  const note = h('input', {type: 'text', placeholder: 'Note (optional)'});
  note.value = row && row.note ? row.note : '';
  const currencyOf = () => (accounts.find((a) => String(a.id) === String(account.value)) || {}).currency || 'THB';
  const valueLabel = h('span', null);
  const sync = async (prefill) => {
    const cur = currencyOf();
    fxField.hidden = cur === 'THB';
    valueLabel.textContent = `Value (${cur})`;
    if (prefill && cur !== 'THB' && !row) {          // a new month starts from the last rate used for this Account
      try { const last = (await api('GET', `/api/snapshots?account_id=${account.value}`))[0]; if (last && last.fx_rate !== 1 && !fx.value) fx.value = groupDigits(last.fx_rate); } catch (e) { /* type it */ }
    }
  };
  account.addEventListener('change', () => sync(true));
  await sync(true);
  const bench = benchmarkField({all: allBenchmarks, row, date, names: ['BTC'], defaults: ['BTC']});
  const form = h('form', {class: 'form', method: 'dialog'}, h('h2', null, `${row ? 'Edit' : 'Add'} — Trading Portfolio`),
    h('label', {class: 'field'}, 'Account', account),
    h('label', {class: 'field'}, 'Date', date),
    h('label', {class: 'field'}, valueLabel, value),
    fxField,
    ...bench.nodes,
    h('label', {class: 'field'}, 'Note', note),
    error,
    h('div', {class: 'form-buttons'}, h('button', {type: 'button', class: 'btn', onclick: () => dialog.close()}, 'Cancel'), h('button', {type: 'submit', class: 'btn dark'}, 'Save')));
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const amount = numberOf(value);
    if (amount == null) { error.textContent = 'Enter the value.'; return; }
    const rate = numberOf(fx);
    if (currencyOf() !== 'THB' && !(rate > 0)) { error.textContent = `Enter the FX rate (THB per 1 ${currencyOf()}).`; return; }
    const badPrice = bench.validate();
    if (badPrice) { error.textContent = badPrice; return; }
    try {
      await api(row ? 'PUT' : 'POST', `/api/snapshots${row ? '/' + row.id : ''}`,
        {account_id: Number(account.value), as_of: date.value, value_native: amount, fx_rate: currencyOf() === 'THB' ? null : rate, note: note.value.trim() || null});
    } catch (e) { error.textContent = e.message; return; }
    const failed = await bench.save();
    dialog.close();
    toast(failed ? `Saved, but a benchmark price was not: ${failed}` : (row ? 'Saved.' : 'Added.'));
    done();
  });
  dialog.replaceChildren(form);
  dialog.showModal();
}

// Snapshots and Flows lists for a set of Accounts (used by Stock, Trading and Wealth)
function accountLists(accounts, rerender) {
  const manual = accounts.filter((a) => a.source === 'manual');
  const ids = new Set(manual.map((a) => a.id));
  const byId = new Map(manual.map((a) => [a.id, a]));
  const name = (row) => (byId.get(row.account_id) || {}).name || '';
  const options = accountOptions(manual);
  if (!manual.length) return [];
  return [
    crud({
      title: 'Monthly values', resource: 'snapshots', filter: (r) => ids.has(r.account_id), byYear: (r) => r.as_of.slice(0, 4), onChange: rerender,
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
      title: 'Deposits and withdrawals', resource: 'flows', filter: (r) => ids.has(r.account_id), byYear: (r) => r.on_date.slice(0, 4), onChange: rerender,
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
// ---------------------------------------------------------------- Cash Flow log editor
// Where the money goes, picked step by step: what kind of money (buttons), which month, which item (a list, so every month spells
// it the same way), the amount and a note. "Other" is for something new; once saved it joins the list.
const CASHFLOW_TYPES = [
  ['income', 'Income', 'Money coming in', 'Source'],
  ['fixed_cost', 'Fixed costs', 'Costs that repeat every month', 'Item'],
  ['allocation', 'Reinvest', 'Money moved into another asset; also recorded as a deposit in Stock, Trading or Saving Bitcoin', 'Reinvest into'],
  ['expense', 'Expense', 'Everyday and one-off spending', 'What for'],
];
const CASHFLOW_ITEMS = {
  income: ['Salary', 'Online Shop', 'Trading', 'Stock dividend'],
  fixed_cost: ['House debt', 'Living Cost', 'Life Ins', 'Health Ins', 'Social Ins', 'Utility', 'EMC', 'Support Haki'],
  expense: [],
  allocation: ['Stock', 'Trading', 'Saving Cash', 'Saving Bitcoin'],
};
// where a Reinvest destination lives in the dashboard
const REINVEST_TAB = {Stock: 'investment', Trading: 'trading', 'Saving Cash': 'wealth', 'Saving Bitcoin': 'wealth'};
const cashflowLabel = (section) => (CASHFLOW_TYPES.find((t) => t[0] === section) || [section, section])[1];

// items of a section: the standard ones, then every other name already used in that section (most used first)
function cashflowItems(section, lines) {
  const used = new Map();
  for (const l of lines) if (l.section === section) used.set(l.line, (used.get(l.line) || 0) + 1);
  const standard = CASHFLOW_ITEMS[section];
  return [...standard, ...[...used.keys()].filter((n) => !standard.includes(n)).sort((a, b) => used.get(b) - used.get(a))];
}

// row: the entry being edited, or null; lines: every Cash Flow line (for the lists and the duplicate check); month: 'YYYY-MM' to start on
function cashflowEditor(row, lines, month) {
  const dialog = $('#dialog');
  dialog.style.width = 'min(520px, calc(100vw - 32px))';
  const error = h('div', {class: 'form-error'});
  let section = row ? row.section : 'expense';
  const monthInput = h('input', {type: 'month', required: true});
  monthInput.value = row ? row.month : (month || today().slice(0, 7));
  const amount = numberInput(row ? row.amount_thb : null, {class: 'num', placeholder: '0', required: true});
  const note = h('input', {type: 'text', placeholder: 'Note (optional)'});
  note.value = row && row.note ? row.note : '';
  const item = h('select', {'aria-label': 'Item'});
  const other = h('input', {type: 'text', placeholder: 'Name the new item'});
  const itemLabel = h('span', null);
  const hint = h('p', {class: 'note', style: 'margin: -4px 0 0'});
  const segment = h('div', {class: 'seg', role: 'tablist'});

  const fillItems = (keep) => {
    const names = cashflowItems(section, lines);
    item.replaceChildren(...names.map((n) => h('option', {value: n}, n)), h('option', {value: '__other'}, 'Other…'));
    if (keep && names.includes(keep)) item.value = keep;
    else if (keep) { item.value = '__other'; other.value = keep; }
    else item.value = names.length ? names[0] : '__other';
    other.hidden = item.value !== '__other';
  };
  const drawType = () => {
    const t = CASHFLOW_TYPES.find((x) => x[0] === section);
    segment.replaceChildren(...CASHFLOW_TYPES.map(([id, label]) => h('button', {type: 'button', role: 'tab', class: `seg-${id}`, 'aria-selected': String(id === section),
      onclick: () => { section = id; other.value = ''; drawType(); fillItems(); } }, label)));
    hint.textContent = t[2];
    itemLabel.textContent = t[3];
  };
  item.addEventListener('change', () => { other.hidden = item.value !== '__other'; if (!other.hidden) other.focus(); });
  drawType();
  fillItems(row ? row.line : null);

  const form = h('form', {class: 'form', method: 'dialog'}, h('h2', null, `${row ? 'Edit' : 'Add'} — Cash flow log`),
    h('div', {class: 'field'}, 'What kind of money is it?', segment), hint,
    h('label', {class: 'field'}, 'Month', monthInput),
    h('label', {class: 'field'}, itemLabel, item, other),
    h('label', {class: 'field'}, 'Amount (THB)', amount),
    h('label', {class: 'field'}, 'Note', note),
    error,
    h('div', {class: 'form-buttons'}, h('button', {type: 'button', class: 'btn', onclick: () => dialog.close()}, 'Cancel'), h('button', {type: 'submit', class: 'btn dark'}, 'Save')));
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = (item.value === '__other' ? other.value : item.value).trim();
    const value = numberOf(amount);
    if (!name) { error.textContent = 'Name the item.'; return; }
    if (value == null) { error.textContent = 'Enter the amount.'; return; }
    if (lines.some((l) => l.month === monthInput.value && l.section === section && l.line.toLowerCase() === name.toLowerCase() && (!row || l.id !== row.id))) {
      error.textContent = `${cashflowLabel(section)} › ${name} already has an entry for ${monthLabel(monthInput.value)}. Edit that one instead.`;
      return;
    }
    let out;
    try {
      out = await api(row ? 'PUT' : 'POST', `/api/cashflow${row ? '/' + row.id : ''}`,
        {month: monthInput.value, section, line: name, amount_thb: value, note: note.value.trim() || null});
    } catch (e) { error.textContent = e.message; return; }
    dialog.close();
    toast(`${row ? 'Saved.' : 'Added.'}${out.deposit_to ? ` Also recorded as a deposit in ${out.deposit_to}.` : ''}`);
    go('expense', monthInput.value);
  });
  dialog.replaceChildren(form);
  dialog.showModal();
}

// ---------------------------------------------------------------- Plan pieces (the Plan page and Home share them)
const planSpan = (m) => (m >= 12 ? `${Math.floor(m / 12)} yr${m % 12 ? ` ${m % 12} mo` : ''}` : `${m} month${m === 1 ? '' : 's'}`);
const planMeter = (share, cls = '') => h('div', {class: `meter ${cls}`},
  h('div', {class: 'bar'}, h('span', {style: `width: ${Math.min(1, Math.max(0, share || 0)) * 100}%`})), h('b', null, share == null ? '—' : `${Math.round(share * 100)}%`));
const planFact = (label, value, sub, cls = '') => h('div', {class: 'fact'}, h('span', {class: 'fact-label'}, label), h('b', {class: cls}, value), sub ? h('span', {class: 'fact-sub'}, sub) : null);

// this year's target: the value aimed at by December, how far along, what is left
function planYearCard(t, home = false) {
  const span = planSpan, meter = planMeter, fact = planFact, asOf = monthLabel(t.month);
  const behind = t.expected_thb == null ? null : t.actual_thb - t.expected_thb;
  return h('article', {class: 'card plan-hero'},
    h('div', {class: 'card-head'}, h('h2', {class: 'caps'}, home ? `${t.year} portfolio goal` : `${t.year} target`), h('span', {class: 'chip'}, t.months_left ? `${span(t.months_left)} left` : 'year end')),
    // on Home: where the portfolio stands over where it is going; on Plan: the target on its own, with the boxes below
    home ? h('div', {class: 'hero-value'}, baht(t.actual_thb), h('span', {class: 'hero-of'}, ` / ${baht(t.target_thb)}`))
      : h('div', {class: 'hero-value'}, baht(t.target_thb)),
    // on Home the bar comes first and the words under it; on Plan the words first
    ...(() => { const words = h('div', {class: 'note'}, home ? `Total at end of ${asOf} / Target by Dec ${t.year}` : `Total Portfolio Value by Dec ${t.year}`), bar = meter(t.progress, 'green'); return home ? [bar, words] : [words, bar]; })(),
    home ? null : h('div', {class: 'facts'},
      fact('Now', baht(t.actual_thb), `end of ${asOf}`),
      fact(t.gap_thb > 0 ? 'To go' : 'Above target', baht(Math.abs(t.gap_thb)), t.opening_thb == null ? null : `started the year at ${baht(t.opening_thb)}`),
      t.per_month_thb != null && t.gap_thb > 0 ? fact('Needed per month', baht(t.per_month_thb), `for the ${span(t.months_left)} left`) : null),
    behind == null ? null : h('p', {class: `note ${behind < 0 ? 'warn' : ''}`},
      `A straight line from the year’s opening value to the target would be at ${baht(t.expected_thb)} by now: `
      + (behind < 0 ? `${baht(-behind)} behind.` : `${baht(behind)} ahead.`)),
    t.stale.length ? h('p', {class: 'note'}, `Carried forward from an earlier month: ${t.stale.join(', ')}.`) : null);
}

const PLAN_SHOW = {Stock: ['Stock', 'investment', 'var(--mint)'], Trading: ['Trading', 'trading', 'var(--ink)'],
  'Saving Bitcoin': ['Saving Bitcoin', 'wealth', 'var(--tan-light)'], 'Saving Cash': ['Saving Cash', 'wealth', 'var(--tan)'], OnTheWall: ['Online Shop', 'shop', 'var(--grey)']};
const planOrder = (g) => { const k = ['Stock', 'Trading', 'OnTheWall', 'Saving Cash', 'Saving Bitcoin'].indexOf(g.name); return k < 0 ? 9 : k; };
const goalLabel = (name) => (PLAN_SHOW[name] || [name])[0];
const goalTableOrder = (a, b) => ['Stock', 'Trading', 'Saving Cash', 'Saving Bitcoin', 'OnTheWall'].indexOf(a.name) - ['Stock', 'Trading', 'Saving Cash', 'Saving Bitcoin', 'OnTheWall'].indexOf(b.name);

// Home: one line per Goal of the year, a black progress bar and what is left
function planGoalRows(t) {
  return h('div', {class: 'goal-rows'}, [...t.items].sort((a, b) => planOrder(a) - planOrder(b)).map((g) => {
    const [label, page, colour] = PLAN_SHOW[g.name] || [g.name, null, 'var(--grey)'];
    const left = g.gap_thb;
    const share = Math.min(1, Math.max(0, g.progress || 0));
    const row = h('div', {class: 'goal-line', role: page ? 'link' : null, tabindex: page ? 0 : null, title: `${label}: ${baht(g.actual_thb)} of ${baht(g.goal_thb)}${g.as_of ? ` (as of ${fmtDay(g.as_of)})` : ''}`},
      h('span', {class: 'goal-line-name'}, h('i', {class: 'dot', style: `background: ${colour}`}), label),
      h('div', {class: 'goal-bar'}, h('span', {class: 'goal-nums'}, `${baht(g.actual_thb)} / ${baht(g.goal_thb)}`),
        h('div', {class: 'goal-track'}, h('span', {style: `width: ${share * 100}%`}))),
      h('b', {class: 'goal-line-pct'}, g.progress == null ? '—' : `${Math.round(g.progress * 100)}%`),
      h('span', {class: `goal-line-left ${left != null && left <= 0 ? 'up' : ''}`}, left == null ? '—' : left <= 0 ? `+${baht(-left)} over` : `${baht(left)} left`));
    if (page) { row.addEventListener('click', () => go(page)); row.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(page); }); }
    return row;
  }));
}

// one card per Goal of the year; compact leaves out the plan's note and growth, for Home
function planGoalCards(t, compact = false) {
  const meter = planMeter;
  const goalCard = (g) => {
    const [label, page, colour] = PLAN_SHOW[g.name] || [g.name, null, 'var(--grey)'];
    const income = !g.group;                                     // a Goal outside the portfolio is a yearly income target
    const reached = g.gap_thb != null && g.gap_thb <= 0;
    const lag = g.deposits_plan_ytd == null ? null : g.deposits_ytd - g.deposits_plan_ytd;
    const row = (k, v, cls = '') => h('div', {class: 'plan-row'}, h('span', null, k), h('b', {class: cls}, v));
    const card = h('article', {class: `card plan-goal ${compact ? 'compact' : ''}`},
      h('div', {class: 'card-head'}, h('h3', {class: 'card-title'}, h('span', {class: 'dot', style: `background: ${colour}`}), label),
        income ? h('span', {class: 'chip'}, 'income target') : null),
      h('div', {class: 'goal-now', title: g.as_of ? `as of ${fmtDay(g.as_of)}` : null}, h('b', null, g.actual_thb == null ? '—' : baht(g.actual_thb)), h('span', null, `of ${baht(g.goal_thb)}`)),
      meter(g.progress),
      h('div', {class: 'plan-rows'},
        g.gap_thb == null ? null : row(reached ? 'Above target' : 'To go', baht(Math.abs(g.gap_thb)), reached ? 'up' : ''),
        g.monthly_thb ? row(income ? 'Aimed per month' : 'Reinvest plan', `${baht(g.monthly_thb)} / mo`) : null,
        g.deposits_plan_ytd == null ? null : row(`Deposits to ${MONTHS[Number(t.month.slice(5, 7)) - 1]}`, `${baht(g.deposits_ytd)} of ${baht(g.deposits_plan_ytd)}`, lag < 0 ? 'warn-text' : 'up'),
        g.growth_pct && !compact ? row('Planned growth', signedPct(g.growth_pct)) : null,
        income && g.actual_thb != null ? row('Counted as', 'profit for dividend') : null),
      g.note && !compact ? h('p', {class: 'plan-note'}, g.note) : null);
    if (page) { card.classList.add('link'); card.tabIndex = 0; card.title = `Open ${label}`; card.addEventListener('click', () => go(page)); }
    return card;
  };
  return [...t.items].sort((a, b) => planOrder(a) - planOrder(b)).map((g) => goalCard(g));
}

// ---------------------------------------------------------------- Plan: how the money moves, and the goal behind the plan
// Income (Salary, Investment, Online Shop) pays the Spending (Fixed costs, Expenses) and feeds Investment (Stock + Trading), whose
// return comes back as Income. The goal: that return alone pays the Spending, so Salary is no longer needed.
// Every amount in the picture is the Cash flow log's average month of the year so far; the goal bar is a planning figure (the
// Investment value at the plan's yearly yields), and says so.
function financeFlowCard(f) {
  const line = (label, value, note) => h('div', {class: 'flow-line'}, h('span', null, label, note ? h('i', null, note) : null), h('b', null, baht(value)));
  const pctOf = (v) => `${Math.round(v * 100)}%`;
  const pct1 = (v) => `${Math.round(v * 1000) / 10}%`;
  const y = f.yields, put = f.reinvest;
  const saved = (text) => { toast(text || 'Saved.'); go('plan'); };

  // Investment: the yields the plan counts on, and what goes in each month
  const editInvest = () => openForm({
    title: 'Investment: what the plan counts on',
    values: {stock: Math.round(y.stock * 1000) / 10, trading: Math.round(y.trading * 1000) / 10,
      in_stock: put.planned.includes('stock') ? put.stock : null, in_trading: put.planned.includes('trading') ? put.trading : null, freed: put.freed},
    fields: [{key: 'stock', label: 'Stock yield', type: 'number', required: true, hint: '% of its value in a year'},
      {key: 'trading', label: 'Trading yield', type: 'number', required: true, hint: '% of its value in a year'},
      {key: 'in_stock', label: 'Reinvest into Stock, per month', type: 'number', placeholder: `${baht(put.logged.stock)} (the Cash flow log’s average)`, hint: 'blank = the log’s average'},
      {key: 'in_trading', label: 'Reinvest into Trading, per month', type: 'number', placeholder: `${baht(put.logged.trading)} (the Cash flow log’s average)`, hint: 'blank = the log’s average'},
      {key: 'freed', label: 'When a debt is paid off, reinvest its payment too', type: 'check'}],
    submit: async (v) => {
      await api('PUT', '/api/plan/yields', {stock: (v.stock || 0) / 100, trading: (v.trading || 0) / 100});
      await api('PUT', '/api/plan/reinvest', {stock: v.in_stock, trading: v.in_trading, freed: Boolean(v.freed)});
      saved();
    },
  });

  // Income and Spending show the log's average month; rows typed here replace it, to try a plan.
  const editBox = (box, title, groups, hint) => () => {
    const dialog = $('#dialog'), error = h('div', {class: 'form-error'}), body = h('tbody');
    const addRow = (r) => {
      const group = h('select', null, groups.map((g) => h('option', {value: g}, g)));
      group.value = r.group;
      const name = h('input', {type: 'text', placeholder: 'e.g. Salary'});
      name.value = r.name || '';
      const row = h('tr', null, h('td', null, group), h('td', null, name), h('td', null, numberInput(r.amount, {placeholder: '0'})),
        h('td', null, h('button', {type: 'button', class: 'btn small ghost', title: 'Remove row', onclick: () => row.remove()}, '×')));
      body.append(row);
    };
    f.rows[box].forEach(addRow);
    const read = () => [...body.children].map((tr) => ({group: tr.querySelector('select').value, name: tr.querySelector('input').value.trim(),
      amount: numberOf(tr.querySelectorAll('input')[1]) || 0})).filter((r) => r.name);
    const save = async (rows) => {
      try { await api('PUT', '/api/plan/flow', {box, rows}); dialog.close(); saved('Saved. The Cash flow log is unchanged.'); }
      catch (e) { error.textContent = e.message; }
    };
    const form = h('form', {class: 'form', method: 'dialog'}, h('h2', null, title),
      h('p', {class: 'note'}, `Monthly figures for planning. They replace the Cash flow log’s average in this box; the log itself is not changed. ${hint}`),
      h('table', {class: 'plan-edit'}, h('thead', null, h('tr', null, h('th', null, 'Type'), h('th', null, 'Name'), h('th', null, 'Per month'), h('th'))), body),
      h('div', null, h('button', {type: 'button', class: 'btn small', onclick: () => addRow({group: groups[0], name: '', amount: null})}, '+ Add row')),
      error,
      h('div', {class: 'form-buttons'},
        f.planned.includes(box) ? h('button', {type: 'button', class: 'btn', onclick: () => save(null)}, 'Back to the log') : null,
        h('button', {type: 'button', class: 'btn', onclick: () => dialog.close()}, 'Cancel'),
        h('button', {type: 'submit', class: 'btn dark'}, 'Save')));
    form.addEventListener('submit', (event) => { event.preventDefault(); const rows = read(); if (!rows.length) { error.textContent = 'Add at least one row.'; return; } save(rows); });
    dialog.replaceChildren(form);
    dialog.style.width = 'min(620px, calc(100vw - 32px))';
    dialog.showModal();
  };
  const editIncome = editBox('income', 'Income per month, for the plan', ['Active', 'Investment', 'Other'],
    'Everything except Salary and the Investment rows counts as income that goes on without the job.');
  const editSpending = editBox('spending', 'Spending per month, for the plan', ['Fixed costs', 'Expenses'], 'A debt’s payment is not listed here: it is set in the Debt box.');
  const boxHead = (label, onEdit, box) => h('div', {class: 'flow-box-head'}, h('span', {class: 'flow-cap'}, label),
    h('button', {type: 'button', class: 'btn small ghost', onclick: onEdit}, f.planned.includes(box) ? 'Edit · planned' : 'Edit'));
  const boxLines = (items) => items.map((l) => line(l.label, l.amount, l.detail));

  // ---- Debt: reducing-balance loans. The payment is the Debt line of Spending, and it ends when the loan is paid off.
  const putDebts = async (list) => { await api('PUT', '/api/plan/debts', {debts: list}); };
  const asInput = (d) => ({name: d.name, line: d.line, balance: d.typed_thb, as_of: d.as_of, rate: d.rate, payment: d.payment_thb});
  const editDebt = (index) => () => {
    const d = index == null ? null : f.debts[index];
    const lines = [...new Set([...f.fixed_lines, ...(d && d.line ? [d.line] : [])])];
    openForm({
      title: d ? `Edit — ${d.name}` : 'Add — debt',
      values: d ? {name: d.name, balance: d.typed_thb, as_of: d.as_of, rate: Math.round(d.rate * 10000) / 100, payment: d.payment_thb, line: d.line}
        : {as_of: today().slice(0, 7), line: lines.find((n) => /debt|loan|หนี้|ผ่อน/i.test(n)) || ''},
      fields: [{key: 'name', label: 'Name', type: 'text', required: true, placeholder: 'House debt'},
        {key: 'balance', label: 'Still owed', type: 'number', required: true, hint: 'the principal left, from the bank’s statement'},
        {key: 'as_of', label: 'Balance as of', type: 'text', required: true, placeholder: '2026-10', hint: 'year-month; the dashboard pays it down from the next month'},
        {key: 'rate', label: 'Interest', type: 'number', required: true, hint: '% a year, charged on what is still owed'},
        {key: 'payment', label: 'Payment per month', type: 'number', required: true},
        {key: 'line', label: 'Its line in the Cash flow log', type: 'select', options: [['', '(not in the log)'], ...lines.map((n) => [n, `Fixed costs › ${n}`])],
          hint: 'moved out of Fixed costs so it is not counted twice'}],
      extra: d ? [{label: 'Delete', class: 'btn danger', onclick: async () => { await putDebts(f.debts.filter((_, i) => i !== index).map(asInput)); saved('Deleted.'); }}] : [],
      submit: async (v) => {
        const item = {name: v.name, line: v.line || '', balance: v.balance, as_of: v.as_of, rate: (v.rate || 0) / 100, payment: v.payment};
        const list = f.debts.map(asInput);
        if (d) list[index] = item; else list.push(item);
        await putDebts(list);
        saved();
      },
    });
  };
  const debtCard = (d, index) => {
    const top = Math.max(d.balance_thb, ...d.years.map((yr) => yr.balance_thb), 1);
    const bar = (label, value, cls = '') => h('div', {class: `debt-year ${cls}`, title: `${label}: ${baht(value)}`},
      h('span', {class: 'debt-amount'}, value ? shortBaht(value).replace('฿', '') : '0'),
      h('span', {class: 'debt-bar'}, h('i', {style: `height: ${Math.max(2, (value / top) * 100)}%`})), h('span', {class: 'debt-label'}, label));
    return h('div', {class: 'debt'},
      h('div', {class: 'debt-head'}, h('b', null, d.name), h('span', {class: 'muted'}, `${pct1(d.rate)} a year, on what is still owed`),
        h('button', {type: 'button', class: 'btn small', onclick: editDebt(index)}, 'Edit')),
      h('div', {class: 'facts'},
        planFact('Still owed', baht(d.balance_thb), d.rolled ? `estimated from ${baht(d.typed_thb)} in ${monthLabel(d.as_of)}` : `as of ${monthLabel(d.as_of)}`),
        planFact('Payment', `${baht(d.payment_thb)} / mo`, d.principal_thb == null ? null : `interest ${baht(d.interest_thb)} · principal ${baht(d.principal_thb)}`),
        d.never ? planFact('Paid off', 'never', `the payment does not cover the interest of ${baht(d.interest_thb)} a month`, 'down')
          : planFact('Paid off', d.paid_off ? monthLabel(d.paid_off) : 'now', d.paid_off ? `${d.months_left} payments left${d.paid_off_age ? ` · age ${d.paid_off_age}` : ''}` : null),
        d.never || !d.paid_off ? null : planFact('Interest still to pay', baht(d.interest_left_thb), `then Spending drops ${baht(d.payment_thb)} / mo`)),
      d.years.length > 1 ? h('div', {class: 'debt-years'}, bar('now', d.balance_thb, 'now'), d.years.map((yr) => bar(String(yr.year), yr.balance_thb))) : null);
  };
  const debtBlock = h('div', {class: 'flow-goal'},
    h('div', {class: 'flow-goal-head'}, h('h3', {class: 'card-title'}, 'Debt', h('span', {class: 'tile-abbr'}, f.debts.length ? `${baht(f.debt_thb)} still owed` : 'none entered')),
      h('button', {type: 'button', class: 'btn small add', onclick: editDebt(null)}, '+ Add debt')),
    f.debts.length ? f.debts.map(debtCard)
      : h('p', {class: 'note'}, 'Add a loan (what is still owed, its interest and the monthly payment) to see when it ends and what that does to the plan.'));

  // ---- the picture
  const arrowDown = h('div', {class: 'flow-v down'}, h('span', {class: 'shaft'}),
    h('div', null, h('b', null, baht(f.reinvest_thb)), h('span', null, put.planned.length ? 'Reinvest · planned' : 'Reinvest')));
  const arrowUp = h('div', {class: 'flow-v up'}, h('span', {class: 'shaft'}),
    h('div', null, h('b', null, baht(f.income.investment)), h('span', null, f.income.investment ? 'Return taken as income' : 'Return taken as income: none yet')));
  const covered = f.coverage == null ? null : Math.min(1, Math.max(0, f.coverage));
  const span = f.months ? `${f.months} month${f.months > 1 ? 's' : ''} of ${f.year}` : `${f.year}`;
  const mix = (needed) => {      // a needed value split the way Stock and Trading are split today
    const total = f.investment.total, part = (v) => shortBaht(needed * v / total).replace('฿', '');
    return total ? h('span', {class: 'fact-split'}, `Stock ${part(f.investment.stock)} · Trading ${part(f.investment.trading)}`) : null;
  };
  const need = (label, needed, sub) => h('div', {class: 'fact'}, h('span', {class: 'fact-label'}, label),
    h('div', {class: 'fact-row'}, h('b', null, shortBaht(needed)), mix(needed)), h('span', {class: 'fact-sub'}, sub));
  const reach = f.reach;
  const reachChip = !f.spending_thb ? null : h('span', {class: 'chip line'},
    !reach ? 'not within 40 years at this pace' : reach.months === 0 ? 'covered today' : `at this pace: ${monthLabel(reach.month)}${reach.age ? ` · age ${reach.age}` : ''}`);
  const chart = h('div', {class: 'chart'});
  if (f.projection.length > 1) {
    requestAnimationFrame(() => lineChart(chart, f.projection.map((p) => ({...p, month: `${p.year}-12`})),
      [{key: 'return_thb', name: 'Investment returns / mo', color: 'var(--up)', width: 2.5}, {key: 'gap_thb', name: 'It has to pay / mo', color: 'var(--tan)', dash: '4 4', width: 1.5}],
      {format: baht, axisFormat: shortBaht, xLabel: (r) => String(r.year), xAnchor: 'fit',
        extra: (r) => [['Investment', baht(r.investment_thb)], f.debts.length ? ['Debt left', baht(r.debt_thb)] : null, r.age ? ['Age', String(r.age)] : null]}));
  }

  return h('article', {class: 'card flow-card'},
    h('div', {class: 'card-head'}, h('h2', {class: 'caps'}, 'Finance plan'), h('span', {class: 'chip'}, f.months ? `average month · ${span}` : 'no Cash flow entries yet')),
    h('div', {class: 'flow'},
      h('div', {class: 'flow-box income'}, boxHead('Income', editIncome, 'income'), h('div', {class: 'flow-total'}, baht(f.income_thb)),
        boxLines(f.income_lines)),
      h('div', {class: 'flow-h'}, h('b', null, baht(f.spending_thb)), h('span', {class: 'shaft'}), h('span', null, f.income_thb ? `${pctOf(f.spending_thb / f.income_thb)} of income` : 'pays for')),
      h('div', {class: 'flow-box spend'}, boxHead('Spending', editSpending, 'spending'), h('div', {class: 'flow-total'}, baht(f.spending_thb)),
        boxLines(f.spending_lines)),
      h('div', {class: 'flow-v-row'}, arrowDown, arrowUp),
      h('div', null),
      h('div', {class: 'flow-left'}, h('span', null, 'Left after spending and reinvesting'), h('b', {class: signClass(f.free_thb)}, baht(f.free_thb)),
        f.saved_thb ? h('span', null, `after ${baht(f.saved_thb)} into Saving`) : null),
      h('div', {class: 'flow-box invest'},
        h('div', {class: 'flow-invest-head'}, h('div', null, h('span', {class: 'flow-cap'}, 'Investment · Stock + Trading'), h('div', {class: 'flow-total'}, baht(f.investment.total))),
          h('button', {type: 'button', class: 'btn small ghost', onclick: editInvest}, 'Edit')),
        h('div', {class: 'flow-invest-lines'},
          line('Stock', f.investment.stock, `yield ${pct1(y.stock)} a year · +${baht(put.stock)}/mo`),
          line('Trading', f.investment.trading, `yield ${pct1(y.trading)} a year · +${baht(put.trading)}/mo`)))),

    debtBlock,

    h('div', {class: 'flow-goal'},
      h('div', {class: 'flow-goal-head'}, h('h3', {class: 'card-title'}, 'The goal: Investment pays for the spending, without Salary'), reachChip),
      h('div', {class: 'meter green'}, h('div', {class: 'bar'}, h('span', {style: `width: ${(covered || 0) * 100}%`})), h('b', null, f.coverage == null ? '—' : pctOf(f.coverage))),
      h('div', {class: f.needed_after_thb != null && f.debt_free ? 'facts two' : 'facts'},
        planFact('Investment has to pay', `${baht(f.gap_thb)} / mo`,
          f.goes_on_thb ? `Spending ${baht(f.spending_thb)} − ${baht(f.goes_on_thb)} income without the job` : 'all of Spending, once Salary stops'),
        planFact('Investment would return', `${baht(f.expected_return_thb)} / mo`, `today’s value at the plan’s yields`),
        f.needed_thb == null ? null : need('Investment needed', f.needed_thb, `Return: ${baht(f.gap_thb)}/mo`),
        f.needed_after_thb == null || !f.debt_free ? null
          : need('Needed once the debt is paid', f.needed_after_thb, `from ${monthLabel(f.debt_free.month)} · Return: ${baht(f.gap_after_thb)}/mo`)),
      f.projection.length > 1 ? h('div', {class: 'flow-chart'}, h('div', {class: 'flow-chart-head'}, h('span', null, 'Projection, year end'),
        h('span', {class: 'spend-legend'}, h('span', null, h('i', {style: 'background: var(--up)'}), 'Investment returns / mo'), h('span', null, h('i', {style: 'background: var(--tan)'}), 'It has to pay / mo'))), chart) : null,
      h('p', {class: 'note'}, `A planning figure, not a result. It counts on Stock returning ${pct1(y.stock)} and Trading ${pct1(y.trading)} every year, on ${baht(f.reinvest_thb)} a month going in`
        + `${put.freed && f.debts.length ? ' (plus a debt’s payment once it is paid off)' : ''}, and on spending staying where it is${f.debts.length ? ' apart from the debt ending' : ''}. `
        + `${f.covered_year ? `Measured by the plan sheet’s year-end Goals instead: ${f.covered_year}. ` : ''}`
        + `Recorded as income from Investment so far: ${baht(f.income.investment)} a month (${f.actual_coverage == null ? '—' : pctOf(f.actual_coverage)} of spending).`)));
}

// this year's target for the Plan page: a ring, the target, and what is left
function planYearRing(t, goals = null) {
  const share = Math.min(1, Math.max(0, t.progress || 0)), R = 50, C = 2 * Math.PI * R, asOf = monthLabel(t.month);
  const id = `ring-${Math.random().toString(36).slice(2, 8)}`;
  const grad = svg('linearGradient', {id, x1: 0, y1: 0, x2: 1, y2: 1});
  [[0, '#a6dcc0'], [.55, '#4fb987'], [1, '#2f9e6e']].forEach(([o, c]) => grad.append(svg('stop', {offset: o, 'stop-color': c})));
  const ring = svg('svg', {viewBox: '0 0 128 128', class: 'ring', role: 'img', 'aria-label': `${Math.round(share * 100)}% of the ${t.year} target`},
    svg('defs', null, grad),
    svg('circle', {cx: 64, cy: 64, r: R, fill: 'none', stroke: '#ecece9', 'stroke-width': 11}),
    svg('circle', {cx: 64, cy: 64, r: R, fill: 'none', stroke: `url(#${id})`, 'stroke-width': 11, 'stroke-linecap': 'round',
      'stroke-dasharray': `${C * share} ${C}`, transform: 'rotate(-90 64 64)'}));
  const row = (k, v, sub, cls = '') => h('div', {class: 'plan-row'}, h('span', null, k, sub ? h('i', null, sub) : null), h('b', {class: cls}, v));
  const behind = t.expected_thb == null ? null : t.actual_thb - t.expected_thb;
  return h('article', {class: 'card plan-year'},
    h('div', {class: 'card-head'}, h('h2', {class: 'caps'}, `${t.year} target`), h('span', {class: 'chip'}, t.months_left ? `${planSpan(t.months_left)} left` : 'year end')),
    h('div', {class: 'ring-wrap'}, ring, h('div', {class: 'ring-center'}, h('b', null, t.progress == null ? '—' : `${Math.round(t.progress * 100)}%`), h('span', null, 'of target'))),
    h('div', {class: 'plan-year-value'}, baht(t.target_thb)),
    h('div', {class: 'note', style: 'text-align: center'}, `Total Portfolio Value by Dec ${t.year}`),
    h('div', {class: 'plan-rows roomy'},
      row('Now', baht(t.actual_thb), `end of ${asOf}`),
      row(t.gap_thb > 0 ? 'To go' : 'Above target', baht(Math.abs(t.gap_thb))),
      t.per_month_thb != null && t.gap_thb > 0 ? row('Needed per month', baht(t.per_month_thb)) : null,
      behind == null ? null : row('Straight-line pace', `${behind < 0 ? '−' : '+'}${baht(Math.abs(behind))}`, behind < 0 ? 'behind' : 'ahead', behind < 0 ? 'warn-text' : 'up')),
    t.stale.length ? h('p', {class: 'note'}, `Carried forward from an earlier month: ${t.stale.join(', ')}.`) : null,
    goals ? h('div', {class: 'plan-year-goals'}, h('h3', {class: 'card-title'}, `${t.year}, Goal by Goal`),
      h('span', {class: 'note'}, 'Value now against the year’s Goal, and deposits recorded against the monthly plan.'),
      h('div', {class: 'plan-goals stacked'}, goals)) : null);
}

// ---------------------------------------------------------------- the year's progress bars at the top of a page
// specs: [{name, label}] where name is a Goal name (Stock, Trading, Saving Cash, Saving Bitcoin, OnTheWall). The box fills in once the
// figures arrive and is left out when the year has no Goal for any of them. 
function goalStrip(year, specs) {
  const box = h('article', {class: 'card goal-strip', hidden: true});
  const bar = (label, actual, goal, note) => {
    const share = goal ? Math.min(1, Math.max(0, actual / goal)) : 0;
    return h('div', {class: 'gs-row', title: note || null},
      h('span', {class: 'gs-label'}, label),
      h('div', {class: 'gs-track'}, h('span', {style: `width: ${share * 100}%`})),
      h('span', {class: 'gs-nums'}, h('b', null, baht(actual)), ` / ${baht(goal)}`),
      h('b', {class: 'gs-pct'}, goal ? `${Math.round(actual / goal * 100)}%` : '—'));
  };
  api('GET', `/api/goal-bars${year ? `?year=${year}` : ''}`).then((res) => {
    const rows = [];
    for (const {name, label} of specs) {
      const b = res.bars[name];
      if (!b || !b.goal_thb) continue;                           // no Goal that year
      rows.push(bar(label, b.actual_thb, b.goal_thb, b.as_of ? `as of ${fmtDay(b.as_of)}` : null));
    }
    if (!rows.length) return;
    box.replaceChildren(...rows);
    box.hidden = false;
  }).catch(() => { /* the page itself still works without the bars */ });
  return box;
}

const pages = {
  async home(host) {
    const d = await api('GET', '/api/home');
    const k = d.kpis;
    setChips(k);
    if (!k) { host.append(h('article', {class: 'card'}, h('p', {class: 'note'}, 'No values recorded yet. Run scripts/import_fund_management.py, or add values under Stock.'))); return; }
    // the big figure is green when the month is up and stays black when it is down (the % and baht beside it carry the red)
    const upOnly = (v) => (v > 0 ? v : 0);
    const linked = (el, page, label) => { el.classList.add('link'); el.tabIndex = 0; el.title = `Open ${label}`;
      el.addEventListener('click', () => go(page)); el.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(page); }); return el; };
    // Total Portfolio Value; its Monthly Return (the change in value, deposits counted) follows the MoM %
    const totalTile = h('article', {class: 'card tile-total'},
      h('div', {class: 'tile-label'}, 'Total Portfolio Value'),
      h('div', {class: `tile-value ${k.total_mom > 0 ? 'up' : ''}`}, baht(k.total)),
      h('div', {class: 'tile-sub'}, h('span', {class: `delta ${signClass(k.total_mom)}`}, signedPct(k.total_mom)),
        h('b', {class: `tile-return-val ${signClass(k.monthly_return)}`, title: 'Monthly Return'}, baht(k.monthly_return)), h('span', null, 'MoM')));
    // the Trading tile shows the same figure as Trading › Trading Portfolio: the journal's Net Balance at the latest FX rate
    const tj = d.trading_journal;
    // MoM is the journal's move since the previous month end (P&L so far this month), in baht at the same FX rate
    let tradingTile;
    if (tj && tj.fx) {
      tradingTile = tile('Trading Portfolio', baht(tj.value * tj.fx), tj.monthly_pct, upOnly(tj.monthly_pct), undefined, tj.monthly_amount == null ? null : tj.monthly_amount * tj.fx);
    } else tradingTile = tile('Trading Portfolio', baht(k.trading), k.trading_mom, upOnly(k.trading_mom));
    host.append(h('div', {class: 'tiles'}, totalTile,
      linked(tile('Stock Portfolio', baht(k.investment), k.investment_mom, upOnly(k.investment_mom), undefined, k.investment_change), 'investment', 'Stock Portfolio'),
      linked(tradingTile, 'trading', 'Trading Portfolio'),
      linked(tile('Shop Revenue', d.shop.available ? baht(k.shop_revenue) : '—', k.shop_mom, upOnly(k.shop_mom), undefined, k.shop_change), 'shop', 'Online Shop'),
      linked(tile(h('span', null, 'Saving', h('span', {class: 'tile-abbr'}, 'Saving + EMC')), baht(k.saving), k.saving_mom, upOnly(k.saving_mom), undefined, k.saving_change), 'wealth', 'Saving')));

    const year = k.month.slice(0, 4);   // this year, as far as the data goes
    const perf = performanceCard({year, rowsYear: d.growth_year, rowsAll: d.growth, legend: 'Total Portfolio',
      nameYear: 'Total Portfolio (incl. deposits)', nameAll: 'Total Portfolio (value growth)'});
    const perfCard = perf.card;

    const donutBox = h('div', {class: 'donut'});
    const ALLOC_ORDER = ['investment', 'trading', 'emc', 'saving'];
    const parts = [...d.allocation].sort((a, b) => ALLOC_ORDER.indexOf(a.group) - ALLOC_ORDER.indexOf(b.group)).map((a) => ({label: GROUPS[a.group][0], value: a.value_thb, color: GROUPS[a.group][1], share: a.share, page: GROUPS[a.group][2]}));
    const allocCard = h('article', {class: 'card'}, h('h2', {class: 'caps'}, 'Asset Allocation'),
      h('div', {class: 'donut-wrap'}, donutBox,
        h('div', {class: 'legend'}, parts.map((p) => h('a', {href: `#${p.page}`}, h('span', null, h('span', {class: 'dot', style: `background: ${p.color}`}), p.label), h('span', null, pct(p.share)))))),
      h('button', {type: 'button', class: 'btn wide', onclick: () => go('assets')}, 'View full breakdown →'));
    host.append(h('div', {class: 'row2'}, perfCard, allocCard));
    perf.draw('return');
    donut(donutBox, parts, {pct: k.total_mom, total: k.total});

    // this year's target on the left, and the year Goal by Goal on the right (both from the Plan page)
    let plan = null;
    try { plan = (await api('GET', '/api/plan')).this_year || null; } catch (e) { /* the rest of Home still loads */ }
    if (plan) {
      host.append(h('div', {class: 'plan-home'}, planYearCard(plan, true),
        h('article', {class: 'card'}, h('div', {class: 'card-head'}, h('h2', {class: 'caps'}, `${plan.year} progress by asset`),
          h('button', {type: 'button', class: 'btn small', onclick: () => go('plan')}, 'Open Plan')),
          planGoalRows(plan))));
    } else {
      host.append(h('article', {class: 'card'}, h('div', {class: 'card-head'}, h('h2', {class: 'caps'}, 'Plan'), h('button', {type: 'button', class: 'btn small', onclick: () => go('plan')}, 'Open Plan')),
        h('p', {class: 'note'}, 'No Goals for this year yet.')));
    }
  },

  async investment(host, picked) {
    const d = await api('GET', `/api/investment${picked ? `?year=${picked}` : ''}`);
    const st = d.stats;
    const manual = d.accounts.filter((a) => a.source === 'manual');
    const ids = new Set(manual.map((a) => a.id));
    const names = new Map(manual.map((a) => [a.id, a.name]));
    const again = () => go('investment');
    host.append(pageHead('Stock Portfolio', null, d.years.length ? yearTabs('investment', d.years, d.year) : null));
    crudYear['Stock Portfolio'] = d.year;
    host.append(goalStrip(d.year, [{name: 'Stock', label: 'Stock'}]));

    // Monthly Return, YTD and CAGR are all change in value with deposits counted, like the chart below.
    host.append(h('div', {class: 'tiles'}, ...accountCards(d.accounts).children, ...bucketStatTiles(st)));

    const perf = performanceCard({year: d.year, yearTab: st && d.year !== st.month.slice(0, 4) ? d.year : null, rowsYear: d.growth_year, rowsAll: d.growth,
      legend: 'Stock', nameYear: 'Stock (incl. deposits)', nameAll: 'Stock (value growth)'});
    host.append(perf.card);
    perf.draw('return');

    const markets = (r) => {
      if (!r.holdings) return h('span', {class: 'muted'}, '—');
      return [...new Set(JSON.parse(r.holdings).map((x) => marketLabel(x.market)))].join(' · ');
    };
    const portfolio = crud({
      title: 'Stock Portfolio', resource: 'snapshots', filter: (r) => ids.has(r.account_id), byYear: (r) => r.as_of.slice(0, 4), onChange: again,
      editor: (row, done) => portfolioEditor(manual, row, done, d.benchmarks),
      note: 'One row per month. Add or edit it to enter the holdings by Market and Stock.',
      columns: [
        {key: 'holdings', label: 'Market', show: markets, cls: 'nowrap'},
        {key: 'as_of', label: 'Date', show: (r) => mmyy(r.as_of), cls: 'nowrap'},
        {key: 'value_thb', label: 'Value (THB)', type: 'money', cls: 'r'},
        {key: 'note', label: 'Note', show: (r) => noteIcon(monthNote(r, d.benchmarks, ['SET']), `Note — ${mmyy(r.as_of)}`)},
      ],
    });

    const donutBox = h('div', {class: 'donut'});
    const parts = d.markets.markets.map((m) => ({label: m.market ? marketLabel(m.market) : 'No market', value: m.value_thb, color: MARKET_COLORS[m.market] || MARKET_COLORS.OTHER, share: m.share}));
    const marketCard = h('article', {class: 'card'},
      h('div', {class: 'card-head'}, h('h2', {class: 'caps'}, 'By market'), d.markets.as_of ? h('span', {class: 'chip'}, `as of ${mmyy(d.markets.as_of)}`) : null),
      parts.length
        ? h('div', {class: 'donut-wrap'}, donutBox,
          h('div', {class: 'legend'}, parts.map((p) => h('div', {class: 'legend-item'}, h('span', null, h('span', {class: 'dot', style: `background: ${p.color}`}), p.label), h('span', null, pct(p.share))))))
        : h('p', {class: 'note'}, 'No holdings by market yet. Add a month in Stock Portfolio with a Market on each row and the split appears here.'));
    const top = d.markets.top || [];
    const topCard = h('article', {class: 'card'}, h('h2', {class: 'caps'}, 'Top 10 holdings'),
      top.length ? h('div', {class: 'table-wrap'}, h('table', null,
        h('thead', null, h('tr', null, h('th', null, '#'), h('th', null, 'Stock'), h('th', null, 'Market'), h('th', {class: 'r'}, 'Value (THB)'), h('th', {class: 'r'}, '% of port'))),
        h('tbody', null, top.map((t, n) => h('tr', null, h('td', {class: 'muted'}, n + 1), h('td', null, t.stock || '—'), h('td', null, marketLabel(t.market)),
          h('td', {class: 'r'}, baht(t.value_thb)), h('td', {class: 'r'}, pct(t.share)))))))
        : h('p', {class: 'note'}, 'Shown once a month has holdings entered. Cash is not counted as a stock.'),
      top.length ? h('p', {class: 'note'}, 'Share is of the whole Stock value, cash included.') : null);
    host.append(h('div', {class: 'pair'}, h('div', {class: 'stack'}, marketCard, topCard), portfolio));
    if (parts.length) donut(donutBox, parts, {total: parts.reduce((t, p) => t + p.value, 0)});

    const flows = crud({
      title: 'Deposits and withdrawals', resource: 'flows', filter: (r) => ids.has(r.account_id), byYear: (r) => r.on_date.slice(0, 4), onChange: again,
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
    host.append(h('div', {class: 'pair half'}, flows));
  },

  async trading(host, year) {
    const url = () => `/api/trading${year ? `?year=${year}` : ''}`;
    let d = await api('GET', url());
    host.append(pageHead('Trading Portfolio', null,
      d.sheet.years.length ? yearTabs('trading', d.sheet.years, d.sheet.year) : null),
      goalStrip(d.sheet.year, [{name: 'Trading', label: 'Trading'}]),
      h('div', {class: 'tiles'},
        d.stats ? (d.stats.fx
          ? tile('Trading Portfolio', baht(d.stats.value * d.stats.fx), undefined, undefined, `${usdt(d.stats.value)} USDT × ${number(d.stats.fx)} (FX ${yymm(d.stats.fx_as_of)})`, undefined, `฿${number(d.stats.fx)}/USDT`)
          : tile('Trading Portfolio', `${usdt(d.stats.value)} USDT`, undefined, undefined, 'Net Balance · no FX rate entered yet')) : null,
        ...bucketStatTiles(d.stats, {fmt: d.stats && d.stats.fx ? (v) => (v == null ? '—' : baht(v * d.stats.fx)) : usdt,
          badge: d.stats && d.stats.fx ? `฿${number(d.stats.fx)}/USDT` : undefined, cagrNote: 'trades only', drawdown: true})));

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
    // Excel is the source of the journal: Sync Excel reads the workbook again and the trades become exactly what it holds
    const syncButton = h('button', {type: 'button', class: 'btn small dark', onclick: async () => {
      syncButton.disabled = true; syncButton.textContent = 'Syncing…';
      try {
        const out = await api('POST', '/api/journal/sync');
        const parts = [`${out.trades} trades`, out.added ? `${out.added} new` : null, out.removed ? `${out.removed} removed` : null].filter(Boolean);
        toast(`Synced from Excel: ${parts.join(', ')}.`);
        go('trading', year);
      } catch (e) { toast(e.message); syncButton.disabled = false; syncButton.textContent = 'Sync Excel'; }
    }}, 'Sync Excel');
    const src = d.journal_source || {};
    const when = (iso) => (iso ? `${fmtDay(iso.slice(0, 10))} ${iso.slice(11, 16)}` : '—');
    const sourceFoot = h('div', {class: 'source-foot'},
      h('span', {class: `muted ${src.stale ? 'warn-text' : ''}`}, !src.exists ? `${src.file || 'The journal workbook'} was not found.`
        : src.stale ? `Excel was saved ${when(src.saved_at)}, after the last sync${src.synced_at ? ` (${when(src.synced_at)})` : ''}. Press Sync Excel.`
        : `In sync · last synced ${when(src.synced_at)}`),
      h('button', {type: 'button', class: 'btn small', disabled: !src.exists, onclick: async () => {
        try { await api('POST', '/api/journal/open'); toast('Opening Excel…'); } catch (e) { toast(e.message); }
      }}, 'Open Excel'));
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
    const jYear = d.sheet.year;
    host.append(h('article', {class: 'card'}, h('div', {class: 'card-head'},
      h('h2', {class: 'card-title'}, 'Trade journal summary'),
      h('span', {class: 'row-gap'}, h('span', {class: 'chip line'}, `Year ${jYear}`), h('span', {class: 'chip'}, 'USDT'),
        h('button', {type: 'button', class: 'btn small', onclick: editSettings}, 'Edit Start and Risk'))), summaryHost));

    const perfYear = jYear || (d.growth_year.length ? d.growth_year[d.growth_year.length - 1].month.slice(0, 4) : String(new Date().getFullYear()));
    crudYear['Trading Portfolio'] = jYear;
    const perf = performanceCard({year: perfYear, rowsYear: d.growth_year, rowsAll: d.growth, legend: 'Trading', bench: 'BTC', title: 'Trading Portfolio', valueFmt: (v) => `${usdt(v)} USDT`, yearTab: d.stats && jYear !== d.stats.month.slice(0, 4) ? jYear : null,
      nameYear: 'Trading (journal)', nameAll: 'Trading'});
    host.append(perf.card);
    perf.draw('return');

    host.append(h('article', {class: 'card'},
      h('div', {class: 'card-head'}, h('h2', {class: 'card-title'}, 'Trade journal'), syncButton),
      h('p', {class: 'note'}, 'Kept in the Excel journal: add and edit trades there, save the file, then press Sync Excel. The table below is a copy of it.'),
      gradesRow,
      h('details', {class: 'rules'}, h('summary', null, 'Setup checklist'),
        h('div', {class: 'table-wrap'}, h('table', null,
          h('thead', null, h('tr', null, ['Setup', 'POI', 'Signal', 'Div', 'Confirm', 'Fib time', 'Fib', 'Exit plan'].map((t) => h('th', null, t)))),
          h('tbody', null,
            h('tr', null, ['Battle Field (EMA)', 'EMA 8/26/50/99/200', 'RSI Strong · DD ไม่ขยาย · ย้ำหัวไปต่อ', 'RSI Divergence', 'Choch/Bos · ไป 2X HB', 'Passed', 'Fib 0.5 / 0.68 / 0.78', '3R · 100 of A'].map((t) => h('td', null, t))),
            h('tr', null, ['Hua Taew (Divergence)', 'RSI Div 4H', 'RSI Div · DD ขยาย · ซอยเท้า', 'RSI Divergence', 'Choch/Bos', 'Passed', 'Fib 0.5 / 0.68 / 0.78', '3R · 100 of A'].map((t) => h('td', null, t))))))),
      grid.wrap, sourceFoot));
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
      title: 'Trading Portfolio', resource: 'snapshots', filter: (r) => ids.has(r.account_id), byYear: (r) => r.as_of.slice(0, 4), onChange: again,
      editor: (row, done) => tradingEditor(manual, row, done, d.benchmarks),
      note: 'Account balance at month end, with the BTC price of the month. For an Account not in THB, the FX rate used.',
      defaults: () => ({account_id: manual[0].id, as_of: today()}),
      columns: [
        {key: 'account_id', label: 'Account', type: 'select', options: accountOpts, show: (r) => (names.get(r.account_id) || {}).name || '', required: true},
        {key: 'as_of', label: 'Date', type: 'date', required: true, show: (r) => yymm(r.as_of), cls: 'nowrap'},
        {key: 'value_native', label: 'Value', type: 'number', required: true, cls: 'r',
          show: (r) => `${number(r.value_native)} ${(names.get(r.account_id) || {}).currency || ''}`},
        {key: 'fx_rate', label: 'FX rate', type: 'number', hint: 'THB per 1 unit; leave blank for THB', cls: 'r'},
        {key: 'value_thb', label: 'THB', type: 'money', form: false, cls: 'r'},
        {key: 'note', label: 'Note', type: 'text', show: (r) => noteIcon(monthNote(r, d.benchmarks, ['BTC']), `Note — ${yymm(r.as_of)}`)},
      ],
    });
    const deposits = crud({
      title: 'Deposits and withdrawals', resource: 'flows', filter: (r) => ids.has(r.account_id), byYear: (r) => r.on_date.slice(0, 4), onChange: again,
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
      host.append(pageHead('Online Shop', intro)); host.append(h('article', {class: 'card'}, h('p', {class: 'note warn'}, d.reason))); return; }
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
      host.append(pageHead('Online Shop', intro));
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
    host.append(h('div', {class: 'page-head'}, h('h2', {class: 'page-title'}, 'Online Shop'), tabs), goalStrip(y.year, [{name: 'OnTheWall', label: 'Online Shop'}]));

    // each tile: the year so far, then the latest month against the one before it (the same % + baht + MoM as the other pages)
    const mom = (list, get, costly = false) => {
      const [prev, cur] = list.slice(-2);
      if (!prev || !cur || !get(prev)) return null;
      const diff = get(cur) - get(prev), good = costly ? -diff : diff;
      return h('div', {class: 'tile-sub'}, h('span', {class: `delta ${signClass(good)}`}, signedPct(diff / get(prev))),
        h('b', {class: `tile-return-val ${signClass(good)}`}, baht(diff)), h('span', null, `MoM · ${MONTHS[cur.month - 1]}`));
    };
    const netOf = (m) => m.net_profit || 0;                      // as the shop sheet does it: revenue - cost of goods - fees - interest and tax
    const net = sum(mm, netOf);
    const latest = mm[mm.length - 1] || {};                       // the latest month with data
    const avg = mm.length ? net / mm.length : 0;                  // the average month of the year so far, the latest included
    const vsAvg = avg ? h('div', {class: 'tile-sub'}, h('span', {class: `delta ${signClass(netOf(latest) - avg)}`}, signedPct((netOf(latest) - avg) / Math.abs(avg))),
      h('b', {class: `tile-return-val ${signClass(netOf(latest) - avg)}`}, baht(netOf(latest) - avg)), h('span', null, 'vs Avg Profit')) : null;
    // against the same months of the year before (Jan to the latest month), so a part year is not set against a whole one
    const before = years.find((x) => x.year === y.year - 1);
    const lastYear = before ? before.months.filter((m) => m.manual && m.month <= (latest.month || 0)) : [];
    const netBefore = sum(lastYear, netOf);
    const yoy = lastYear.length && netBefore ? h('div', {class: 'tile-sub'}, h('span', {class: `delta ${signClass(net - netBefore)}`}, signedPct((net - netBefore) / Math.abs(netBefore))),
      h('b', {class: `tile-return-val ${signClass(net - netBefore)}`}, baht(net - netBefore)), h('span', null, 'YOY')) : null;
    host.append(h('div', {class: 'tiles'},
      h('article', {class: 'card'}, h('div', {class: 'tile-label'}, `Revenue ${y.year}`), h('div', {class: 'tile-value'}, baht(ytd)), mom(mm, (m) => m.revenue), h('div', {class: 'tile-sub'}, `${mm.length} months with data`)),
      h('article', {class: 'card'}, h('div', {class: 'tile-label'}, (latest.month ? `Net Profit · ${MONTHS[latest.month - 1]}` : 'Net Profit')), h('div', {class: `tile-value ${netOf(latest) > 0 ? 'up' : ''}`}, baht(netOf(latest))), vsAvg, h('div', {class: 'tile-sub'}, `current Avg Profit ${baht(avg)}${latest.has_cogs ? '' : ' · cost of goods not entered'}`)),
      h('article', {class: 'card'}, h('div', {class: 'tile-label'}, 'Fees, shipping and ads'), h('div', {class: 'tile-value'}, baht(fees)), mom(mm, (m) => m.sga, true), h('div', {class: 'tile-sub'}, ytd ? `${(fees / ytd * 100).toFixed(1)}% of revenue` : '')),
      h('article', {class: 'card'}, h('div', {class: 'tile-label'}, `Net Profit ${y.year}`), h('div', {class: `tile-value ${net > 0 ? 'up' : ''}`}, baht(net)), yoy, h('div', {class: 'tile-sub'}, `${mm.length} months so far${cogs ? '' : ' · cost of goods not entered'}`))));

    if (mm.length) {
      // columns: Revenue of each month; lines: Profit added up month by month, and the year before's as the benchmark
      const lastManual = mm[mm.length - 1].month;
      const before = years.find((x) => x.year === y.year - 1);
      let cum = 0, cumBefore = 0;
      const rows = Array.from({length: lastManual}, (_, i) => {
        const cur = by[i + 1], old = before && before.months.find((m) => m.month === i + 1);
        if (cur && cur.manual) cum += netOf(cur);
        if (old && old.manual) cumBefore += netOf(old);
        return {month: `${y.year}-${String(i + 1).padStart(2, '0')}`, revenue: cur && cur.manual ? cur.revenue : null,
          profit: cur && cur.manual ? cum : null, before: old && old.manual ? cumBefore : null};
      });
      const hasBefore = rows.some((r) => r.before != null);
      const chart = h('div', {class: 'chart'});
      host.append(h('article', {class: 'card'},
        h('div', {class: 'card-head'}, h('h2', {class: 'card-title'}, 'Revenue and cumulative profit'),
          h('div', {class: 'spend-legend'},
            h('span', null, h('i', {style: 'background: #dededa; border-radius: 2px'}), 'Revenue'),
            h('span', null, h('i', {style: 'background: var(--up)'}), `Cumulative Profit ${y.year}`),
            hasBefore ? h('span', null, h('i', {style: 'background: var(--grey)'}), `Benchmark ${y.year - 1}`) : null)),
        chart));
      lineChart(chart, rows, [{key: 'profit', name: `Cumulative Profit ${y.year}`, color: 'var(--up)', width: 2.5},
        ...(hasBefore ? [{key: 'before', name: `Benchmark ${y.year - 1}`, color: 'var(--grey)', dash: '5 4', width: 1.8}] : [])],
        {format: baht, axisFormat: shortBaht, bars: {key: 'revenue', name: 'Revenue', color: '#dededa'}});
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
    host.append(h('article', {class: 'card'}, h('div', {class: 'card-head'}, h('h2', {class: 'card-title'}, mm.length ? `Monthly profit and loss · ${MONTHS[mm[0].month - 1]}${mm.length > 1 ? `–${MONTHS[mm[mm.length - 1].month - 1]}` : ''} ${y.year}` : `Monthly profit and loss · ${y.year}`),
      h('button', {type: 'button', class: 'btn small add', onclick: () => openEditor(...nextMonth())}, '+ Add')), h('div', {class: 'table-wrap fit'}, h('table', null,
      h('thead', null, h('tr', null, h('th', null, ''), MONTHS.map((m, i) => h('th', {class: 'r'},
        h('button', {type: 'button', class: 'th-btn', title: `Add or change ${m} ${y.year}`, onclick: () => openEditor(y.year, i + 1)}, m))), h('th', {class: 'r'}, 'Total'))),
      h('tbody', null, ...lines('revenue_lines'), row('Total revenue', (m) => m.revenue, {strong: true}),
        ...lines('cogs_lines'), row('Total cost of goods (COGS)', (m) => (m.has_cogs ? m.cogs : null), {strong: true}),
        ...lines('sga_lines'), row('Total fees and overheads', (m) => m.sga, {strong: true}),
        ...lines('tax_lines'),
        row('After fees (before COGS)', (m) => m.after_fees, {strong: true}),
        row('Net profit', (m) => m.net_profit, {strong: true, flag: (m) => !m.has_cogs, flagNote: 'No cost of goods typed for this month, so it is counted as 0'})))),
      h('div', {class: 'source-foot'}, h('span', {class: 'muted'}, 'The figures are kept in the OTW Finance sheets of 4. Fund Management.xlsx.'),
        h('button', {type: 'button', class: 'btn small', onclick: async () => {
          try { await api('POST', '/api/fund/open'); toast('Opening Excel…'); } catch (e) { toast(e.message); }
        }}, 'Open Excel'))));

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
    const tabs = h('div', {class: 'tabs', role: 'tablist'}, [['cards', 'Cards'], ['family', 'Family Statement']].map(([id, label]) =>
      h('button', {type: 'button', role: 'tab', 'aria-selected': String(id === tab), onclick: () => go('wealth', id)}, label)));
    host.append(h('div', {class: 'page-head'}, h('h2', {class: 'page-title'}, 'Saving'), tabs));
    if (tab === 'cards') host.append(goalStrip(null, [{name: 'Saving Cash', label: 'Saving Cash'}, {name: 'Saving Bitcoin', label: 'Saving Bitcoin'}]));
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
      {key: 'allocation', label: 'Shown in Asset Allocation as', type: 'select', options: [['emc', 'Cash'], ['saving', 'Bitcoin']]},
      {key: 'counts_in_total', label: 'Counted in Total Portfolio Value', type: 'check'},
      {key: 'note', label: 'Note', type: 'text'},
    ];
    const addCard = () => openForm({
      title: 'Add Wealth Card', values: {currency: 'THB', allocation: 'saving', counts_in_total: 1, opening_date: today()},
      fields: [{key: 'name', label: 'Name', type: 'pick', options: ['Family Statement', 'Bitcoin', 'Cash', 'Gold'], required: true}, {key: 'currency', label: 'Currency', type: 'text', hint: 'THB, USDT, USD …'}, ...cardFields.slice(1),
        {key: 'opening_value', label: 'Opening value', type: 'number', hint: 'in the card’s currency; recorded as a deposit so it never shows as return'},
        {key: 'opening_fx_rate', label: 'FX rate', type: 'number', hint: 'THB per 1 unit; leave blank for THB'},
        {key: 'opening_date', label: 'Opening date', type: 'date'}],
      submit: async (values) => { await api('POST', '/api/accounts', {...values, bucket: 'wealth'}); toast('Card added.'); again(); },
    });
    const editCard = (a) => openForm({
      title: `Edit — ${a.name}`, values: a, fields: [...cardFields, {key: 'active', label: 'Active', type: 'check'}],
      submit: async (values) => { await api('PUT', `/api/accounts/${a.id}`, values); toast('Saved.'); again(); },
    });
    // the page's own confirm box: a native confirm() can be blocked by the browser, and then Delete silently does nothing
    const deleteCard = (a) => {
      const dialog = $('#dialog');
      dialog.style.width = 'min(420px, calc(100vw - 32px))';
      const error = h('div', {class: 'form-error'});
      dialog.replaceChildren(h('form', {class: 'form', method: 'dialog'}, h('h2', null, `Delete “${a.name}”?`),
        h('p', {class: 'note'}, 'This removes the card with all its monthly values and deposits. It is logged in History, where it can be undone.'), error,
        h('div', {class: 'form-buttons'}, h('button', {type: 'button', class: 'btn', onclick: () => dialog.close()}, 'Cancel'),
          h('button', {type: 'button', class: 'btn danger', onclick: async () => {
            try { await api('DELETE', `/api/accounts/${a.id}`); dialog.close(); toast('Card deleted.'); again(); } catch (e) { error.textContent = e.message; }
          }}, 'Delete'))));
      dialog.showModal();
    };
    const valueOf = (a) => (a.live ? a.live.value_thb : a.snapshot && a.snapshot.value_thb) || 0;
    // EMC (Emergency Cash) is every Counted card shown as EMC: Family Statement + Saving + Cash. It is worked out, not typed.
    const emcOrder = (a) => { const i = ['Family Statement', 'Saving', 'Cash'].indexOf(a.name); return i < 0 ? 9 : i; };
    const emcParts = cards.filter((a) => a.group === 'emc' && a.counts_in_total).sort((x, y) => emcOrder(x) - emcOrder(y));
    const emcTile = h('article', {class: 'card wcard'},
      h('div', {class: 'card-head'}, h('div', {class: 'tile-label'}, h('span', null, 'Saving', h('span', {class: 'tile-abbr'}, 'Emergency Cash')))),
      h('div', {class: 'tile-value'}, baht(emcParts.reduce((t, a) => t + valueOf(a), 0))),
      h('div', {class: 'tile-sub'}, emcParts.map((a) => `${a.name} ${baht(valueOf(a))}`).join(' + ') || 'no cards counted as EMC'));
    const first = ['Family Statement', 'BTC', 'Bitcoin'];
    const ordered = [...first.map((n) => cards.find((a) => a.name === n)).filter(Boolean), ...cards.filter((a) => !first.includes(a.name))];
    host.append(h('div', {class: 'cards-row'},
      h('div', {class: 'cards'}, emcTile, ordered.map((a) => {
        const value = a.live ? a.live.value_thb : a.snapshot && a.snapshot.value_thb;
        const asOf = a.live ? a.live.as_of : a.snapshot && a.snapshot.as_of;
        const ledger = a.source === 'family_statement';          // read from the ledger Maki keeps: nothing to edit or delete here
        return h('article', ledger ? {class: 'card'} : {class: 'card wcard', title: 'Click to edit', onclick: () => editCard(a)},
          h('div', {class: 'card-head'}, h('div', {class: 'tile-label'}, a.source === 'family_statement' ? h('span', null, 'Cash', h('span', {class: 'tile-abbr'}, a.name))
              : ['BTC', 'Bitcoin'].includes(a.name) ? h('span', null, a.name, h('span', {class: 'tile-abbr'}, 'Crypto')) : a.name),
            ledger ? null : h('button', {type: 'button', class: 'btn-del', onclick: (e) => { e.stopPropagation(); deleteCard(a); }}, 'Delete')),
          h('div', {class: 'tile-value'}, baht(value)),
          h('div', {class: 'tile-sub'}, asOf ? `as of ${asOf}` : 'no value yet', a.snapshot && a.currency !== 'THB' ? ` · ${number(a.snapshot.value_native)} ${a.currency}` : ''),
          a.counts_in_total ? null : h('div', {class: 'tile-sub'}, h('span', {class: 'badge'}, 'Display-only')));      // a card that is not in Total Portfolio Value says so
      })),
      h('button', {type: 'button', class: 'btn dark', onclick: addCard}, '+ Add card')), ...accountLists(cards, again));
  },

  async expense(host, picked) {
    const lines = await api('GET', '/api/cashflow');
    const allMonths = [...new Set(lines.map((l) => l.month))].sort();
    const month = allMonths.includes(picked) ? picked : allMonths[allMonths.length - 1];
    const years = [...new Set(allMonths.map((m) => m.slice(0, 4)))].sort().reverse();
    const year = month ? month.slice(0, 4) : String(new Date().getFullYear());
    const months = allMonths.filter((m) => m.startsWith(year));          // the months of the year shown
    const again = (m) => go('expense', m);
    const tabs = h('div', {class: 'tabs', role: 'tablist'}, years.map((y) =>
      h('button', {type: 'button', role: 'tab', 'aria-selected': String(y === year), onclick: () => again(allMonths.filter((m) => m.startsWith(y)).pop())}, y)));
    host.append(h('div', {class: 'page-head'}, h('h2', {class: 'page-title'}, 'Cash flow management'), years.length ? tabs : null));

    const sum = (m, section) => lines.filter((l) => l.month === m && l.section === section).reduce((t, l) => t + l.amount_thb, 0);
    const spend = (m) => ({fixed: sum(m, 'fixed_cost'), other: sum(m, 'expense')});
    const total = (m) => spend(m).fixed + spend(m).other;
    const hasIncome = lines.some((l) => l.section === 'income');
    const hasReinvest = lines.some((l) => l.section === 'allocation');
    const FIXED = '#b4b4ae', OTHER = '#34342f', EARN = '#bfe3cf', REIN = '#9a9a94';       // fixed costs grey, expenses dark grey, income light green
    const reinv = (m) => sum(m, 'allocation');
    const free = (m) => sum(m, 'income') - total(m) - reinv(m);      // what is left of the month's income once spending and reinvesting are taken off
    const SOURCES = [['Salary', '#2a2a29'], ['Online Shop', '#2f9e6e'], ['Trading', '#c98a1b'], ['Stock dividend', '#7b8cc4']];   // income sources drawn as lines

    if (months.length) {
      const prev = allMonths[allMonths.indexOf(month) - 1];
      const now = spend(month), earned = sum(month, 'income');
      const average = months.reduce((t, m) => t + total(m), 0) / months.length;
      const averageIncome = months.reduce((t, m) => t + sum(m, 'income'), 0) / months.length;
      // each tile: the month's figure, its move against the month before (% + baht + MoM; for a cost a rise is red), and its share of income
      const moveOf = (get, costly = false) => {
        if (!prev) return null;
        const was = get(prev), diff = get(month) - was;
        if (!was) return null;
        const good = costly ? -diff : diff;
        return [h('span', {class: `delta ${signClass(good)}`}, signedPct(diff / Math.abs(was))), h('span', null, 'MoM')];
      };
      const ofIncome = (v, income = earned) => (income ? `${pct(v / income)} Inc.` : '');      // share of income, short
      const cfTile = (label, value, move, share, title) => h('article', {class: 'card', title: title || null},
        h('div', {class: 'tile-top'}, h('div', {class: 'tile-label'}, label), share ? h('span', {class: 'tile-share', title: 'Share of income'}, share) : null),
        h('div', {class: 'tile-value'}, value),
        move ? h('div', {class: 'tile-sub one-line'}, ...move) : null);
      // the average month's spending split: how much of it is fixed costs and how much expenses
      const avgFixed = months.reduce((t, m) => t + spend(m).fixed, 0) / months.length;
      const fixedShare = average ? Math.round(avgFixed / average * 100) : null;
      const splitOfAverage = fixedShare == null ? null : [h('span', null, `Fixed ${fixedShare}%`), h('span', null, '·'), h('span', null, `Expense ${100 - fixedShare}%`)];
      const dot = (colour, text) => h('span', null, h('span', {class: 'dot', style: `background: ${colour}`}), text);
      host.append(h('div', {class: 'tiles'},
        hasIncome ? cfTile(dot(EARN, 'Income'), baht(earned), moveOf((m) => sum(m, 'income')), earned ? '' : 'none this month') : null,
        cfTile('Total spending', baht(total(month)), moveOf(total, true), ofIncome(total(month))),
        cfTile(dot(FIXED, 'Fixed costs'), baht(now.fixed), moveOf((m) => spend(m).fixed, true), ofIncome(now.fixed)),
        hasIncome ? cfTile('Free cash flow', baht(free(month)), moveOf(free), ofIncome(free(month))) : null,
        cfTile('Avg per month', baht(average), splitOfAverage, ofIncome(average, averageIncome), `Average of ${months.length} month${months.length > 1 ? 's' : ''} in ${year}`)));

      // bars: spending (fixed costs under, expenses on top) beside income, one pair per month. Lines: each income source, and the
      // average monthly spending of the year (dashed). A pair picks its month.
      const W = 1000, H = 300, padL = 44, padB = 26, padT = 26;
      const sources = SOURCES.filter(([name]) => months.some((m) => lines.some((l) => l.month === m && l.section === 'income' && l.line === name && l.amount_thb)));
      const peak = Math.max(...months.map((m) => Math.max(total(m), sum(m, 'income'))), 1);
      const step = [10000, 20000, 25000, 50000, 100000, 200000].find((s) => peak / s <= 5) || 200000;
      const top = Math.ceil(peak / step) * step;
      const plotH = H - padT - padB, yOf = (v) => H - padB - (v / top) * plotH;
      const slot = (W - padL - 6) / months.length, bw = Math.min(30, slot * 0.34);
      const chart = svg('svg', {viewBox: `0 0 ${W} ${H}`, class: 'bars', role: 'img', 'aria-label': 'Spending and income by month'});
      for (let v = 0; v <= top; v += step) {
        chart.append(svg('line', {x1: padL, x2: W - 6, y1: yOf(v), y2: yOf(v), class: 'grid-line'}), svg('text', {x: padL - 8, y: yOf(v) + 4, 'text-anchor': 'end', class: 'bar-lab'}, v ? `${v / 1000}k` : '0'));
      }
      const centre = (k) => padL + slot * k + slot / 2;
      months.forEach((m, k) => {
        const f = spend(m), earn = sum(m, 'income');
        const xi = centre(k) - bw - 2, xs = centre(k) + 2;      // income on the left, spending beside it
        const g = svg('g', {class: `bar ${m === month ? 'on' : ''}`, tabindex: 0, role: 'button', 'aria-label': `${monthLabel(m)} spending ${baht(total(m))}`});
        g.append(svg('rect', {x: padL + slot * k, y: 0, width: slot, height: H, fill: 'transparent'}),
          svg('rect', {x: xs, y: yOf(f.fixed), width: bw, height: Math.max(yOf(0) - yOf(f.fixed), 0), rx: 4, fill: FIXED}),
          f.other > 0 ? svg('rect', {x: xs, y: yOf(f.fixed + f.other), width: bw, height: yOf(f.fixed) - yOf(f.fixed + f.other), rx: 4, fill: OTHER}) : null,
          earn > 0 ? svg('rect', {x: xi, y: yOf(earn), width: bw, height: yOf(0) - yOf(earn), rx: 4, fill: EARN}) : null,
          svg('text', {x: xs + bw / 2, y: yOf(total(m)) - 6, 'text-anchor': 'middle', class: 'bar-val'}, total(m) ? `${Math.round(total(m) / 1000)}k` : ''),
          svg('text', {x: centre(k), y: H - 8, 'text-anchor': 'middle', class: 'bar-lab month'}, MONTHS[Number(m.slice(5, 7)) - 1]));
        g.addEventListener('click', () => again(m));
        g.addEventListener('keydown', (e) => { if (e.key === 'Enter') again(m); });
        chart.append(g);
      });
      chart.append(svg('line', {x1: padL, x2: W - 6, y1: yOf(average), y2: yOf(average), class: 'avg-line'}),
        svg('text', {x: W - 8, y: yOf(average) - 5, 'text-anchor': 'end', class: 'avg-lab'}, `avg ${Math.round(average / 1000)}k`));
      const incomeOf = (m, name) => lines.filter((l) => l.month === m && l.section === 'income' && (!name || l.line === name)).reduce((t, l) => t + l.amount_thb, 0);
      const drawn = [['Income', 'var(--up)', (m) => incomeOf(m)], ...(sources.length > 1 ? sources.map(([name, colour]) => [name, colour, (m) => incomeOf(m, name)]) : [])];
      if (hasIncome) for (const [, colour, get] of drawn) {
        const pts = months.map((m, k) => [centre(k), yOf(get(m))]);
        chart.append(svg('polyline', {points: pts.map((q) => q.join(',')).join(' '), fill: 'none', stroke: colour, 'stroke-width': 1.8, 'stroke-linejoin': 'round', 'pointer-events': 'none'}),
          ...pts.map(([x, y]) => svg('circle', {cx: x, cy: y, r: 3, fill: '#fff', stroke: colour, 'stroke-width': 1.6, 'pointer-events': 'none'})));
      }
      const key = (colour, label, extra = '') => h('span', null, h('i', {style: `background: ${colour}; ${extra}`}), label);
      const legend = h('div', {class: 'spend-legend'}, hasIncome ? key(EARN, 'Income') : null, key(FIXED, 'Fixed costs'), key(OTHER, 'Expenses'),
        ...(hasIncome ? drawn : []).map(([name, colour]) => key(colour, name, 'height: 3px; border-radius: 2px; width: 12px;')), key('var(--muted)', 'Average spending', 'height: 0; width: 12px; background: none; border-top: 2px dashed var(--muted); border-radius: 0;'));

      // the picked month's lines, each with a bar showing its size against the month's largest line
      const block = (title, section, colour) => {
        const rows = lines.filter((l) => l.month === month && l.section === section && l.amount_thb).sort((a, b) => b.amount_thb - a.amount_thb);
        const big = rows.length ? rows[0].amount_thb : 1;
        return h('div', {class: 'spend-block'},
          h('div', {class: 'spend-head'}, h('span', null, h('i', {class: 'dot', style: `background: ${colour}`}), title), h('b', null, baht(rows.reduce((t, l) => t + l.amount_thb, 0)))),
          rows.length ? rows.map((l) => h('div', {class: 'spend-row', title: l.note || null},
            h('span', {class: 'spend-name'}, l.line), h('span', {class: 'spend-amt'}, baht(l.amount_thb)),
            h('span', {class: 'spend-bar'}, h('span', {style: `width: ${Math.max(2, l.amount_thb / big * 100)}%; background: ${colour}`}))))
            : h('p', {class: 'empty'}, 'Nothing this month.'));
      };
      const picker = h('select', {class: 'month-pick', 'aria-label': 'Month'}, [...months].reverse().map((m) => h('option', {value: m}, monthLabel(m))));
      picker.value = month;
      picker.addEventListener('change', () => again(picker.value));
      // the same hover as the other charts: a rule through the month, and a light card beside it listing the figures
      const rule = svg('line', {y1: padT - 8, y2: H - padB, stroke: 'var(--muted)', 'stroke-width': 1, visibility: 'hidden', 'pointer-events': 'none'});
      chart.append(rule);
      const tip = h('div', {class: 'tip light'});
      const plot = h('div', {class: 'chart bars-wrap'}, chart, tip);
      chart.addEventListener('pointermove', (event) => {
        const box = plot.getBoundingClientRect(), scale = box.width / W;
        const k = Math.min(months.length - 1, Math.max(0, Math.floor(((event.clientX - box.left) / scale - padL) / slot)));
        const m = months[k], f = spend(m), dot = (c) => h('i', {class: 'tip-dot', style: `background: ${c}`});
        rule.setAttribute('x1', centre(k)); rule.setAttribute('x2', centre(k)); rule.setAttribute('visibility', 'visible');
        const row = (c, name, v, cls = '') => h('div', {class: `tip-line ${cls}`}, h('span', {class: 'tip-name'}, c ? dot(c) : null, name), h('b', null, baht(v)));
        tip.replaceChildren(h('div', {class: 'tip-head'}, monthLabel(m)),
          ...(hasIncome ? [row(EARN, 'Income', incomeOf(m))] : []),
          row(null, 'Spending', total(m)),
          row(FIXED, 'Fixed costs', f.fixed, 'tip-extra'), row(OTHER, 'Expenses', f.other),
          ...(reinv(m) ? [row(REIN, 'Reinvest', reinv(m))] : []),
          ...(hasIncome ? [row(null, 'Free cash flow', free(m))] : []),
          row(null, 'Average spending', average));
        tip.style.display = 'block';
        const tipW = tip.offsetWidth, tipH = tip.offsetHeight, px0 = centre(k) * scale, gap = 14;
        tip.style.left = `${Math.max(0, px0 + gap + tipW <= box.width ? px0 + gap : px0 - gap - tipW)}px`;
        tip.style.top = `${Math.max(0, Math.min(box.height - tipH, (event.clientY - box.top) - tipH / 2))}px`;
      });
      chart.addEventListener('pointerleave', () => { rule.setAttribute('visibility', 'hidden'); tip.style.display = 'none'; });
      host.append(h('article', {class: 'card'}, h('h2', {class: 'card-title'}, `Spending and income ${year}`), plot, legend));
      const byMonth = h('article', {class: 'card'}, h('div', {class: 'card-head'}, h('h2', {class: 'card-title'}, `By month ${year}`),
        h('button', {type: 'button', class: 'btn small add', onclick: () => cashflowEditor(null, lines, month)}, '+ Add')), h('div', {class: 'table-wrap'}, h('table', null,
        h('thead', null, h('tr', null, ['Month', ...(hasIncome ? ['Income'] : []), 'Fixed costs', 'Expenses', 'Spending', ...(hasReinvest ? ['Reinvest'] : []), ...(hasIncome ? ['Free cash flow'] : [])].map((t, k) => h('th', {class: k ? 'r' : ''}, t)))),
        h('tbody', null, [...months].reverse().map((m) => {
          const f = spend(m), left = free(m);
          return h('tr', {class: m === month ? 'picked' : ''}, h('td', {class: 'nowrap'}, monthLabel(m)), hasIncome ? h('td', {class: 'r'}, baht(sum(m, 'income'))) : null,
            h('td', {class: 'r'}, baht(f.fixed)), h('td', {class: 'r'}, f.other ? baht(f.other) : h('span', {class: 'muted'}, '–')), h('td', {class: 'r'}, h('b', null, baht(total(m)))),
            hasReinvest ? h('td', {class: 'r'}, reinv(m) ? baht(reinv(m)) : h('span', {class: 'muted'}, '–')) : null,
            hasIncome ? h('td', {class: `r ${signClass(left)}`}, baht(left)) : null);
        })))));

      // the picked month's income split: what share went to fixed costs, spending, reinvesting, and what was left
      const fixedNow = now.fixed, otherNow = now.other, reinNow = reinv(month);
      const leftNow = earned - fixedNow - otherNow - reinNow;
      const slices = [['Fixed costs', fixedNow, FIXED], ['Expenses', otherNow, OTHER], ['Reinvest', reinNow, REIN], ['Free cash flow', Math.max(leftNow, 0), EARN]].filter(([, v]) => v > 0);
      const sliceTotal = slices.reduce((t, [, v]) => t + v, 0);
      const pieBox = h('div', {class: 'donut'});
      const pieCard = h('article', {class: 'card'}, h('h2', {class: 'card-title'}, `Where the income went · ${monthLabel(month)}`),
        slices.length ? h('div', {class: 'donut-wrap'}, pieBox, h('div', {class: 'legend'}, slices.map(([label, v, colour]) =>
          h('div', {class: 'legend-item'}, h('span', null, h('span', {class: 'dot', style: `background: ${colour}`}), label), h('span', null, `${baht(v)} · ${pct(v / sliceTotal)}`)))))
          : h('p', {class: 'empty'}, 'Nothing recorded for this month.'),
        !earned && slices.length ? h('p', {class: 'note'}, 'No income entered for this month, so the shares are of what went out.') : null,
        earned && leftNow < 0 ? h('p', {class: 'note warn'}, `Money out is ${baht(-leftNow)} more than the income entered, so the shares are of what went out.`) : null);
      if (slices.length) donut(pieBox, slices.map(([label, value, color]) => ({label, value, color})), {total: sliceTotal});
      host.append(h('div', {class: 'pair'},
        h('article', {class: 'card'}, h('div', {class: 'card-head'}, h('h2', {class: 'card-title'}, `Where the money went · ${monthLabel(month)}`), picker),
          hasIncome && earned ? block('Income', 'income', EARN) : null, block('Fixed costs', 'fixed_cost', FIXED), block('Expenses', 'expense', OTHER),
          hasReinvest ? block('Reinvest', 'allocation', REIN) : null),
        h('div', {class: 'stack'}, pieCard, byMonth)));
    }
    host.append(crud({
      title: months.length ? `Cash flow log · ${monthLabel(month)}` : 'Cash flow log', resource: 'cashflow', query: months.length ? `?month=${month}` : '', noAdd: months.length > 0,
      headExtra: months.length ? (() => {
        const pick = h('select', {class: 'month-pick', 'aria-label': 'Month'}, [...months].reverse().map((m) => h('option', {value: m}, monthLabel(m))));
        pick.value = month;
        pick.addEventListener('change', () => again(pick.value));
        return pick;
      })() : null, onChange: () => again(month),
      note: 'Every income, fixed cost, expense and reinvestment of the month. Add one to say where the money came from or went.',
      editor: (row) => cashflowEditor(row, lines, month),
      columns: [
        {key: 'section', label: 'Type', show: (r) => cashflowLabel(r.section)},
        {key: 'line', label: 'Item', show: (r) => (r.section === 'allocation' && REINVEST_TAB[r.line] ? h('a', {href: `#${REINVEST_TAB[r.line]}`, class: 'tab-link', title: `Open ${r.line}`}, `${r.line} ↗`) : r.line)},
        {key: 'amount_thb', label: 'Amount', type: 'money', cls: 'r'},
        {key: 'note', label: 'Note'},
        {key: 'entered_by', label: 'By', cls: 'muted'},
      ],
    }));
  },

  async plan(host) {
    const d = await api('GET', '/api/plan');
    const t = d.this_year, big = d.big;
    if (!t) {
      host.append(pageHead('Plan', 'Targets by year, against the current value.'),
        h('article', {class: 'card'}, h('p', {class: 'note'}, 'No Goals or monthly values yet. Add Goals below, or run scripts/import_fund_management.py.')));
    } else {
      const asOf = monthLabel(t.month);
      host.append(pageHead('Plan', `Best’s targets from the plan sheet, against where everything stood at the end of ${asOf}.`));
      const span = planSpan, meter = planMeter, fact = planFact;
      // ---- how the money moves and the goal behind the plan, with this year's target beside it
      const yearCard = planYearRing(t, planGoalCards(t, true));
      const last = d.roadmap.find((r) => r.year === big.year);
      const bigCard = h('article', {class: 'card plan-hero big'},
        h('div', {class: 'card-head'}, h('h2', {class: 'caps'}, `Big target${big.age ? ` · age ${big.age}` : ''}`), h('span', {class: 'chip'}, big.months_left > 0 ? `${span(big.months_left)} left` : 'due')),
        h('div', {class: 'hero-value'}, baht(big.target_thb)),
        h('div', {class: 'note'}, `Total Portfolio Value by Dec ${big.year}`),
        meter(big.progress, 'ink'),
        h('div', {class: 'facts'},
          fact('Now', baht(big.actual_thb), `end of ${asOf}`),
          fact('To go', baht(Math.max(big.gap_thb, 0)), big.actual_thb ? `${number(big.target_thb / big.actual_thb, 1)}× today’s value` : null),
          big.needed_growth == null ? null : fact('Needed per year', signedPct(big.needed_growth), 'growth in value, deposits counted')),
        last ? h('p', {class: 'note'}, `The plan for ${big.year}: ` + [['Stock', last.plan.investment], ['Trading', last.plan.trading], ['Saving Cash', last.plan.emc], ['Saving Bitcoin', last.plan.saving]]
          .filter(([, v]) => v).map(([k, v]) => `${k} ${shortBaht(v)}`).join(' · ') + '.') : null);
      host.append(h('div', {class: 'plan-top'}, d.flow ? financeFlowCard(d.flow) : null, yearCard));

      // ---- the road to the big target with the big target beside it, then what Maki has to say about the plan
      const chartRows = [...d.history.map((x) => ({month: `${x.year}-12`, label: String(x.year), actual: x.actual_thb, plan: null})),
        ...d.roadmap.map((r) => ({month: r.as_of || `${r.year}-12`, label: String(r.year), actual: r.actual_thb, plan: r.target_thb, age: r.age, current: r.year === t.year}))];
      const chartBox = h('div', {class: 'chart'});
      const roadCard = h('article', {class: 'card'},
        h('div', {class: 'card-head'}, h('h2', {class: 'card-title'}, 'Road to the big target'),
          h('div', {class: 'legend-row'}, h('span', null, h('span', {class: 'dot', style: 'background: var(--up)'}), 'Actual'), h('span', null, h('span', {class: 'dot', style: 'background: var(--tan)'}), 'Plan (year end)'))),
        chartBox);
      const noteRow = (n) => h('div', {class: 'advice-item'},
        h('div', {class: 'advice-meta'}, h('span', null, fmtDay(n.noted_on)), h('span', null, n.entered_by === 'best' ? 'Best' : n.entered_by[0].toUpperCase() + n.entered_by.slice(1))),
        h('p', {class: 'advice-body'}, n.body));
      const addNote = () => openForm({
        title: 'Add — note on the Plan', values: {noted_on: today(), topic: 'Plan'},
        fields: [{key: 'noted_on', label: 'Date', type: 'date', required: true}, {key: 'topic', label: 'Topic', type: 'text', required: true, hint: 'keep “Plan” in it so the note shows here'},
          {key: 'body', label: 'Note', type: 'textarea', required: true}],
        submit: async (v) => { await api('POST', '/api/advice', v); toast('Added.'); go('plan'); },
      });
      const adviceCard = h('article', {class: 'card advice-card'},
        h('div', {class: 'card-head'}, h('h2', {class: 'caps'}, 'Maki Advise'), h('button', {type: 'button', class: 'btn small add', onclick: addNote}, '+ Add')),
        d.advice.length ? h('div', {class: 'advice-list'}, d.advice.map(noteRow))
          : h('p', {class: 'empty'}, 'Nothing about the plan yet. Maki’s notes with the topic “Plan” appear here: what the figures show against this plan, never a call to buy or sell.'),
        h('button', {type: 'button', class: 'btn wide', onclick: () => go('advise')}, 'All notes →'));
      host.append(h('div', {class: 'plan-top'}, roadCard, bigCard), adviceCard);
      lineChart(chartBox, chartRows, [{key: 'plan', name: 'Plan (year end)', color: 'var(--tan)', dash: '4 4', width: 1.5}, {key: 'actual', name: 'Actual', color: 'var(--up)', width: 2.5}],
        {format: baht, axisFormat: shortBaht, xLabel: (r) => r.label, xAnchor: 'fit',
          extra: (r) => [r.age ? ['Age', String(r.age)] : null, r.actual != null && r.plan != null ? [r.current ? 'To this year’s target' : 'Against plan', baht(r.actual - r.plan)] : null]});

      // ---- every year of the plan
      const cell = (v) => h('td', {class: 'r'}, v ? baht(v) : h('span', {class: 'muted'}, '–'));
      host.append(h('article', {class: 'card'}, h('h2', {class: 'card-title'}, 'Target Breakdown', h('span', {class: 'tile-abbr'}, 'Year by Year')),
        h('p', {class: 'note'}, 'Year-end targets. The portfolio target adds Stock, Trading, Saving Cash and Saving Bitcoin; the Online Shop figure is a yearly income target and is not part of it.'),
        h('div', {class: 'table-wrap'}, h('table', null,
          h('thead', null, h('tr', null, ['Year', 'Age', 'Stock', 'Trading', 'Saving Cash', 'Saving Bitcoin', 'Portfolio target', 'Actual', 'Against plan', 'Online Shop income'].map((x, k) => h('th', {class: `${k ? 'r' : ''} ${k === 6 ? 'hl' : ''}`}, x)))),
          h('tbody', null, d.roadmap.map((r) => h('tr', {class: r.year === t.year ? 'picked' : ''},
            h('td', null, r.year), h('td', {class: 'r'}, r.age || ''), cell(r.plan.investment), cell(r.plan.trading), cell(r.plan.emc), cell(r.plan.saving),
            h('td', {class: 'r hl'}, h('b', null, baht(r.target_thb))),
            h('td', {class: 'r'}, r.actual_thb == null ? h('span', {class: 'muted'}, '–') : [baht(r.actual_thb), r.year === t.year ? h('span', {class: 'muted'}, ` (${MONTHS[Number(t.month.slice(5, 7)) - 1]})`) : null]),
            h('td', {class: `r ${signClass(r.diff_thb)}`}, r.diff_thb == null ? (r.year === t.year ? h('span', {class: 'muted'}, pct(t.progress)) : '') : baht(r.diff_thb)),
            cell(r.income_thb)))))),
        h('div', {class: 'source-foot'}, h('span', {class: 'muted'}, 'The plan is drawn in the Fin Plan(Y) sheet of 4. Fund Management.xlsx.'),
          h('button', {type: 'button', class: 'btn small', onclick: async () => {
            try { await api('POST', '/api/fund/open'); toast('Opening Excel…'); } catch (e) { toast(e.message); }
          }}, 'Open Excel'))));
      crudYear.Goals = String(t.year);
    }
    host.append(crud({
      title: 'Goals', resource: 'goals', byYear: (r) => String(r.year), sort: goalTableOrder, onChange: () => go('plan'),
      note: 'One Goal per year and name. A Goal with no Bucket (such as OnTheWall) is an income target and stays outside Total Portfolio Value.',
      defaults: () => ({year: new Date().getFullYear(), bucket: 'investment'}),
      columns: [
        {key: 'year', label: 'Year', type: 'number', required: true, show: (r) => r.year},
        {key: 'name', label: 'Name', type: 'text', required: true, show: (r) => goalLabel(r.name)},
        {key: 'bucket', label: 'Bucket', type: 'select', table: false, options: [['investment', 'Stock'], ['trading', 'Trading'], ['wealth', 'Wealth'], ['', 'None']]},
        {key: 'goal_thb', label: 'Goal', type: 'money', required: true, cls: 'r'},
        {key: 'monthly_thb', label: 'Monthly plan', type: 'money', cls: 'r', hint: 'reinvestment per month'},
        {key: 'growth_pct', label: 'Growth', type: 'number', cls: 'r', hint: 'as a share: 0.15 = 15%', show: (r) => (r.growth_pct == null ? '' : signedPct(r.growth_pct))},
        {key: 'note', label: 'Action plan', type: 'textarea', cls: 'wrap'},
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
const PAGE_NAMES = {investment: 'Stock Portfolio', trading: 'Trading Portfolio', shop: 'Online Shop', wealth: 'Saving', expense: 'Cash flow management',
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
