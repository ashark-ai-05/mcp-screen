import fs from 'node:fs';
import type { WidgetSource } from '../src/types.js';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalApi } from '../src/api.js';
import { AllowList, describeSource, extractToolData, RefreshScheduler, runCommand, sourceKey, validateSource } from '../src/refresh.js';
import { CanvasStore } from '../src/store.js';
import { startHub, type Hub } from '../src/hub.js';

const tick = () => new Promise((r) => setTimeout(r, 20));

function setup(runners: ConstructorParameters<typeof RefreshScheduler>[2] = {}, file: string | null = null) {
  const store = new CanvasStore();
  const allow = new AllowList(file);
  const scheduler = new RefreshScheduler(store, allow, runners);
  const api = new LocalApi(store, scheduler, 'http://test');
  return { store, allow, scheduler, api };
}

describe('live widgets', () => {
  const schedulers: RefreshScheduler[] = [];
  afterEach(() => schedulers.splice(0).forEach((s) => s.stopAll()));

  it('never runs an unapproved command', async () => {
    const command = vi.fn(async () => 'x');
    const { api, scheduler } = setup({ command });
    schedulers.push(scheduler);
    const w = await api.place({ kind: 'text', title: 'up', data: { text: '' }, source: { type: 'command', argv: ['uptime'] } });
    await tick();
    expect(w.status).toBe('needs-approval');
    expect(command).not.toHaveBeenCalled();
    expect(scheduler.isScheduled(w.id)).toBe(false);
    expect((await scheduler.refreshNow(w.id)).status).toBe('needs-approval');
    expect(command).not.toHaveBeenCalled();
  });

  it('runs after approval, keeps refreshing on the interval, and re-renders', async () => {
    vi.useFakeTimers();
    let n = 0;
    const command = vi.fn(async () => JSON.stringify({ value: ++n, label: 'open PRs' }));
    const { api, scheduler, store } = setup({ command });
    schedulers.push(scheduler);
    const w = await api.place({ kind: 'metric', title: 'PRs', data: { value: 0 }, source: { type: 'command', argv: ['gh', 'pr', 'list'], parse: 'json' }, intervalMs: 2000 });
    scheduler.approve(w.id);
    await vi.advanceTimersByTimeAsync(10);
    expect(store.get(w.id)?.data.value).toBe(1);
    expect(store.get(w.id)?.status).toBe('live');
    await vi.advanceTimersByTimeAsync(4000);
    expect(command).toHaveBeenCalledTimes(3);
    expect(command).toHaveBeenCalledWith(['gh', 'pr', 'list'], undefined);
    vi.useRealTimers();
  });

  it('allow-list approval is exact: same argv auto-starts, different argv does not', async () => {
    const command = vi.fn(async () => 'ok');
    const { api, scheduler } = setup({ command });
    schedulers.push(scheduler);
    const a = await api.place({ kind: 'text', title: 'a', data: { text: '' }, source: { type: 'command', argv: ['git', 'status'] } });
    scheduler.approve(a.id);
    const b = await api.place({ kind: 'text', title: 'b', data: { text: '' }, source: { type: 'command', argv: ['git', 'status'] } });
    const c = await api.place({ kind: 'text', title: 'c', data: { text: '' }, source: { type: 'command', argv: ['git', 'status', '; rm -rf /'] } });
    await tick();
    expect(scheduler.isScheduled(b.id)).toBe(true);
    expect(scheduler.isScheduled(c.id)).toBe(false);
    expect(c.status).toBe('needs-approval');
  });

  it('persists the allow-list (0600) and revoke removes it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcps-'));
    const file = path.join(dir, 'allowlist.json');
    const src: WidgetSource = { type: 'command', argv: ['date'] };
    const a = new AllowList(file);
    a.add(src);
    expect(new AllowList(file).has(src)).toBe(true);
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    a.remove(src);
    expect(new AllowList(file).has(src)).toBe(false);
  });

  it('reports source errors on the widget, and deny stops it', async () => {
    const { api, scheduler, store } = setup({ command: async () => { throw new Error('boom'); } });
    schedulers.push(scheduler);
    const w = await api.place({ kind: 'text', title: 'x', data: { text: '' }, source: { type: 'command', argv: ['false'] } });
    await scheduler.approve(w.id);
    await tick();
    expect(store.get(w.id)?.status).toBe('error');
    expect(store.get(w.id)?.error).toContain('boom');
    expect(scheduler.deny(w.id).status).toBe('denied');
    expect(scheduler.isScheduled(w.id)).toBe(false);
  });

  it('runs real commands without a shell', async () => {
    expect(await runCommand([process.execPath, '-e', 'process.stdout.write("hi")'])).toBe('hi');
    // shell metacharacters are passed literally, not interpreted
    expect(await runCommand([process.execPath, '-e', 'process.stdout.write(process.argv[1])', '$(whoami);echo pwned'])).toBe('$(whoami);echo pwned');
  });

  it('validates and describes sources; mcp sources need wrap mode', async () => {
    expect(() => validateSource({ type: 'url', url: 'file:///etc/passwd' })).toThrow(/http/);
    expect(() => validateSource({ type: 'command', argv: [] })).toThrow(/argv/);
    expect(describeSource({ type: 'command', argv: ['gh', 'pr', 'list', '--json', 'title,state'] })).toBe('$ gh pr list --json "title,state"');
    expect(sourceKey({ type: 'url', url: 'https://a' })).toBe('url:https://a');
    const { api, scheduler, store } = setup();
    schedulers.push(scheduler);
    const w = await api.place({ kind: 'text', title: 'm', data: { text: '' }, source: { type: 'mcp', tool: 'x' } });
    scheduler.approve(w.id);
    await tick();
    expect(store.get(w.id)?.error).toMatch(/wrap/);
    expect(extractToolData({ content: [{ type: 'text', text: '{"a":1}' }] })).toEqual({ a: 1 });
    expect(extractToolData({ structuredContent: { b: 2 }, content: [] })).toEqual({ b: 2 });
  });
});

describe('approval over HTTP', () => {
  let hub: Hub | undefined;
  afterEach(async () => hub?.close());
  it('approve endpoint needs the token and starts the refresh', async () => {
    hub = await startHub({ port: 0, home: null, runners: { url: async () => 'fresh' } });
    const w = await hub.api.place({ kind: 'markdown', title: 'u', data: { markdown: 'stale' }, source: { type: 'url', url: 'https://example.com/x' } });
    const denied = await fetch(`${hub.url}/api/widgets/${w.id}/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(denied.status).toBe(401);
    const ok = await fetch(`${hub.url}/api/widgets/${w.id}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mcp-screen-token': hub.token },
      body: '{}',
    });
    expect(ok.status).toBe(200);
    await tick();
    expect(hub.store.get(w.id)?.data.markdown).toBe('fresh');
  });
});
