#!/usr/bin/env node
// A tiny MCP server that ships an MCP Apps UI (ui:// resource), for trying `mcp-screen wrap`.
//   claude mcp add demo -- npx mcp-screen wrap -- node examples/demo-app-server.mjs
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'demo-ci', version: '0.1.0' });
const URI = 'ui://demo-ci/flaky-tests';

const flaky = [
  { test: 'checkout › applies coupon', fails: 9, runs: 40 },
  { test: 'auth › refresh token race', fails: 6, runs: 40 },
  { test: 'search › debounce', fails: 4, runs: 40 },
  { test: 'upload › resumes after drop', fails: 3, runs: 40 },
];

server.registerTool(
  'flaky_tests',
  {
    title: 'Flaky tests',
    description: 'List the flakiest tests in CI over the last N days.',
    inputSchema: { days: z.number().default(30) },
    _meta: { ui: { resourceUri: URI } },
  },
  async ({ days }) => ({
    content: [{ type: 'text', text: JSON.stringify({ days, flaky }) }],
    structuredContent: { days, flaky },
  }),
);

server.registerTool(
  'quarantine_test',
  { description: 'Quarantine a flaky test.', inputSchema: { test: z.string() } },
  async ({ test }) => ({ content: [{ type: 'text', text: `quarantined: ${test}` }], structuredContent: { quarantined: test } }),
);

const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  body{font:14px ui-sans-serif,system-ui;margin:0;padding:16px;color:#1d2433;background:#fff}
  h3{margin:0 0 4px;font-size:15px} .sub{color:#6b7385;font-size:12px;margin-bottom:12px}
  .row{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid #eef0f4}
  .bar{height:8px;border-radius:4px;background:linear-gradient(90deg,#ff8a65,#ff5252)}
  .name{flex:1} .n{color:#6b7385;font-variant-numeric:tabular-nums;width:48px;text-align:right}
  button{font:inherit;font-size:12px;border:1px solid #d6dae3;background:#f7f8fb;border-radius:6px;padding:3px 8px;cursor:pointer}
  button.done{background:#e8f8f1;border-color:#b5e8d2;color:#1c7a55}
</style></head><body><h3>Flaky tests</h3><div class="sub" id="sub">waiting for host…</div><div id="list"></div>
<script>
  let nextId = 1; const pending = new Map();
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++; pending.set(id, { resolve, reject });
    parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*');
  });
  const notify = (method, params) => parent.postMessage({ jsonrpc: '2.0', method, params }, '*');
  function render(data) {
    document.getElementById('sub').textContent = 'last ' + data.days + ' days · rendered by an MCP App in a null-origin sandbox';
    const list = document.getElementById('list'); list.textContent = '';
    for (const f of data.flaky) {
      const row = document.createElement('div'); row.className = 'row';
      const name = document.createElement('span'); name.className = 'name'; name.textContent = f.test;
      const bar = document.createElement('div'); bar.className = 'bar'; bar.style.width = (f.fails * 8) + 'px';
      const n = document.createElement('span'); n.className = 'n'; n.textContent = f.fails + '/' + f.runs;
      const b = document.createElement('button'); b.textContent = 'Quarantine';
      b.onclick = async () => {
        b.disabled = true;
        const res = await rpc('tools/call', { name: 'quarantine_test', arguments: { test: f.test } });
        b.textContent = '✓ ' + (res.structuredContent ? 'quarantined' : 'done'); b.className = 'done';
        rpc('ui/update-model-context', { structuredContent: { quarantined: f.test } });
      };
      row.append(name, bar, n, b); list.append(row);
    }
  }
  window.addEventListener('message', (e) => {
    if (e.source !== parent) return;
    const m = e.data || {};
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(m.error) : p.resolve(m.result); return; }
    if (m.method === 'ui/notifications/tool-result') render(m.params.structuredContent);
  });
  rpc('ui/initialize', { protocolVersion: '2026-01-26', appInfo: { name: 'flaky-tests', version: '0.1.0' }, appCapabilities: {} })
    .then((r) => { document.getElementById('sub').textContent = 'connected to ' + r.hostInfo.name; notify('ui/notifications/initialized', {}); });
</script></body></html>`;

server.registerResource('flaky-tests-ui', URI, { mimeType: 'text/html;profile=mcp-app' }, async () => ({
  contents: [{ uri: URI, mimeType: 'text/html;profile=mcp-app', text: HTML }],
}));

await server.connect(new StdioServerTransport());
