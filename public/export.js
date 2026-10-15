// mcp-screen share/export: a self-contained HTML snapshot and a PNG of the whole canvas (every widget, not just the view).
// Pure helpers live on McpScreenExport so they can be unit-tested outside the browser.
(function (root) {
  'use strict';

  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  /** Build a standalone HTML document: inlined CSS (+ font as a data URL), no scripts, no network. */
  function buildStaticHtml({ css, fontDataUrl, title, bodyHtml, when }) {
    let style = String(css);
    if (fontDataUrl) style = style.replace(/url\(['"]?\/fonts\/inter-var-latin\.woff2['"]?\)/g, `url('${fontDataUrl}')`);
    else style = style.replace(/@font-face\s*{[^}]*}/g, '');
    // Belt and braces: a snapshot must never run code.
    const safeBody = String(bodyHtml)
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<iframe[\s\S]*?(<\/iframe>|\/>)/gi, '')
      .replace(/\son\w+="[^"]*"/gi, '');
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:">
<title>${escapeHtml(title)}</title>
<style>${style}
*, *::before, *::after { animation: none !important; transition: none !important; }
.snapshot-note { color: var(--muted); font-size: 12px; margin: 0 22px 18px; }
</style></head>
<body class="exported">${safeBody}
<p class="snapshot-note">Snapshot from mcp-screen · ${escapeHtml(when)}</p>
</body></html>`;
  }

  function slug(d = new Date(), canvasName) {
    const p = (n) => String(n).padStart(2, '0');
    const project = String(canvasName || (root.__mcpScreen && root.__mcpScreen.state && root.__mcpScreen.state.canvas) || '')
      .toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    return project ? `mcp-screen-${project}-${stamp}` : `mcp-screen-${stamp}`;
  }

  /** Localhost URL that opens this named canvas (token in the hash so it never hits the server log as a query). */
  function canvasLink() {
    const st = root.__mcpScreen && root.__mcpScreen.state;
    const id = (st && st.canvas) || 'default';
    const u = new URL(location.href);
    u.hash = `canvas=${encodeURIComponent(id)}`;
    return u.toString();
  }

  // ---------- browser-only below ----------
  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  async function fontAsDataUrl() {
    try {
      const buf = await (await fetch('/fonts/inter-var-latin.woff2')).blob();
      return await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(buf); });
    } catch { return null; }
  }

  /** Clone the header + active view, freezing live state into static markup. */
  function snapshotDom() {
    const header = document.querySelector('header.top').cloneNode(true);
    const view = document.querySelector('.view.active');
    const clone = view.cloneNode(true);
    // MCP Apps run in a null-origin sandbox we can't read; leave an honest placeholder.
    const liveFrames = view.querySelectorAll('iframe');
    clone.querySelectorAll('iframe').forEach((f, i) => {
      const ph = document.createElement('div');
      ph.className = 'app-placeholder';
      ph.textContent = `Interactive MCP App “${liveFrames[i]?.title || 'app'}” (not included in snapshots)`;
      f.replaceWith(ph);
    });
    clone.querySelectorAll('.caption, .flyer, .ripple').forEach((n) => n.remove());
    // images are inlined so the snapshot needs no network (same-origin ones only; others get a placeholder)
    const liveImgs = view.querySelectorAll('img');
    clone.querySelectorAll('img').forEach((im, i) => {
      const src = liveImgs[i];
      try {
        if (!src || !src.complete || !src.naturalWidth) throw new Error('not loaded');
        const c = document.createElement('canvas');
        c.width = src.naturalWidth; c.height = src.naturalHeight;
        c.getContext('2d').drawImage(src, 0, 0);
        im.src = c.toDataURL('image/png');
        im.removeAttribute('srcset');
      } catch { im.removeAttribute('src'); im.alt = `${im.alt || 'image'} (not included in snapshots)`; }
    });
    let width = Math.ceil(document.documentElement.clientWidth);
    let height = Math.ceil(Math.max(document.documentElement.scrollHeight, window.innerHeight));
    const full = fullCanvas(clone);
    if (full) { width = Math.max(width, full.width); height = document.querySelector('header.top').offsetHeight + full.height + 60; }
    const main = document.createElement('main');
    main.append(clone);
    return { header, main, width, height, full };
  }

  /** On the canvas tab, lay the cloned world out at 1:1 so every widget and note is in the snapshot. */
  function fullCanvas(clone) {
    const cv = root.__mcpScreen && root.__mcpScreen.canvas;
    const stage = clone.querySelector('#stage') || (clone.id === 'stage' ? clone : null);
    const b = cv && stage && cv.bounds();
    if (!b) return null;
    const notes = root.__mcpScreen.state.annotations;
    const talky = [...notes.values()].some((a) => a.text);
    const pad = 32, extraR = talky ? 300 : 0, extraB = talky ? 160 : 0;
    const width = Math.ceil(b.x1 - b.x0 + pad * 2 + extraR), height = Math.ceil(b.y1 - b.y0 + pad * 2 + extraB);
    stage.querySelectorAll('.toolbar, .zoombar, .minimap, .dots, .empty').forEach((n) => n.remove());
    stage.querySelectorAll('.culled').forEach((n) => n.classList.remove('culled'));
    stage.classList.remove('moving');
    stage.style.cssText += `;width:${width}px;height:${height}px;min-height:0;max-height:none;overflow:visible;position:relative;flex:none`;
    const world = stage.querySelector('#world');
    if (world) world.style.transform = `translate(${pad - b.x0}px, ${pad - b.y0}px) scale(1)`;
    return { width, height };
  }

  /** Largest scale ≤ want that keeps the PNG under browser canvas limits. */
  function pngScale(width, height, want = 2) {
    return Math.max(0.25, Math.min(want, 16000 / width, 16000 / height, Math.sqrt(1.2e8 / (width * height))));
  }

  async function exportHtml() {
    const css = await (await fetch('/app.css')).text();
    const { header, main } = snapshotDom();
    const html = buildStaticHtml({ css, fontDataUrl: await fontAsDataUrl(), title: `mcp-screen · ${new Date().toLocaleString()}`, bodyHtml: header.outerHTML + main.outerHTML, when: new Date().toLocaleString() });
    const blob = new Blob([html], { type: 'text/html' });
    download(blob, `${slug()}.html`);
    return blob;
  }

  /** Render the static snapshot through SVG <foreignObject> into a 2x canvas. */
  async function exportPng(scale = 2) {
    const css = await (await fetch('/app.css')).text();
    const font = await fontAsDataUrl();
    const { header, main, width, height } = snapshotDom();
    scale = pngScale(width, height, scale);
    const style = css.replace(/url\(['"]?\/fonts\/inter-var-latin\.woff2['"]?\)/g, `url('${font}')`)
      // backdrop blur doesn't survive foreignObject; give glass a solid-ish base instead
      + `\n.card,.rep,.panel,.map-wrap,.node{backdrop-filter:none!important;background-color:rgba(20,24,36,.92)}
         *,*::before,*::after{animation:none!important;transition:none!important}
         .ann-x,.reply-in,.note .x{display:none!important}
         .actions{display:none!important}`;
    const wrap = document.createElement('div');
    wrap.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
    wrap.style.cssText = `width:${width}px;min-height:${height}px;background:#07080d;color:#eef1f8;font-family:'Inter var',sans-serif`;
    wrap.className = 'exported';
    const st = document.createElement('style');
    st.textContent = style;
    wrap.append(st, header, main);
    const xhtml = new XMLSerializer().serializeToString(wrap);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject width="100%" height="100%">${xhtml}</foreignObject></svg>`;
    const img = new Image();
    img.decoding = 'sync';
    const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('could not rasterise the snapshot')); img.src = url; });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);
    ctx.fillStyle = '#07080d';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    download(blob, `${slug()}.png`);
    return blob;
  }

  root.McpScreenExport = { buildStaticHtml, slug, escapeHtml, pngScale, exportHtml, exportPng, canvasLink };
})(typeof window !== 'undefined' ? window : globalThis);
