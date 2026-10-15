import { validateSource } from './refresh.js';
import type { RefreshScheduler } from './refresh.js';
import type { AskInput, AskResult, CanvasStore, PlaceInput, ReportInput, UpdateInput } from './store.js';
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
  readonly url: string;
}

export class LocalApi implements ScreenApi {
  constructor(
    private readonly store: CanvasStore,
    private readonly scheduler: RefreshScheduler,
    readonly url: string,
  ) {}
  async place(input: PlaceInput): Promise<Widget> {
    if (input.source) validateSource(input.source);
    const w = this.store.place(input);
    this.scheduler.register(w);
    return this.store.get(w.id) ?? w;
  }
  async update(id: string, patch: UpdateInput): Promise<Widget> {
    return this.store.update(id, patch);
  }
  async read(id: string): Promise<unknown> {
    return this.store.read(id);
  }
  async readCanvas(): Promise<unknown> {
    return this.store.readCanvas();
  }
  async remove(id: string): Promise<boolean> {
    return this.store.remove(id);
  }
  async postReport(input: ReportInput): Promise<Report> {
    return this.store.postReport(input);
  }
  async fileEvent(ev: FileEvent): Promise<Activity[]> {
    return this.store.fileEvent(ev);
  }
  async clear(): Promise<{ removed: number }> {
    return this.store.clear();
  }
  async undoClear(): Promise<{ restored: number }> {
    const back = this.store.undoClear();
    for (const w of back) this.scheduler.register(w);
    return { restored: back.length };
  }
  async ask(input: AskInput): Promise<AskResult> {
    return this.store.ask(input).result;
  }
}

export class RemoteApi implements ScreenApi {
  constructor(
    readonly url: string,
    private readonly token: string,
  ) {}
  private async call<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const init: RequestInit = {
      method,
      headers: { 'content-type': 'application/json', 'x-mcp-screen-token': this.token },
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
