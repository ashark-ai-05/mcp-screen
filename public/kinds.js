// mcp-screen renderers for the richer widget kinds. Same rules as app.js: agent data only ever
// reaches the DOM through textContent / setAttribute, never innerHTML.
(function (root) {
  'use strict';
  root.McpScreenKinds = function makeKinds(ctx) {
    const { h, s, api, select, markdown, rerender } = ctx;
    const HL = root.McpScreenHighlight;
    const pt = (o) => JSON.stringify(o);

    function codeLine(tokens) {
      return tokens.map(([cls, t]) => (cls ? h('span', { class: `tk-${cls}` }, t) : t));
    }

    // ---------- code ----------
    function copyText(text, btn) {
      const done = () => { btn.textContent = 'Copied'; btn.classList.add('ok'); setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('ok'); }, 1400); };
      if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done, () => fallback());
      else fallback();
      function fallback() {
        const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } });
        ta.value = text;
        document.body.append(ta);
        ta.select();
        try { document.execCommand('copy'); done(); } catch { btn.textContent = 'Copy failed'; }
        ta.remove();
      }
    }
    function renderCode(w) {
      const d = w.data;
      const lang = d.language || HL.guess(d.filename) || '';
      const lines = HL.block(d.code, lang);
      const start = d.startLine || 1;
      const hi = new Set(d.highlight || []);
      const btn = h('button', { class: 'btn ghost copy', onclick: () => copyText(d.code, btn) }, 'Copy');
      return h('div', { class: 'code-w' },
        h('div', { class: 'code-bar' }, h('span', { class: 'mono fn' }, d.filename || ''), lang ? h('span', { class: 'kind' }, lang) : null, btn),
        h('div', { class: 'code-scroll' }, h('table', { class: 'code' }, h('tbody', {}, lines.map((toks, i) => {
          const n = start + i;
          return h('tr', { class: hi.has(n) ? 'hl' : '', 'data-pt': pt({ line: n, text: d.code.split('\n')[i] ?? '' }) }, h('td', { class: 'ln' }, String(n)), h('td', { class: 'lc' }, codeLine(toks)));
        })))));
    }

    // ---------- diff ----------
    const diffMode = new Map();
    function pairRows(rows) {
      const out = [];
      for (let i = 0; i < rows.length; ) {
        const r = rows[i];
        if (r.t === 'ctx' || r.t === 'hunk') { out.push(r.t === 'hunk' ? { hunk: r } : { l: r, r }); i++; continue; }
        const dels = [], adds = [];
        while (i < rows.length && rows[i].t === 'del') dels.push(rows[i++]);
        while (i < rows.length && rows[i].t === 'add') adds.push(rows[i++]);
        for (let k = 0; k < Math.max(dels.length, adds.length); k++) out.push({ l: dels[k], r: adds[k] });
      }
      return out;
    }
    function renderDiff(w) {
      const d = w.data;
      const mode = diffMode.get(w.id) || d.mode || 'split';
      const toggle = h('div', { class: 'seg' }, ['split', 'unified'].map((m) =>
        h('button', { class: mode === m ? 'on' : '', onclick: () => { diffMode.set(w.id, m); rerender(w.id); } }, m === 'split' ? 'Side by side' : 'Unified')));
      const files = d.files || [];
      return h('div', { class: 'diff-w' },
        h('div', { class: 'diff-top' }, h('span', { class: 'add' }, `+${d.added ?? 0}`), h('span', { class: 'del' }, `−${d.removed ?? 0}`), h('span', { class: 'muted' }, `${files.length} file${files.length === 1 ? '' : 's'}`), toggle),
        files.map((f) => {
          let sa = null, sb = null;
          const tok = (text, side) => {
            const r = HL.line(text, f.language, side === 'a' ? sa : sb);
            if (side === 'a') sa = r.state; else sb = r.state;
            return codeLine(r.tokens);
          };
          const ptOf = (r) => pt({ path: f.path, type: r.t, line: r.b ?? r.a, text: r.text });
          let body;
          if (mode === 'unified') {
            body = f.rows.map((r) => r.t === 'hunk'
              ? h('tr', { class: 'hunk' }, h('td', { colspan: 4 }, r.text))
              : h('tr', { class: r.t, 'data-pt': ptOf(r) }, h('td', { class: 'ln' }, r.a ?? ''), h('td', { class: 'ln' }, r.b ?? ''), h('td', { class: 'sg' }, r.t === 'add' ? '+' : r.t === 'del' ? '−' : ''), h('td', { class: 'lc' }, tok(r.text, r.t === 'del' ? 'a' : 'b'))));
          } else {
            body = pairRows(f.rows).map((p) => p.hunk
              ? h('tr', { class: 'hunk' }, h('td', { colspan: 4 }, p.hunk.text))
              : h('tr', { class: p.l === p.r ? 'ctx' : 'chg', 'data-pt': ptOf(p.r || p.l) },
                h('td', { class: 'ln' }, p.l ? p.l.a ?? '' : ''), h('td', { class: `lc ${p.l && p.l !== p.r ? 'del' : p.l ? '' : 'none'}` }, p.l ? tok(p.l.text, 'a') : ''),
                h('td', { class: 'ln' }, p.r ? p.r.b ?? '' : ''), h('td', { class: `lc ${p.r && p.l !== p.r ? 'add' : p.r ? '' : 'none'}` }, p.r ? tok(p.r.text, 'b') : '')));
          }
          return h('div', { class: 'diff-file' },
            h('div', { class: 'diff-path mono' }, f.path, h('span', { class: 'add' }, ` +${f.added}`), h('span', { class: 'del' }, ` −${f.removed}`)),
            h('table', { class: `diff ${mode}` }, h('tbody', {}, body)));
        }));
    }

    // ---------- diagram ----------
    // does the straight segment between two node centres pass through box p?
    function segHits(a, b, p) {
      for (let t = 0.15; t <= 0.85; t += 0.05) {
        const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t;
        if (Math.abs(x - p.x) < p.w / 2 + 4 && Math.abs(y - p.y) < p.h / 2 + 4) return true;
      }
      return false;
    }
    function renderDiagram(w) {
      const { graph, layout } = w.data;
      const pad = 24;
      const svg = s('svg', { class: 'diagram', viewBox: `${-pad} ${-pad} ${layout.width + pad * 2 + (w.data.graph.direction === "LR" ? 0 : 60)} ${layout.height + pad * 2 + (w.data.graph.direction === "LR" ? 60 : 0)}`, preserveAspectRatio: 'xMidYMid meet' },
        s('defs', {}, s('marker', { id: `arr-${w.id}`, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, s('path', { d: 'M0,0 L10,5 L0,10 z', fill: '#8ea6ff' }))));
      const lr = graph.direction === 'LR';
      for (const e of graph.edges) {
        const a = layout.pos[e.from], b = layout.pos[e.to];
        if (!a || !b) continue;
        let d, mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        // an edge that skips a layer may run straight through another node: bow it out to the side
        const blocker = Object.entries(layout.pos).find(([id, p]) => id !== e.from && id !== e.to && segHits(a, b, p));
        if (e.from === e.to) d = `M${a.x + a.w / 2},${a.y} c40,-40 40,40 0,10`;
        else if (lr) {
          const x1 = a.x + a.w / 2, x2 = b.x - b.w / 2;
          if (blocker) { const p = blocker[1]; const by = Math.max(a.y, b.y, p.y + p.h / 2 + 22) + 14; my = by; d = `M${x1},${a.y} C${x1 + 30},${by} ${x2 - 30},${by} ${x2},${b.y}`; }
          else d = `M${x1},${a.y} C${(x1 + x2) / 2},${a.y} ${(x1 + x2) / 2},${b.y} ${x2},${b.y}`;
        } else {
          const up = b.y < a.y; const y1 = a.y + (up ? -a.h / 2 : a.h / 2), y2 = b.y + (up ? b.h / 2 : -b.h / 2);
          if (blocker) {
            const p = blocker[1]; const bx = Math.max(a.x, b.x, p.x + p.w / 2 + 22) + 14; mx = bx - 10;
            d = `M${a.x + a.w / 2},${a.y} C${bx},${a.y} ${bx},${b.y} ${b.x + b.w / 2},${b.y}`;
          } else d = `M${a.x},${y1} C${a.x},${(y1 + y2) / 2} ${b.x},${(y1 + y2) / 2} ${b.x},${y2}`;
        }
        svg.append(s('path', { class: `edge ${e.style || 'solid'}`, d, 'marker-end': e.arrow === false ? null : `url(#arr-${w.id})` }));
        if (e.label) {
          const tw = e.label.length * 6.4 + 12;
          svg.append(s('g', { class: 'elabel' }, s('rect', { x: mx - tw / 2, y: my - 10, width: tw, height: 20, rx: 6 }), s('text', { x: mx, y: my + 4, 'text-anchor': 'middle' }, e.label)));
        }
      }
      graph.nodes.forEach((n, i) => {
        const p = layout.pos[n.id];
        let shape;
        if (n.shape === 'diamond') shape = s('polygon', { points: `${p.x},${p.y - p.h / 2} ${p.x + p.w / 2},${p.y} ${p.x},${p.y + p.h / 2} ${p.x - p.w / 2},${p.y}` });
        else if (n.shape === 'circle') shape = s('ellipse', { cx: p.x, cy: p.y, rx: p.w / 2, ry: p.h / 2 });
        else shape = s('rect', { x: p.x - p.w / 2, y: p.y - p.h / 2, width: p.w, height: p.h, rx: n.shape === 'stadium' ? p.h / 2 : n.shape === 'round' ? 14 : 9 });
        svg.append(s('g', { class: `dnode ${n.shape || 'rect'}`, style: `animation-delay:${i * 40}ms`, 'data-pt': pt({ node: n.id, label: n.label }), onclick: () => select(w, { node: n.id, label: n.label }) },
          shape, s('text', { x: p.x, y: p.y + 4.5, 'text-anchor': 'middle' }, n.label.length > 30 ? `${n.label.slice(0, 29)}…` : n.label), s('title', {}, n.label)));
      });
      return svg;
    }

    // ---------- image ----------
    function renderImage(w) {
      const d = w.data;
      const img = h('img', { src: w.imageSrc || '', alt: d.alt || w.title, referrerpolicy: 'no-referrer', draggable: 'false', style: { objectFit: d.fit || 'contain' } });
      const box = h('div', { class: 'img-w loading' }, img);
      img.style.opacity = '0';
      img.addEventListener('load', () => { box.classList.remove('loading'); img.style.transition = 'opacity .4s'; img.style.opacity = '1'; });
      img.addEventListener('error', () => box.classList.remove('loading'));
      img.addEventListener('error', () => box.replaceChildren(h('div', { class: 'empty-w err-w' }, h('b', { class: 'ew-x' }, '!'), d.url ? `Couldn't load ${d.url}` : `Couldn't read ${d.path} (moved, or no longer an image?)`)));
      return h('figure', { class: 'image' }, box, d.caption ? h('figcaption', {}, d.caption) : null);
    }

    // ---------- log ----------
    const ANSI = { 30: '#5b6070', 31: '#ff6b81', 32: '#4fe0b0', 33: '#ffbe5c', 34: '#8ea6ff', 35: '#c58cff', 36: '#5cc8ff', 37: '#d8dce8', 90: '#8b93a9', 91: '#ff8a9b', 92: '#7ff0c8', 93: '#ffd28a', 94: '#aabdff', 95: '#d8acff', 96: '#8fdcff', 97: '#ffffff' };
    function ansi(line) {
      const out = [];
      let style = {};
      let last = 0;
      const re = /\x1b\[([\d;]*)m/g;
      const flush = (t) => { if (t) out.push(Object.keys(style).length ? h('span', { style: { ...style } }, t) : t); };
      for (const m of line.matchAll(re)) {
        flush(line.slice(last, m.index));
        for (const c of (m[1] || '0').split(';').map(Number)) {
          if (c === 0) style = {}; else if (c === 1) style.fontWeight = '700'; else if (ANSI[c]) style.color = ANSI[c];
        }
        last = m.index + m[0].length;
      }
      flush(line.slice(last).replace(/\x1b\[[\d;?]*[A-Za-z]/g, ''));
      return out;
    }
    const logStick = new Map();
    function renderLog(w) {
      const d = w.data;
      const level = (l) => /\b(error|fail(ed)?|fatal|panic)\b/i.test(l) ? 'e' : /\bwarn(ing)?\b/i.test(l) ? 'w' : '';
      const first = (d.dropped || 0) + 1;
      const pre = h('div', { class: `log${d.wrap ? ' wrap' : ''}` },
        d.dropped ? h('div', { class: 'log-drop' }, `… ${d.dropped} earlier line${d.dropped === 1 ? '' : 's'} trimmed`) : null,
        d.lines.map((l, i) => h('div', { class: `ll ${level(l)}`, 'data-pt': pt({ line: first + i, text: l.replace(/\x1b\[[\d;]*m/g, '') }) }, h('span', { class: 'ln' }, String(first + i)), h('span', {}, ansi(l)))));
      pre.addEventListener('scroll', () => logStick.set(w.id, pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8));
      requestAnimationFrame(() => { if (logStick.get(w.id) !== false) pre.scrollTop = pre.scrollHeight; });
      return pre;
    }

    // ---------- checklist ----------
    const ICON = { todo: '', doing: '', done: '✓', failed: '✕', skipped: '–' };
    function renderChecklist(w) {
      const { items, progress } = w.data;
      const pct = progress && progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
      return h('div', { class: 'cl' },
        h('div', { class: 'cl-top' }, h('span', { class: 'cl-n' }, `${progress ? progress.done : 0}/${progress ? progress.total : items.length}`), h('div', { class: 'bar' }, h('i', { style: { width: `${pct}%` } })), h('span', { class: 'muted' }, `${pct}%`)),
        h('ul', {}, items.map((it) => h('li', { class: it.status, 'data-pt': pt({ id: it.id, label: it.label, status: it.status }) },
          h('span', { class: `ck ${it.status}` }, ICON[it.status] || ''), h('span', { class: 'cl-l' }, it.label, it.detail ? h('small', {}, it.detail) : null)))));
    }

    // ---------- form ----------
    function renderForm(w) {
      const d = w.data;
      const open = d.state === 'open';
      const vals = d.values || {};
      const inputs = new Map();
      const err = h('div', { class: 'form-err', role: 'alert' });
      const field = (f) => {
        const v = vals[f.id] !== undefined ? vals[f.id] : f.default;
        let input, extra = null;
        const common = { id: `${w.id}-${f.id}`, name: f.id, disabled: !open, required: f.required };
        if (f.type === 'textarea') { input = h('textarea', { ...common, rows: 3, placeholder: f.placeholder || '' }); input.value = v ?? ''; }
        else if (f.type === 'select') {
          input = h('select', common, f.required ? null : h('option', { value: '' }, '—'), f.options.map((o) => typeof o === 'string' ? h('option', { value: o }, o) : h('option', { value: o.value }, o.label)));
          input.value = v ?? (f.required ? (typeof f.options[0] === 'string' ? f.options[0] : f.options[0].value) : '');
        } else if (f.type === 'checkbox') {
          input = h('input', { ...common, type: 'checkbox', class: 'switch' });
          input.checked = v === true;
        } else if (f.type === 'slider') {
          input = h('input', { ...common, type: 'range', min: f.min, max: f.max, step: f.step || 1 });
          input.value = v ?? f.min;
          extra = h('output', { class: 'mono' }, String(input.value));
          input.addEventListener('input', () => { extra.textContent = input.value; });
        } else {
          input = h('input', { ...common, type: f.type === 'number' ? 'number' : 'text', min: f.min, max: f.max, step: f.step, placeholder: f.placeholder || '' });
          input.value = v ?? '';
        }
        inputs.set(f.id, input);
        return h('label', { class: `field ${f.type}`, for: common.id },
          h('span', { class: 'fl' }, f.label, f.required ? h('b', {}, ' *') : null, extra),
          input, f.help ? h('small', {}, f.help) : null);
      };
      const submit = async (e) => {
        e.preventDefault();
        const values = {};
        for (const f of d.fields) {
          const el = inputs.get(f.id);
          values[f.id] = f.type === 'checkbox' ? el.checked : f.type === 'number' || f.type === 'slider' ? (el.value === '' ? null : Number(el.value)) : el.value;
        }
        btn.disabled = true;
        const r = await api('POST', `/api/widgets/${encodeURIComponent(w.id)}/submit`, { values });
        if (r.error) { err.textContent = r.error; btn.disabled = false; }
      };
      const btn = h('button', { class: 'btn accent', type: 'submit', disabled: !open }, open ? d.submitLabel || 'Send to agent' : d.state === 'submitted' ? 'Sent ✓' : d.state);
      const STATE = { submitted: 'Submitted · values sent to the agent', timeout: 'Timed out · the agent moved on', cancelled: 'Cancelled by the agent' };
      let timer = null;
      if (open && d.expiresAt) {
        const total = Date.parse(d.expiresAt) - Date.parse(w.createdAt);
        const left = Math.max(0, Date.parse(d.expiresAt) - Date.now());
        const bar = h('i', { style: { transform: `scaleX(${total > 0 ? left / total : 0})`, transition: `transform ${left}ms linear` } });
        requestAnimationFrame(() => requestAnimationFrame(() => { bar.style.transform = 'scaleX(0)'; }));
        timer = h('div', { class: 'q-timer' }, bar);
      }
      return h('form', { class: `form ${d.state}`, onsubmit: submit, novalidate: true },
        h('div', { class: 'q-text' }, d.prompt),
        d.detail ? h('p', { class: 'q-detail' }, d.detail) : null,
        h('div', { class: 'fields' }, d.fields.map(field)),
        err,
        h('div', { class: 'q-foot' }, open ? h('span', {}, 'The agent is waiting for this') : h('span', { class: `q-state ${d.state === 'submitted' ? 'answered' : d.state}` }, STATE[d.state] || d.state), timer, btn));
    }

    // ---------- map (offline: bundled Natural Earth 1:110m land) ----------
    let world = null;
    const worldReady = fetch('/world-110m.json').then((r) => r.json()).then((j) => {
      world = j.rings.map((r) => { let d = ''; for (let i = 0; i < r.length; i += 2) d += `${i && Math.abs(r[i] - r[i - 2]) < 180 ? 'L' : 'M'}${(r[i] + 180).toFixed(1)},${(90 - r[i + 1]).toFixed(1)}`; return `${d}Z`; }).join('');
      document.querySelectorAll('.card[data-kind="map"]').forEach((c) => rerender(c.dataset.id));
    }).catch(() => { world = ''; });
    void worldReady;
    function renderMap(w) {
      const { markers = [], bounds } = w.data;
      let [west, south, east, north] = bounds || [-170, -58, 190, 84];
      if (!bounds && markers.length) {
        const lons = markers.map((m) => m.lon), lats = markers.map((m) => m.lat);
        west = Math.min(...lons); east = Math.max(...lons); south = Math.min(...lats); north = Math.max(...lats);
        const padX = Math.max(12, (east - west) * 0.2), padY = Math.max(8, (north - south) * 0.25);
        west -= padX; east += padX; south -= padY; north += padY;
        if (east - west < 40) { const c = (east + west) / 2; west = c - 20; east = c + 20; }
        if (north - south < 24) { const c = (north + south) / 2; south = c - 12; north = c + 12; }
      }
      const vx = west + 180, vy = 90 - north, vw = east - west, vh = north - south;
      // map units per screen pixel ("meet" fits the tighter axis), so markers and text keep a fixed on-screen size
      const cw = (w.w || 2) * 300 + ((w.w || 2) - 1) * 16, ch = (w.h || 2) * 150 + ((w.h || 2) - 1) * 16 - 56;
      const u = Math.max(vw / cw, vh / Math.max(60, ch));
      const k = u * 180; // legacy stroke scale
      const max = Math.max(1, ...markers.map((m) => (typeof m.value === 'number' ? Math.abs(m.value) : 0)));
      const svg = s('svg', { class: 'geo', viewBox: `${vx} ${vy} ${vw} ${vh}`, preserveAspectRatio: 'xMidYMid meet' });
      const g = s('g', { class: 'grat', 'stroke-width': u * 0.6 });
      for (let lon = -180; lon <= 180; lon += 30) g.append(s('line', { x1: lon + 180, x2: lon + 180, y1: 0, y2: 180 }));
      for (let lat = -60; lat <= 60; lat += 30) g.append(s('line', { x1: 0, x2: 360, y1: 90 - lat, y2: 90 - lat }));
      svg.append(g);
      if (world) svg.append(s('path', { class: 'land', d: world, 'stroke-width': u * 0.8 }));
      else if (world === null) svg.append(s('text', { x: vx + vw / 2, y: vy + vh / 2, 'text-anchor': 'middle', class: 'map-load', 'font-size': u * 12 }, 'loading map…'));
      const sel = w.selection && w.selection.label;
      markers.forEach((m, i) => {
        const x = m.lon + 180, y = 90 - m.lat;
        const r = (typeof m.value === 'number' ? 4 + 8 * Math.sqrt(Math.abs(m.value) / max) : 5) * u;
        svg.append(s('g', { class: `mk${sel === m.label ? ' sel' : ''}`, style: `--c:${m.color || '#ffbe5c'};animation-delay:${i * 50}ms`, 'data-pt': pt({ label: m.label, lat: m.lat, lon: m.lon, value: m.value }), onclick: () => select(w, sel === m.label ? null : { label: m.label, lat: m.lat, lon: m.lon, value: m.value }) },
          s('circle', { class: 'halo', cx: x, cy: y, r: r * 1.8 }), s('circle', { class: 'dot', cx: x, cy: y, r, 'stroke-width': u * 1.5 }),
          s('text', { x: x + r + 4 * u, y: y + 4 * u, 'font-size': u * 11, 'stroke-width': u * 3, 'text-anchor': x + r + 90 * u > vx + vw ? 'end' : 'start', dx: x + r + 90 * u > vx + vw ? -(2 * r + 8 * u) : 0 }, m.value !== undefined ? `${m.label} · ${m.value}` : m.label), s('title', {}, m.label)));
      });
      return h('div', { class: 'map-w' }, svg, markers.length ? null : h('span', { class: 'geo-empty' }, 'No markers yet'), h('span', { class: 'attrib' }, 'Natural Earth · offline'));
    }

    // ---------- timeline ----------
    function renderTimeline(w) {
      const items = w.data.items;
      const times = items.map((i) => Date.parse(i.at));
      const dated = times.every((t) => !Number.isNaN(t));
      const minGap = 132;
      const n = items.length;
      const width = Math.max(n * minGap, 100);
      let xs;
      if (dated && n > 1) {
        const t0 = Math.min(...times), t1 = Math.max(...times);
        xs = times.map((t) => (t1 === t0 ? 0.5 : (t - t0) / (t1 - t0)));
        // keep labels apart: enforce a minimum spacing in order
        const order = xs.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]);
        const min = 1 / Math.max(1, n) * 0.9;
        for (let k = 1; k < order.length; k++) if (order[k][0] - order[k - 1][0] < min) order[k][0] = order[k - 1][0] + min;
        const span = order[order.length - 1][0] || 1;
        order.forEach(([x, i]) => { xs[i] = x / Math.max(1, span); });
      } else xs = items.map((_, i) => (n === 1 ? 0.5 : i / (n - 1)));
      const fmt = (i) => {
        if (!dated) return i.at;
        const d = new Date(i.at);
        return /T\d/.test(i.at) ? d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
      };
      const sel = w.selection && w.selection.index;
      return h('div', { class: 'tl-scroll' }, h('div', { class: 'tl', style: { minWidth: `${width}px` } },
        h('div', { class: 'tl-axis' }),
        items.map((it, i) => h('button', {
          class: `tl-i ${it.status || 'info'} ${i % 2 ? 'down' : 'up'}${sel === i ? ' sel' : ''}`, title: it.detail || it.title,
          style: { left: `calc(56px + (100% - 112px) * ${xs[i]})`, animationDelay: `${i * 60}ms` },
          'data-pt': pt({ index: i, at: it.at, title: it.title }),
          onclick: () => select(w, sel === i ? null : { index: i, at: it.at, title: it.title }),
        }, h('span', { class: 'tl-dot' }), h('span', { class: 'tl-t' }, h('small', {}, fmt(it)), it.title)))));
    }

    return { code: renderCode, diff: renderDiff, diagram: renderDiagram, image: renderImage, log: renderLog, checklist: renderChecklist, form: renderForm, map: renderMap, timeline: renderTimeline };
  };
})(typeof window !== 'undefined' ? window : globalThis);
