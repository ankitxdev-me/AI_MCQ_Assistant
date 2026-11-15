import { QuestionImageRef, QuestionImagePayload } from '@ai-mcq/shared-types';
import { isRendered, isOptionRendered } from './visibility';

/**
 * Rich question context: tables, code and images that sit around a question's options.
 *
 * Portals put a lot of the question outside the prompt text: a code editor in a split pane,
 * a "match column 1 with column 2" table, or a diagram. Plain textContent loses all of that.
 */

const OPTION_CONTROL_SELECTOR =
  'input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]';
const CODE_EDITOR_SELECTOR = '.cm-editor, .CodeMirror, .monaco-editor, .ace_editor';
const CHROME_SELECTOR = 'header, nav, footer, aside, [role="banner"], [role="navigation"], #ai-mcq-assistant-root';
const DECORATIVE_IMAGE = /logo|avatar|profile|user-?pic|icon|emoji|badge|flag|spinner|loader|sprite/i;
const MIN_IMAGE_SIDE = 64;
const MAX_IMAGES = 6;

export interface QuestionRichContext {
  /** Text blocks to append to the question (tables, code). */
  textBlocks: string[];
  images: QuestionImageRef[];
  /** Live elements behind `images`, same order. */
  imageElements: Element[];
  /** Stable key for fingerprinting: same prompt + different code/table/image must not collide. */
  contextKey: string;
  region: Element;
  hasVisualContent: boolean;
}

/** Turns an option's stored selector back into the clickable element and its visual wrapper. */
export function resolveOptionElement(selector?: string): Element | null {
  if (!selector) return null;
  try {
    return document.querySelector(selector);
  } catch {
    return null;
  }
}

function optionWrapper(el: Element): Element {
  if (el instanceof HTMLInputElement) {
    if (el.labels && el.labels.length > 0) return el.labels[0];
    return el.closest('label') || el.parentElement || el;
  }
  return el;
}

/**
 * Largest ancestor of the options that still belongs to this question only.
 * Stops as soon as an ancestor also holds another question's visible controls.
 */
export function findQuestionRegion(optionEls: Element[]): Element {
  const own = new Set(optionEls);
  let region: Element = optionEls[0];
  let node: Element | null = optionEls[0].parentElement;

  while (node && node !== document.documentElement) {
    const foreign = Array.from(node.querySelectorAll(OPTION_CONTROL_SELECTOR)).some(
      (c) => !own.has(c) && !c.closest('#ai-mcq-assistant-root') && isOptionRendered(c),
    );
    if (foreign) break;
    region = node;
    if (node === document.body) break;
    node = node.parentElement;
  }
  return region;
}

function cellText(cell: Element): string {
  return ((cell as HTMLElement).innerText || cell.textContent || '').replace(/\s+/g, ' ').replace(/\|/g, '/').trim();
}

/** Serializes an HTML table as a Markdown table so rows and columns survive. */
export function tableToMarkdown(table: HTMLTableElement): string {
  const rows = Array.from(table.rows).map((r) => Array.from(r.cells).map(cellText));
  if (rows.length === 0) return '';
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r: string[]) => [...r, ...Array(width - r.length).fill('')];
  const lines = [`| ${pad(rows[0]).join(' | ')} |`, `|${' --- |'.repeat(width)}`];
  for (const r of rows.slice(1)) lines.push(`| ${pad(r).join(' | ')} |`);
  return lines.join('\n');
}

function linesText(lines: Element[]): string {
  return lines
    .map((l) => (l.textContent || '').replace(/ /g, ' ').replace(/​/g, ''))
    .join('\n')
    .replace(/\n+$/, '');
}

/** Reads code out of the common in-browser editors, falling back to <pre>. */
export function extractCodeBlocks(region: Element): string[] {
  const blocks: string[] = [];
  const seen = new Set<string>();
  const push = (code: string) => {
    const trimmed = code.replace(/\s+$/, '');
    if (trimmed.trim().length >= 3 && !seen.has(trimmed)) {
      seen.add(trimmed);
      blocks.push(trimmed);
    }
  };

  // CodeMirror 6
  region.querySelectorAll('.cm-content').forEach((el) => {
    if (isRendered(el)) push(linesText(Array.from(el.querySelectorAll(':scope > .cm-line'))));
  });
  // CodeMirror 5
  region.querySelectorAll('.CodeMirror-code').forEach((el) => {
    if (isRendered(el)) push(linesText(Array.from(el.querySelectorAll('.CodeMirror-line'))));
  });
  // Monaco: lines are absolutely positioned, so order them by their top offset
  region.querySelectorAll('.monaco-editor .view-lines').forEach((el) => {
    if (!isRendered(el)) return;
    const lines = Array.from(el.querySelectorAll<HTMLElement>('.view-line')).sort(
      (a, b) => (parseFloat(a.style.top) || 0) - (parseFloat(b.style.top) || 0),
    );
    push(linesText(lines));
  });
  // Ace
  region.querySelectorAll('.ace_text-layer').forEach((el) => {
    if (isRendered(el)) push(linesText(Array.from(el.querySelectorAll('.ace_line'))));
  });
  // Plain <pre> blocks outside editors
  region.querySelectorAll('pre').forEach((el) => {
    if (el.closest(CODE_EDITOR_SELECTOR) || el.closest('label') || !isRendered(el)) return;
    if (el.querySelector(OPTION_CONTROL_SELECTOR)) return;
    push((el as HTMLElement).innerText || el.textContent || '');
  });

  return blocks;
}

function isDecorative(el: Element): boolean {
  const attrs = [
    el.getAttribute('alt'),
    el.getAttribute('src'),
    el.getAttribute('class'),
    el.getAttribute('id'),
    (el as HTMLElement).parentElement?.getAttribute('class'),
  ]
    .filter(Boolean)
    .join(' ');
  return DECORATIVE_IMAGE.test(attrs);
}

function bigEnough(el: Element): boolean {
  const r = el.getBoundingClientRect();
  return r.width >= MIN_IMAGE_SIDE && r.height >= MIN_IMAGE_SIDE;
}

function simpleHash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

/**
 * Collects tables, code and images that belong to the question whose options are `optionEls`.
 * Cheap enough to run on every DOM scan: no pixel reads, no network.
 */
export function collectQuestionContext(
  optionEls: Element[],
  optionIds: string[],
): QuestionRichContext | null {
  const live = optionEls.filter(Boolean);
  if (live.length === 0) return null;

  const region = findQuestionRegion(live);
  const wrappers = live.map(optionWrapper);
  const inOption = (el: Element) => wrappers.some((w) => w.contains(el));

  const textBlocks: string[] = [];

  // Tables (e.g. "Match column 1 with column 2")
  region.querySelectorAll('table').forEach((t) => {
    if (!isRendered(t) || t.querySelector(OPTION_CONTROL_SELECTOR) || inOption(t)) return;
    if (t.parentElement?.closest('table')) return; // nested tables are covered by their parent
    const md = tableToMarkdown(t as HTMLTableElement);
    if (md) textBlocks.push(`[TABLE]\n${md}`);
  });

  // Code (editor panes and <pre>)
  extractCodeBlocks(region).forEach((code) => textBlocks.push(`[CODE]\n${code}`));

  // Images, SVG diagrams, canvases
  const images: QuestionImageRef[] = [];
  const imageElements: Element[] = [];
  const candidates = Array.from(region.querySelectorAll('img, svg, canvas'));
  for (const el of candidates) {
    if (images.length >= MAX_IMAGES) break;
    if (el.closest(CHROME_SELECTOR) || el.closest(CODE_EDITOR_SELECTOR)) continue;
    if (el.tagName.toLowerCase() === 'svg' && el.parentElement?.closest('svg')) continue;
    // cheap attribute checks first, layout-dependent checks last
    if (isDecorative(el) || el.closest('button, [role="button"]') || !bigEnough(el) || !isRendered(el)) continue;

    if (el instanceof HTMLImageElement) {
      if (el.complete && el.naturalWidth === 0) continue; // broken image
      if (!(el.currentSrc || el.src)) continue;
    }

    const optIdx = wrappers.findIndex((w) => w.contains(el));
    const label = optIdx >= 0 ? `Option ${optionIds[optIdx]} image` : 'Question figure';
    const tag = el.tagName.toLowerCase();

    if (el instanceof HTMLImageElement) {
      images.push({ kind: 'img', src: el.currentSrc || el.src, label });
    } else {
      images.push({ kind: tag === 'canvas' ? 'canvas' : 'svg', label });
    }
    imageElements.push(el);
  }

  const imageKeys = images.map((img, i) =>
    img.kind === 'img' ? simpleHash(img.src || '') : `${img.kind}${i}:${simpleHash(imageElements[i].outerHTML.slice(0, 2000))}`,
  );
  const contextKey = textBlocks.length || imageKeys.length ? simpleHash(textBlocks.join('\n') + '|' + imageKeys.join(',')) : '';

  return {
    textBlocks,
    images,
    imageElements,
    contextKey,
    region,
    hasVisualContent: images.length > 0,
  };
}

/**
 * The statement closest to the options, for questions without a "?" (True/False etc.).
 * Climbs from the options' shared parent until it finds real text that is not an option,
 * a button, or a counter, staying inside the question region.
 */
export function nearbyQuestionText(optionEls: Element[], region: Element): string {
  const wrappers = optionEls.map(optionWrapper);
  let node: Element | null = wrappers[0].parentElement;
  while (node && !wrappers.every((w) => node!.contains(w))) node = node.parentElement;

  while (node) {
    const clone = node.cloneNode(true) as Element;
    // Drop options, buttons, inputs and scripts from the copy before reading its text
    const liveAll = Array.from(node.querySelectorAll('*'));
    const cloneAll = Array.from(clone.querySelectorAll('*'));
    liveAll.forEach((el, i) => {
      const drop =
        wrappers.some((w) => w === el) ||
        el.matches(
          'button, [role="button"], input, textarea, select, script, style, noscript, template, iframe, svg, header, nav, footer, [role="banner"], [role="navigation"], [role="radio"], [role="checkbox"]',
        ) ||
        !isRendered(el);
      if (drop) cloneAll[i].remove();
    });
    const text = (clone.textContent || '')
      .replace(/\b(questions? attempted|score)\s*:?\s*\d+\s*\/\s*\d+/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (text.length >= 15) return text.slice(0, 1500);
    if (node === region || node === document.body) break;
    node = node.parentElement;
  }
  return '';
}

// ---------------------------------------------------------------------------
// Turning collected visuals into image bytes for the AI (runs only when solving)
// ---------------------------------------------------------------------------

export interface MediaRequestItem {
  label: string;
  url?: string;
  dataUrl?: string;
}

export interface ScreenshotRect {
  x: number;
  y: number;
  width: number;
  height: number;
  devicePixelRatio: number;
}

async function svgToDataUrl(svg: SVGElement): Promise<string | null> {
  try {
    const rect = svg.getBoundingClientRect();
    const clone = svg.cloneNode(true) as SVGElement;
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    if (!clone.getAttribute('width')) clone.setAttribute('width', String(Math.round(rect.width)));
    if (!clone.getAttribute('height')) clone.setAttribute('height', String(Math.round(rect.height)));
    const markup = new XMLSerializer().serializeToString(clone);
    const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(markup);

    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('svg load failed'));
      img.src = url;
    });

    const canvas = document.createElement('canvas');
    const scale = Math.min(2, 1280 / Math.max(rect.width, rect.height, 1));
    canvas.width = Math.max(1, Math.round(rect.width * scale));
    canvas.height = Math.max(1, Math.round(rect.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}

function canvasToDataUrl(canvas: HTMLCanvasElement): string | null {
  try {
    return canvas.toDataURL('image/png');
  } catch {
    return null; // tainted by cross-origin content
  }
}

/** Prepares the request for the background worker; reports which visuals could not be read locally. */
export async function buildMediaRequest(
  refs: QuestionImageRef[],
  elements: Element[],
): Promise<{ items: MediaRequestItem[]; unreadable: number }> {
  const items: MediaRequestItem[] = [];
  let unreadable = 0;

  for (let i = 0; i < refs.length; i++) {
    const ref = refs[i];
    const el = elements[i];
    if (ref.kind === 'img' && ref.src) {
      if (ref.src.startsWith('data:')) items.push({ label: ref.label, dataUrl: ref.src });
      else items.push({ label: ref.label, url: ref.src });
    } else if (ref.kind === 'svg' && el) {
      const dataUrl = await svgToDataUrl(el as SVGElement);
      if (dataUrl) items.push({ label: ref.label, dataUrl });
      else unreadable++;
    } else if (ref.kind === 'canvas' && el) {
      const dataUrl = canvasToDataUrl(el as HTMLCanvasElement);
      if (dataUrl) items.push({ label: ref.label, dataUrl });
      else unreadable++;
    }
  }
  return { items, unreadable };
}

/** Viewport rectangle of the question region, for a cropped screenshot. */
export function regionScreenshotRect(region: Element): ScreenshotRect | null {
  const r = region.getBoundingClientRect();
  const x = Math.max(0, r.left);
  const y = Math.max(0, r.top);
  const right = Math.min(window.innerWidth, r.right);
  const bottom = Math.min(window.innerHeight, r.bottom);
  if (right - x < 20 || bottom - y < 20) return null;
  return { x, y, width: right - x, height: bottom - y, devicePixelRatio: window.devicePixelRatio || 1 };
}

export interface ResolvedMedia {
  images: QuestionImagePayload[];
  failures: string[];
  screenshotUsed: boolean;
}
