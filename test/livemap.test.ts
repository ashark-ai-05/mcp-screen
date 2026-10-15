import { describe, expect, it } from 'vitest';
import { agentColor, autoLayers, matchNodes, toRepoPath } from '../src/livemap.js';
import { CanvasStore } from '../src/store.js';
import type { Activity } from '../src/types.js';

const map = {
  root: '/repo',
  nodes: [
    { id: 'cli', label: 'CLI', globs: ['src/cli.ts'] },
    { id: 'hub', label: 'Hub', globs: ['src/hub.ts', 'src/api.ts'] },
    { id: 'ui', label: 'Browser UI', globs: ['public/**'] },
    { id: 'tests', label: 'Tests', globs: ['test/**/*.test.ts'] },
  ],
  edges: [
    { from: 'cli', to: 'hub' },
    { from: 'hub', to: 'ui' },
  ],
};

describe('livemap', () => {
  it('maps absolute and relative paths onto glob nodes', () => {
    expect(toRepoPath('/repo/src/hub.ts', '/repo', undefined)).toBe('src/hub.ts');
    expect(toRepoPath('./public/app.js', undefined, '/x')).toBe('public/app.js');
    expect(matchNodes(map.nodes, 'src/api.ts')).toEqual(['hub']);
    expect(matchNodes(map.nodes, 'public/deep/x.css')).toEqual(['ui']);
    expect(matchNodes(map.nodes, 'README.md')).toEqual([]);
    expect(matchNodes(map.nodes, '../other/src/hub.ts')).toEqual([]);
  });

  it('lays nodes out in layers following edges', () => {
    const l = autoLayers(map.nodes, map.edges);
    expect([l.get('cli'), l.get('hub'), l.get('ui'), l.get('tests')]).toEqual([0, 1, 2, 0]);
    const s = new CanvasStore();
    const w = s.place({ kind: 'livemap', title: 'Arch', data: map });
    const layout = w.data.layout as Record<string, { x: number; y: number }>;
    expect(layout.hub!.y).toBeGreaterThan(layout.cli!.y);
    expect(layout.ui!.y).toBeGreaterThan(layout.hub!.y);
  });

  it('lights up nodes on file events with a stable per-agent colour, and tracks unmapped files', () => {
    const s = new CanvasStore();
    const w = s.place({ id: 'arch', kind: 'livemap', title: 'Arch', data: map });
    const seen: Activity[] = [];
    s.bus.on((e) => e.type === 'activity' && seen.push(e.activity));
    s.fileEvent({ path: '/repo/src/hub.ts', agent: 'claude-a' });
    s.fileEvent({ path: 'public/app.css', cwd: '/repo', agent: 'subagent-b' });
    s.fileEvent({ path: '/repo/docs/new-module.md', agent: 'claude-a' });
    expect(seen.map((a) => a.nodeIds)).toEqual([['hub'], ['ui']]);
    expect(seen[0]!.color).toBe(agentColor('claude-a'));
    expect(agentColor('claude-a')).toBe(agentColor('claude-a'));
    expect(s.read(w.id).unmappedFiles).toEqual(['docs/new-module.md']);
    expect(s.recentActivity()).toHaveLength(2);
  });

  it('rejects maps without globs', () => {
    const s = new CanvasStore();
    expect(() => s.place({ kind: 'livemap', title: 'x', data: { nodes: [{ id: 'a', label: 'A', globs: [] }] } })).toThrow(/globs/);
  });
});
