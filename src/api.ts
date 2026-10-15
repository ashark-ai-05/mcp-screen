import { validateSource } from './refresh.js';
import type { RefreshScheduler } from './refresh.js';
import type { AskInput, AskResult, CanvasStore, FormInput, FormResult, PlaceInput, ReportInput, UpdateInput } from './store.js';
import type { Activity, FileEvent, Report, Widget } from './types.js';

/** Everything the MCP tools and hooks need. Implemented in-process or over HTTP to a running hub. */
export interface ScreenApi {
  place(input: PlaceInput): Promise<Widget>;
  update(id: string, patch: UpdateInput): Promise<Widget>;
  read(id: string): Promise<unknown>;
  readCanvas(): Promise<unknown>;
  remove(id: string): Promise<boolean>;
  postReport(input: ReportInput): Promise<Report>;
  fileEvent(ev: FileEvent): Promise<Activity[]>;
  clear(): Promise<{ removed: number }>;
  undoClear(): Promise<{ restored: number }>;
  /** Blocks until the human answers, the timeout passes, or `signal` aborts. */
  ask(input: AskInput): Promise<AskResult>;
  /** Blocks until the human submits the form, the timeout passes, or `signal` aborts. */
  askForm(input: FormInput): Promise<FormResult>;
  tidy(columns?: number): Promise<Array<{ id: string; x: number; y: number }>>;
  replyAnnotation(id: string, text: string): Promise<unknown>;
  listCanvases(): Promise<unknown>;
  openCanvas(id: string, title?: string): Promise<unknown>;
  pendingQuestions(): Promise<unknown>;
  /** Optional canvas id for the next place/read/clear/tidy (agent project). */
  useCanvas?(id: string | undefined): void;
  readonly defaultCanvas?: string;
  readonly url: string;
}

export class LocalApi implements ScreenApi {
  private canvasHint: string | undefined;
  constructor(
    private readonly store: CanvasStore,
    private readonly scheduler: RefreshScheduler,
    readonly url: string,
    private readonly book?: import('./canvases.js').CanvasBook,
    private readonly agentDefault?: string,
  ) {}
  useCanvas(id: string | undefined): void { this.canvasHint = id; }
  /** The canvas this MCP session writes to when a tool omits `canvas`. */
  get defaultCanvas(): string | undefined { return this.agentDefault; }
  private target(switchTo = true): CanvasStore {
    if (!this.book) return this.store;
    const id = this.canvasHint;
    if (!id) return this.book.active;
    this.book.ensure(id);
    if (switchTo && id !== this.book.activeCanvasId) this.book.setActive(id);
    return this.book.store(id);
  }
  async place(input: PlaceInput): Promise<Widget> {
    if (input.source) validateSource(input.source);
    const store = this.target();
    const w = store.place(input);
    this.scheduler.register(w, store);
    return store.get(w.id) ?? w;
  }
  async update(id: string, patch: UpdateInput): Promise<Widget> {
    return this.target().update(id, patch);
  }
  async read(id: string): Promise<unknown> {
    return this.target(false).read(id);
  }
  async readCanvas(): Promise<unknown> {
    const store = this.target(false);
    const canvas = this.book?.activeCanvasId;
    const base = store.readCanvas() as Record<string, unknown>;
    return { ...base, canvas, canvases: this.book?.list() ?? [] };
  }
  async remove(id: string): Promise<boolean> {
    return this.target().remove(id);
  }
  async postReport(input: ReportInput): Promise<Report> {
    return this.target().postReport(input);
  }
  async fileEvent(ev: FileEvent): Promise<Activity[]> {
    return this.target().fileEvent(ev);
  }
  async clear(): Promise<{ removed: number }> {
    return this.target().clear();
  }
  async undoClear(): Promise<{ restored: number }> {
    const back = this.target().undoClear();
    for (const w of back) this.scheduler.register(w);
    return { restored: back.length };
  }
  async ask(input: AskInput): Promise<AskResult> {
    return this.target().ask(input).result;
  }
  async askForm(input: FormInput): Promise<FormResult> {
    return this.target().askForm(input).result;
  }
  async replyAnnotation(id: string, text: string) {
    return this.target().replyAnnotation(id, text, 'agent');
  }
  async tidy(columns?: number) {
    return this.target().tidy(columns);
  }
  async listCanvases() {
    return this.book?.list() ?? [{ id: 'default', title: 'default', updatedAt: new Date().toISOString(), widgets: this.store.list().length, annotations: this.store.listAnnotations().length, active: true }];
  }
  async openCanvas(id: string, title?: string) {
    if (!this.book) throw new Error('named canvases are not available');
    return this.book.setActive(id, title);
  }
  async pendingQuestions() {
    return this.book?.pendingAcross() ?? this.store.pendingQuestions().map((q) => ({ canvas: 'default', title: 'default', ...q }));
  }
}

export class RemoteApi implements ScreenApi {
  constructor(
    readonly url: string,
    private readonly token: string,
  ) {}
  private canvasHint: string | undefined;
  defaultCanvas: string | undefined;
  useCanvas(id: string | undefined): void { this.canvasHint = id; }
  private async call<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const headers: Record<string, string> = { 'content-type': 'application/json', 'x-mcp-screen-token': this.token };
    if (this.canvasHint) headers['x-mcp-screen-canvas'] = this.canvasHint;
    const init: RequestInit = {
      method,
      headers,
      signal: signal ?? AbortSignal.timeout(10_000),
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await fetch(`${this.url}${path}`, init);
    const json = (await res.json()) as { error?: string; result?: T };
    if (!res.ok) throw new Error(json.error ?? `hub returned HTTP ${res.status}`);
    return json.result as T;
  }
  place(input: PlaceInput) {
    return this.call<Widget>('POST', '/api/widgets', input);
  }
  update(id: string, patch: UpdateInput) {
    return this.call<Widget>('PATCH', `/api/widgets/${encodeURIComponent(id)}`, patch);
  }
  read(id: string) {
    return this.call<unknown>('GET', `/api/widgets/${encodeURIComponent(id)}`);
  }
  readCanvas() {
    return this.call<unknown>('GET', '/api/canvas');
  }
  remove(id: string) {
    return this.call<boolean>('DELETE', `/api/widgets/${encodeURIComponent(id)}`);
  }
  postReport(input: ReportInput) {
    return this.call<Report>('POST', '/api/reports', input);
  }
  fileEvent(ev: FileEvent) {
    return this.call<Activity[]>('POST', '/api/file-events', ev);
  }
  clear() {
    return this.call<{ removed: number }>('POST', '/api/canvas/clear', {});
  }
  undoClear() {
    return this.call<{ restored: number }>('POST', '/api/canvas/undo', {});
  }
  replyAnnotation(id: string, text: string) {
    return this.call<unknown>('POST', `/api/annotations/${encodeURIComponent(id)}/reply`, { text, from: 'agent' });
  }
  tidy(columns?: number) {
    return this.call<Array<{ id: string; x: number; y: number }>>('POST', '/api/canvas/tidy', columns === undefined ? {} : { columns });
  }
  listCanvases() { return this.call('GET', '/api/canvases'); }
  openCanvas(id: string) { return this.call('POST', `/api/canvases/${encodeURIComponent(id)}/open`, {}); }
  pendingQuestions() { return this.call('GET', '/api/pending-questions'); }
  async askForm(input: FormInput): Promise<FormResult> {
    const { signal, ...body } = input;
    const timeout = AbortSignal.timeout((body.timeoutMs ?? 180_000) + 10_000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      return await this.call<FormResult>('POST', '/api/ask-form', body, combined);
    } catch (err) {
      if (signal?.aborted) return { submitted: false, reason: 'cancelled', widgetId: '' };
      throw err;
    }
  }
  async ask(input: AskInput): Promise<AskResult> {
    const { signal, ...body } = input;
    // Long request: the hub holds it open until the human answers. Closing it cancels the question.
    const timeout = AbortSignal.timeout((body.timeoutMs ?? 180_000) + 10_000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      return await this.call<AskResult>('POST', '/api/ask', body, combined);
    } catch (err) {
      if (signal?.aborted) return { answered: false, reason: 'cancelled', widgetId: '' };
      throw err;
    }
  }
}
