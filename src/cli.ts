#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { RemoteApi, type ScreenApi } from './api.js';
import { hooksSnippet, mergeHooks, runHook } from './hook.js';
import { fileURLToPath } from 'node:url';
import { readHubInfo, startHub, VERSION, type Hub } from './hub.js';
import { createScreenServer } from './mcp.js';
import { runWrap } from './wrap.js';

const HELP = `mcp-screen ${VERSION} - a screen for terminal agents

Usage:
  mcp-screen                     stdio MCP server + local canvas (what Claude Code runs)
  mcp-screen wrap -- <cmd...>    proxy another MCP server and render its MCP Apps (ui://) on the canvas
  mcp-screen serve               canvas only, no MCP (keep it open in a tab)
  mcp-screen hook                Claude Code hook entry (Stop / SubagentStop / PostToolUse), reads stdin
  mcp-screen install-hooks [--write] [--local]  print (or merge into ./.claude/settings.json) the hook config

Options:
  --port <n>    canvas port (default 4747, env MCP_SCREEN_PORT)
  --no-open     don't open the browser (env MCP_SCREEN_NO_OPEN=1)

Install in Claude Code:  claude mcp add screen -- npx mcp-screen`;

const log = (...a: unknown[]): void => console.error('[mcp-screen]', ...a);

function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
  } catch {
    /* no browser available */
  }
}

/** When the agent goes away (stdin closes) shut down, so the canvas port doesn't linger. */
function exitWithParent(hub: Hub | null): void {
  const bye = (): void => {
    void (hub ? hub.close() : Promise.resolve()).finally(() => process.exit(0));
  };
  process.stdin.on('end', bye);
  process.stdin.on('close', bye);
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}

/** Start the hub, or attach to one another session already started. */
async function getApi(port: number, open: boolean): Promise<{ api: ScreenApi; hub: Hub | null }> {
  try {
    const hub = await startHub({ port });
    log(`canvas at ${hub.url}`);
    if (open) openBrowser(hub.url);
    return { api: hub.api, hub };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
    const info = readHubInfo();
    if (!info || info.port !== port) throw new Error(`port ${port} is in use by something else; pass --port`);
    const api = new RemoteApi(`http://127.0.0.1:${info.port}`, info.token);
    await api.readCanvas();
    log(`attached to the canvas already running at ${api.url}`);
    return { api, hub: null };
  }
}

async function main(argv: string[]): Promise<void> {
  const dash = argv.indexOf('--');
  const own = dash >= 0 ? argv.slice(0, dash) : argv;
  const rest = dash >= 0 ? argv.slice(dash + 1) : [];
  const portIdx = own.indexOf('--port');
  const port = Number(portIdx >= 0 ? own[portIdx + 1] : (process.env.MCP_SCREEN_PORT ?? 4747));
  const open = !own.includes('--no-open') && !process.env.MCP_SCREEN_NO_OPEN;
  const cmd = own.find((a, i) => !a.startsWith('-') && own[i - 1] !== '--port');

  if (own.includes('--help') || own.includes('-h')) return void console.log(HELP);
  if (own.includes('--version')) return void console.log(VERSION);

  switch (cmd) {
    case 'hook': {
      const chunks: Buffer[] = [];
      for await (const c of process.stdin) chunks.push(c as Buffer);
      await runHook(Buffer.concat(chunks).toString('utf8'));
      return;
    }
    case 'install-hooks': {
      // --local: point hooks at this checkout (for development) instead of the npm package
      const snippet = hooksSnippet(own.includes('--local') ? `node ${JSON.stringify(fileURLToPath(import.meta.url))} hook` : undefined);
      if (!own.includes('--write')) return void console.log(JSON.stringify(snippet, null, 2));
      const file = path.join(process.cwd(), '.claude', 'settings.json');
      const cur = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>) : {};
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(mergeHooks(cur, snippet), null, 2) + '\n');
      return void console.log(`mcp-screen hooks merged into ${file}`);
    }
    case 'serve': {
      const hub = await startHub({ port });
      console.log(`mcp-screen canvas at ${hub.url}`);
      if (open) openBrowser(hub.url);
      const stop = (): void => void hub.close().then(() => process.exit(0));
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      return;
    }
    case 'wrap': {
      const { api, hub } = await getApi(port, open);
      const server = await runWrap(rest, api, hub);
      await server.connect(new StdioServerTransport());
      exitWithParent(hub);
      log(`wrapping: ${rest.join(' ')}`);
      return;
    }
    case undefined: {
      const { api, hub } = await getApi(port, open);
      await createScreenServer(api).connect(new StdioServerTransport());
      exitWithParent(hub);
      return;
    }
    default:
      console.error(`unknown command ${cmd}\n\n${HELP}`);
      process.exit(2);
  }
}

main(process.argv.slice(2)).catch((err: unknown) => {
  log((err as Error).message);
  process.exit(1);
});
