// mcp-screen infinite canvas: pan & zoom, drag-to-move, minimap, "Tidy up", and the annotation layer
// (arrows, circles, highlighter, sticky notes) the agent can read back. Deliberately not a whiteboard:
// no shapes library, no rotation, no grouping; just enough to point at things.
(function (root) {
  'use strict';
  const COL = 300, ROW = 150, GAP = 16;
  const COLORS = ['#ffd166', '#ff6b81', '#7c9cff', '#4fe0b0', '#c58cff'];
  const TOOLS = [
    { id: 'select', key: 'v', label: 'Select & pan', icon: 'M3 2l10 5-4 1.5L7.5 13z' },
    { id: 'arrow', key: 'a', label: 'Arrow', icon: 'M3 13L13 3M7 3h6v6' },
    { id: 'circle', key: 'o', label: 'Circle', icon: 'M8 2.5a5.5 4.5 0 1 0 .01 0z' },
    { id: 'highlight', key: 'h', label: 'Highlighter', icon: 'M2.5 12.5c2-3 3.5-6 5.5-6s1 4 3 4 2-3 2.5-4' },
    { id: 'note', key: 'n', label: 'Sticky note', icon: 'M3 3h10v6l-4 4H3zM9 13V9h4' },
  ];

  root.McpScreenCanvas = function makeCanvas(ctx) {
    const { h, s, api, state, stage, world, grid } = ctx;
    const KEY = 'mcp-screen:view';
    const view = Object.assign({ x: 32, y: 28, z: 1 }, JSON.parse(localStorage.getItem(KEY) || 'null') || {});
    let tool = 'select';
    let color = COLORS[0];
    let zTop = 10;
    const notes = new Map(); // annotation id -> DOM (svg group or note div)

    // ---------- coordinates ----------
    const sizeOf = (w) => ({ width: w.w * COL + (w.w - 1) * GAP, height: w.h * ROW + (w.h - 1) * GAP });
    // the stage only changes size on window resize; reading it per frame would force a layout flush
    let rectCache = null;
    const stageRect = () => rectCache || (rectCache = stage.getBoundingClientRect());
    new ResizeObserver(() => { rectCache = null; }).observe(stage);
    window.addEventListener('resize', () => { rectCache = null; });
    window.addEventListener('scroll', () => { rectCache = null; }, true);
    const toWorld = (cx, cy) => { const r = stageRect(); return [(cx - r.left - view.x) / view.z, (cy - r.top - view.y) / view.z]; };
    const apply = () => {
      world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.z})`;
      const cell = Math.max(8, 26 * view.z);
      if (cell !== dotsCell) { dotsCell = cell; dots.style.backgroundSize = `${cell}px ${cell}px`; }
      dots.style.transform = `translate(${(((view.x % cell) + cell) % cell)}px, ${(((view.y % cell) + cell) % cell)}px)`;
      const zl = `${Math.round(view.z * 100)}%`;
      if (zoomLabel.textContent !== zl) zoomLabel.textContent = zl; // an identical write still invalidates paint
      // while the view moves, the world is one composited layer and animations pause, so a pan or
      // zoom is a GPU transform, not a repaint of every card; it re-rasters sharply 160 ms after
      if (!stage.classList.contains('moving')) stage.classList.add('moving');
      clearTimeout(movingTimer);
      movingTimer = setTimeout(() => stage.classList.remove('moving'), 160);
      schedule();
    };
    let movingTimer = 0, dotsCell = 0;
    const dots = h('div', { class: 'dots', 'aria-hidden': 'true' });
    stage.prepend(dots);
    // per-frame work (minimap, culling) is coalesced into one rAF; the saved view is debounced
    let frameQueued = false, saveTimer = 0;
    function schedule() {
      if (frameQueued) return;
      frameQueued = true;
      requestAnimationFrame(() => { frameQueued = false; drawMinimap(); cull(); });
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => localStorage.setItem(KEY, JSON.stringify(view)), 250);
    }
    // cards far outside the viewport skip rendering (content-visibility) but keep their box, so nothing shifts
    function cull() {
      const r = stageRect();
      const m = 400 / view.z;
      const x0 = -view.x / view.z - m, y0 = -view.y / view.z - m, x1 = (r.width - view.x) / view.z + m, y1 = (r.height - view.y) / view.z + m;
      for (const card of world.querySelectorAll(':scope .card[data-id]')) {
        const w = state.widgets.get(card.dataset.id);
        if (!w) continue;
        const { width, height } = sizeOf(w);
        const off = w.x > x1 || w.y > y1 || w.x + width < x0 || w.y + height < y0;
        if (off !== card.classList.contains('culled')) card.classList.toggle('culled', off);
      }
    }
    // centre one widget in the usable area at a given zoom (used by "reveal" and by tests)
    function focusOn(id, z = 1) {
      const w = state.widgets.get(id);
      if (!w) return;
      const r = stageRect();
      const { width, height } = sizeOf(w);
      view.z = z;
      view.x = 76 + (r.width - 76 - 24) / 2 - (w.x + width / 2) * z;
      view.y = Math.max(24, (r.height - height * z) / 2) - w.y * z;
      apply();
    }
    const panBy = (dx, dy) => { view.x += dx; view.y += dy; apply(); };
    function zoomAt(z, cx, cy) {
      const nz = Math.min(2.5, Math.max(0.2, z));
      const r = stageRect();
      const px = cx - r.left, py = cy - r.top;
      view.x = px - ((px - view.x) / view.z) * nz;
      view.y = py - ((py - view.y) / view.z) * nz;
      view.z = nz;
      apply();
    }
    function bounds() {
      const ws = [...state.widgets.values()];
      if (!ws.length) return null;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const w of ws) { const { width, height } = sizeOf(w); x0 = Math.min(x0, w.x); y0 = Math.min(y0, w.y); x1 = Math.max(x1, w.x + width); y1 = Math.max(y1, w.y + height); }
      for (const a of state.annotations.values()) for (const [x, y] of a.points) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
      return { x0, y0, x1, y1 };
    }
    function fit(animate = true) {
      const b = bounds();
      const r = stageRect();
      if (!b) { view.x = 32; view.y = 28; view.z = 1; return apply(); }
      // usable area: right of the annotation toolbar, left of the minimap/zoom bar
      const left = 76, right = r.width > 900 ? 250 : 24, pad = 28;
      const aw = r.width - left - right - pad * 2, ah = r.height - pad * 2;
      const z = Math.min(1, aw / (b.x1 - b.x0), ah / (b.y1 - b.y0));
      view.z = Math.max(0.2, z);
      view.x = left + pad + (aw - (b.x1 - b.x0) * view.z) / 2 - b.x0 * view.z;
      view.y = pad + Math.max(0, (ah - (b.y1 - b.y0) * view.z) / 2) - b.y0 * view.z;
      if (animate) { world.classList.add('glide'); setTimeout(() => world.classList.remove('glide'), 450); }
      apply();
    }

    // ---------- chrome: toolbar, zoom bar, minimap ----------
    const toolbar = h('div', { class: 'toolbar', role: 'toolbar', 'aria-label': 'Annotate' },
      TOOLS.map((t) => h('button', { class: `tool${t.id === tool ? ' on' : ''}`, 'data-tool': t.id, title: `${t.label} (${t.key.toUpperCase()})`, 'aria-label': t.label, onclick: () => setTool(t.id) },
        svgIcon(t.icon))),
      h('span', { class: 'sep' }),
      COLORS.map((c) => h('button', { class: `swatch${c === color ? ' on' : ''}`, 'data-color': c, title: 'Ink colour', style: { '--c': c }, onclick: () => setColor(c) })));
    const zoomLabel = h('button', { class: 'zl', title: 'Reset to 100%', onclick: () => { const r = stageRect(); zoomAt(1, r.left + r.width / 2, r.top + r.height / 2); } }, '100%');
    const zoombar = h('div', { class: 'zoombar' },
      h('button', { class: 'zb', title: 'Zoom out (−)', onclick: () => { const r = stageRect(); zoomAt(view.z / 1.2, r.left + r.width / 2, r.top + r.height / 2); } }, '−'),
      zoomLabel,
      h('button', { class: 'zb', title: 'Zoom in (+)', onclick: () => { const r = stageRect(); zoomAt(view.z * 1.2, r.left + r.width / 2, r.top + r.height / 2); } }, '+'),
      h('button', { class: 'zb wide', id: 'fit-btn', title: 'Fit everything (F)', onclick: () => fit() }, 'Fit'),
      h('button', { class: 'zb wide accent', id: 'tidy-btn', title: 'Tidy up: re-pack widgets into a grid', onclick: () => tidy() }, svgIcon('M2 3h5v4H2zM9 3h5v4H9zM2 9h12v4H2z'), 'Tidy up'),
      h('button', { class: 'zb', id: 'help-btn', title: 'Keyboard shortcuts (?)', 'aria-label': 'Keyboard shortcuts', onclick: () => window.__mcpScreenShortcuts && window.__mcpScreenShortcuts(true) }, '?'));
    const mini = h('canvas', { class: 'minimap', width: 220, height: 140, title: 'Minimap: click or drag to move' });
    stage.append(toolbar, zoombar, mini);

    function svgIcon(d) { return s('svg', { viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, s('path', { d })); }
    function setTool(t) {
      tool = t;
      toolbar.querySelectorAll('.tool').forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
      stage.dataset.tool = t;
    }
    function setColor(c) {
      color = c;
      toolbar.querySelectorAll('.swatch').forEach((b) => b.classList.toggle('on', b.dataset.color === c));
    }
    setTool('select');
    // how many 300px columns read comfortably on this screen (phones get one, big screens four)
    function columnsForView() {
      const r = stageRect();
      return Math.max(1, Math.min(4, Math.floor((r.width - 100) / 260)));
    }
    async function tidy() {
      world.classList.add('glide');
      await api('POST', '/api/canvas/tidy', { columns: columnsForView() });
      setTimeout(() => { fit(); world.classList.remove('glide'); }, 380);
    }

    let miniMap = null;
    function drawMinimap() {
      const b = bounds();
      mini.classList.toggle('hidden', !b);
      const r = stageRect();
      const g = mini.getContext('2d');
      const W = mini.width, H = mini.height;
      g.clearRect(0, 0, W, H);
      const vx0 = -view.x / view.z, vy0 = -view.y / view.z, vx1 = vx0 + r.width / view.z, vy1 = vy0 + r.height / view.z;
      const x0 = Math.min(b ? b.x0 : 0, vx0), y0 = Math.min(b ? b.y0 : 0, vy0), x1 = Math.max(b ? b.x1 : 1, vx1), y1 = Math.max(b ? b.y1 : 1, vy1);
      const k = Math.min((W - 16) / (x1 - x0), (H - 16) / (y1 - y0));
      const ox = (W - (x1 - x0) * k) / 2 - x0 * k, oy = (H - (y1 - y0) * k) / 2 - y0 * k;
      miniMap = { k, ox, oy };
      for (const w of state.widgets.values()) {
        const { width, height } = sizeOf(w);
        g.fillStyle = w.kind === 'question' || w.kind === 'form' ? 'rgba(255,190,92,.55)' : 'rgba(142,166,255,.38)';
        roundRect(g, ox + w.x * k, oy + w.y * k, Math.max(2, width * k), Math.max(2, height * k), 2);
        g.fill();
      }
      for (const a of state.annotations.values()) {
        g.fillStyle = a.color;
        const [x, y] = a.points[0];
        g.fillRect(ox + x * k - 1.5, oy + y * k - 1.5, 3, 3);
      }
      g.strokeStyle = 'rgba(255,255,255,.75)';
      g.lineWidth = 1.2;
      g.strokeRect(ox + vx0 * k, oy + vy0 * k, (vx1 - vx0) * k, (vy1 - vy0) * k);
    }
    function roundRect(g, x, y, w, hgt, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + hgt, r); g.arcTo(x + w, y + hgt, x, y + hgt, r); g.arcTo(x, y + hgt, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
    function miniJump(e) {
      if (!miniMap) return;
      const rr = mini.getBoundingClientRect();
      const wx = (e.clientX - rr.left - miniMap.ox) / miniMap.k, wy = (e.clientY - rr.top - miniMap.oy) / miniMap.k;
      const r = stageRect();
      view.x = r.width / 2 - wx * view.z;
      view.y = r.height / 2 - wy * view.z;
      apply();
    }
    mini.addEventListener('pointerdown', (e) => { e.stopPropagation(); mini.setPointerCapture(e.pointerId); miniJump(e); const mv = (ev) => miniJump(ev); mini.addEventListener('pointermove', mv); mini.addEventListener('pointerup', () => mini.removeEventListener('pointermove', mv), { once: true }); });

    // ---------- placing cards ----------
    function position(card, w) {
      const { width, height } = sizeOf(w);
      const extra = w.status === 'needs-approval' && w.h < 2 ? ROW + GAP : 0;
      card.style.left = `${w.x}px`;
      card.style.top = `${w.y}px`;
      card.style.width = `${width}px`;
      card.style.height = `${height + extra}px`;
    }

    // ---------- pan / zoom / drag ----------
    stage.addEventListener('wheel', (e) => {
      if (e.target.closest('.minimap, .toolbar, .zoombar')) return;
      if (e.ctrlKey || e.metaKey) { e.preventDefault(); zoomAt(view.z * Math.exp(-e.deltaY * 0.0022), e.clientX, e.clientY); return; }
      // Let scrollable widget bodies scroll; pan the canvas otherwise.
      for (let el = e.target; el && el !== stage; el = el.parentElement) {
        if ((Math.abs(e.deltaY) > Math.abs(e.deltaX) ? el.scrollHeight > el.clientHeight + 1 : el.scrollWidth > el.clientWidth + 1) && /(auto|scroll)/.test(getComputedStyle(el).overflow + getComputedStyle(el).overflowY + getComputedStyle(el).overflowX)) {
          const atTop = el.scrollTop <= 0 && e.deltaY < 0, atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1 && e.deltaY > 0;
          if (!atTop && !atBottom) return;
        }
      }
      e.preventDefault();
      view.x -= e.deltaX;
      view.y -= e.deltaY;
      apply();
    }, { passive: false });

    let spaceDown = false;
    stage.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.toolbar, .zoombar, .minimap, .note-edit, .note .x, .ann-x')) return;
      if (tool !== 'select' && !spaceDown && e.button === 0) return startDraw(e);
      const head = e.target.closest('.card-head');
      const card = e.target.closest('.card');
      const onAnn = e.target.closest('.ann, .note');
      if (head && card && e.button === 0 && !spaceDown && !e.target.closest('button, a, input, select, textarea')) return startDrag(e, card);
      if (onAnn && !spaceDown) return selectAnn(onAnn.dataset.ann);
      if (card && !spaceDown && e.button !== 1) return;
      startPan(e);
    });
    function startPan(e) {
      e.preventDefault();
      stage.classList.add('panning');
      selectAnn(null);
      const sx = e.clientX, sy = e.clientY, vx = view.x, vy = view.y;
      const mv = (ev) => { view.x = vx + ev.clientX - sx; view.y = vy + ev.clientY - sy; apply(); };
      const up = () => { stage.classList.remove('panning'); window.removeEventListener('pointermove', mv); };
      window.addEventListener('pointermove', mv);
      window.addEventListener('pointerup', up, { once: true });
    }
    function startDrag(e, card) {
      e.preventDefault();
      const id = card.dataset.id;
      const w = state.widgets.get(id);
      if (!w) return;
      card.classList.add('dragging');
      card.style.zIndex = String(++zTop);
      const sx = e.clientX, sy = e.clientY, ox = w.x, oy = w.y;
      let nx = ox, ny = oy;
      const mv = (ev) => {
        nx = Math.round((ox + (ev.clientX - sx) / view.z) / 8) * 8;
        ny = Math.round((oy + (ev.clientY - sy) / view.z) / 8) * 8;
        card.style.left = `${nx}px`;
        card.style.top = `${ny}px`;
        // annotations on this card follow it while dragging
        for (const a of state.annotations.values()) if (a.target && a.target.widgetId === id && notes.get(a.id)) notes.get(a.id).style.transform = `translate(${nx - ox}px, ${ny - oy}px)`;
      };
      const up = async () => {
        window.removeEventListener('pointermove', mv);
        card.classList.remove('dragging');
        if (nx !== ox || ny !== oy) { w.x = nx; w.y = ny; await api('POST', `/api/widgets/${encodeURIComponent(id)}/move`, { x: nx, y: ny }); }
        drawMinimap();
      };
      window.addEventListener('pointermove', mv);
      window.addEventListener('pointerup', up, { once: true });
    }

    document.addEventListener('keydown', (e) => {
      if (state.tab !== 'canvas' || e.target.closest('input, textarea, select, [contenteditable]') || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === ' ') { spaceDown = true; stage.classList.add('space'); e.preventDefault(); return; }
      const t = TOOLS.find((x) => x.key === e.key.toLowerCase());
      if (t) return setTool(t.id);
      if (e.key === 'Escape') { setTool('select'); selectAnn(null); }
      if (e.key === 'f') fit();
      if (e.key === '+' || e.key === '=') { const r = stageRect(); zoomAt(view.z * 1.2, r.left + r.width / 2, r.top + r.height / 2); }
      if (e.key === '-') { const r = stageRect(); zoomAt(view.z / 1.2, r.left + r.width / 2, r.top + r.height / 2); }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected) { api('DELETE', `/api/annotations/${selected}`); selected = null; }
    });
    document.addEventListener('keyup', (e) => { if (e.key === ' ') { spaceDown = false; stage.classList.remove('space'); } });

    // ---------- annotations: drawing ----------
    const ink = s('svg', { class: 'ink', width: 1, height: 1 },
      s('defs', {}, COLORS.map((c, i) => s('marker', { id: `ink-head-${i}`, viewBox: '0 0 10 10', refX: 7, refY: 5, markerWidth: 4.2, markerHeight: 4.2, orient: 'auto-start-reverse' }, s('path', { d: 'M0,0 L10,5 L0,10 z', fill: c })))));
    const noteLayer = h('div', { class: 'note-layer' });
    world.append(ink, noteLayer);
    const head = (c) => `url(#ink-head-${Math.max(0, COLORS.indexOf(c))})`;
    const smooth = (pts) => pts.length < 3 ? `M${pts.map((p) => p.join(',')).join(' L')}` : pts.reduce((d, p, i) => {
      if (i === 0) return `M${p[0]},${p[1]}`;
      const prev = pts[i - 1];
      return `${d} Q${prev[0]},${prev[1]} ${(prev[0] + p[0]) / 2},${(prev[1] + p[1]) / 2}`;
    }, '') + ` L${pts[pts.length - 1].join(',')}`;
    function shapeEl(kind, pts, c) {
      if (kind === 'arrow') { const [a, b] = [pts[0], pts[pts.length - 1]]; return s('path', { class: 'ink-arrow', d: `M${a[0]},${a[1]} L${b[0]},${b[1]}`, stroke: c, 'marker-end': head(c) }); }
      if (kind === 'circle') {
        const [a, b] = [pts[0], pts[pts.length - 1]];
        const cx = (a[0] + b[0]) / 2, cy = (a[1] + b[1]) / 2, rx = Math.abs(b[0] - a[0]) / 2 + 6, ry = Math.abs(b[1] - a[1]) / 2 + 6;
        // A slightly hand-drawn ellipse: overshoot the start so it reads as "circled".
        const p = (t, k = 1) => `${cx + rx * k * Math.cos(t)},${cy + ry * k * Math.sin(t)}`;
        let d = `M${p(-2.2, 1.04)}`;
        for (let t = -2.2; t <= -2.2 + Math.PI * 2.12; t += 0.18) d += ` L${p(t, 1 + 0.035 * Math.sin(t * 3))}`;
        return s('path', { class: 'ink-circle', d, stroke: c });
      }
      return s('path', { class: 'ink-hl', d: smooth(pts), stroke: c });
    }
    function startDraw(e) {
      e.preventDefault();
      const start = toWorld(e.clientX, e.clientY);
      if (tool === 'note') return editNote({ points: [start], color, isNew: true });
      const pts = [start];
      const g = s('g', { class: 'ann drawing' });
      ink.append(g);
      const redraw = () => g.replaceChildren(shapeEl(tool, pts, color));
      const kind = tool;
      const mv = (ev) => {
        const p = toWorld(ev.clientX, ev.clientY);
        if (kind === 'highlight') { const l = pts[pts.length - 1]; if (Math.hypot(p[0] - l[0], p[1] - l[1]) > 3 / view.z && pts.length < 1500) pts.push(p); }
        else pts[1] = p;
        redraw();
      };
      const up = () => {
        window.removeEventListener('pointermove', mv);
        const end = pts[pts.length - 1];
        if (pts.length < 2 || Math.hypot(end[0] - pts[0][0], end[1] - pts[0][1]) < 8) { g.remove(); return; }
        askText(kind, pts, g);
      };
      window.addEventListener('pointermove', mv);
      window.addEventListener('pointerup', up, { once: true });
    }
    /** After a shape: an optional note for the agent ("why?"), then save. */
    function askText(kind, pts, g) {
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
      const at = kind === 'arrow' ? pts[0] : [Math.max(...xs) + 10, Math.min(...ys) - 6];
      const input = h('input', { class: 'note-edit inline', placeholder: 'Add a note for the agent… (Enter)', maxlength: 2000 });
      const box = h('div', { class: 'note-edit-wrap', style: { left: `${at[0]}px`, top: `${at[1]}px`, '--c': color } }, input);
      noteLayer.append(box);
      setTimeout(() => input.focus(), 0);
      let done = false;
      const finish = async (save) => {
        if (done) return;
        done = true;
        box.remove();
        if (!save) { g.remove(); return; }
        const res = await createAnnotation(kind, pts, input.value);
        g.remove();
        if (res && res.result) flashTarget(res.result);
      };
      input.addEventListener('keydown', (ev) => { ev.stopPropagation(); if (ev.key === 'Enter') finish(true); if (ev.key === 'Escape') finish(false); });
      input.addEventListener('blur', () => finish(true));
    }
    function editNote({ points, color: c, id, text = '', isNew }) {
      const ta = h('textarea', { class: 'note-edit', placeholder: 'Note for the agent…', maxlength: 2000, rows: 3 });
      ta.value = text;
      const box = h('div', { class: 'note editing', style: { left: `${points[0][0]}px`, top: `${points[0][1]}px`, '--c': c } }, ta, h('small', {}, 'Enter to save · Shift+Enter for a new line'));
      noteLayer.append(box);
      setTimeout(() => ta.focus(), 0);
      let done = false;
      const finish = async (save) => {
        if (done) return;
        done = true;
        box.remove();
        const value = ta.value.trim();
        if (!save) return;
        if (isNew) { if (value) { const r = await createAnnotation('note', points, value); if (r && r.result) flashTarget(r.result); } }
        else await api('PATCH', `/api/annotations/${id}`, { text: value });
      };
      ta.addEventListener('keydown', (ev) => { ev.stopPropagation(); if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); finish(true); } if (ev.key === 'Escape') finish(false); });
      ta.addEventListener('blur', () => finish(true));
      setTool('select');
    }

    /** Which widget does this point at, and which rendered data points ([data-pt]) are under it? */
    function hitTest(kind, pts) {
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
      const box = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
      const last = pts[pts.length - 1];
      const anchor = kind === 'arrow' ? last : kind === 'note' ? pts[0] : [(box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2];
      const ws = [...state.widgets.values()].reverse();
      const inside = (w, p) => { const { width, height } = sizeOf(w); return p[0] >= w.x && p[0] <= w.x + width && p[1] >= w.y && p[1] <= w.y + height; };
      let target = ws.find((w) => inside(w, anchor));
      if (!target && (kind === 'circle' || kind === 'highlight')) {
        let best = 0;
        for (const w of ws) {
          const { width, height } = sizeOf(w);
          const ow = Math.min(w.x + width, box.x1) - Math.max(w.x, box.x0), oh = Math.min(w.y + height, box.y1) - Math.max(w.y, box.y0);
          if (ow > 0 && oh > 0 && ow * oh > best) { best = ow * oh; target = w; }
        }
      }
      if (!target) return {};
      const card = grid.querySelector(`.card[data-id="${CSS.escape(target.id)}"]`);
      if (!card) return { widgetId: target.id };
      const found = [];
      const cands = [...card.querySelectorAll('[data-pt]')].map((el) => {
        const r = el.getBoundingClientRect();
        if (!r.width && !r.height) return null;
        const [cx, cy] = toWorld(r.left + r.width / 2, r.top + r.height / 2);
        const [lx, ly] = toWorld(r.left, r.top);
        const [rx, ry] = toWorld(r.right, r.bottom);
        return { el, cx, cy, lx, ly, rx, ry };
      }).filter(Boolean);
      if (kind === 'circle') {
        const cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2, rx = (box.x1 - box.x0) / 2 + 6, ry = (box.y1 - box.y0) / 2 + 6;
        for (const c of cands) if (((c.cx - cx) / rx) ** 2 + ((c.cy - cy) / ry) ** 2 <= 1) found.push(c);
      } else if (kind === 'highlight') {
        for (const c of cands) if (pts.some(([x, y]) => x >= c.lx - 4 && x <= c.rx + 4 && y >= c.ly - 4 && y <= c.ry + 4)) found.push(c);
      } else {
        const [ax, ay] = anchor;
        const containing = cands.filter((c) => ax >= c.lx && ax <= c.rx && ay >= c.ly && ay <= c.ry);
        if (containing.length) found.push(containing.sort((p, q) => (p.rx - p.lx) * (p.ry - p.ly) - (q.rx - q.lx) * (q.ry - q.ly))[0]);
        else {
          const near = cands.map((c) => [Math.hypot(c.cx - ax, c.cy - ay), c]).sort((p, q) => p[0] - q[0])[0];
          if (near && near[0] < 40) found.push(near[1]);
        }
      }
      const dataPoints = found.slice(0, 20).map((c) => { try { return JSON.parse(c.el.dataset.pt); } catch { return null; } }).filter(Boolean);
      return { widgetId: target.id, dataPoints };
    }
    function createAnnotation(kind, pts, text) {
      const { widgetId, dataPoints } = hitTest(kind, pts);
      const body = { kind, points: pts.map(([x, y]) => [Math.round(x), Math.round(y)]), color };
      if (text && text.trim()) body.text = text.trim();
      if (widgetId) body.widgetId = widgetId;
      if (dataPoints && dataPoints.length) body.dataPoints = dataPoints;
      return api('POST', '/api/annotations', body);
    }
    function flashTarget(a) {
      if (!a.target) return;
      const card = grid.querySelector(`.card[data-id="${CSS.escape(a.target.widgetId)}"]`);
      if (!card) return;
      card.classList.add('flash');
      setTimeout(() => card.classList.remove('flash'), 900);
      const pts = a.target.dataPoints && a.target.dataPoints.length;
      ctx.toast(`The agent can read this note${pts ? ` · points at ${pts} data point${pts === 1 ? '' : 's'} in “${a.target.title}”` : ` · on “${a.target.title}”`}`, null, 3200);
    }

    // ---------- annotations: rendering ----------
    let selected = null;
    function selectAnn(id) {
      selected = id;
      for (const [aid, el] of notes) el.classList.toggle('sel', aid === id);
    }
    function label(a) {
      if (!a.text || a.kind === 'note') return null;
      const xs = a.points.map((p) => p[0]), ys = a.points.map((p) => p[1]);
      const at = a.kind === 'arrow' ? a.points[0] : [Math.max(...xs) + 10, Math.min(...ys) - 6];
      return h('div', { class: 'ann-label', 'data-ann': a.id, style: { left: `${at[0]}px`, top: `${at[1]}px`, '--c': a.color } }, a.text);
    }
    // the conversation under a mark: agent replies, a "waiting" state, and a follow-up box once answered
    function thread(a) {
      if (!a.text) return null;
      const replies = a.replies || [];
      const last = replies[replies.length - 1];
      const waiting = !last || last.from === 'human';
      const box = h('div', { class: `thread${waiting ? ' waiting' : ''}`, onpointerdown: (e) => e.stopPropagation(), ondblclick: (e) => e.stopPropagation() },
        replies.map((r, i) => h('div', { class: `reply ${r.from}`, style: { animationDelay: `${i === replies.length - 1 ? 0 : 0}ms` } },
          h('span', { class: 'who' }, r.from === 'agent' ? 'agent' : 'you'), h('span', { class: 'rt' }, r.text))),
        waiting ? h('div', { class: 'reply pending' }, h('span', { class: 'dots' }, h('i'), h('i'), h('i')), h('span', {}, 'waiting for the agent')) : null);
      if (!waiting) {
        const input = h('input', { class: 'reply-in', placeholder: 'Follow up…', maxlength: 2000, 'aria-label': 'Follow up for the agent' });
        input.addEventListener('keydown', (ev) => {
          ev.stopPropagation();
          if (ev.key === 'Enter' && input.value.trim()) { api('POST', `/api/annotations/${a.id}/reply`, { text: input.value.trim(), from: 'human' }); input.disabled = true; }
        });
        box.append(input);
      }
      return box;
    }

    function renderAnnotations() {
      const seen = new Set();
      for (const a of state.annotations.values()) {
        seen.add(a.id);
        const key = JSON.stringify([a.points, a.text, a.color, a.target && a.target.widgetId, a.replies]);
        const old = notes.get(a.id);
        if (old && old.dataset.key === key) continue;
        old && old.remove();
        old && old._label && old._label.remove();
        let el;
        if (a.kind === 'note') {
          el = h('div', { class: 'note', 'data-ann': a.id, style: { left: `${a.points[0][0]}px`, top: `${a.points[0][1]}px`, '--c': a.color }, ondblclick: () => editNote({ ...a, isNew: false }) },
            h('div', { class: 'note-text' }, a.text || ''),
            h('div', { class: 'note-foot' }, a.target ? `on “${a.target.title}”` : 'on the canvas'),
            thread(a),
            h('button', { class: 'x', title: 'Delete note', onclick: (ev) => { ev.stopPropagation(); api('DELETE', `/api/annotations/${a.id}`); } }, '×'));
          noteLayer.append(el);
        } else {
          el = s('g', { class: `ann ${a.kind}`, 'data-ann': a.id }, s('path', { class: 'hit', d: shapeEl(a.kind, a.points, a.color).getAttribute('d') }), shapeEl(a.kind, a.points, a.color));
          ink.append(el);
          const l = label(a);
          if (l) {
            const t = thread(a);
            if (t) l.append(t);
            l.append(h('button', { class: 'ann-x', title: 'Delete', onclick: (ev) => { ev.stopPropagation(); api('DELETE', `/api/annotations/${a.id}`); } }, '×'));
            noteLayer.append(l);
            el._label = l;
          }
        }
        el.dataset.key = key;
        notes.set(a.id, el);
      }
      for (const [id, el] of notes) if (!seen.has(id)) { el.classList.add('leaving'); el._label && el._label.remove(); setTimeout(() => el.remove(), 200); notes.delete(id); }
      const n = state.annotations.size;
      const open = [...state.annotations.values()].filter((a) => a.text && (!a.replies || !a.replies.length || a.replies[a.replies.length - 1].from === 'human')).length;
      document.getElementById('count-notes').textContent = n ? `${n} note${n === 1 ? '' : 's'} for the agent${open ? ` · ${open} waiting` : ' · all answered'}` : '';
      drawMinimap();
    }

    window.addEventListener('resize', () => schedule());
    apply();
    return { position, renderAnnotations, fit, drawMinimap, view, setTool, toWorld, bounds, cull: schedule, panBy, zoomAt, tidy, columnsForView, focusOn };
  };
})(typeof window !== 'undefined' ? window : globalThis);
