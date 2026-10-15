// mcp-screen browser client. Plain DOM, no framework, no build step.
// Every agent-supplied string goes through textContent: no innerHTML with data.
(() => {
  'use strict';
  const TOKEN = document.querySelector('meta[name="mcp-screen-token"]').content;
  const SVGNS = 'http://www.w3.org/2000/svg';
  const state = { widgets: new Map(), reports: [], activity: [], hot: new Map(), tableSort: new Map(), tab: 'canvas' };
  const frames = new Map(); // widgetId -> { iframe, ready }

  // ---------- helpers ----------
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
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
    return h('table', { class: 't' },
      h('thead', {}, h('tr', {}, columns.map((c, ci) =>
        h('th', {
          class: sort.col === ci ? `sorted${sort.asc ? ' asc' : ''}` : '',
          onclick: () => { state.tableSort.set(w.id, { col: ci, asc: sort.col === ci ? !sort.asc : false }); rerender(w.id); },
        }, c)))),
      h('tbody', {}, body.map(({ r, i }) => {
        const dim = filter && !r.some((cell) => String(cell) === String(filter.value));
        return h('tr', {
          class: (i === selIdx ? 'sel' : '') + (dim ? ' dim' : ''),
          onclick: () => select(w, { rowIndex: i, row: Object.fromEntries(columns.map((c, ci) => [c, r[ci]])) }),
        }, r.map((cell) => h('td', {}, cell == null ? '' : String(cell))));
      })));
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
      pts.forEach((p, i) => svg.append(s('circle', { cx: p[0], cy: p[1], r: 3, fill: '#7c9cff', style: 'cursor:pointer', onclick: () => select(w, { label: labels[i], value: values[i], filter: { value: labels[i] } }) })));
    } else {
      values.forEach((v, i) => {
        const bh = (v / max) * ih, x = pad.l + step * i + step * 0.15, y = pad.t + ih - bh;
        svg.append(s('rect', {
          class: `bar${selLabel && selLabel !== labels[i] ? ' dim' : ''}`, x, y, width: step * 0.7, height: Math.max(1, bh), rx: 3,
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
    return h('div', { class: 'metric' },
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

  const RENDER = {
    markdown: (w) => markdown(w.data.markdown),
    text: (w) => h('pre', { class: 'text' }, w.data.text),
    table: renderTable,
    chart: renderChart,
    metric: renderMetric,
    kv: (w) => h('dl', { class: 'kv' }, Object.entries(w.data.items).flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, String(v))])),
    'status-list': (w) => h('ul', { class: 'sl' }, w.data.items.map((it) => h('li', {}, h('span', { class: `s ${it.status}` }), h('span', {}, it.label), it.detail ? h('span', { class: 'det' }, it.detail) : null))),
    'mcp-app': renderApp,
    livemap: (w) => h('div', { class: 'md' }, h('p', {}, `Architecture map with ${w.data.nodes.length} nodes. `), h('button', { class: 'btn', onclick: () => setTab('livemap') }, 'Open Livemap →')),
  };

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
      class: `card${w.kind === 'mcp-app' ? ' app' : ''}`, 'data-id': w.id,
      style: { gridColumn: `span ${w.w}`, gridRow: `span ${w.h}` },
    },
      h('div', { class: 'card-head' },
        h('span', { class: 'card-title', title: w.title }, w.title),
        h('span', { class: 'kind' }, w.kind === 'mcp-app' ? 'MCP App' : w.kind),
        STATUS_LABEL[w.status] ? h('span', { class: `pill ${w.status}` }, STATUS_LABEL[w.status]) : null),
      body);
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
  function renderCanvas() {
    const widgets = [...state.widgets.values()].filter((w) => w.kind !== 'livemap' || true);
    document.getElementById('count-canvas').textContent = widgets.length ? String(widgets.length) : '';
    // Keep iframes alive: reuse existing cards for mcp-app widgets.
    const keep = new Map([...grid.querySelectorAll('.card.app')].map((c) => [c.dataset.id, c]));
    grid.replaceChildren();
    if (!widgets.length) {
      grid.append(h('div', { class: 'empty' },
        h('h2', {}, 'Your agent’s screen is ready'),
        h('p', {}, 'Ask your agent to show you something, e.g. ', h('code', {}, '“chart our last 30 days of CI failures on the screen”')),
        h('p', {}, 'Tools: place_widget · update_widget · read_widget · read_canvas · post_report')));
      return;
    }
    for (const w of widgets) {
      const existing = keep.get(w.id);
      if (existing && existing.dataset.v === w.updatedAt) grid.append(existing);
      else {
        const c = card(w);
        c.dataset.v = w.updatedAt;
        grid.append(c);
      }
    }
  }
  function rerender(id) {
    const w = state.widgets.get(id);
    const old = grid.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
    if (!w || !old) return renderAll();
    const c = card(w);
    c.dataset.v = w.updatedAt;
    c.style.animation = 'none';
    old.replaceWith(c);
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

  const lm = document.getElementById('livemap');
  const HOT_MS = 7000;
  function renderLivemap() {
    const maps = [...state.widgets.values()].filter((w) => w.kind === 'livemap');
    document.getElementById('count-livemap').textContent = maps.length ? String(maps.length) : '';
    lm.replaceChildren();
    const w = maps[maps.length - 1];
    if (!w) {
      lm.append(h('div', { class: 'empty', style: { gridColumn: '1 / -1', minHeight: '420px' } },
        h('h2', {}, 'No architecture map yet'),
        h('p', {}, 'Ask your agent: ', h('code', {}, '“draw a livemap of this repo with place_widget”')),
        h('p', {}, 'Each box maps to file globs; edits from the PostToolUse hook light it up.')));
      return;
    }
    const { nodes, edges, layout, width, height } = w.data;
    const NW = 168, NH = 58;
    const svg = s('svg', { class: 'map', width: Math.max(width, 400) + 40, height: height + 30, viewBox: `-20 0 ${Math.max(width, 400) + 40} ${height + 30}` },
      s('defs', {}, s('marker', { id: 'arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, s('path', { d: 'M0,0 L10,5 L0,10 z', fill: '#4a5272' }))));
    for (const e of edges) {
      const a = layout[e.from], b = layout[e.to];
      if (!a || !b) continue;
      const y1 = a.y + NH / 2, y2 = b.y - NH / 2 - 2, my = (y1 + y2) / 2;
      svg.append(s('path', { class: 'edge', d: `M${a.x},${y1} C${a.x},${my} ${b.x},${my} ${b.x},${y2}`, 'marker-end': 'url(#arrow)' }));
      if (e.label) svg.append(s('text', { class: 'edge-l', x: (a.x + b.x) / 2 + 6, y: my }, e.label));
    }
    const now = Date.now();
    for (const n of nodes) {
      const p = layout[n.id];
      if (!p) continue;
      const hot = (state.hot.get(`${w.id}:${n.id}`) || []).filter((x) => now - x.t < HOT_MS);
      const g = s('g', { class: `node${hot.length ? ' hot' : ''}`, transform: `translate(${p.x - NW / 2},${p.y - NH / 2})`, style: hot.length ? `--glow:${hot[hot.length - 1].color}` : '' },
        s('title', {}, `${n.label}\n${n.globs.join('\n')}${n.description ? `\n\n${n.description}` : ''}`),
        s('rect', { width: NW, height: NH }),
        s('text', { class: 'lbl', x: 14, y: 24 }, n.label),
        s('text', { class: 'gl', x: 14, y: 42 }, n.globs.join(', ').slice(0, 26)));
      const agents = [...new Set(hot.map((x) => x.agent))];
      agents.forEach((a, i) => g.append(s('circle', { cx: NW - 14 - i * 12, cy: 14, r: 4.5, fill: agentColor(a) })));
      svg.append(g);
    }
    const acts = state.activity.filter((a) => a.widgetId === w.id).slice(-30).reverse();
    const agents = [...new Set(acts.map((a) => a.agent))];
    const unmapped = w.unmappedFiles || [];
    lm.append(
      h('div', { class: 'map-wrap' }, h('div', { class: 'map-title' }, h('h3', {}, w.title), h('span', { class: 'kind' }, `${nodes.length} modules`), w.data.root ? h('span', { class: 'br mono', style: { color: 'var(--muted)', fontSize: '12px' } }, w.data.root) : null), svg),
      h('div', { class: 'side' },
        h('div', { class: 'panel' }, h('h4', {}, 'Agents'), agents.length ? h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } }, agents.map(chip)) : h('div', { class: 'unmapped', style: { color: 'var(--muted)' } }, 'Waiting for file edits…')),
        h('div', { class: 'panel' }, h('h4', {}, 'Live edits'), h('ul', { class: 'feed' }, acts.map((a) => h('li', {},
          h('span', { class: 'who' }, chip(a.agent), h('span', { style: { color: 'var(--muted)' } }, `→ ${a.nodeIds.map((id) => (nodes.find((n) => n.id === id) || {}).label || id).join(', ')}`), h('span', { style: { marginLeft: 'auto', color: 'var(--muted)' } }, ago(a.at))),
          h('span', { class: 'path' }, a.path))))),
        unmapped.length ? h('div', { class: 'panel' }, h('h4', {}, 'Outside the map'), h('div', { class: 'unmapped' }, `${unmapped.length} edited file${unmapped.length > 1 ? 's' : ''} match no box. Ask the agent to refresh the livemap.`, unmapped.slice(-6).map((u) => h('code', {}, u)))) : null));
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
              toolInfo: { tool: { name: w.data.toolName } },
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
      state.reports = snap.reports;
      state.activity = snap.activity;
      for (const a of snap.activity) markHot(a);
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
          if (prev.kind === 'mcp-app' && frames.get(ev.widget.id)) frames.get(ev.widget.id).widget = ev.widget;
          else rerender(ev.widget.id);
          if (ev.widget.kind === 'chart' && ev.widget.data.linkTo) rerender(ev.widget.data.linkTo);
          const c = grid.querySelector(`.card[data-id="${CSS.escape(ev.widget.id)}"]`);
          if (c && prev.updatedAt !== ev.widget.updatedAt && JSON.stringify(prev.data) !== JSON.stringify(ev.widget.data)) {
            c.classList.add('flash');
            setTimeout(() => c.classList.remove('flash'), 900);
          }
          if (ev.widget.kind === 'livemap') renderLivemap();
        } else renderAll();
      } else if (ev.type === 'remove') {
        state.widgets.delete(ev.id);
        frames.delete(ev.id);
        renderAll();
      } else if (ev.type === 'report') {
        state.reports.push(ev.report);
        renderStandup();
      } else if (ev.type === 'activity') {
        state.activity.push(ev.activity);
        markHot(ev.activity);
        renderLivemap();
      }
    };
  }
  function markHot(a) {
    const t = Date.parse(a.at) || Date.now();
    for (const n of a.nodeIds) {
      const key = `${a.widgetId}:${n}`;
      state.hot.set(key, [...(state.hot.get(key) || []), { t, color: a.color, agent: a.agent }].slice(-6));
    }
    setTimeout(renderLivemap, HOT_MS + 50);
  }
  setInterval(() => {
    for (const el of document.querySelectorAll('.ago[data-iso]')) if (el.dataset.iso) el.textContent = `· ${ago(el.dataset.iso)}`;
  }, 1000);
  connect();
})();
