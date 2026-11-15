/**
 * True when the element is actually rendered (not inside a display:none /
 * visibility:hidden / [hidden] subtree). Hidden wizard steps and collapsed
 * sections must not be treated as live questions.
 */
export function isRendered(el: Element | null | undefined): boolean {
  if (!el || !el.isConnected) return false;

  const anyEl = el as any;
  if (typeof anyEl.checkVisibility === 'function') {
    try {
      return anyEl.checkVisibility({ checkVisibilityCSS: true });
    } catch {
      // fall through to manual walk
    }
  }

  let node: Element | null = el;
  while (node && node !== document.documentElement) {
    if ((node as HTMLElement).hidden) return false;
    const style = window.getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    node = node.parentElement;
  }
  return true;
}

/**
 * Visibility for an answer control. Portals often hide the native
 * <input type="radio"> and draw a styled label instead, so an option counts as
 * visible when the input OR its label / wrapper is rendered.
 */
export function isOptionRendered(el: Element | null | undefined): boolean {
  if (!el) return false;
  if (isRendered(el)) return true;

  if (el instanceof HTMLInputElement) {
    if (el.labels) {
      for (const lbl of Array.from(el.labels)) {
        if (isRendered(lbl)) return true;
      }
    }
    return isRendered(el.closest('label')) || isRendered(el.parentElement);
  }
  return false;
}
