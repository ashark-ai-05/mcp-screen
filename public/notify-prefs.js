// Notification mute / quiet hours. Pure helpers on McpScreenNotify so tests can load them outside the browser.
(function (root) {
  'use strict';
  const KEY = 'mcp-screen.notify';

  function load(storage) {
    try {
      const raw = JSON.parse((storage || localStorage).getItem(KEY) || '{}');
      return {
        muted: !!raw.muted,
        mutedCanvases: Array.isArray(raw.mutedCanvases) ? raw.mutedCanvases.map(String) : [],
        quietStart: Number.isFinite(raw.quietStart) ? raw.quietStart : null,
        quietEnd: Number.isFinite(raw.quietEnd) ? raw.quietEnd : null,
      };
    } catch {
      return { muted: false, mutedCanvases: [], quietStart: null, quietEnd: null };
    }
  }

  function save(prefs, storage) {
    (storage || localStorage).setItem(KEY, JSON.stringify(prefs));
  }

  /** Quiet window in local hours (0–24). Supports overnight (e.g. 22→7). */
  function inQuietHours(prefs, d) {
    if (prefs.quietStart == null || prefs.quietEnd == null) return false;
    const date = d || new Date();
    const h = date.getHours() + date.getMinutes() / 60;
    const a = prefs.quietStart, b = prefs.quietEnd;
    if (a === b) return true;
    return a < b ? h >= a && h < b : h >= a || h < b;
  }

  function shouldNotify(prefs, canvasId, opts) {
    const o = opts || {};
    if (prefs.muted) return false;
    if (canvasId && prefs.mutedCanvases.includes(canvasId)) return false;
    if (inQuietHours(prefs, o.now)) return false;
    if (o.permission != null && o.permission !== 'granted') return false;
    return true;
  }

  function summarize(prefs, canvasId) {
    if (prefs.muted) return 'Muted · all canvases';
    if (canvasId && prefs.mutedCanvases.includes(canvasId)) return `Muted · ${canvasId}`;
    if (prefs.quietStart != null && prefs.quietEnd != null) {
      const fmt = (n) => `${String(Math.floor(n)).padStart(2, '0')}:${String(Math.round((n % 1) * 60)).padStart(2, '0')}`;
      return `Quiet ${fmt(prefs.quietStart)}–${fmt(prefs.quietEnd)}`;
    }
    return 'Replies while this tab is hidden';
  }

  root.McpScreenNotify = { KEY, load, save, inQuietHours, shouldNotify, summarize };
})(typeof window !== 'undefined' ? window : globalThis);
