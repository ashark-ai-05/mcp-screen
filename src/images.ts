/** Local images for the `image` widget: only real image files, checked by extension AND magic bytes. */
import fs from 'node:fs';
import path from 'node:path';

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);

/** Validate an agent-supplied path at place time. Returns the resolved real path. */
export function checkImagePath(p: string): string {
  if (!path.isAbsolute(p)) throw new Error('image path must be absolute');
  const ext = path.extname(p).toLowerCase();
  if (!EXT.has(ext)) throw new Error(`image path must end in ${[...EXT].join(', ')}`);
  let real: string;
  try {
    real = fs.realpathSync(p);
  } catch {
    throw new Error(`image not found: ${p}`);
  }
  const st = fs.statSync(real);
  if (!st.isFile()) throw new Error('image path is not a file');
  if (st.size > MAX_IMAGE_BYTES) throw new Error(`image is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB`);
  if (!EXT.has(path.extname(real).toLowerCase())) throw new Error('image path resolves to a non-image file');
  return real;
}

/** Content type from magic bytes; null if it isn't one of the image types we serve. */
export function sniffImage(buf: Buffer): string | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  const head = buf.subarray(0, 1024).toString('utf8').replace(/^\uFEFF/, '').trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return 'image/svg+xml';
  return null;
}

/** Read an image for serving. Re-checks everything: the file may have changed since it was placed. */
export function readImage(p: string): { type: string; body: Buffer } {
  const real = checkImagePath(p);
  const body = fs.readFileSync(real);
  const type = sniffImage(body);
  if (!type) throw new Error('file is not a supported image');
  return { type, body };
}
