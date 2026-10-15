// mcp-screen browser client. Plain DOM, no framework, no build step.
// Every agent-supplied string goes through textContent: no innerHTML with data.
(() => {
  'use strict';
  const TOKEN = document.querySelector('meta[name="mcp-screen-token"]').content;
  const SVGNS = 'http://www.w3.org/2000/svg';
  const state = { widgets: new Map(), annotations: new Map(), reports: [], activity: [], tableSort: new Map(), tab: 'canvas' };
  const frames = new Map(); // widgetId -> { iframe, ready }

  // ---------- helpers ----------
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'style' && typeof v === 'object') for (const [sk, sv] of Object.entries(v)) { if (sk.startsWith('--')) el.style.setProperty(sk, sv); else el.style[sk] = sv; }
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
    return el;
  }
  function s(tag, attrs, ...kids) {
    const el = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, String(v));
    }
    for (const kid of kids.flat()) if (kid != null) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    return el;
  }
  const api = (method, path, body) =>
    fetch(path, {
      method,
      headers: { 'content-type': 'application/json', 'x-mcp-screen-token': TOKEN },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then((r) => r.json());
  const ago = (iso) => {
    if (!iso) return '';
    const sec = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
    if (sec < 60) return `${sec}s ago`;
    if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
    return `${Math.round(sec / 3600)}h ago`;
  };
  const PALETTE = ['#7c9cff', '#ff7ab6', '#4fd1a5', '#ffb547', '#b48cff', '#5cc8ff', '#ff6b6b', '#c3e86b'];
  const agentColor = (a) => {
    let x = 0;
    for (const ch of a) x = (x * 31 + ch.charCodeAt(0)) >>> 0;
    return PALETTE[x % PALETTE.length];
  };
  const chip = (agent) => h('span', { class: 'chip' }, h('span', { class: 'sw', style: { background: agentColor(agent) } }), agent);

  // Tiny markdown: headings, lists, bold, italics, inline code, paragraphs. Text nodes only.
  function inline(text) {
    const out = [];
    const re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g;
    let last = 0;
    for (const m of text.matchAll(re)) {
      if (m.index > last) out.push(text.slice(last, m.index));
      const t = m[0];
      if (t.startsWith('`')) out.push(h('code', {}, t.slice(1, -1)));
      else if (t.startsWith('**')) out.push(h('strong', {}, t.slice(2, -2)));
      else out.push(h('em', {}, t.slice(1, -1)));
      last = m.index + t.length;
    }
    out.push(text.slice(last));
    return out;
  }
  function markdown(src) {
    const root = h('div', { class: 'md' });
    let list = null;
    for (const line of String(src).split('\n')) {
      const hm = /^(#{1,3})\s+(.*)/.exec(line);
      const li = /^\s*[-*]\s+(.*)/.exec(line);
      if (li) {
        if (!list) root.append((list = h('ul')));
        list.append(h('li', {}, inline(li[1])));
        continue;
      }
      list = null;
      if (hm) root.append(h(`h${hm[1].length}`, {}, inline(hm[2])));
      else if (line.trim()) root.append(h('p', {}, inline(line)));
    }
    return root;
  }

  // ---------- widget renderers ----------
  const select = (w, selection) => api('POST', `/api/widgets/${encodeURIComponent(w.id)}/selection`, { selection });

  function renderTable(w) {
    const { columns, rows } = w.data;
    const sort = state.tableSort.get(w.id) || { col: -1, asc: false };
    // A chart with data.linkTo === this table's id filters it when a bar is clicked.
    const linked = [...state.widgets.values()].find((c) => c.kind === 'chart' && c.data.linkTo === w.id && c.selection);
    const filter = linked && linked.selection.filter;
    let body = rows.map((r, i) => ({ r, i }));
    if (sort.col >= 0)
      body.sort((a, b) => {
        const x = a.r[sort.col], y = b.r[sort.col];
        const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
        return sort.asc ? c : -c;
      });
    const selIdx = w.selection && typeof w.selection.rowIndex === 'number' ? w.selection.rowIndex : -1;
    if (filter) body = body.filter(({ r }) => r.some((cell) => String(cell) === String(filter.value)));
    const bar = filter ? h('div', { class: 'filter' }, `filtered by ${filter.value} · ${body.length} of ${rows.length} rows`,
      h('button', { class: 'btn ghost', onclick: () => select(linked, null) }, 'clear')) : null;
    return h('div', {}, bar, h('table', { class: 't' },
      h('thead', {}, h('tr', {}, columns.map((c, ci) =>
        h('th', {
          class: sort.col === ci ? `sorted${sort.asc ? ' asc' : ''}` : '',
          onclick: () => { state.tableSort.set(w.id, { col: ci, asc: sort.col === ci ? !sort.asc : false }); rerender(w.id); },
        }, c)))),
      h('tbody', {}, body.map(({ r, i }) => {
        return h('tr', {
          class: i === selIdx ? 'sel' : '',
          'data-pt': JSON.stringify({ rowIndex: i, row: Object.fromEntries(columns.map((c, ci) => [c, r[ci]])) }),
          onclick: () => select(w, { rowIndex: i, row: Object.fromEntries(columns.map((c, ci) => [c, r[ci]])) }),
        }, r.map((cell) => h('td', {}, cell == null ? '' : String(cell))));
      }))));
  }

  function renderChart(w) {
    const { labels, values, type, unit } = w.data;
    const W = 600, H = 260, pad = { l: 34, r: 10, t: 16, b: 28 };
    const max = Math.max(1, ...values);
    const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
    const svg = s('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none' },
      s('defs', {},
        s('linearGradient', { id: 'barGrad', x1: 0, y1: 0, x2: 0, y2: 1 }, s('stop', { offset: 0, 'stop-color': '#9db4ff' }), s('stop', { offset: 1, 'stop-color': '#6b7fe0' })),
        s('linearGradient', { id: 'areaGrad', x1: 0, y1: 0, x2: 0, y2: 1 }, s('stop', { offset: 0, 'stop-color': 'rgba(124,156,255,.35)' }), s('stop', { offset: 1, 'stop-color': 'rgba(124,156,255,0)' }))));
    for (let g = 0; g <= 4; g++) {
      const y = pad.t + (ih * g) / 4;
      svg.append(s('line', { class: 'grid-l', x1: pad.l, x2: W - pad.r, y1: y, y2: y }));
      svg.append(s('text', { x: pad.l - 6, y: y + 3, 'text-anchor': 'end' }, Math.round(max - (max * g) / 4)));
    }
    const step = iw / labels.length;
    const selLabel = w.selection && w.selection.label;
    const every = Math.ceil(labels.length / 12);
    if (type === 'line') {
      const pts = values.map((v, i) => [pad.l + step * (i + 0.5), pad.t + ih - (v / max) * ih]);
      svg.append(s('path', { class: 'area', d: `M${pts[0][0]},${pad.t + ih} L${pts.map((p) => p.join(',')).join(' L')} L${pts[pts.length - 1][0]},${pad.t + ih} Z` }));
      svg.append(s('path', { class: 'line', d: `M${pts.map((p) => p.join(',')).join(' L')}` }));
      pts.forEach((p, i) => svg.append(s('circle', { cx: p[0], cy: p[1], r: 3, fill: '#7c9cff', style: 'cursor:pointer', 'data-pt': JSON.stringify({ label: labels[i], value: values[i] }), onclick: () => select(w, { label: labels[i], value: values[i], filter: { value: labels[i] } }) })));
    } else {
      values.forEach((v, i) => {
        const bh = (v / max) * ih, x = pad.l + step * i + step * 0.15, y = pad.t + ih - bh;
        svg.append(s('rect', {
          class: `bar${selLabel && selLabel !== labels[i] ? ' dim' : ''}`, x, y, width: step * 0.7, height: Math.max(1, bh), rx: 3,
          'data-pt': JSON.stringify({ label: labels[i], value: v }),
          onclick: () => select(w, selLabel === labels[i] ? null : { label: labels[i], value: v, filter: { value: labels[i] } }),
        }, s('title', {}, `${labels[i]}: ${v}${unit || ''}`)));
        if (labels.length <= 16) svg.append(s('text', { class: 'val', x: x + step * 0.35, y: y - 4, 'text-anchor': 'middle' }, v));
      });
    }
    labels.forEach((l, i) => { if (i % every === 0) svg.append(s('text', { x: pad.l + step * (i + 0.5), y: H - 9, 'text-anchor': 'middle' }, l)); });
    return svg;
  }

  function renderMetric(w) {
    const { value, label, delta } = w.data;
    return h('div', { class: 'metric', 'data-pt': JSON.stringify({ value, label }) },
      h('div', { class: 'v' }, String(value)),
      h('div', { class: 'l' }, label || '', delta != null ? h('span', { class: `d ${delta >= 0 ? 'up' : 'down'}` }, `  ${delta >= 0 ? '▲' : '▼'} ${Math.abs(delta)}`) : null));
  }

  function renderApp(w) {
    let f = frames.get(w.id);
    if (!f) {
      // Null origin: allow-scripts WITHOUT allow-same-origin. The frame cannot read the API token,
      // cookies or the parent DOM, and its CSP header limits network to the resource's declared domains.
      const iframe = h('iframe', {
        class: 'app-frame', sandbox: 'allow-scripts allow-forms', referrerpolicy: 'no-referrer',
        src: `/frame/${encodeURIComponent(w.id)}?n=${w.frameNonce}`, title: w.title,
      });
      f = { iframe, ready: false, widget: w };
      frames.set(w.id, f);
    }
    f.widget = w;
    return f.iframe;
  }

  function renderQuestion(w) {
    const d = w.data;
    const open = d.state === 'open';
    const answer = d.answer && d.answer.id;
    const choices = h('div', { class: `choices${open ? '' : ' closed'}` }, d.choices.map((c, i) =>
      h('button', {
        class: `choice${answer === c.id ? ' chosen' : answer ? ' dim' : ''}`, 'data-choice': c.id,
        onclick: open ? () => api('POST', `/api/widgets/${encodeURIComponent(w.id)}/answer`, { choice: c.id }) : null,
      },
        h('span', { class: 'k' }, answer === c.id ? '✓' : String(i + 1)),
        h('span', { class: 'lbl' }, c.label),
        c.description ? h('span', { class: 'desc' }, c.description) : null,
        c.preview ? h('div', { class: 'prev' }, markdown(c.preview)) : null)));
    const STATE = { answered: `Answered · sent “${d.answer ? d.answer.label : ''}” back to the agent`, timeout: 'Timed out · the agent moved on', cancelled: 'Cancelled by the agent' };
    let timer = null;
    if (open && d.expiresAt) {
      const total = Date.parse(d.expiresAt) - Date.parse(w.createdAt);
      const left = Math.max(0, Date.parse(d.expiresAt) - Date.now());
      const bar = h('i', { style: { transform: `scaleX(${total > 0 ? left / total : 0})`, transition: `transform ${left}ms linear` } });
      requestAnimationFrame(() => requestAnimationFrame(() => { bar.style.transform = 'scaleX(0)'; }));
      timer = h('div', { class: 'q-timer' }, bar);
    }
    return h('div', { class: 'q' },
      h('div', { class: 'q-text' }, d.question),
      d.detail ? h('p', { class: 'q-detail' }, d.detail) : null,
      choices,
      h('div', { class: 'q-foot' }, open ? h('span', {}, 'The agent is waiting for your click') : h('span', { class: `q-state ${d.state}` }, STATE[d.state] || d.state), timer));
  }

  const RENDER = {
    question: renderQuestion,
    markdown: (w) => markdown(w.data.markdown),
    text: (w) => h('pre', { class: 'text' }, w.data.text),
    table: renderTable,
    chart: renderChart,
    metric: renderMetric,
    kv: (w) => h('dl', { class: 'kv' }, Object.entries(w.data.items).flatMap(([k, v]) => [h('dt', { 'data-pt': JSON.stringify({ key: k, value: v }) }, k), h('dd', { 'data-pt': JSON.stringify({ key: k, value: v }) }, String(v))])),
    'status-list': (w) => h('ul', { class: 'sl' }, w.data.items.map((it) => h('li', { 'data-pt': JSON.stringify({ label: it.label, status: it.status }) }, h('span', { class: `s ${it.status}` }), h('span', {}, it.label), it.detail ? h('span', { class: 'det' }, it.detail) : null))),
    'mcp-app': renderApp,
    livemap: (w) => h('div', { class: 'md' }, h('p', {}, `Architecture map with ${w.data.nodes.length} nodes. `), h('button', { class: 'btn', onclick: () => setTab('livemap') }, 'Open Livemap →')),
  };

  Object.assign(RENDER, window.McpScreenKinds({ h, s, api, select, markdown, rerender: (id) => rerender(id) }));
  const KIND_LABEL = { 'mcp-app': 'MCP App', question: 'ask_user', form: 'ask_form' };

  const STATUS_LABEL = { live: 'live', 'needs-approval': 'needs approval', error: 'error', denied: 'denied' };

  function card(w) {
    const body = h('div', { class: 'card-body' });
    if (w.status === 'needs-approval' && w.source) {
      body.append(h('div', { class: 'approve' },
        h('p', {}, `The agent wants this widget to refresh every ${Math.round((w.intervalMs || 30000) / 1000)}s from:`),
        h('code', {}, w.sourceLabel || ''),
        h('button', { class: 'btn primary', onclick: () => api('POST', `/api/widgets/${encodeURIComponent(w.id)}/approve`) }, 'Approve & allow-list'),
        ' ',
        h('button', { class: 'btn ghost', onclick: () => api('POST', `/api/widgets/${encodeURIComponent(w.id)}/deny`) }, 'Deny')));
    }
    if (w.error) body.append(h('div', { class: 'err' }, w.error));
    try {
      body.append((RENDER[w.kind] || RENDER.text)(w));
    } catch (e) {
      body.append(h('div', { class: 'err' }, `render failed: ${e.message}`));
    }
    const el = h('article', {
      class: `card k-${w.kind}${w.kind === 'mcp-app' ? ' app' : ''}${w.kind === 'question' || w.kind === 'form' ? ` question ${w.data.state}` : ''}`, 'data-id': w.id, 'data-kind': w.kind,
    },
      h('div', { class: 'card-head', title: 'Drag to move' },
        h('span', { class: 'grip', 'aria-hidden': 'true' }),
        h('span', { class: 'card-title', title: w.title }, w.title),
        h('span', { class: 'kind' }, KIND_LABEL[w.kind] || w.kind),
        STATUS_LABEL[w.status] ? h('span', { class: `pill ${w.status}` }, STATUS_LABEL[w.status]) : null),
      body);
    canvas.position(el, w);
    if (w.source && w.status !== 'needs-approval') {
      el.append(h('div', { class: 'card-foot' },
        h('span', { class: 'src mono', title: w.sourceLabel }, w.sourceLabel),
        h('span', { class: 'ago', 'data-iso': w.lastRefreshedAt || '' }, w.lastRefreshedAt ? `· ${ago(w.lastRefreshedAt)}` : ''),
        w.status === 'live' || w.status === 'error'
          ? h('button', { class: 'btn ghost', onclick: () => api('POST', `/api/widgets/${encodeURIComponent(w.id)}/revoke`) }, 'Stop')
          : null));
    } else if (w.kind === 'mcp-app') {
      el.append(h('div', { class: 'card-foot' }, h('span', { class: 'src mono' }, `${w.data.resourceUri}  ·  via ${w.data.toolName}`)));
    }
    return el;
  }

  // ---------- views ----------
  const grid = document.getElementById('grid');
  const stage = document.getElementById('stage');
  const toastRef = { fn: null };
  const canvas = window.McpScreenCanvas({ h, s, api, state, stage, world: document.getElementById('world'), grid, toast: (...a) => toastRef.fn(...a) });
  let emptyEl = null;
  function renderCanvas() {
    const widgets = [...state.widgets.values()];
    document.getElementById('count-canvas').textContent = widgets.length ? String(widgets.length) : '';
    // Keyed reconcile. Cards are never re-parented (moving an iframe in the DOM reloads it and
    // loses the MCP App's state); they are absolutely positioned on the infinite canvas.
    const existing = new Map([...grid.querySelectorAll('.card')].map((c) => [c.dataset.id, c]));
    for (const [id, c] of existing) if (!state.widgets.has(id)) {
      frames.delete(id);
      if (c.classList.contains('leaving')) continue;
      c.classList.add('leaving');
      setTimeout(() => c.remove(), 280);
    }
    let fresh = 0;
    document.getElementById('clear-btn').disabled = !widgets.length && !state.annotations.size;
    emptyEl?.remove();
    emptyEl = null;
    if (!widgets.length) {
      emptyEl = h('div', { class: 'empty' },
        h('h2', {}, 'Your agent’s screen is ready'),
        h('p', {}, 'Ask your agent to show you something, e.g. ', h('code', {}, '“chart our last 30 days of CI failures on the screen”')),
        h('p', {}, 'Drag cards by their title · scroll or drag the background to pan · Ctrl/⌘ + scroll to zoom · draw with the tools on the left'));
      stage.append(emptyEl);
    }
    for (const w of widgets) {
      let c = existing.get(w.id);
      if (!c || (c.dataset.v !== w.updatedAt && w.kind !== 'mcp-app')) {
        const next = card(w);
        next.dataset.v = w.updatedAt;
        if (c) { next.style.animation = 'none'; next.style.zIndex = c.style.zIndex; c.replaceWith(next); } else { next.style.setProperty('--delay', `${Math.min(fresh++, 6) * 70}ms`); grid.append(next); }
        c = next;
      } else canvas.position(c, w);
    }
    canvas.renderAnnotations();
  }
  function rerender(id) {
    const w = state.widgets.get(id);
    const old = grid.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
    if (!w || !old) return renderAll();
    if (w.kind === 'mcp-app') return canvas.position(old, w); // never rebuild a live app frame
    const c = card(w);
    c.dataset.v = w.updatedAt;
    c.style.animation = 'none';
    c.style.zIndex = old.style.zIndex;
    old.replaceWith(c);
  }
  /** Glide to a new widget the agent placed outside the current view. */
  function reveal(w) {
    const r = stage.getBoundingClientRect();
    const v = canvas.view;
    const x0 = -v.x / v.z, y0 = -v.y / v.z, x1 = x0 + r.width / v.z, y1 = y0 + r.height / v.z;
    if (w.x > x1 - 40 || w.y > y1 - 40 || w.x < x0 - 200 || w.y < y0 - 100) canvas.fit();
  }

  const board = document.getElementById('board');
  function renderStandup() {
    const reports = state.reports;
    document.getElementById('count-standup').textContent = reports.length ? String(reports.length) : '';
    board.replaceChildren();
    if (!reports.length) {
      board.append(h('div', { class: 'empty', style: { width: '100%', minHeight: '420px' } },
        h('h2', {}, 'No standup cards yet'),
        h('p', {}, 'Agents post here with ', h('code', {}, 'post_report'), ', or automatically via the Stop / SubagentStop hooks:'),
        h('p', {}, h('code', {}, 'npx mcp-screen install-hooks --write'))));
      return;
    }
    const byTree = new Map();
    for (const r of reports) {
      if (!byTree.has(r.worktree)) byTree.set(r.worktree, []);
      byTree.get(r.worktree).push(r);
    }
    for (const [tree, list] of byTree) {
      const branch = list[list.length - 1].branch;
      const byAgent = new Map();
      for (const r of [...list].reverse()) {
        if (!byAgent.has(r.agent)) byAgent.set(r.agent, []);
        byAgent.get(r.agent).push(r);
      }
      board.append(h('div', { class: 'col' },
        h('div', { class: 'col-head' }, h('h3', {}, tree), branch ? h('span', { class: 'br mono' }, `⎇ ${branch}`) : null),
        [...byAgent].map(([agent, reps]) => h('div', { class: 'agent-group' },
          h('div', { class: 'agent-label' }, chip(agent), `${reps.length} report${reps.length > 1 ? 's' : ''}`),
          reps.map(reportCard)))));
    }
  }
  const SRC = { tool: 'post_report', 'stop-hook': 'Stop hook', 'subagent-stop-hook': 'SubagentStop hook' };
  function reportCard(r) {
    const t = r.tests || { status: 'unknown' };
    const testText = t.status === 'unknown' ? 'tests: not run'
      : `${t.status === 'pass' ? '✓' : '✗'} ${[t.passed != null ? `${t.passed} passed` : '', t.failed ? `${t.failed} failed` : ''].filter(Boolean).join(', ') || t.status}`;
    const files = r.filesChanged || [];
    return h('div', { class: 'rep' },
      h('div', { class: 'rep-top' }, h('span', { class: 'kind' }, SRC[r.source] || r.source), h('span', { class: 't', title: r.at }, ago(r.at))),
      h('p', { class: 'sum' }, r.summary),
      h('div', { class: `tests ${t.status}`, title: t.command || '' }, testText, t.command ? h('span', { class: 'mono', style: { opacity: 0.7 } }, ` · ${t.command}`) : null),
      files.length ? h('ul', { class: 'files' },
        files.slice(0, 8).map((f) => h('li', {}, h('span', { class: 'p mono' }, f.path), h('span', { class: 'a' }, `+${f.added ?? 0}`), h('span', { class: 'r' }, `−${f.removed ?? 0}`))),
        files.length > 8 ? h('li', { style: { color: 'var(--muted)' } }, `…and ${files.length - 8} more`) : null) : null,
      r.risks && r.risks.length ? h('ul', { class: 'risks' }, r.risks.map((x) => h('li', {}, x))) : null);
  }

  // ---------- livemap + agent theatre ----------
  // Static layer (edges + nodes) is rebuilt only when the map changes. Agents are glowing orbs
  // that glide to whichever module they touch; each file flies in as a chip and lands with a ripple.
  const lm = document.getElementById('livemap');
  const HOT_MS = 6500;
  const NODE_W = 176, NODE_H = 62;
  const theatre = { mapId: null, mapVersion: null, stage: null, svg: null, nodes: new Map(), orbs: new Map(), counts: new Map(), recent: new Map(), focus: false, captionTimer: 0 };
  const ACT_LABEL = { read: 'READ', edit: 'EDIT', create: 'NEW' };
  const VERB = { read: 'is reading', edit: 'is editing', create: 'created' };
  const PAD = 40;

  function currentMap() {
    const maps = [...state.widgets.values()].filter((w) => w.kind === 'livemap');
    return maps[maps.length - 1];
  }

  function renderLivemap() {
    const w = currentMap();
    document.getElementById('count-livemap').textContent = [...state.widgets.values()].filter((x) => x.kind === 'livemap').length || '';
    if (!w) {
      theatre.mapId = null;
      lm.replaceChildren(h('div', { class: 'empty', style: { gridColumn: '1 / -1', minHeight: '440px' } },
        h('h2', {}, 'No architecture map yet'),
        h('p', {}, 'Ask your agent: ', h('code', {}, '“draw a livemap of this repo with place_widget”')),
        h('p', {}, 'Each box maps to file globs. With the hooks installed, every file the agent reads or edits flies onto its box.')));
      return;
    }
    if (theatre.mapId !== w.id || theatre.mapVersion !== JSON.stringify([w.data.nodes, w.data.edges, w.title])) buildStage(w);
    renderSide(w);
  }

  function buildStage(w) {
    theatre.mapId = w.id;
    theatre.mapVersion = JSON.stringify([w.data.nodes, w.data.edges, w.title]);
    theatre.nodes.clear();
    theatre.orbs.clear();
    const { nodes, edges, layout } = w.data;
    const width = Math.max(w.data.width, 520) + PAD * 2;
    const height = w.data.height + PAD * 2 + 30;
    const stage = h('div', { class: 'stage', style: { width: `${width}px`, height: `${height}px` } });
    const svg = s('svg', { class: 'map', width, height, viewBox: `0 0 ${width} ${height}` },
      s('defs', {}, s('marker', { id: 'arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse' }, s('path', { d: 'M0,0 L10,5 L0,10 z', fill: 'rgba(160,170,210,.35)' }))));
    const pos = (id) => layout[id] && { x: layout[id].x + PAD, y: layout[id].y + PAD };
    for (const e of edges) {
      const a = pos(e.from), b = pos(e.to);
      if (!a || !b) continue;
      const y1 = a.y + NODE_H / 2, y2 = b.y - NODE_H / 2 - 3, my = (y1 + y2) / 2;
      svg.append(s('path', { class: 'edge', 'data-from': e.from, 'data-to': e.to, d: `M${a.x},${y1} C${a.x},${my} ${b.x},${my} ${b.x},${y2}`, 'marker-end': 'url(#arrow)' }));
      if (e.label) svg.append(s('text', { class: 'edge-l', x: (a.x + b.x) / 2 + 6, y: my }, e.label));
    }
    stage.append(svg);
    nodes.forEach((n, i) => {
      const p = pos(n.id);
      if (!p) return;
      const el = h('div', { class: 'node', title: `${n.label}\n${n.globs.join('\n')}${n.description ? `\n\n${n.description}` : ''}`, style: { left: `${p.x}px`, top: `${p.y}px`, animationDelay: `${i * 45}ms` } },
        h('div', { class: 'lbl' }, n.label),
        h('div', { class: 'gl' }, n.globs.join(', ')),
        h('span', { class: 'n' }, String(theatre.counts.get(`${w.id}:${n.id}`) || 0)),
        h('div', { class: 'files-mini' }));
      theatre.nodes.set(n.id, { el, x: p.x, y: p.y, label: n.label });
      stage.append(el);
    });
    const caption = h('div', { class: 'caption idle' });
    theatre.stage = stage;
    theatre.svg = svg;
    theatre.caption = caption;
    const wrap = h('div', { class: 'map-wrap' },
      h('div', { class: 'map-title' }, h('h3', {}, w.title), h('span', { class: 'kind' }, `${nodes.length} modules`),
        w.data.root ? h('span', { class: 'mono', style: { color: 'var(--muted)', fontSize: '12px' } }, w.data.root) : null,
        h('button', { class: 'btn ghost', onclick: () => { theatre.focus = !theatre.focus; lm.classList.toggle('focus', theatre.focus); } }, theatre.focus ? 'Show panel' : 'Theatre mode')),
      stage, caption);
    const side = h('div', { class: 'side' });
    theatre.side = side;
    lm.classList.toggle('focus', theatre.focus);
    lm.replaceChildren(wrap, side);
    // replay heat that is still warm
    for (const a of state.activity.filter((x) => x.widgetId === w.id && Date.now() - Date.parse(x.at) < HOT_MS)) heat(a);
  }

  function renderSide(w) {
    if (!theatre.side) return;
    const acts = state.activity.filter((a) => a.widgetId === w.id).slice(-40).reverse();
    const agents = [...new Set(acts.map((a) => a.agent))];
    const unmapped = w.unmappedFiles || [];
    const label = (id) => (theatre.nodes.get(id) || {}).label || id;
    theatre.side.replaceChildren(
      h('div', { class: 'panel' }, h('h4', {}, 'Agents on stage'), agents.length ? h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } }, agents.map(chip)) : h('div', { class: 'unmapped', style: { color: 'var(--muted)' } }, 'Waiting for the first file…')),
      h('div', { class: 'panel' }, h('h4', {}, 'Live activity'), h('ul', { class: 'feed' }, acts.map((a) => h('li', {},
        h('span', { class: 'who' }, chip(a.agent), h('span', { class: `act ${a.action || 'edit'}` }, ACT_LABEL[a.action || 'edit']), h('span', { style: { color: 'var(--muted)' } }, `→ ${a.nodeIds.map(label).join(', ')}`), h('span', { class: 'ago', 'data-iso': a.at, style: { marginLeft: 'auto', color: 'var(--muted)' } }, ago(a.at))),
        h('span', { class: 'path' }, a.path))))),
      ...(unmapped.length ? [h('div', { class: 'panel' }, h('h4', {}, 'Outside the map'), h('div', { class: 'unmapped' }, `${unmapped.length} file${unmapped.length > 1 ? 's' : ''} match no box. Ask the agent to refresh the livemap.`, unmapped.slice(-6).map((u) => h('code', {}, u))))] : []));
  }

  /** Persistent glow + counter + mini file list on a node. */
  function heat(a) {
    const action = a.action || 'edit';
    for (const id of a.nodeIds) {
      const n = theatre.nodes.get(id);
      if (!n) continue;
      const key = `${a.widgetId}:${id}`;
      n.el.style.setProperty('--glow', a.color);
      n.el.classList.remove('read', 'edit');
      void n.el.offsetWidth;
      n.el.classList.add(action === 'read' ? 'read' : 'edit');
      n.el.querySelector('.n').textContent = String(theatre.counts.get(key) || 0);
      const recent = theatre.recent.get(key) || [];
      n.el.querySelector('.files-mini').replaceChildren(...recent.slice(0, 3).map((p) => h('span', {}, p)));
      clearTimeout(n.cool);
      n.cool = setTimeout(() => n.el.classList.remove('read', 'edit'), HOT_MS);
    }
  }

  /** The show: orb glides to the module, the file chip flies in and lands with a ripple. */
  function perform(a) {
    const action = a.action || 'edit';
    for (const id of a.nodeIds) {
      const key = `${a.widgetId}:${id}`;
      theatre.counts.set(key, (theatre.counts.get(key) || 0) + 1);
      const base = a.path.split('/').pop();
      theatre.recent.set(key, [base, ...(theatre.recent.get(key) || []).filter((x) => x !== base)].slice(0, 3));
    }
    if (a.replay || a.widgetId !== theatre.mapId || !theatre.stage) return;
    const target = theatre.nodes.get(a.nodeIds[0]);
    if (!target) return;
    const stage = theatre.stage;

    // agent orb
    let orb = theatre.orbs.get(a.agent);
    const from = orb ? { x: orb.x, y: orb.y, node: orb.node } : { x: target.x, y: -10, node: null };
    if (!orb) {
      const el = h('div', { class: 'orb', 'data-name': a.agent, style: { '--c': a.color, left: `${from.x}px`, top: `${from.y}px` } }, a.agent.slice(0, 1).toUpperCase());
      el.style.setProperty('--c', a.color);
      stage.append(el);
      orb = { el, x: from.x, y: from.y, node: null };
      theatre.orbs.set(a.agent, orb);
    }
    const slot = [...theatre.orbs.keys()].indexOf(a.agent);
    const sameNode = [...theatre.orbs.entries()].filter(([name, o]) => name !== a.agent && o.node === a.nodeIds[0]).length;
    const ox = target.x - NODE_W / 2 - 18, oy = target.y - 12 + sameNode * 26;
    void slot;
    requestAnimationFrame(() => {
      orb.el.style.left = `${ox}px`;
      orb.el.style.top = `${oy}px`;
    });
    orb.el.classList.add('busy');
    clearTimeout(orb.idle);
    orb.idle = setTimeout(() => orb.el.classList.remove('busy'), 2500);

    // light the edge it travels along
    if (from.node && from.node !== a.nodeIds[0]) {
      const path = theatre.svg.querySelector(`.edge[data-from="${CSS.escape(from.node)}"][data-to="${CSS.escape(a.nodeIds[0])}"], .edge[data-from="${CSS.escape(a.nodeIds[0])}"][data-to="${CSS.escape(from.node)}"]`);
      if (path) {
        path.style.setProperty('--flow', a.color);
        path.classList.add('flow');
        setTimeout(() => path.classList.remove('flow'), 1400);
      }
    }
    orb.x = ox; orb.y = oy; orb.node = a.nodeIds[0];

    // flying file chip
    const flyer = h('div', { class: 'flyer', style: { left: `${from.x}px`, top: `${from.y}px` } }, h('i', {}, ACT_LABEL[action]), a.path.split('/').slice(-2).join('/'));
    flyer.style.setProperty('--c', a.color);
    stage.append(flyer);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      flyer.style.left = `${target.x}px`;
      flyer.style.top = `${target.y}px`;
    }));
    setTimeout(() => {
      flyer.classList.add('landed');
      const ripple = h('div', { class: 'ripple', style: { left: `${target.x}px`, top: `${target.y}px` } });
      ripple.style.setProperty('--glow', a.color);
      stage.append(ripple);
      setTimeout(() => ripple.remove(), 1000);
      heat(a);
      setTimeout(() => flyer.remove(), 400);
    }, 820);

    // caption
    const cap = theatre.caption;
    cap.style.setProperty('--c', a.color);
    cap.replaceChildren(chip(a.agent), h('span', { class: 'verb' }, VERB[action]), h('code', {}, a.path), h('span', { class: 'arrow' }, '→'), h('strong', {}, target.label));
    cap.classList.remove('idle');
    clearTimeout(theatre.captionTimer);
    theatre.captionTimer = setTimeout(() => cap.classList.add('idle'), 3200);
  }

  function renderAll() {
    renderCanvas();
    renderStandup();
    renderLivemap();
  }

  function setTab(tab) {
    state.tab = tab;
    for (const b of document.querySelectorAll('.tab')) b.classList.toggle('active', b.dataset.tab === tab);
    for (const v of document.querySelectorAll('.view')) v.classList.toggle('active', v.id === `view-${tab}`);
    history.replaceState(null, '', `#${tab}`);
  }
  for (const b of document.querySelectorAll('.tab')) b.addEventListener('click', () => setTab(b.dataset.tab));
  if (['canvas', 'standup', 'livemap'].includes(location.hash.slice(1))) setTab(location.hash.slice(1));

  // ---------- MCP Apps bridge (host side of ext-apps postMessage JSON-RPC) ----------
  const PROTOCOL = '2026-01-26';
  function frameFor(source) {
    for (const [id, f] of frames) if (f.iframe.contentWindow === source) return [id, f];
    return [];
  }
  function post(f, msg) {
    f.iframe.contentWindow && f.iframe.contentWindow.postMessage({ jsonrpc: '2.0', ...msg }, '*');
  }
  window.addEventListener('message', async (ev) => {
    const [id, f] = frameFor(ev.source);
    if (!f) return; // only our sandboxed frames are trusted to talk to the bridge
    const msg = ev.data;
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return;
    const w = f.widget;
    const reply = (result) => msg.id != null && post(f, { id: msg.id, result });
    const fail = (code, message) => msg.id != null && post(f, { id: msg.id, error: { code, message } });
    try {
      switch (msg.method) {
        case 'ui/initialize': {
          const rect = f.iframe.getBoundingClientRect();
          return reply({
            protocolVersion: PROTOCOL,
            hostInfo: { name: 'mcp-screen', version: '0.1.0' },
            hostCapabilities: { openLinks: {}, serverTools: {}, serverResources: {}, logging: {} },
            hostContext: {
              theme: 'light', displayMode: 'inline', availableDisplayModes: ['inline'], platform: 'desktop',
              containerDimensions: { width: Math.round(rect.width), maxHeight: Math.round(rect.height) },
              ...(w.data.toolDef ? { toolInfo: { tool: w.data.toolDef } } : {}),
              locale: navigator.language, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            },
          });
        }
        case 'ui/notifications/initialized':
          f.ready = true;
          post(f, { method: 'ui/notifications/tool-input', params: { arguments: w.data.toolInput || {} } });
          if (w.data.toolResult) post(f, { method: 'ui/notifications/tool-result', params: w.data.toolResult });
          return;
        case 'tools/call':
        case 'resources/read': {
          const res = await api('POST', `/api/widgets/${encodeURIComponent(id)}/call`, { method: msg.method, params: msg.params });
          return res.error ? fail(-32000, res.error) : reply(res.result);
        }
        case 'ui/open-link': {
          const url = msg.params && msg.params.url;
          if (!/^https?:\/\//.test(url || '')) return fail(-32602, 'only http(s) links');
          window.open(url, '_blank', 'noopener,noreferrer');
          return reply({});
        }
        case 'ui/message':
        case 'ui/update-model-context':
          await select(w, { from: 'mcp-app', method: msg.method, ...(msg.params || {}) });
          return reply({});
        case 'ui/request-display-mode':
          return reply({ mode: 'inline' });
        case 'ui/notifications/size-changed':
        case 'notifications/message':
          return;
        case 'ping':
          return reply({});
        default:
          if (msg.id != null) fail(-32601, `method not supported by mcp-screen: ${msg.method}`);
      }
    } catch (e) {
      fail(-32603, e.message);
    }
  });

  // ---------- live connection ----------
  const conn = document.getElementById('conn');
  const connText = document.getElementById('conn-text');
  function connect() {
    const es = new EventSource(`/api/events?token=${encodeURIComponent(TOKEN)}`);
    es.addEventListener('snapshot', (e) => {
      const snap = JSON.parse(e.data);
      state.widgets = new Map(snap.widgets.map((w) => [w.id, w]));
      state.annotations = new Map((snap.annotations || []).map((a) => [a.id, a]));
      state.reports = snap.reports;
      state.activity = snap.activity;
      for (const a of snap.activity) perform({ ...a, replay: true });
      renderAll();
    });
    es.onopen = () => { conn.classList.add('on'); connText.textContent = `live · ${location.host}`; };
    es.onerror = () => { conn.classList.remove('on'); connText.textContent = 'reconnecting…'; };
    es.onmessage = (e) => {
      const ev = JSON.parse(e.data);
      if (ev.type === 'widget') {
        const prev = state.widgets.get(ev.widget.id);
        state.widgets.set(ev.widget.id, ev.widget);
        if (prev) {
          if (prev.kind === 'mcp-app' && frames.get(ev.widget.id)) { frames.get(ev.widget.id).widget = ev.widget; rerender(ev.widget.id); }
          else if (JSON.stringify({ ...prev, x: 0, y: 0 }) === JSON.stringify({ ...ev.widget, x: 0, y: 0 })) {
            const c = grid.querySelector(`.card[data-id="${CSS.escape(ev.widget.id)}"]`);
            if (c) canvas.position(c, ev.widget); // moved only: no rebuild
          } else rerender(ev.widget.id);
          canvas.drawMinimap();
          if (ev.widget.kind === 'chart' && ev.widget.data.linkTo) rerender(ev.widget.data.linkTo);
          const c = grid.querySelector(`.card[data-id="${CSS.escape(ev.widget.id)}"]`);
          if (c && prev.updatedAt !== ev.widget.updatedAt && JSON.stringify(prev.data) !== JSON.stringify(ev.widget.data)) {
            c.classList.add('flash');
            setTimeout(() => c.classList.remove('flash'), 900);
          }
          if (ev.widget.kind === 'livemap') renderLivemap();
        } else { renderAll(); reveal(ev.widget); }
      } else if (ev.type === 'remove') {
        state.widgets.delete(ev.id);
        frames.delete(ev.id);
        renderAll();
      } else if (ev.type === 'report') {
        state.reports.push(ev.report);
        renderStandup();
      } else if (ev.type === 'activity') {
        state.activity.push(ev.activity);
        if (state.activity.length > 300) state.activity.shift();
        perform(ev.activity);
        const w = currentMap();
        if (w) renderSide(w);
      } else if (ev.type === 'annotation') {
        state.annotations.set(ev.annotation.id, ev.annotation);
        canvas.renderAnnotations();
        document.getElementById('clear-btn').disabled = false;
      } else if (ev.type === 'annotation-remove') {
        state.annotations.delete(ev.id);
        canvas.renderAnnotations();
      } else if (ev.type === 'cleared') {
        toast(`Cleared ${ev.count} widget${ev.count === 1 ? '' : 's'}`, ev.undoable ? { label: 'Undo', run: () => api('POST', '/api/canvas/undo') } : null);
      } else if (ev.type === 'restored') {
        toast(`Restored ${ev.count} widget${ev.count === 1 ? '' : 's'}`);
      }
    };
  }
  // ---------- header actions: clear (confirm + undo), share ----------
  let toastEl = null;
  toastRef.fn = (...a) => toast(...a);
  function toast(text, action, ms = 8000) {
    toastEl?.remove();
    const el = h('div', { class: 'toast', role: 'status' }, h('span', {}, text),
      action ? h('button', { class: 'btn accent', onclick: () => { action.run(); el.remove(); } }, action.label) : null,
      h('span', { class: 'bar', style: { animationDuration: `${ms}ms` } }));
    document.body.append(el);
    toastEl = el;
    setTimeout(() => el.remove(), ms);
  }
  function confirmDialog({ title, body, ok, danger }) {
    return new Promise((resolve) => {
      const close = (v) => { bg.remove(); document.removeEventListener('keydown', key); resolve(v); };
      const key = (e) => { if (e.key === 'Escape') close(false); if (e.key === 'Enter') close(true); };
      const bg = h('div', { class: 'modal-bg', onclick: (e) => { if (e.target === bg) close(false); } },
        h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' }, h('h3', {}, title), h('p', {}, body),
          h('div', { class: 'row' }, h('button', { class: 'btn ghost', onclick: () => close(false) }, 'Cancel'),
            h('button', { class: `btn ${danger ? 'danger' : 'accent'}`, 'data-ok': '1', onclick: () => close(true) }, ok))));
      document.body.append(bg);
      document.addEventListener('keydown', key);
      bg.querySelector('[data-ok]').focus();
    });
  }
  document.getElementById('clear-btn').addEventListener('click', async () => {
    const n = state.widgets.size;
    const a = state.annotations.size;
    if (!n && !a) return;
    const what = [n ? `${n} widget${n === 1 ? '' : 's'}` : '', a ? `${a} note${a === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ');
    if (await confirmDialog({ title: `Clear ${what}?`, body: 'Everything on the canvas goes away, including the livemap and your annotations. Standup cards stay. You can undo right after.', ok: 'Clear canvas', danger: true }))
      await api('POST', '/api/canvas/clear', {});
  });
  const shareMenu = document.getElementById('share-menu');
  document.getElementById('share-btn').addEventListener('click', (e) => { e.stopPropagation(); shareMenu.classList.toggle('open'); });
  document.addEventListener('click', () => shareMenu.classList.remove('open'));
  async function doExport(kind) {
    shareMenu.classList.remove('open');
    try {
      const blob = kind === 'png' ? await window.McpScreenExport.exportPng() : await window.McpScreenExport.exportHtml();
      toast(`${kind.toUpperCase()} saved · ${(blob.size / 1024).toFixed(0)} KB`, null, 3500);
    } catch (e) {
      toast(`Export failed: ${e.message}`, null, 5000);
    }
  }
  document.getElementById('export-png').addEventListener('click', () => doExport('png'));
  document.getElementById('export-html').addEventListener('click', () => doExport('html'));
  window.__mcpScreen = { doExport, canvas, state };

  setInterval(() => {
    for (const el of document.querySelectorAll('.card-foot .ago[data-iso]')) if (el.dataset.iso) el.textContent = `· ${ago(el.dataset.iso)}`;
    for (const el of document.querySelectorAll('.feed .ago[data-iso]')) el.textContent = ago(el.dataset.iso);
  }, 1000);
  connect();
})();
