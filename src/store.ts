import { randomUUID } from 'node:crypto';
import { EventBus } from './bus.js';
import { checkImagePath } from './images.js';
import { contains, findSlot, overlapArea, pushDown, sizeOf, tidy, type Rect } from './layout.js';
import { agentColor, autoLayers, matchNodes, toRepoPath } from './livemap.js';
import { enrich, validateData, type FormField } from './registry.js';
import type { Activity, Annotation, AnnotationKind, FileEvent, Report, Widget, WidgetKind, WidgetSource } from './types.js';

export interface PlaceInput {
  id?: string;
  kind: WidgetKind;
  title: string;
  data: unknown;
  w?: number;
  h?: number;
  source?: WidgetSource;
  intervalMs?: number;
  /** World-pixel position; omitted = first free slot. */
  x?: number;
  y?: number;
}

export interface UpdateInput {
  title?: string;
  data?: unknown;
  /** Shallow-merge into existing data (default). Pass false to replace the data wholesale. */
  merge?: boolean;
  w?: number;
  h?: number;
  x?: number;
  y?: number;
}

export interface AnnotationInput {
  kind: AnnotationKind;
  points: Array<[number, number]>;
  text?: string;
  color?: string;
  /** Data points the browser found under the annotation (it can see the rendered bars/rows). */
  dataPoints?: unknown[];
  /** Optional hint; the server still checks the geometry. */
  widgetId?: string;
}

export interface FormInput {
  prompt: string;
  detail?: string;
  fields: FormField[];
  submitLabel?: string;
  title?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type FormValues = Record<string, string | number | boolean | null>;
export type FormResult =
  | { submitted: true; values: FormValues; widgetId: string }
  | { submitted: false; reason: 'timeout' | 'cancelled' | 'removed'; widgetId: string };

export type ReportInput = Omit<Report, 'id' | 'at' | 'source' | 'tests' | 'risks' | 'filesChanged'> &
  Partial<Pick<Report, 'source' | 'tests' | 'risks' | 'filesChanged' | 'at'>>;

const clampSpan = (n: number | undefined, d: number): number => Math.max(1, Math.min(4, Math.round(n ?? d)));
const DEFAULT_SPAN: Partial<Record<WidgetKind, [number, number]>> = {
  metric: [1, 1],
  table: [2, 2],
  chart: [2, 2],
  'mcp-app': [2, 3],
  livemap: [4, 3],
  diff: [4, 3],
  diagram: [2, 3],
  image: [2, 2],
  log: [2, 2],
  checklist: [1, 2],
  code: [2, 2],
  map: [2, 2],
  timeline: [4, 1],
};
const ANNOTATION_COLORS = new Set(['#ffd166', '#ff6b81', '#7c9cff', '#4fe0b0', '#c58cff']);
const clean = (n: number): number => Math.round(Number.isFinite(n) ? n : 0);

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
  private pendingAsks = new Map<string, (r: AskResult | FormResult) => void>();
  private annotations = new Map<string, Annotation>();
  private lastClearedNotes: Annotation[] = [];
  private reports: Report[] = [];
  private unmapped = new Map<string, string[]>();
  private activity: Activity[] = [];

  constructor(private readonly now: () => Date = () => new Date()) {}

  place(input: PlaceInput): Widget {
    const data = prepare(input.kind, input.data);
    const id = input.id ?? `${input.kind}-${randomUUID().slice(0, 8)}`;
    if (this.widgets.has(id)) throw new Error(`widget ${id} already exists; use update_widget`);
    const [dw, dh] = DEFAULT_SPAN[input.kind] ?? [1, 2];
    const ts = this.now().toISOString();
    const span = { w: clampSpan(input.w, dw), h: clampSpan(input.h, dh) };
    const at = input.x !== undefined && input.y !== undefined ? { x: clean(input.x), y: clean(input.y) } : findSlot(span, this.rects());
    const widget: Widget = {
      id,
      kind: input.kind,
      title: input.title,
      data,
      ...span,
      ...at,
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
    if (patch.data !== undefined) w.data = prepare(w.kind, mergeData(w, patch.data as Record<string, unknown>, patch.merge !== false));
    if (patch.title !== undefined) w.title = patch.title;
    const resized = (patch.w !== undefined && clampSpan(patch.w, w.w) !== w.w) || (patch.h !== undefined && clampSpan(patch.h, w.h) !== w.h);
    if (patch.w !== undefined) w.w = clampSpan(patch.w, w.w);
    if (patch.h !== undefined) w.h = clampSpan(patch.h, w.h);
    w.updatedAt = this.now().toISOString();
    if (patch.x !== undefined || patch.y !== undefined) this.move(id, patch.x ?? w.x, patch.y ?? w.y, false);
    this.emit(w);
    if (resized) for (const [oid, y] of pushDown(id, this.list())) this.move(oid, (this.widgets.get(oid) as Widget).x, y);
    return w;
  }

  /** Move a widget (the human dragged it, or the agent set x/y). Annotations on it move along. */
  move(id: string, x: number, y: number, emit = true): Widget {
    const w = this.require(id);
    const dx = clean(x) - w.x;
    const dy = clean(y) - w.y;
    w.x = clean(x);
    w.y = clean(y);
    if (dx || dy)
      for (const a of this.annotations.values())
        if (a.target?.widgetId === id) {
          a.points = a.points.map(([px, py]) => [px + dx, py + dy]);
          this.bus.push({ type: 'annotation', annotation: a });
        }
    if (emit) this.emit(w);
    return w;
  }

  /** Re-pack every widget into a tidy grid, keeping reading order. */
  tidy(): Array<{ id: string; x: number; y: number }> {
    const out: Array<{ id: string; x: number; y: number }> = [];
    for (const [id, p] of tidy(this.list())) {
      this.move(id, p.x, p.y);
      out.push({ id, ...p });
    }
    return out;
  }

  private rects(except?: string): Rect[] {
    return this.list()
      .filter((w) => w.id !== except)
      .map((w) => ({ x: w.x, y: w.y, ...sizeOf(w) }));
  }

  // ---------- annotations ----------

  /** The human drew something. Works out which widget it points at from the geometry. */
  annotate(input: AnnotationInput): Annotation {
    if (!['arrow', 'circle', 'highlight', 'note'].includes(input.kind)) throw new Error('annotation kind must be arrow, circle, highlight or note');
    if (!Array.isArray(input.points) || !input.points.length || input.points.length > 2000) throw new Error('annotation needs 1-2000 points');
    if (!input.points.every((p) => Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === 'number' && Number.isFinite(n)))) throw new Error('annotation points must be [x, y] numbers');
    if (input.dataPoints !== undefined && !Array.isArray(input.dataPoints)) throw new Error('dataPoints must be an array');
    if (JSON.stringify(input.dataPoints ?? []).length > 20_000) throw new Error('dataPoints too large');
    const points = input.points.map(([x, y]) => [clean(x), clean(y)] as [number, number]);
    const a: Annotation = {
      id: `note-${randomUUID().slice(0, 8)}`,
      kind: input.kind,
      points,
      color: input.color && ANNOTATION_COLORS.has(input.color) ? input.color : '#ffd166',
      createdAt: this.now().toISOString(),
    };
    if (input.text?.trim()) a.text = input.text.trim().slice(0, 2000);
    const w = this.targetOf(a, input.widgetId);
    if (w) {
      a.target = { widgetId: w.id, title: w.title, kind: w.kind };
      if (input.dataPoints?.length) a.target.dataPoints = input.dataPoints.slice(0, 50);
    }
    this.annotations.set(a.id, a);
    this.bus.push({ type: 'annotation', annotation: a });
    return a;
  }

  updateAnnotation(id: string, patch: { text?: string }): Annotation {
    const a = this.annotations.get(id);
    if (!a) throw new Error(`no annotation ${id}`);
    if (patch.text !== undefined) {
      if (patch.text.trim()) a.text = patch.text.trim().slice(0, 2000);
      else delete a.text;
    }
    this.bus.push({ type: 'annotation', annotation: a });
    return a;
  }

  removeAnnotation(id: string): boolean {
    const ok = this.annotations.delete(id);
    if (ok) this.bus.push({ type: 'annotation-remove', id });
    return ok;
  }

  listAnnotations(): Annotation[] {
    return [...this.annotations.values()];
  }

  private targetOf(a: Annotation, hint?: string): Widget | undefined {
    const xs = a.points.map((p) => p[0]);
    const ys = a.points.map((p) => p[1]);
    const box = { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
    const last = a.points[a.points.length - 1] as [number, number];
    // Arrow: its head. Note: its top-left corner. Circle / highlight: the centre of what was drawn.
    const anchor = a.kind === 'arrow' ? { x: last[0], y: last[1] } : a.kind === 'note' ? { x: a.points[0]![0], y: a.points[0]![1] } : { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const ws = this.list().reverse(); // later widgets paint on top
    const rect = (w: Widget): Rect => ({ x: w.x, y: w.y, ...sizeOf(w) });
    const hinted = hint ? this.widgets.get(hint) : undefined;
    if (hinted && contains(rect(hinted), anchor)) return hinted;
    const hit = ws.find((w) => contains(rect(w), anchor));
    if (hit || a.kind === 'note' || a.kind === 'arrow') return hit;
    let best: Widget | undefined;
    let area = 0;
    for (const w of ws) {
      const o = overlapArea(rect(w), box);
      if (o > area) [best, area] = [w, o];
    }
    return best;
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
      for (const a of this.listAnnotations()) if (a.target?.widgetId === id) this.removeAnnotation(a.id);
    }
    return ok;
  }

  /** Remove every widget. The removed set is kept so `undoClear()` can bring it back. */
  clear(): { removed: number } {
    const all = this.list();
    if (all.length === 0 && this.annotations.size === 0) return { removed: 0 };
    this.lastClearedNotes = this.listAnnotations();
    for (const a of this.lastClearedNotes) this.removeAnnotation(a.id);
    for (const w of all) {
      this.widgets.delete(w.id);
      this.settleAsk(w.id, 'removed');
      this.bus.push({ type: 'remove', id: w.id });
    }
    // Open questions can't be answered after an undo (their tool call already returned).
    this.lastCleared = all.filter((w) => !((w.kind === 'question' || w.kind === 'form') && w.data.state === 'open'));
    this.bus.push({ type: 'cleared', count: all.length, undoable: this.lastCleared.length + this.lastClearedNotes.length > 0 });
    return { removed: all.length };
  }

  canUndoClear(): boolean {
    return !!this.lastCleared?.length || this.lastClearedNotes.length > 0;
  }

  /** Restore the widgets removed by the last clear (skipping ids that were reused since). */
  undoClear(): Widget[] {
    const back = (this.lastCleared ?? []).filter((w) => !this.widgets.has(w.id));
    this.lastCleared = null;
    for (const w of back) {
      this.widgets.set(w.id, w);
      this.emit(w);
    }
    for (const a of this.lastClearedNotes) {
      if (a.target && !this.widgets.has(a.target.widgetId)) continue;
      this.annotations.set(a.id, a);
      this.bus.push({ type: 'annotation', annotation: a });
    }
    this.lastClearedNotes = [];
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
    const result = this.wait<AskResult>(widget.id, timeoutMs, input.signal);
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

  /** Place a form and wait for the human to submit it. Same lifecycle as ask(). */
  askForm(input: FormInput): { widget: Widget; result: Promise<FormResult> } {
    const timeoutMs = Math.min(ASK_MAX_TIMEOUT_MS, Math.max(1000, input.timeoutMs ?? ASK_DEFAULT_TIMEOUT_MS));
    const widget = this.place({
      kind: 'form',
      title: input.title ?? 'Your input',
      w: 2,
      h: Math.min(4, Math.max(2, Math.ceil((170 + Math.ceil(input.fields.length / 2) * 66 + (input.fields.some((f) => f.type === 'textarea') ? 60 : 0)) / 166))),
      data: {
        prompt: input.prompt,
        ...(input.detail ? { detail: input.detail } : {}),
        fields: input.fields,
        ...(input.submitLabel ? { submitLabel: input.submitLabel } : {}),
        state: 'open',
        expiresAt: new Date(this.now().getTime() + timeoutMs).toISOString(),
      },
    });
    this.formIds.add(widget.id);
    const result = this.wait<FormResult>(widget.id, timeoutMs, input.signal);
    return { widget, result };
  }

  /** The human pressed Submit. Values are checked against the field definitions. */
  submitForm(id: string, raw: Record<string, unknown>): Widget {
    const w = this.require(id);
    if (w.kind !== 'form') throw new Error('not a form widget');
    if (w.data.state !== 'open') throw new Error(`form is already ${String(w.data.state)}`);
    const values = checkFormValues(w.data.fields as FormField[], raw);
    w.data = { ...w.data, state: 'submitted', values };
    w.selection = { values };
    w.updatedAt = this.now().toISOString();
    this.emit(w);
    const resolve = this.pendingAsks.get(id);
    this.pendingAsks.delete(id);
    resolve?.({ submitted: true, values, widgetId: id });
    return w;
  }

  private wait<T>(id: string, timeoutMs: number, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve) => {
      const timer = setTimeout(() => this.settleAsk(id, 'timeout'), timeoutMs);
      timer.unref?.();
      const onAbort = (): void => this.settleAsk(id, 'cancelled');
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pendingAsks.set(id, (r) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(r as T);
      });
      if (signal?.aborted) onAbort();
    });
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
    const isForm = w?.kind === 'form' || (!w && this.formIds.has(id));
    resolve(isForm ? { submitted: false, reason, widgetId: id } : { answered: false, reason, widgetId: id });
  }
  private readonly formIds = new Set<string>();

  get(id: string): Widget | undefined {
    return this.widgets.get(id);
  }

  list(): Widget[] {
    return [...this.widgets.values()];
  }

  /** read_widget payload: the widget plus anything the human did with it. */
  read(id: string): Widget & { unmappedFiles?: string[]; annotations: Annotation[]; width: number; height: number } {
    const w = this.require(id);
    const annotations = this.listAnnotations().filter((a) => a.target?.widgetId === id);
    const base = { ...w, ...sizeOf(w), annotations };
    return w.kind === 'livemap' ? { ...base, unmappedFiles: this.unmapped.get(id) ?? [] } : base;
  }

  readCanvas(): {
    widgets: Array<Pick<Widget, 'id' | 'kind' | 'title' | 'status' | 'selection' | 'x' | 'y'> & { width: number; height: number }>;
    annotations: Annotation[];
    reports: number;
  } {
    return {
      widgets: this.list().map((w) => ({ id: w.id, kind: w.kind, title: w.title, status: w.status, selection: w.selection, x: w.x, y: w.y, ...sizeOf(w) })),
      annotations: this.listAnnotations(),
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

/** Validate, then add render-ready derived fields. Image paths are checked here so errors reach the agent. */
function prepare(kind: WidgetKind, raw: unknown): Record<string, unknown> {
  const data = enrich(kind, validateData(kind, raw));
  if (kind === 'image' && typeof data.path === 'string') checkImagePath(data.path);
  return withLayout(kind, data);
}

/** update_widget conveniences: `append` for logs, `set` for checklist items; otherwise a shallow merge. */
function mergeData(w: Widget, patch: Record<string, unknown>, merge: boolean): Record<string, unknown> {
  if (!merge) return patch;
  const { append, set, ...rest } = patch as { append?: unknown; set?: unknown } & Record<string, unknown>;
  const next: Record<string, unknown> = { ...w.data, ...rest };
  if (append !== undefined) {
    if (w.kind !== 'log') throw new Error('data.append only works on log widgets');
    const more = (Array.isArray(append) ? append : String(append).replace(/\n$/, '').split('\n')).map(String);
    next.lines = [...((next.lines as string[]) ?? []), ...more];
  }
  if (set !== undefined) {
    if (w.kind !== 'checklist' || typeof set !== 'object' || !set) throw new Error('data.set only works on checklist widgets, as {"<id or label>": "<status>"}');
    const items = ((next.items as Array<{ id?: string; label: string; status: string }>) ?? []).map((i) => ({ ...i }));
    for (const [key, status] of Object.entries(set as Record<string, unknown>)) {
      const it = items.find((i) => i.id === key) ?? items.find((i) => i.label === key);
      if (!it) throw new Error(`no checklist item with id or label "${key}"`);
      it.status = String(status);
    }
    next.items = items;
  }
  return next;
}

/** Coerce and check submitted form values against the field definitions. */
export function checkFormValues(fields: FormField[], raw: Record<string, unknown>): FormValues {
  const out: FormValues = {};
  for (const f of fields) {
    const v = raw[f.id];
    const empty = v === undefined || v === null || v === '';
    if (f.type === 'checkbox') {
      out[f.id] = v === true || v === 'true' || v === 'on';
      continue;
    }
    if (empty) {
      if (f.required) throw new Error(`"${f.label}" is required`);
      out[f.id] = null;
      continue;
    }
    if (f.type === 'number' || f.type === 'slider') {
      const n = typeof v === 'number' ? v : Number(v);
      if (!Number.isFinite(n)) throw new Error(`"${f.label}" must be a number`);
      if (f.min !== undefined && n < f.min) throw new Error(`"${f.label}" must be at least ${f.min}`);
      if (f.max !== undefined && n > f.max) throw new Error(`"${f.label}" must be at most ${f.max}`);
      out[f.id] = n;
    } else if (f.type === 'select') {
      const allowed = (f.options ?? []).map((o) => (typeof o === 'string' ? o : o.value));
      if (!allowed.includes(String(v))) throw new Error(`"${f.label}" must be one of ${allowed.join(', ')}`);
      out[f.id] = String(v);
    } else {
      const t = String(v);
      if (t.length > 5000) throw new Error(`"${f.label}" is too long`);
      out[f.id] = t;
    }
  }
  return out;
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
