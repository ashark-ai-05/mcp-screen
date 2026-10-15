import fs from 'node:fs';
import vm from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import { startHub, type Hub } from '../src/hub.js';
import { CanvasStore } from '../src/store.js';

type ExportApi = {
  buildStaticHtml(o: { css: string; fontDataUrl: string | null; title: string; bodyHtml: string; when: string }): string;
  slug(d?: Date): string;
};
function loadExport(): ExportApi {
  const sandbox: Record<string, unknown> = {};
  vm.runInNewContext(fs.readFileSync('public/export.js', 'utf8'), { globalThis: sandbox });
  return sandbox.McpScreenExport as ExportApi;
}

describe('share: static HTML export', () => {
  const ex = loadExport();
  const css = "@font-face { font-family: 'Inter var'; src: url('/fonts/inter-var-latin.woff2') format('woff2'); }\n.card{color:red}";

  it('produces a self-contained, script-free document with the font inlined', () => {
    const html = ex.buildStaticHtml({
      css,
      fontDataUrl: 'data:font/woff2;base64,AAAA',
      title: 'Snap <1>',
      bodyHtml: '<main><div class="card" onclick="steal()">hi</div><script>alert(1)</script><iframe src="/frame/x"></iframe></main>',
      when: 'today',
    });
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain("url('data:font/woff2;base64,AAAA')");
    expect(html).not.toContain('/fonts/inter');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<iframe/i);
    expect(html).not.toContain('onclick');
    expect(html).toContain("default-src 'none'");
    expect(html).toContain('<title>Snap &lt;1&gt;</title>');
    expect(html).toContain('<div class="card">hi</div>');
    expect(html).toContain('class="exported"');
  });

  it('drops the @font-face when the font is unavailable, and names files by time', () => {
    const html = ex.buildStaticHtml({ css, fontDataUrl: null, title: 't', bodyHtml: '', when: '' });
    expect(html).not.toContain('@font-face');
    expect(ex.slug(new Date(2026, 9, 15, 9, 5, 7))).toBe('mcp-screen-20261015-090507');
  });
});

describe('theatre: file actions + assets', () => {
  let hub: Hub | undefined;
  afterEach(async () => hub?.close());

  it('carries read/edit/create through to livemap activity', () => {
    const s = new CanvasStore();
    s.place({ id: 'm', kind: 'livemap', title: 'm', data: { root: '/r', nodes: [{ id: 'a', label: 'A', globs: ['src/**'] }] } });
    expect(s.fileEvent({ path: '/r/src/x.ts', agent: 'claude', action: 'read' })[0]!.action).toBe('read');
    expect(s.fileEvent({ path: '/r/src/y.ts', agent: 'claude', action: 'create' })[0]!.action).toBe('create');
    expect(s.fileEvent({ path: '/r/src/z.ts', agent: 'claude' })[0]!.action).toBe('edit');
  });

  it('serves the bundled font and the export script', async () => {
    hub = await startHub({ port: 0, home: null });
    const font = await fetch(`${hub.url}/fonts/inter-var-latin.woff2`);
    expect(font.status).toBe(200);
    expect(font.headers.get('content-type')).toBe('font/woff2');
    expect((await fetch(`${hub.url}/export.js`)).status).toBe(200);
    expect((await fetch(`${hub.url}/fonts/../package.json`)).status).not.toBe(200);
    const page = await (await fetch(`${hub.url}/`)).text();
    expect(page).toContain('id="clear-btn"');
    expect(page).toContain('id="export-png"');
  });
});
