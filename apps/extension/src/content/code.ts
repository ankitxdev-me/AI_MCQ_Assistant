import { isRendered } from './visibility';

/**
 * Code panels shown next to or inside a question.
 *
 * Portals render code in many ways: CodeMirror/Monaco/Ace, <pre>, or their own <div>s with a
 * line-number gutter. Only the known editors used to be recognised, so a custom panel was read as
 * part of the question text: the gutter came out as "1234567891011" glued to the first line, and
 * indent-guide glyphs became garbage characters. Here any monospace block counts as code.
 */

const EDITOR_SELECTOR = '.cm-editor, .CodeMirror, .monaco-editor, .ace_editor';
const OPTION_CONTROLS = 'input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"], textarea';
const MONOSPACE = /mono|courier|consolas|menlo|monaco|fira ?code|source code|jetbrains|inconsolata|\bhack\b|cascadia/i;
const CANDIDATES = 'pre, code, div, section, table, ol, ul, p';

const visibleText = (el: Element): string => {
  const t = (el as HTMLElement).innerText;
  return typeof t === 'string' ? t : el.textContent || '';
};

/**
 * Removes characters that carry no meaning for the question: private-use icon-font glyphs,
 * zero-width characters, and runs of one repeated non-ASCII glyph (indent guides, decorative
 * borders). Runs of ASCII like "____" (fill-in blanks) or "...." are kept.
 */
export function stripJunkChars(text: string): string {
  return text
    .replace(/[-​-‍⁠﻿]/g, '')
    .replace(/([^\x00-\x7F])\1{3,}/gu, '');
}

/** A rendered block of code (known editor, <pre>, or monospace text with several lines). */
export function isCodeBlock(el: Element): boolean {
  if (el.closest('#ai-mcq-assistant-root, label')) return false;
  if (el.querySelector(OPTION_CONTROLS)) return false;
  if (el.matches(EDITOR_SELECTOR) || el.matches('pre')) return isRendered(el);
  if (el.matches('code') && el.parentElement?.closest('pre')) return false; // the <pre> is the block
  const family = window.getComputedStyle(el).fontFamily || '';
  if (!MONOSPACE.test(family)) return false;
  // a monospace parent makes every child monospace too: only count the outermost one
  const parentFamily = el.parentElement ? window.getComputedStyle(el.parentElement).fontFamily || '' : '';
  if (MONOSPACE.test(parentFamily) && !el.parentElement?.matches('body')) return false;
  const lines = visibleText(el)
    .split('\n')
    .filter((l) => l.trim().length > 0);
  const multiLine = lines.length >= 2 || el.querySelectorAll('br, div, li, tr').length >= 2;
  return multiLine && isRendered(el);
}

/** Outermost code blocks inside root (root included). */
export function findCodeBlocks(root: Element): HTMLElement[] {
  const found: HTMLElement[] = [];
  const consider = (el: Element) => {
    if (found.some((f) => f.contains(el))) return;
    if (isCodeBlock(el)) found.push(el as HTMLElement);
  };
  consider(root);
  if (found.includes(root as HTMLElement)) return found;
  root.querySelectorAll(CANDIDATES).forEach(consider);
  return found.filter((f) => !found.some((o) => o !== f && o.contains(f)));
}

/** Concatenation "123...n" used to find a glued line-number gutter. */
const counting = (n: number) => Array.from({ length: n }, (_, i) => String(i + 1)).join('');

/**
 * Removes a line-number gutter from extracted code, in whichever shape it came out:
 *   - a leading column of lines "1", "2", ... "N"
 *   - the numbers glued together in front of the code: "1234567891011f(Node a, ..."
 *   - a number in front of every line: "1  f(Node a", "2  temp1=a"
 */
export function stripLineNumbers(code: string): string {
  let lines = code.replace(/\r/g, '').split('\n');

  // Leading column: "1", "2", ... on their own lines (blank lines between allowed)
  let next = 1;
  let cut = 0;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === '') continue;
    if (t === String(next)) {
      next++;
      cut = i + 1;
    } else break;
  }
  if (next > 3) lines = lines.slice(cut);

  // Glued numbers in front of the first code line
  const firstIdx = lines.findIndex((l) => l.trim() !== '');
  if (firstIdx >= 0) {
    const first = lines[firstIdx].trimStart();
    for (let n = 400; n >= 3; n--) {
      const run = counting(n);
      if (first.startsWith(run) && !/\d/.test(first.charAt(run.length))) {
        lines[firstIdx] = first.slice(run.length);
        break;
      }
    }
  }

  // A number in front of each line, counting up from 1
  const nonEmpty = lines.map((l, i) => ({ l, i })).filter((x) => x.l.trim() !== '');
  const numbered = nonEmpty.filter((x, k) => new RegExp(`^\\s*${k + 1}(\\s|$)`).test(x.l)).length;
  if (nonEmpty.length >= 3 && numbered === nonEmpty.length) {
    nonEmpty.forEach((x, k) => {
      lines[x.i] = x.l.replace(new RegExp(`^\\s*${k + 1}(\\s|$)`), '');
    });
  }

  return lines.join('\n');
}

/** Clean code text of a block: gutter removed, junk glyphs removed, indentation kept. */
export function codeText(el: Element): string {
  const raw = visibleText(el).replace(/ /g, ' ');
  return stripLineNumbers(stripJunkChars(raw))
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n')
    .replace(/^\n+|\n+$/g, '');
}

/** Text of an element with its code blocks left out (the prompt around the code). */
export function textWithoutCode(el: Element): string {
  const blocks = findCodeBlocks(el);
  if (blocks.length === 0) return el.textContent || '';
  if (blocks.includes(el as HTMLElement)) return '';
  const clone = el.cloneNode(true) as Element;
  const live = Array.from(el.querySelectorAll('*'));
  const copies = Array.from(clone.querySelectorAll('*'));
  live.forEach((node, i) => {
    if (blocks.includes(node as HTMLElement)) copies[i].remove();
  });
  return clone.textContent || '';
}
