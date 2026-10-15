import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { frameCsp, startHub, type Hub } from '../src/hub.js';
import { uiResourceUri, WrapProxy, type UpstreamLike } from '../src/wrap.js';

describe('wrap: MCP Apps detection', () => {
  it('finds current and legacy ui resource metadata', () => {
    expect(uiResourceUri({ _meta: { ui: { resourceUri: 'ui://a/b' } } })).toBe('ui://a/b');
    expect(uiResourceUri({ _meta: { 'ui/resourceUri': 'ui://legacy' } })).toBe('ui://legacy');
    expect(uiResourceUri({ _meta: { ui: { resourceUri: 'https://x' } } })).toBeUndefined();
    expect(uiResourceUri({})).toBeUndefined();
  });

  it('builds a locked-down frame CSP from declared domains only', () => {
    const csp = frameCsp({ connectDomains: ['https://api.example.com'], resourceDomains: ['https://cdn.example.com', "'unsafe-eval'"] });
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain('connect-src https://api.example.com');
    expect(csp).toContain('https://cdn.example.com');
    expect(csp).not.toContain('unsafe-eval');
    expect(frameCsp(undefined)).toContain("connect-src 'none'");
  });
});

describe('wrap: proxy', () => {
  let hub: Hub | undefined;
  afterEach(async () => hub?.close());

  it('passes tools through, adds screen tools, and renders ui:// results on the canvas', async () => {
    hub = await startHub({ port: 0, home: null });
    const calls: string[] = [];
    const upstream: UpstreamLike = {
      listTools: async () => ({
        tools: [
          { name: 'weather', inputSchema: { type: 'object' }, _meta: { ui: { resourceUri: 'ui://w/view' } } },
          { name: 'plain', inputSchema: { type: 'object' } },
        ],
      }),
      callTool: async ({ name }) => {
        calls.push(name);
        return { content: [{ type: 'text', text: `${name} ok` }] };
      },
      readResource: async ({ uri }) => ({ contents: [{ uri, mimeType: 'text/html;profile=mcp-app', text: '<p>hi</p>' }] }),
    };
    const proxy = new WrapProxy(upstream, hub.api);
    const names = (await proxy.listTools()).map((t) => t.name);
    expect(names.slice(0, 2)).toEqual(['weather', 'plain']);
    expect(names).toContain('place_widget');

    const plain = await proxy.callTool('plain', {});
    expect(plain.content).toHaveLength(1);
    const r = await proxy.callTool('weather', { city: 'Melbourne' });
    expect((r.content.at(-1) as { text: string }).text).toMatch(/Rendered ui:\/\/w\/view/);
    const app = hub.store.list().find((w) => w.kind === 'mcp-app')!;
    expect(app.data).toMatchObject({ html: '<p>hi</p>', toolName: 'weather', toolInput: { city: 'Melbourne' } });
    expect(calls).toEqual(['plain', 'weather']);
    const screen = await proxy.callTool('read_canvas', {});
    expect(JSON.parse((screen.content[0] as { text: string }).text).widgets).toHaveLength(1);
  });

  it('serves the app HTML only with the per-widget nonce, never inline in events', async () => {
    hub = await startHub({ port: 0, home: null });
    const w = await hub.api.place({ kind: 'mcp-app', title: 'a', data: { html: '<b>secret-ui</b>', resourceUri: 'ui://x', toolName: 't' } });
    expect((await fetch(`${hub.url}/frame/${w.id}?n=wrong`)).status).toBe(404);
    const state = await (await fetch(`${hub.url}/api/state`, { headers: { 'x-mcp-screen-token': hub.token } })).json();
    const decorated = state.result.widgets[0];
    expect(decorated.data.html).toBeUndefined();
    const frame = await fetch(`${hub.url}/frame/${w.id}?n=${decorated.frameNonce}`);
    expect(await frame.text()).toBe('<b>secret-ui</b>');
    expect(frame.headers.get('content-security-policy')).toContain("default-src 'none'");
  });

  it('works against a real stdio MCP App server (examples/demo-app-server.mjs)', async () => {
    hub = await startHub({ port: 0, home: null });
    const client = new Client({ name: 't', version: '1' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve('examples/demo-app-server.mjs')], stderr: 'ignore' }));
    try {
      const proxy = new WrapProxy(client as unknown as UpstreamLike, hub.api);
      await proxy.listTools();
      await proxy.callTool('flaky_tests', { days: 14 });
      const app = hub.store.list()[0]!;
      expect(app.kind).toBe('mcp-app');
      expect(String(app.data.html)).toContain('ui/initialize');
      expect((app.data.toolResult as { structuredContent: { days: number } }).structuredContent.days).toBe(14);
    } finally {
      await client.close();
    }
  });
});
