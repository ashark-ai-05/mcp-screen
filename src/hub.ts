import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalApi } from './api.js';
import { CanvasBook, defaultCanvasFrom } from './canvases.js';
import { AllowList, describeSource, RefreshScheduler, type Runners } from './refresh.js';
import { readImage } from './images.js';
import { CanvasStore, type AnnotationInput, type AskInput, type FormInput } from './store.js';

type AskInputBody = Omit<AskInput, 'signal'>;
type FormInputBody = Omit<FormInput, 'signal'>;
import type { ScreenEvent, Widget } from './types.js';

export const VERSION = '0.1.0';
const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function screenHome(): string {
  return process.env.MCP_SCREEN_HOME ?? path.join(os.homedir(), '.mcp-screen');
}

export interface HubInfo {
  port: number;
  token: string;
  pid: number;
}

export type AppCallHandler = (widgetId: string, method: string, params: Record<string, unknown>) => Promise<unknown>;

export interface HubOptions {
  port?: number;
  host?: string;
  home?: string | null;
  /** Save canvases under <home>/canvases/ and restore on start (default true when home is set). */
  persist?: boolean;
  /** Override the default canvas name (otherwise derived from the git root / MCP_SCREEN_CANVAS). */
  canvas?: string;
  runners?: Partial<Runners>;
  token?: string;
}

export interface Hub {
  store: CanvasStore;
  book: CanvasBook;
  scheduler: RefreshScheduler;
  api: LocalApi;
  url: string;
  port: number;
  token: string;
  setAppCallHandler(h: AppCallHandler): void;
  close(): Promise<void>;
}

const MAX_BODY = 2 * 1024 * 1024;
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** A per-widget nonce lets the sandboxed frame load its HTML without ever seeing the API token. */
const frameNonces = new WeakMap<Widget, string>();

export async function startHub(opts: HubOptions = {}): Promise<Hub> {
  const home = opts.home === undefined ? screenHome() : opts.home;
  const token = opts.token ?? randomBytes(24).toString('hex');
  const persist = opts.persist !== false && process.env.MCP_SCREEN_NO_PERSIST !== '1';
  const seed = opts.canvas ? { id: opts.canvas, title: opts.canvas } : defaultCanvasFrom();
  const book = new CanvasBook({ home, persist: !!(home && persist), seed });
  // `store` is always the active canvas; the browser and most hub routes use it.
  const storeOf = (): CanvasStore => book.active;
  let store = storeOf();
  const allow = new AllowList(home ? path.join(home, 'allowlist.json') : null);
  const scheduler = new RefreshScheduler(store, allow, opts.runners);
  book.bus.on((e) => {
    if (e.type === 'canvas-switch') {
      store = storeOf();
      scheduler.watch(store);
    }
  });
  // watch every canvas already known so removals stop timers
  for (const c of book.list()) scheduler.watch(book.store(c.id));
  let appCall: AppCallHandler | undefined;
  const nonceFor = (w: Widget): string => {
    let n = frameNonces.get(w);
    if (!n) {
      n = randomBytes(16).toString('hex');
      frameNonces.set(w, n);
    }
    return n;
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      const status = err instanceof HttpError ? err.status : 400;
      send(res, status, { error: (err as Error).message });
    });
  });

  const decorate = (w: Widget): Widget & { sourceLabel?: string; frameNonce?: string; imageSrc?: string } => {
    const out: Widget & { sourceLabel?: string; frameNonce?: string; imageSrc?: string } = { ...w };
    if (w.source) out.sourceLabel = describeSource(w.source);
    if (w.kind === 'image') {
      const real = store.get(w.id);
      // Local files go through /img with a per-widget nonce; the browser never learns the path's bytes any other way.
      if (typeof w.data.path === 'string' && real) out.imageSrc = `/img/${encodeURIComponent(w.id)}?n=${nonceFor(real)}&v=${encodeURIComponent(w.updatedAt)}`;
      else if (typeof w.data.url === 'string') out.imageSrc = w.data.url;
    }
    if (w.kind === 'mcp-app') {
      const real = store.get(w.id);
      if (real) out.frameNonce = nonceFor(real);
      // The browser loads the HTML through /frame, never inline.
      out.data = { ...w.data, html: undefined };
    }
    return out;
  };
  const decorateEvent = (e: ScreenEvent): ScreenEvent => {
    if (e.type === 'widget') return { type: 'widget', widget: decorate(e.widget) };
    if (e.type === 'canvas-switch') return { ...e, widgets: e.widgets.map((w) => decorate(w)) };
    return e;
  };

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const hostname = (req.headers.host ?? '').replace(/:\d+$/, '');
    if (!ALLOWED_HOSTS.has(hostname)) throw new HttpError(403, 'bad host header (DNS rebinding protection)');
    const url = new URL(req.url ?? '/', 'http://localhost');
    const p = url.pathname;

    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8').replace('__MCP_SCREEN_TOKEN__', token);
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-security-policy':
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; frame-src 'self'; connect-src 'self'; frame-ancestors 'none'",
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      });
      res.end(html);
      return;
    }
    if (req.method === 'GET' && /^\/(fonts\/)?[\w-]+\.(js|css|svg|woff2|json)$/.test(p)) {
      const file = path.join(PUBLIC_DIR, p.slice(1));
      if (!fs.existsSync(file)) throw new HttpError(404, 'not found');
      const ext = p.slice(p.lastIndexOf('.') + 1);
      const type = { js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', svg: 'image/svg+xml', woff2: 'font/woff2', json: 'application/json' }[ext];
      res.writeHead(200, { 'content-type': type ?? 'application/octet-stream', 'x-content-type-options': 'nosniff', 'cache-control': ext === 'woff2' ? 'max-age=86400' : 'no-cache' });
      res.end(fs.readFileSync(file));
      return;
    }
    const img = /^\/img\/([\w.-]+)$/.exec(p);
    if (req.method === 'GET' && img) {
      const w = store.get(decodeURIComponent(img[1] as string));
      if (!w || w.kind !== 'image' || typeof w.data.path !== 'string' || url.searchParams.get('n') !== nonceFor(w)) throw new HttpError(404, 'not found');
      let file: { type: string; body: Buffer };
      try {
        file = readImage(w.data.path);
      } catch (err) {
        throw new HttpError(404, (err as Error).message);
      }
      res.writeHead(200, {
        'content-type': file.type,
        // An SVG opened directly must not run script in our origin.
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store',
        'content-disposition': 'inline',
      });
      res.end(file.body);
      return;
    }
    const frame = /^\/frame\/([\w.-]+)$/.exec(p);
    if (req.method === 'GET' && frame) {
      const w = store.get(decodeURIComponent(frame[1] as string));
      if (!w || w.kind !== 'mcp-app' || url.searchParams.get('n') !== nonceFor(w)) throw new HttpError(404, 'not found');
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': frameCsp(w.data.csp),
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'cache-control': 'no-store',
      });
      res.end(String(w.data.html));
      return;
    }

    if (!p.startsWith('/api/')) throw new HttpError(404, 'not found');
    const supplied = req.headers['x-mcp-screen-token'] ?? (p === '/api/events' ? url.searchParams.get('token') : null);
    if (supplied !== token) throw new HttpError(401, 'missing or bad token');

    if (req.method === 'GET' && p === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`);
      const sub = book.bus.subscribe();
      const ping = setInterval(() => res.write(': ping\n\n'), 15000);
      req.on('close', () => {
        clearInterval(ping);
        sub.close();
      });
      for await (const e of sub) res.write(`data: ${JSON.stringify(decorateEvent(e))}\n\n`);
      return;
    }
    if (req.method === 'GET' && p === '/api/state') return send(res, 200, { result: snapshot() });
    if (req.method === 'GET' && p === '/api/canvas') return send(res, 200, { result: { ...store.readCanvas() as object, canvas: book.activeCanvasId, canvases: book.list() } });
    if (req.method === 'GET' && p === '/api/canvases') return send(res, 200, { result: book.list() });
    if (req.method === 'GET' && p === '/api/pending-questions') return send(res, 200, { result: book.pendingAcross() });
    if (req.method === 'GET' && p === '/api/allowlist') return send(res, 200, { result: allow.list() });

    const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readJson(req);
    // agent (or UI) can name a canvas per request
    const canvasHdr = req.headers['x-mcp-screen-canvas'];
    const canvasBody = typeof (body as { canvas?: unknown }).canvas === 'string' ? (body as { canvas: string }).canvas : undefined;
    const canvasName = (typeof canvasHdr === 'string' && canvasHdr) || canvasBody;
    if (canvasName) api.useCanvas?.(canvasName);
    else api.useCanvas?.(undefined);
    if (req.method === 'POST' && p === '/api/canvases') {
      const title = typeof (body as { title?: unknown }).title === 'string' ? (body as { title: string }).title : (canvasName || 'canvas');
      const id = typeof (body as { id?: unknown }).id === 'string' ? (body as { id: string }).id : title;
      book.ensure(id, title);
      return send(res, 200, { result: book.setActive(id) });
    }
    const open = /^\/api\/canvases\/([\w.-]+)\/open$/.exec(p);
    if (open && req.method === 'POST') return send(res, 200, { result: book.setActive(open[1] as string) });
    if (req.method === 'POST' && p === '/api/widgets') return send(res, 200, { result: await api.place(body as never) });
    if (req.method === 'POST' && p === '/api/reports') return send(res, 200, { result: store.postReport(body as never) });
    if (req.method === 'POST' && p === '/api/file-events') return send(res, 200, { result: store.fileEvent(body as never) });
    if (req.method === 'POST' && p === '/api/canvas/clear') return send(res, 200, { result: await api.clear() });
    if (req.method === 'POST' && p === '/api/canvas/undo') return send(res, 200, { result: await api.undoClear() });
    if (req.method === 'POST' && p === '/api/canvas/tidy') return send(res, 200, { result: await api.tidy(typeof (body as { columns?: unknown })?.columns === 'number' ? (body as { columns: number }).columns : undefined) });
    if (req.method === 'POST' && p === '/api/annotations') return send(res, 200, { result: store.annotate(body as AnnotationInput) });
    if (req.method === 'POST' && p === '/api/annotations/undo') return send(res, 200, { result: store.undoAnnotation() });
    const ann = /^\/api\/annotations\/([\w.-]+)$/.exec(p);
    if (ann && req.method === 'DELETE') return send(res, 200, { result: store.removeAnnotation(ann[1] as string) });
    const rep = /^\/api\/annotations\/([\w.-]+)\/reply$/.exec(p);
    if (rep && req.method === 'POST') {
      const b = body as { text?: unknown; from?: unknown };
      return send(res, 200, { result: store.replyAnnotation(rep[1] as string, typeof b.text === 'string' ? b.text : '', b.from === 'human' ? 'human' : 'agent') });
    }
    if (ann && req.method === 'PATCH') return send(res, 200, { result: store.updateAnnotation(ann[1] as string, body as { text?: string }) });
    if (req.method === 'POST' && p === '/api/ask-form') {
      const ctrl = new AbortController();
      res.on('close', () => {
        if (!res.writableFinished) ctrl.abort();
      });
      return send(res, 200, { result: await api.askForm({ ...(body as FormInputBody), signal: ctrl.signal }) });
    }
    if (req.method === 'POST' && p === '/api/ask') {
      const ctrl = new AbortController();
      res.on('close', () => {
        if (!res.writableFinished) ctrl.abort();
      });
      const result = await api.ask({ ...(body as AskInputBody), signal: ctrl.signal });
      return send(res, 200, { result });
    }

    const m = /^\/api\/widgets\/([^/]+)(?:\/(selection|approve|deny|revoke|refresh|call|answer|submit|move))?$/.exec(p);
    if (!m) throw new HttpError(404, 'not found');
    const id = decodeURIComponent(m[1] as string);
    const action = m[2];
    if (!action) {
      if (req.method === 'GET') return send(res, 200, { result: store.read(id) });
      if (req.method === 'PATCH') return send(res, 200, { result: store.update(id, body as never) });
      if (req.method === 'DELETE') return send(res, 200, { result: store.remove(id) });
    }
    if (req.method !== 'POST') throw new HttpError(405, 'method not allowed');
    switch (action) {
      case 'submit':
        return send(res, 200, { result: store.submitForm(id, ((body as { values?: unknown }).values ?? {}) as Record<string, unknown>) });
      case 'move': {
        const { x, y } = body as { x?: unknown; y?: unknown };
        if (typeof x !== 'number' || typeof y !== 'number') throw new HttpError(400, 'move needs numeric x and y');
        return send(res, 200, { result: store.move(id, x, y) });
      }
      case 'answer':
        return send(res, 200, { result: store.answer(id, String((body as { choice?: unknown }).choice ?? '')) });
      case 'selection':
        return send(res, 200, { result: store.setSelection(id, (body as { selection?: unknown }).selection ?? null) });
      case 'approve':
        return send(res, 200, { result: scheduler.approve(id) });
      case 'deny':
        return send(res, 200, { result: scheduler.deny(id) });
      case 'revoke':
        return send(res, 200, { result: scheduler.revoke(id) });
      case 'refresh':
        return send(res, 200, { result: await scheduler.refreshNow(id) });
      case 'call': {
        const w = store.get(id);
        if (!w || w.kind !== 'mcp-app') throw new HttpError(404, 'no such app widget');
        if (!appCall) throw new HttpError(501, 'this canvas is not running `mcp-screen wrap`, so apps cannot call tools');
        const { method, params } = body as { method: string; params?: Record<string, unknown> };
        if (method !== 'tools/call' && method !== 'resources/read') throw new HttpError(400, `method ${method} not proxied`);
        return send(res, 200, { result: await appCall(id, method, params ?? {}) });
      }
    }
    throw new HttpError(404, 'not found');
  }

  function snapshot() {
    store = storeOf();
    return {
      version: VERSION,
      canvas: book.activeCanvasId,
      canvases: book.list(),
      widgets: store.list().map((w) => decorate(w.kind === 'livemap' ? { ...w, unmappedFiles: store.unmappedFor(w.id) } as Widget : w)),
      reports: store.listReports(),
      activity: store.recentActivity(),
      canUndoClear: store.canUndoClear(),
      annotations: store.listAnnotations(),
    };
  }

  const host = opts.host ?? '127.0.0.1';
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 4747, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}`;
  const api = new LocalApi(store, scheduler, url, book, seed.id);

  if (home && persist) {
    fs.mkdirSync(home, { recursive: true });
    await book.restoreAll((st) => new LocalApi(st, scheduler, url));
    process.once('exit', () => book.flush());
  }

  if (home) {
    fs.mkdirSync(home, { recursive: true });
    const info: HubInfo = { port, token, pid: process.pid };
    fs.writeFileSync(path.join(home, 'hub.json'), JSON.stringify(info), { mode: 0o600 });
  }

  return {
    get store() { return book.active; },
    book,
    scheduler,
    api,
    url,
    port,
    token,
    setAppCallHandler: (h) => {
      appCall = h;
    },
    close: async () => {
      book.stop();
      scheduler.stopAll();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      if (home) {
        try {
          const f = path.join(home, 'hub.json');
          const cur = JSON.parse(fs.readFileSync(f, 'utf8')) as HubInfo;
          if (cur.pid === process.pid && cur.port === port) fs.unlinkSync(f);
        } catch {
          /* ignore */
        }
      }
    },
  };
}

export function readHubInfo(home = screenHome()): HubInfo | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, 'hub.json'), 'utf8')) as HubInfo;
  } catch {
    return null;
  }
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return void res.end();
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  if (!(req.headers['content-type'] ?? '').includes('application/json')) throw new HttpError(415, 'expected application/json');
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'body too large');
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

/** CSP for an MCP App frame: inline code only, network limited to the domains the resource declared. */
export function frameCsp(csp: unknown): string {
  const c = (csp ?? {}) as { connectDomains?: unknown; resourceDomains?: unknown };
  const clean = (v: unknown): string =>
    (Array.isArray(v) ? v : [])
      .filter((d): d is string => typeof d === 'string' && /^https?:\/\/[\w.*:-]+(\/[\w./-]*)?$/.test(d))
      .join(' ');
  const res = clean(c.resourceDomains);
  const conn = clean(c.connectDomains);
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' ${res}`.trim(),
    `style-src 'unsafe-inline' ${res}`.trim(),
    `img-src data: blob: ${res}`.trim(),
    `font-src data: ${res}`.trim(),
    `media-src data: blob: ${res}`.trim(),
    conn ? `connect-src ${conn}` : "connect-src 'none'",
    "frame-ancestors 'self'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}
