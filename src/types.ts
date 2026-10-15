export type WidgetKind =
  | 'markdown'
  | 'table'
  | 'chart'
  | 'metric'
  | 'kv'
  | 'text'
  | 'status-list'
  | 'mcp-app'
  | 'question'
  | 'livemap';

/** Where a live widget pulls fresh data from. Refreshed server-side, no LLM involved. */
export type WidgetSource =
  | { type: 'command'; argv: string[]; cwd?: string; parse?: 'json' | 'text' }
  | { type: 'url'; url: string; parse?: 'json' | 'text' }
  | { type: 'mcp'; tool: string; arguments?: Record<string, unknown> };

export type LiveStatus = 'static' | 'needs-approval' | 'live' | 'error' | 'denied';

export interface Widget {
  id: string;
  kind: WidgetKind;
  title: string;
  data: Record<string, unknown>;
  /** Grid span hints, 1-4 columns, 1-4 rows. */
  w: number;
  h: number;
  source?: WidgetSource;
  intervalMs?: number;
  status: LiveStatus;
  error?: string;
  lastRefreshedAt?: string;
  /** What the human selected / the app reported back. Readable by the agent via read_widget. */
  selection?: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface FileChange {
  path: string;
  added?: number;
  removed?: number;
}

export interface TestResult {
  status: 'pass' | 'fail' | 'unknown';
  passed?: number;
  failed?: number;
  command?: string;
}

export interface Report {
  id: string;
  agent: string;
  worktree: string;
  branch?: string;
  summary: string;
  filesChanged: FileChange[];
  tests: TestResult;
  risks: string[];
  source: 'tool' | 'stop-hook' | 'subagent-stop-hook';
  sessionId?: string;
  at: string;
}

export interface FileEvent {
  path: string;
  cwd?: string;
  agent: string;
  tool?: string;
  /** What the agent did to the file. Defaults to 'edit'. */
  action?: FileAction;
  at?: string;
}

export type FileAction = 'read' | 'edit' | 'create';

export interface Activity {
  widgetId: string;
  nodeIds: string[];
  agent: string;
  color: string;
  path: string;
  action: FileAction;
  at: string;
}

export type ScreenEvent =
  | { type: 'widget'; widget: Widget }
  | { type: 'remove'; id: string }
  | { type: 'report'; report: Report }
  | { type: 'activity'; activity: Activity }
  | { type: 'cleared'; count: number; undoable: boolean }
  | { type: 'restored'; count: number };
