import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

type Store = { store: Record<string, string>; getItem(k: string): string | null; setItem(k: string, v: string): void };
function load() {
  const localStorage: Store = {
    store: {},
    getItem(k) { return this.store[k] ?? null; },
    setItem(k, v) { this.store[k] = v; },
  };
  const sandbox: Record<string, unknown> = { localStorage };
  vm.runInNewContext(fs.readFileSync('public/notify-prefs.js', 'utf8'), { globalThis: sandbox, localStorage });
  return sandbox.McpScreenNotify as {
    inQuietHours(p: { quietStart: number | null; quietEnd: number | null }, d?: Date): boolean;
    shouldNotify(p: { muted: boolean; mutedCanvases: string[]; quietStart: number | null; quietEnd: number | null }, canvasId?: string, opts?: { permission?: string; now?: Date }): boolean;
    summarize(p: { muted: boolean; mutedCanvases: string[]; quietStart: number | null; quietEnd: number | null }, canvasId?: string): string;
  };
}

describe('notification prefs', () => {
  const N = load();
  const base = { muted: false, mutedCanvases: [] as string[], quietStart: null as number | null, quietEnd: null as number | null };

  it('respects mute, per-canvas mute, and quiet hours (including overnight)', () => {
    expect(N.shouldNotify(base, 'a', { permission: 'granted' })).toBe(true);
    expect(N.shouldNotify({ ...base, muted: true }, 'a', { permission: 'granted' })).toBe(false);
    expect(N.shouldNotify({ ...base, mutedCanvases: ['shop'] }, 'shop', { permission: 'granted' })).toBe(false);
    expect(N.shouldNotify({ ...base, mutedCanvases: ['shop'] }, 'other', { permission: 'granted' })).toBe(true);
    const quiet = { ...base, quietStart: 22, quietEnd: 7 };
    expect(N.inQuietHours(quiet, new Date('2026-10-16T23:00:00'))).toBe(true);
    expect(N.inQuietHours(quiet, new Date('2026-10-16T03:00:00'))).toBe(true);
    expect(N.inQuietHours(quiet, new Date('2026-10-16T12:00:00'))).toBe(false);
    expect(N.shouldNotify(quiet, 'a', { permission: 'granted', now: new Date('2026-10-16T23:30:00') })).toBe(false);
    expect(N.summarize({ ...base, muted: true })).toMatch(/Muted/);
  });
});
