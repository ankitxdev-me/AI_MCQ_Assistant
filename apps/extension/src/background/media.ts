/**
 * Image helpers for the service worker.
 *
 * The worker can fetch any URL (host permission <all_urls>), so cross-origin question images
 * that a content script cannot read are fetched here. Everything is re-encoded to JPEG/PNG and
 * scaled down so Gemini gets a supported format at a sane size.
 */

export interface MediaItem {
  label: string;
  url?: string;
  dataUrl?: string;
}

export interface ImagePayload {
  mimeType: string;
  data: string;
  label?: string;
}

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
  devicePixelRatio: number;
}

const MAX_SIDE = 1280;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function dataUrlToBlob(dataUrl: string): Blob {
  const match = dataUrl.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
  if (!match) throw new Error('Invalid data URL');
  const mime = match[1] || 'application/octet-stream';
  const payload = match[3];
  if (match[2]) {
    const bin = atob(payload);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }
  return new Blob([decodeURIComponent(payload)], { type: mime });
}

/** Decodes any browser-supported raster image, scales it to MAX_SIDE, re-encodes as PNG or JPEG. */
export async function normalizeImage(blob: Blob, crop?: { sx: number; sy: number; sw: number; sh: number }): Promise<{ mimeType: string; data: string }> {
  if (blob.type.includes('svg')) {
    throw new Error('SVG files must be rasterized in the page');
  }
  const bitmap = crop
    ? await createImageBitmap(blob, crop.sx, crop.sy, crop.sw, crop.sh)
    : await createImageBitmap(blob);

  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('No 2D context');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();

  // PNG keeps text and code crisp; JPEG keeps photos small
  const mimeType = blob.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
  const out = await canvas.convertToBlob(mimeType === 'image/jpeg' ? { type: mimeType, quality: 0.85 } : { type: mimeType });
  return { mimeType, data: bytesToBase64(new Uint8Array(await out.arrayBuffer())) };
}

async function loadItem(item: MediaItem): Promise<Blob> {
  if (item.dataUrl) return dataUrlToBlob(item.dataUrl);
  if (!item.url) throw new Error('No image source');
  const res = await fetch(item.url, { credentials: 'include', signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  if (!blob.type.startsWith('image/')) throw new Error(`Not an image (${blob.type || 'unknown type'})`);
  return blob;
}

export async function resolveMediaItems(items: MediaItem[]): Promise<{ images: ImagePayload[]; failures: string[] }> {
  const images: ImagePayload[] = [];
  const failures: string[] = [];
  for (const item of items) {
    try {
      const blob = await loadItem(item);
      const norm = await normalizeImage(blob);
      images.push({ ...norm, label: item.label });
    } catch (err: any) {
      failures.push(`${item.label}: ${err?.message || err}`);
    }
  }
  return { images, failures };
}

/** Crops a captureVisibleTab screenshot to the question region (CSS px * devicePixelRatio). */
export async function cropScreenshot(dataUrl: string, rect: CropRect, label = 'Screenshot of the question'): Promise<ImagePayload> {
  const blob = dataUrlToBlob(dataUrl);
  const full = await createImageBitmap(blob);
  const dpr = rect.devicePixelRatio || 1;
  const sx = Math.max(0, Math.floor(rect.x * dpr));
  const sy = Math.max(0, Math.floor(rect.y * dpr));
  const sw = Math.max(1, Math.min(full.width - sx, Math.ceil(rect.width * dpr)));
  const sh = Math.max(1, Math.min(full.height - sy, Math.ceil(rect.height * dpr)));
  full.close?.();
  const norm = await normalizeImage(blob, { sx, sy, sw, sh });
  return { ...norm, label };
}
