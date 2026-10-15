import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { coerceRefreshed } from './registry.js';
import type { CanvasStore } from './store.js';
import type { Widget, WidgetSource } from './types.js';

export const MIN_INTERVAL_MS = 2000;
export const COMMAND_TIMEOUT_MS = 10_000;
export const MAX_OUTPUT_BYTES = 256 * 1024;

/** Canonical identity of a source. Approval is for this exact string, nothing looser. */
export function sourceKey(src: WidgetSource): string {
  switch (src.type) {
    case 'command':
      return `command:${JSON.stringify({ argv: src.argv, cwd: src.cwd ?? null })}`;
    case 'url':
      return `url:${src.url}`;
    case 'mcp':
      return `mcp:${JSON.stringify({ tool: src.tool, arguments: src.arguments ?? {} })}`;
  }
}

export function describeSource(src: WidgetSource): string {
  switch (src.type) {
    case 'command':
      return `$ ${src.argv.map((a) => (/^[\w./:=@-]+$/.test(a) ? a : JSON.stringify(a))).join(' ')}${src.cwd ? `  (in ${src.cwd})` : ''}`;
    case 'url':
      return `GET ${src.url}`;
    case 'mcp':
      return `MCP tool ${src.tool}(${JSON.stringify(src.arguments ?? {})})`;
  }
}

export function validateSource(src: WidgetSource): void {
  if (src.type === 'command') {
    if (!Array.isArray(src.argv) || src.argv.length === 0 || !src.argv.every((a) => typeof a === 'string'))
      throw new Error('command source needs argv: a non-empty array of strings (no shell is used)');
  } else if (src.type === 'url') {
    const u = new URL(src.url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('url source must be http(s)');
  }
}

/** Persistent allow-list of approved sources, stored as JSON (0600) under the mcp-screen home. */
export class AllowList {
  private entries = new Set<string>();
  constructor(private readonly file: string | null) {
    if (file && fs.existsSync(file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { approved?: string[] };
        for (const e of parsed.approved ?? []) this.entries.add(e);
      } catch {
        /* a corrupt allow-list approves nothing */
      }
    }
  }
  has(src: WidgetSource): boolean {
    return this.entries.has(sourceKey(src));
  }
  add(src: WidgetSource): void {
    this.entries.add(sourceKey(src));
    this.save();
  }
  remove(src: WidgetSource): void {
    this.entries.delete(sourceKey(src));
    this.save();
  }
  list(): string[] {
    return [...this.entries];
  }
  private save(): void {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ approved: this.list() }, null, 2), { mode: 0o600 });
  }
}

export type McpCaller = (tool: string, args: Record<string, unknown>) => Promise<unknown>;

export function runCommand(argv: string[], cwd?: string): Promise<string> {
  const [cmd, ...args] = argv;
  return new Promise((resolve, reject) => {
    execFile(
      cmd as string,
      args,
      { cwd, timeout: COMMAND_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, shell: false, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`${err.message.split('\n')[0]}${stderr ? `: ${String(stderr).slice(0, 300)}` : ''}`));
        else resolve(String(stdout));
      },
    );
  });
}

export interface Runners {
  command: (argv: string[], cwd?: string) => Promise<string>;
  url: (url: string) => Promise<string>;
  mcp?: McpCaller;
}

const defaultRunners: Runners = {
  command: runCommand,
  url: async (url) => {
    const res = await fetch(url, { signal: AbortSignal.timeout(COMMAND_TIMEOUT_MS), redirect: 'error' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    return text.slice(0, MAX_OUTPUT_BYTES);
  },
};

/**
 * Re-runs approved widget sources on their interval and pushes the result
 * into the store. Deterministic: no model in the loop. Unapproved sources
 * never run; they sit in `needs-approval` until a human clicks Approve.
 */
export class RefreshScheduler {
  private timers = new Map<string, NodeJS.Timeout>();
  private running = new Set<string>();
  private widgetStore = new Map<string, CanvasStore>();
  private runners: Runners;
  private unsubscribe: () => void;

  constructor(
    private readonly store: CanvasStore,
    private readonly allow: AllowList,
    runners: Partial<Runners> = {},
  ) {
    this.runners = { ...defaultRunners, ...runners };
    this.unsubscribe = store.bus.on((e) => {
      if (e.type === 'remove') this.stop(e.id);
    });
  }
  /** Which store owns a widget (named canvases may place into a non-default store). */
  private forId(id: string): CanvasStore { return this.widgetStore.get(id) ?? this.store; }
  /** Watch another store for removals (call when a new named canvas is created). */
  watch(store: CanvasStore): void {
    store.bus.on((e) => { if (e.type === 'remove') this.stop(e.id); });
  }

  setMcpCaller(caller: McpCaller): void {
    this.runners.mcp = caller;
  }

  /** Called after a widget with a source is placed. Starts it if already allow-listed. */
  register(w: Widget, store?: CanvasStore): void {
    if (store) this.widgetStore.set(w.id, store);
    if (!w.source) return;
    const s = this.forId(w.id);
    if (this.allow.has(w.source)) this.start(w.id);
    else if (w.status !== 'needs-approval') s.patchMeta(w.id, { status: 'needs-approval' });
  }

  approve(id: string): Widget {
    const w = this.mustGet(id);
    if (!w.source) throw new Error('widget has no source');
    this.allow.add(w.source);
    this.start(id);
    return this.mustGet(id);
  }

  deny(id: string): Widget {
    this.stop(id);
    return this.forId(id).patchMeta(id, { status: 'denied' });
  }

  /** Revoke: stop the timer and drop the source from the allow-list. */
  revoke(id: string): Widget {
    const w = this.mustGet(id);
    if (w.source) this.allow.remove(w.source);
    this.stop(id);
    return this.forId(id).patchMeta(id, { status: 'needs-approval' });
  }

  async refreshNow(id: string): Promise<Widget> {
    const s = this.forId(id);
    const w = this.mustGet(id);
    if (!w.source) return w;
    if (!this.allow.has(w.source)) {
      return s.patchMeta(id, { status: 'needs-approval' });
    }
    if (this.running.has(id)) return w;
    this.running.add(id);
    try {
      const raw = await this.fetchSource(w.source);
      const current = s.get(id);
      if (!current) return w;
      const data = coerceRefreshed(current.kind, raw);
      return s.patchMeta(id, {
        data,
        status: 'live',
        error: undefined,
        lastRefreshedAt: new Date().toISOString(),
      });
    } catch (err) {
      if (!s.get(id)) return w;
      return s.patchMeta(id, { status: 'error', error: (err as Error).message });
    } finally {
      this.running.delete(id);
    }
  }

  stop(id: string): void {
    const t = this.timers.get(id);
    if (t) clearInterval(t);
    this.timers.delete(id);
    this.widgetStore.delete(id);
  }

  stopAll(): void {
    for (const id of [...this.timers.keys()]) this.stop(id);
    this.unsubscribe();
  }

  isScheduled(id: string): boolean {
    return this.timers.has(id);
  }

  private start(id: string): void {
    const w = this.mustGet(id);
    this.stop(id);
    void this.refreshNow(id);
    const t = setInterval(() => void this.refreshNow(id), Math.max(MIN_INTERVAL_MS, w.intervalMs ?? 30000));
    t.unref?.();
    this.timers.set(id, t);
  }

  private async fetchSource(src: WidgetSource): Promise<unknown> {
    switch (src.type) {
      case 'command': {
        const out = await this.runners.command(src.argv, src.cwd);
        return src.parse === 'json' ? JSON.parse(out) : out;
      }
      case 'url': {
        const out = await this.runners.url(src.url);
        return src.parse === 'json' ? JSON.parse(out) : out;
      }
      case 'mcp': {
        if (!this.runners.mcp) throw new Error('MCP sources only work in `mcp-screen wrap` mode');
        return extractToolData(await this.runners.mcp(src.tool, src.arguments ?? {}));
      }
    }
  }

  private mustGet(id: string): Widget {
    const w = this.store.get(id);
    if (!w) throw new Error(`no widget with id ${id}`);
    return w;
  }
}

/** Prefer structuredContent, else the first text block (parsed as JSON when possible). */
export function extractToolData(result: unknown): unknown {
  const r = result as { structuredContent?: unknown; content?: Array<{ type: string; text?: string }> };
  if (r?.structuredContent !== undefined) return r.structuredContent;
  const text = r?.content?.find((c) => c.type === 'text')?.text;
  if (text === undefined) return result;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
