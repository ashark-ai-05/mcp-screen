import { randomUUID } from 'node:crypto';
import { EventBus } from './bus.js';
import { agentColor, autoLayers, matchNodes, toRepoPath } from './livemap.js';
import { validateData } from './registry.js';
import type { Activity, FileEvent, Report, Widget, WidgetKind, WidgetSource } from './types.js';

export interface PlaceInput {
  id?: string;
  kind: WidgetKind;
  title: string;
  data: unknown;
  w?: number;
  h?: number;
  source?: WidgetSource;
  intervalMs?: number;
}

export interface UpdateInput {
  title?: string;
  data?: unknown;
  /** Shallow-merge into existing data (default). Pass false to replace the data wholesale. */
  merge?: boolean;
  w?: number;
  h?: number;
}

export type ReportInput = Omit<Report, 'id' | 'at' | 'source' | 'tests' | 'risks' | 'filesChanged'> &
  Partial<Pick<Report, 'source' | 'tests' | 'risks' | 'filesChanged' | 'at'>>;

const clampSpan = (n: number | undefined, d: number): number => Math.max(1, Math.min(4, Math.round(n ?? d)));
const DEFAULT_SPAN: Partial<Record<WidgetKind, [number, number]>> = {
  metric: [1, 1],
  table: [2, 2],
  chart: [2, 2],
  'mcp-app': [2, 3],
  livemap: [4, 3],
};

export interface AskInput {
  question: string;
  detail?: string;
  choices: Array<{ id: string; label: string; description?: string; preview?: string }>;
  title?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type AskResult =
  | { answered: true; choice: { id: string; label: string }; widgetId: string }
  | { answered: false; reason: 'timeout' | 'cancelled' | 'removed'; widgetId: string };

export const ASK_DEFAULT_TIMEOUT_MS = 180_000;
export const ASK_MAX_TIMEOUT_MS = 900_000;

export class CanvasStore {
  readonly bus = new EventBus();
  private widgets = new Map<string, Widget>();
  private lastCleared: Widget[] | null = null;
  private pendingAsks = new Map<string, (r: AskResult) => void>();
  private reports: Report[] = [];
  private unmapped = new Map<string, string[]>();
  private activity: Activity[] = [];

  constructor(private readonly now: () => Date = () => new Date()) {}

  place(input: PlaceInput): Widget {
    const data = withLayout(input.kind, validateData(input.kind, input.data));
    const id = input.id ?? `${input.kind}-${randomUUID().slice(0, 8)}`;
    if (this.widgets.has(id)) throw new Error(`widget ${id} already exists; use update_widget`);
    const [dw, dh] = DEFAULT_SPAN[input.kind] ?? [1, 2];
    const ts = this.now().toISOString();
    const widget: Widget = {
      id,
      kind: input.kind,
      title: input.title,
      data,
      w: clampSpan(input.w, dw),
      h: clampSpan(input.h, dh),
      status: input.source ? 'needs-approval' : 'static',
      createdAt: ts,
      updatedAt: ts,
    };
    if (input.source) {
      widget.source = input.source;
      widget.intervalMs = Math.max(2000, input.intervalMs ?? 30000);
    }
    this.widgets.set(id, widget);
    this.emit(widget);
    return widget;
  }

  update(id: string, patch: UpdateInput): Widget {
    const w = this.require(id);
    if (patch.data !== undefined) {
      const next = patch.merge === false ? patch.data : { ...w.data, ...(patch.data as object) };
      w.data = withLayout(w.kind, validateData(w.kind, next));
    }
    if (patch.title !== undefined) w.title = patch.title;
    if (patch.w !== undefined) w.w = clampSpan(patch.w, w.w);
    if (patch.h !== undefined) w.h = clampSpan(patch.h, w.h);
    w.updatedAt = this.now().toISOString();
    this.emit(w);
    return w;
  }

  /** Internal: status / refresh bookkeeping without schema re-validation of untouched fields. */
  patchMeta(id: string, meta: Partial<Pick<Widget, 'status' | 'error' | 'lastRefreshedAt' | 'data'>>): Widget {
    const w = this.require(id);
    Object.assign(w, meta);
    if ('error' in meta && meta.error === undefined) delete w.error;
    w.updatedAt = this.now().toISOString();
    this.emit(w);
    return w;
  }

  setSelection(id: string, selection: unknown): Widget {
    const w = this.require(id);
    w.selection = selection;
    this.emit(w);
    return w;
  }

  remove(id: string): boolean {
    const ok = this.widgets.delete(id);
    if (ok) {
      this.settleAsk(id, 'removed');
      this.bus.push({ type: 'remove', id });
    }
    return ok;
  }

  /** Remove every widget. The removed set is kept so `undoClear()` can bring it back. */
  clear(): { removed: number } {
    const all = this.list();
    if (all.length === 0) return { removed: 0 };
    for (const w of all) {
      this.widgets.delete(w.id);
      this.settleAsk(w.id, 'removed');
      this.bus.push({ type: 'remove', id: w.id });
    }
    // Open questions can't be answered after an undo (their tool call already returned).
    this.lastCleared = all.filter((w) => !(w.kind === 'question' && w.data.state === 'open'));
    this.bus.push({ type: 'cleared', count: all.length, undoable: this.lastCleared.length > 0 });
    return { removed: all.length };
  }

  canUndoClear(): boolean {
    return !!this.lastCleared?.length;
  }

  /** Restore the widgets removed by the last clear (skipping ids that were reused since). */
  undoClear(): Widget[] {
    const back = (this.lastCleared ?? []).filter((w) => !this.widgets.has(w.id));
    this.lastCleared = null;
    for (const w of back) {
      this.widgets.set(w.id, w);
      this.emit(w);
    }
    this.bus.push({ type: 'restored', count: back.length });
    return back;
  }

  /**
   * Place a question card and wait for the human to click a choice.
   * Resolves on answer, timeout, abort (the agent's tool call was cancelled) or removal.
   */
  ask(input: AskInput): { widget: Widget; result: Promise<AskResult> } {
    const timeoutMs = Math.min(ASK_MAX_TIMEOUT_MS, Math.max(1000, input.timeoutMs ?? ASK_DEFAULT_TIMEOUT_MS));
    const widget = this.place({
      kind: 'question',
      title: input.title ?? 'Your call',
      w: input.choices.length > 3 ? 4 : Math.max(2, input.choices.length),
      h: 2,
      data: {
        question: input.question,
        ...(input.detail ? { detail: input.detail } : {}),
        choices: input.choices,
        state: 'open',
        expiresAt: new Date(this.now().getTime() + timeoutMs).toISOString(),
      },
    });
    const result = new Promise<AskResult>((resolve) => {
      const timer = setTimeout(() => this.settleAsk(widget.id, 'timeout'), timeoutMs);
      timer.unref?.();
      const onAbort = (): void => this.settleAsk(widget.id, 'cancelled');
      input.signal?.addEventListener('abort', onAbort, { once: true });
      this.pendingAsks.set(widget.id, (r) => {
        clearTimeout(timer);
        input.signal?.removeEventListener('abort', onAbort);
        resolve(r);
      });
      if (input.signal?.aborted) onAbort();
    });
    return { widget, result };
  }

  /** The human clicked a choice. */
  answer(id: string, choiceId: string): Widget {
    const w = this.require(id);
    if (w.kind !== 'question') throw new Error('not a question widget');
    if (w.data.state !== 'open') throw new Error(`question is already ${String(w.data.state)}`);
    const choice = (w.data.choices as Array<{ id: string; label: string }>).find((c) => c.id === choiceId);
    if (!choice) throw new Error(`no choice ${choiceId}`);
    w.data = { ...w.data, state: 'answered', answer: { id: choice.id, label: choice.label, at: this.now().toISOString() } };
    w.selection = { id: choice.id, label: choice.label };
    w.updatedAt = this.now().toISOString();
    this.emit(w);
    const resolve = this.pendingAsks.get(id);
    this.pendingAsks.delete(id);
    resolve?.({ answered: true, choice: { id: choice.id, label: choice.label }, widgetId: id });
    return w;
  }

  private settleAsk(id: string, reason: 'timeout' | 'cancelled' | 'removed'): void {
    const resolve = this.pendingAsks.get(id);
    if (!resolve) return;
    this.pendingAsks.delete(id);
    const w = this.widgets.get(id);
    if (w && reason !== 'removed') {
      w.data = { ...w.data, state: reason };
      w.updatedAt = this.now().toISOString();
      this.emit(w);
    }
    resolve({ answered: false, reason, widgetId: id });
  }

  get(id: string): Widget | undefined {
    return this.widgets.get(id);
  }

  list(): Widget[] {
    return [...this.widgets.values()];
  }

  /** read_widget payload: the widget plus anything the human did with it. */
  read(id: string): Widget & { unmappedFiles?: string[] } {
    const w = this.require(id);
    return w.kind === 'livemap' ? { ...w, unmappedFiles: this.unmapped.get(id) ?? [] } : { ...w };
  }

  readCanvas(): { widgets: Array<Pick<Widget, 'id' | 'kind' | 'title' | 'status' | 'selection'>>; reports: number } {
    return {
      widgets: this.list().map(({ id, kind, title, status, selection }) => ({ id, kind, title, status, selection })),
      reports: this.reports.length,
    };
  }

  postReport(input: ReportInput): Report {
    const report: Report = {
      id: `report-${randomUUID().slice(0, 8)}`,
      at: input.at ?? this.now().toISOString(),
      source: input.source ?? 'tool',
      agent: input.agent || 'agent',
      worktree: input.worktree || 'default',
      summary: input.summary,
      filesChanged: input.filesChanged ?? [],
      tests: input.tests ?? { status: 'unknown' },
      risks: input.risks ?? [],
    };
    if (input.branch) report.branch = input.branch;
    if (input.sessionId) report.sessionId = input.sessionId;
    this.reports.push(report);
    if (this.reports.length > 500) this.reports.shift();
    this.bus.push({ type: 'report', report });
    return report;
  }

  listReports(): Report[] {
    return [...this.reports];
  }

  /** Map a file touched by an agent onto every livemap's nodes and broadcast the glow. */
  fileEvent(ev: FileEvent): Activity[] {
    const out: Activity[] = [];
    for (const w of this.widgets.values()) {
      if (w.kind !== 'livemap') continue;
      const nodes = w.data.nodes as Array<{ id: string; label: string; globs: string[] }>;
      const rel = toRepoPath(ev.path, w.data.root as string | undefined, ev.cwd);
      const nodeIds = matchNodes(nodes, rel);
      if (nodeIds.length === 0) {
        const list = this.unmapped.get(w.id) ?? [];
        if (!list.includes(rel) && !rel.startsWith('../')) list.push(rel);
        this.unmapped.set(w.id, list.slice(-50));
        this.emit(w);
        continue;
      }
      const activity: Activity = {
        widgetId: w.id,
        nodeIds,
        agent: ev.agent,
        color: agentColor(ev.agent),
        path: rel,
        action: ev.action ?? 'edit',
        at: ev.at ?? this.now().toISOString(),
      };
      this.activity.push(activity);
      if (this.activity.length > 200) this.activity.shift();
      this.bus.push({ type: 'activity', activity });
      out.push(activity);
    }
    return out;
  }

  recentActivity(): Activity[] {
    return [...this.activity];
  }

  unmappedFor(id: string): string[] {
    return this.unmapped.get(id) ?? [];
  }

  private require(id: string): Widget {
    const w = this.widgets.get(id);
    if (!w) throw new Error(`no widget with id ${id}`);
    return w;
  }

  private emit(w: Widget): void {
    const unmapped = w.kind === 'livemap' ? { unmappedFiles: this.unmapped.get(w.id) ?? [] } : {};
    this.bus.push({ type: 'widget', widget: { ...w, ...unmapped } });
  }
}

/** Livemaps get a server-computed layered layout so the browser stays dumb. */
function withLayout(kind: WidgetKind, data: Record<string, unknown>): Record<string, unknown> {
  if (kind !== 'livemap') return data;
  const nodes = data.nodes as Array<{ id: string; layer?: number }>;
  const edges = (data.edges as Array<{ from: string; to: string }>) ?? [];
  const layers = autoLayers(nodes, edges);
  const byLayer = new Map<number, string[]>();
  for (const n of nodes) {
    const l = layers.get(n.id) ?? 0;
    byLayer.set(l, [...(byLayer.get(l) ?? []), n.id]);
  }
  const layout: Record<string, { x: number; y: number }> = {};
  const maxCount = Math.max(...[...byLayer.values()].map((v) => v.length));
  for (const [l, ids] of byLayer) {
    ids.forEach((id, i) => {
      layout[id] = { x: ((i + 0.5) / ids.length) * Math.max(ids.length, maxCount) * 200, y: l * 130 + 50 };
    });
  }
  return { ...data, layout, width: maxCount * 200, height: byLayer.size * 130 };
}
