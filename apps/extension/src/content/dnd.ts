/**
 * Helpers for drag-and-drop ("arrange in order") questions.
 *
 * Drag libraries put their markers in different places. react-beautiful-dnd marks the whole card,
 * but dnd-kit, react-dnd and many custom lists only mark the small drag handle (the ⋮⋮ icon),
 * which has no text. Reading the handle gave items like "Step 1" and made the drag impossible to
 * verify. These helpers map each marked element to its full row (the card with the step text).
 */

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * For each marked element, climb to the largest ancestor that still contains only that one
 * marked element. That ancestor is the row: handle + step text (+ its number label if any).
 */
export function expandToItemRows(marked: HTMLElement[]): HTMLElement[] {
  const rows: HTMLElement[] = [];
  for (const el of marked) {
    let row: HTMLElement = el;
    let parent = el.parentElement;
    while (parent && parent !== document.body && parent !== document.documentElement) {
      const inside = marked.filter((m) => parent!.contains(m)).length;
      if (inside > 1) break;
      row = parent;
      parent = parent.parentElement;
    }
    if (!rows.includes(row)) rows.push(row);
  }
  // Keep the outermost rows only (a handle and its card may both carry markers)
  return rows.filter((r) => !rows.some((o) => o !== r && o.contains(r)));
}

/** True when the item carries real text (not just a handle icon or a lone number). */
export function hasItemText(el: Element): boolean {
  return norm(el.textContent || '').replace(/^\d+[\s.:)\-]*/, '').replace(/[^\p{L}\p{N}]/gu, '').length >= 3;
}

/**
 * Compact structure of an element for diagnostics: tags, drag-related attributes and short text,
 * so a log line shows which drag library a portal uses without dumping the whole page.
 */
export function domSkeleton(el: Element, maxDepth = 5, maxLen = 1800): string {
  const KEEP = /^(data-rbd|data-rfd|data-dnd|data-sortable|data-id|draggable|role|aria-roledescription|aria-grabbed|tabindex|class)/;
  const walk = (node: Element, depth: number): string => {
    const attrs = Array.from(node.attributes)
      .filter((a) => KEEP.test(a.name))
      .map((a) => (a.name === 'class' ? `.${a.value.trim().split(/\s+/).slice(0, 3).join('.')}` : `[${a.name}=${a.value.slice(0, 24)}]`))
      .join('');
    const own = Array.from(node.childNodes)
      .filter((c) => c.nodeType === Node.TEXT_NODE)
      .map((c) => norm(c.textContent || ''))
      .join(' ')
      .slice(0, 30);
    const kids =
      depth < maxDepth ? Array.from(node.children).slice(0, 6).map((c) => walk(c, depth + 1)).join('') : node.children.length ? '…' : '';
    return `<${node.tagName.toLowerCase()}${attrs}>${own ? `"${own}"` : ''}${kids}</>`;
  };
  return walk(el, 0).slice(0, maxLen);
}
