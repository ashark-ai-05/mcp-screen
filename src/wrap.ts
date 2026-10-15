import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type { ScreenApi } from './api.js';
import type { Hub } from './hub.js';
import { VERSION } from './hub.js';
import { callScreenTool, SCREEN_TOOLS, toolExtra, type ToolExtra } from './mcp.js';

export const UI_MIME = 'text/html;profile=mcp-app';

/** Where a tool declares its MCP Apps UI: `_meta.ui.resourceUri` (current) or `_meta["ui/resourceUri"]` (legacy). */
export function uiResourceUri(tool: Pick<Tool, '_meta'>): string | undefined {
  const meta = (tool._meta ?? {}) as Record<string, unknown>;
  const ui = meta.ui as { resourceUri?: unknown } | undefined;
  const uri = typeof ui?.resourceUri === 'string' ? ui.resourceUri : meta['ui/resourceUri'];
  return typeof uri === 'string' && uri.startsWith('ui://') ? uri : undefined;
}

export interface UpstreamLike {
  listTools(): Promise<{ tools: Tool[] }>;
  callTool(p: { name: string; arguments?: Record<string, unknown> }): Promise<unknown>;
  readResource(p: { uri: string }): Promise<{ contents: Array<{ uri: string; mimeType?: string; text?: string; blob?: string; _meta?: Record<string, unknown> }> }>;
  listResources?(): Promise<unknown>;
}

/** Fetch a ui:// resource and return its HTML plus any declared CSP. */
export async function loadUiResource(upstream: UpstreamLike, uri: string): Promise<{ html: string; csp?: unknown }> {
  const res = await upstream.readResource({ uri });
  const c = res.contents.find((x) => x.uri === uri) ?? res.contents[0];
  if (!c) throw new Error(`resource ${uri} returned no contents`);
  const html = c.text ?? (c.blob ? Buffer.from(c.blob, 'base64').toString('utf8') : '');
  if (!html) throw new Error(`resource ${uri} has no HTML`);
  const meta = (c._meta ?? {}) as { ui?: { csp?: unknown } };
  return meta.ui?.csp ? { html, csp: meta.ui.csp } : { html };
}

/**
 * The proxy core: forwards a tool call upstream and, when the tool ships an
 * MCP Apps UI, places it on the canvas as an `mcp-app` widget.
 */
export class WrapProxy {
  private tools = new Map<string, Tool>();
  constructor(
    private readonly upstream: UpstreamLike,
    private readonly api: ScreenApi,
  ) {}

  async listTools(): Promise<Tool[]> {
    const { tools } = await this.upstream.listTools();
    this.tools = new Map(tools.map((t) => [t.name, t]));
    const ours = SCREEN_TOOLS.filter((t) => !this.tools.has(t.name));
    return [...tools, ...ours];
  }

  async callTool(name: string, args: Record<string, unknown>, extra: ToolExtra = {}): Promise<CallToolResult> {
    if (!this.tools.has(name)) {
      const screen = await callScreenTool(this.api, name, args, extra);
      if (screen) return screen;
      await this.listTools();
    }
    const tool = this.tools.get(name);
    const result = (await this.upstream.callTool({ name, arguments: args })) as CallToolResult;
    const uri = tool ? uiResourceUri(tool) : undefined;
    if (!uri) return result;
    try {
      const { html, csp } = await loadUiResource(this.upstream, uri);
      const w = await this.api.place({
        kind: 'mcp-app',
        title: tool?.title ?? tool?.annotations?.title ?? name,
        data: { html, csp, resourceUri: uri, toolName: name, toolDef: tool, toolInput: args, toolResult: result },
      });
      return {
        ...result,
        content: [...(result.content ?? []), { type: 'text', text: `[mcp-screen] Rendered ${uri} on ${this.api.url} as widget ${w.id}.` }],
      };
    } catch (err) {
      return {
        ...result,
        content: [...(result.content ?? []), { type: 'text', text: `[mcp-screen] Could not render ${uri}: ${(err as Error).message}` }],
      };
    }
  }
}

export async function runWrap(command: string[], api: ScreenApi, hub: Hub | null): Promise<Server> {
  const [cmd, ...args] = command;
  if (!cmd) throw new Error('usage: mcp-screen wrap -- <command> [args...]');
  const client = new Client({ name: 'mcp-screen', version: VERSION });
  await client.connect(new StdioClientTransport({ command: cmd, args, stderr: 'inherit' }));
  const upstream = client as unknown as UpstreamLike;
  const proxy = new WrapProxy(upstream, api);

  if (hub) {
    hub.setAppCallHandler(async (_id, method, params) => {
      if (method === 'tools/call') return client.callTool(params as { name: string; arguments?: Record<string, unknown> });
      return client.readResource(params as { uri: string });
    });
    hub.scheduler.setMcpCaller((tool, a) => client.callTool({ name: tool, arguments: a }));
  }

  const caps = client.getServerCapabilities() ?? {};
  const server = new Server(
    { name: 'mcp-screen', version: VERSION },
    { capabilities: { tools: {}, ...(caps.resources ? { resources: {} } : {}) } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await proxy.listTools() }));
  server.setRequestHandler(CallToolRequestSchema, async (req, extra) =>
    proxy.callTool(req.params.name, req.params.arguments ?? {}, toolExtra(req.params._meta?.progressToken, extra)),
  );
  if (caps.resources) {
    server.setRequestHandler(ListResourcesRequestSchema, async (req) => client.listResources(req.params));
    server.setRequestHandler(ReadResourceRequestSchema, async (req) => client.readResource(req.params));
  }
  return server;
}
