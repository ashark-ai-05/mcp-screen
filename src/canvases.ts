/**
 * Named canvases: one store per project. The default name comes from the git root
 * (or MCP_SCREEN_CANVAS). Each canvas persists to <home>/canvases/<id>.json.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { EventBus } from './bus.js';
import { restore, startPersistence, CANVAS_FILE } from './persist.js';
import { CanvasStore } from './store.js';
import type { ScreenApi } from './api.js';
import type { ScreenEvent } from './types.js';


export interface CanvasInfo {
  id: string;
  title: string;
  updatedAt: string;
  widgets: number;
  annotations: number;
  active: boolean;
}

export function slug(name: string): string {
  const s = name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  return s || 'default';
}

/** Prefer MCP_SCREEN_CANVAS; else the basename of the git root (or cwd). */
export function defaultCanvasFrom(cwd = process.cwd()): { id: string; title: string } {
  const env = process.env.MCP_SCREEN_CANVAS?.trim();
  if (env) return { id: slug(env), title: env };
  let root = cwd;
  try {
    root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || cwd;
  } catch { /* not a git tree */ }
  const title = path.basename(root) || 'default';
  return { id: slug(title), title };
}

export class CanvasBook {
  readonly bus = new EventBus();
  private readonly entries = new Map<string, { store: CanvasStore; title: string; updatedAt: string; persist: { flush(): void; stop(): void } | null }>();
  private activeId: string;
  private readonly dir: string | null;
  private readonly doPersist: boolean;
  private readonly unsubs = new Map<string, () => void>();

  constructor(opts: { home: string | null; persist: boolean; seed?: { id: string; title: string } }) {
    this.dir = opts.home ? path.join(opts.home, 'canvases') : null;
    this.doPersist = !!opts.home && opts.persist;
    const seed = opts.seed ?? { id: 'default', title: 'default' };
    this.activeId = seed.id;
    this.ensure(seed.id, seed.title);
    if (this.dir && opts.home) this.migrateLegacy(opts.home);
    if (this.dir) this.loadIndex();
  }

  get active(): CanvasStore { return this.entries.get(this.activeId)!.store; }
  get activeCanvasId(): string { return this.activeId; }
  store(id?: string): CanvasStore { return this.ensure(id ?? this.activeId).store; }

  ensure(id: string, title?: string): { store: CanvasStore; title: string; updatedAt: string; persist: { flush(): void; stop(): void } | null } {
    const key = slug(id);
    let e = this.entries.get(key);
    if (e) {
      if (title && title !== e.title) { e.title = title; this.writeIndex(); }
      return e;
    }
    const store = new CanvasStore();
    e = { store, title: title?.trim() || key, updatedAt: new Date().toISOString(), persist: null };
    this.entries.set(key, e);
    this.unsubs.set(key, store.bus.on((ev) => {
      e!.updatedAt = new Date().toISOString();
      if (key === this.activeId) this.bus.push(ev);
    }));
    if (this.doPersist && this.dir) {
      fs.mkdirSync(this.dir, { recursive: true });
      e.persist = startPersistence(this.dir, store, 300, `${key}.json`);
    }
    this.writeIndex();
    this.bus.push({ type: 'canvases', canvases: this.list() });
    return e;
  }

  /** Pending annotation questions across every named canvas (for the agent hook). */
  pendingAcross(): Array<{ canvas: string; title: string; id: string; kind: string; question: string; target?: unknown }> {
    const out: Array<{ canvas: string; title: string; id: string; kind: string; question: string; target?: unknown }> = [];
    for (const [id, e] of this.entries) {
      for (const q of e.store.pendingQuestions()) out.push({ canvas: id, title: e.title, ...q });
    }
    return out;
  }

  list(): CanvasInfo[] {
    return [...this.entries.entries()]
      .map(([id, e]) => ({ id, title: e.title, updatedAt: e.updatedAt, widgets: e.store.list().length, annotations: e.store.listAnnotations().length, active: id === this.activeId }))
      .sort((a, b) => (a.id === this.activeId ? -1 : b.id === this.activeId ? 1 : a.title.localeCompare(b.title)));
  }

  setActive(id: string, title?: string): CanvasInfo {
    const key = slug(id);
    this.ensure(key, title ?? id);
    this.activeId = key;
    this.writeIndex();
    this.bus.push({ type: 'canvases', canvases: this.list() });
    // the browser reloads from the snapshot that follows
    this.bus.push({ type: 'canvas-switch', canvas: key, widgets: this.active.list(), annotations: this.active.listAnnotations() });
    return this.list().find((c) => c.id === key)!;
  }

  rename(id: string, title: string): CanvasInfo {
    const e = this.ensure(id);
    e.title = title.trim().slice(0, 80) || e.title;
    this.writeIndex();
    this.bus.push({ type: 'canvases', canvases: this.list() });
    return this.list().find((c) => c.id === slug(id))!;
  }

  async restoreAll(apiFor: (store: CanvasStore) => ScreenApi): Promise<void> {
    if (!this.dir || !fs.existsSync(this.dir)) return;
    for (const f of fs.readdirSync(this.dir).filter((n) => n.endsWith('.json') && n !== 'index.json')) {
      const id = slug(f.replace(/\.json$/, ''));
      const e = this.ensure(id);
      await restore(this.dir, e.store, apiFor(e.store), f);
    }
  }

  flush(): void { for (const e of this.entries.values()) e.persist?.flush(); this.writeIndex(); }
  stop(): void {
    for (const e of this.entries.values()) e.persist?.stop();
    for (const off of this.unsubs.values()) off();
    this.writeIndex();
  }

  private migrateLegacy(home: string): void {
    const legacy = path.join(home, CANVAS_FILE);
    if (!fs.existsSync(legacy) || !this.dir) return;
    fs.mkdirSync(this.dir, { recursive: true });
    const dest = path.join(this.dir, `${this.activeId}.json`);
    if (!fs.existsSync(dest)) {
      try { fs.renameSync(legacy, dest); } catch { try { fs.copyFileSync(legacy, dest); } catch { /* ignore */ } }
    }
  }

  private loadIndex(): void {
    if (!this.dir) return;
    try {
      const idx = JSON.parse(fs.readFileSync(path.join(this.dir, 'index.json'), 'utf8')) as { active?: string; canvases?: Array<{ id: string; title: string }> };
      for (const c of idx.canvases ?? []) if (c?.id) this.ensure(c.id, c.title);
      if (idx.active && this.entries.has(slug(idx.active))) this.activeId = slug(idx.active);
    } catch { /* first run */ }
    if (this.dir && fs.existsSync(this.dir)) {
      for (const f of fs.readdirSync(this.dir).filter((n) => n.endsWith('.json') && n !== 'index.json')) this.ensure(f.replace(/\.json$/, ''));
    }
  }

  private writeIndex(): void {
    if (!this.dir || !this.doPersist) return;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = path.join(this.dir, `index.${process.pid}.tmp`);
      fs.writeFileSync(tmp, JSON.stringify({ active: this.activeId, canvases: this.list().map(({ id, title, updatedAt }) => ({ id, title, updatedAt })) }), { mode: 0o600 });
      fs.renameSync(tmp, path.join(this.dir, 'index.json'));
    } catch { /* best effort */ }
  }
}
