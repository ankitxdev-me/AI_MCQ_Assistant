import { OptionItem } from '@ai-mcq/shared-types';
import { isOptionRendered, isRendered } from './visibility';
import { sleep } from './timing';

export class DOMInteractionManager {
  /**
   * Confirms and applies selection for an option on the webpage.
   * Uses multi-tiered targeting: option text matching, positional index, and element selector.
   * Transparently supports both single radio buttons and multiple checkbox selections.
   */
  public selectOption(
    optionId: string,
    elementSelector?: string,
    optionText?: string,
  ): { success: boolean; message: string } {
    // If multiple comma-separated IDs passed (e.g., "A, C" or "A,C")
    if (optionId.includes(',') || optionId.includes(';')) {
      const parts = optionId.split(/[,;]+/).map((s) => s.trim()).filter(Boolean);
      if (parts.length > 1) {
        return this.selectMultipleOptions(parts);
      }
    }

    let targetElement: HTMLElement | null = null;

    // 0. The selector captured at extraction time points at the exact control of THIS question.
    //    Trust it when it is unique, still on screen, and its label still reads like the option.
    //    This stops a same-worded option in another question on the page from being clicked.
    targetElement = this.resolveExtractedOption(elementSelector, optionText);

    // 1. Target by option text (fallback for portals that re-render and break selectors).
    //    Exact label match wins. Partial match is only trusted for longer texts and only when
    //    a single option matches, so "30" can never click "3000".
    if (!targetElement && optionText && optionText.trim()) {
      targetElement = this.findOptionByText(optionText);
    }

    // 2. Target by position (A -> 1st, B -> 2nd). Only safe when the page shows one question.
    if (!targetElement) {
      const optionIndex = this.getOptionIndex(optionId);
      const controls = this.renderedOptionControls();
      if (optionIndex >= 0 && controls.length > optionIndex && this.looksLikeSingleQuestion(controls)) {
        targetElement = controls[optionIndex];
      }
    }

    // 3. Fallback to CSS selector if provided and valid
    if (!targetElement && elementSelector) {
      try {
        targetElement = document.querySelector<HTMLElement>(elementSelector);
      } catch (e) {
        // invalid selector syntax fallback
      }
    }

    // 4. Last resort fallback
    if (!targetElement) {
      targetElement = this.findOptionFallback(optionId);
    }

    if (!targetElement) {
      return {
        success: false,
        message: `Could not find element for option "${optionId}" on the webpage.`,
      };
    }

    if (typeof targetElement.scrollIntoView === 'function') {
      targetElement.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    targetElement.focus?.();

    const input =
      targetElement instanceof HTMLInputElement
        ? targetElement
        : targetElement.querySelector<HTMLInputElement>('input[type="radio"], input[type="checkbox"]');

    if (input && (input.type === 'radio' || input.type === 'checkbox')) {
      const ok = this.setInputChecked(input, true);
      return {
        success: ok,
        message: ok
          ? `Successfully selected option ${optionId}`
          : `Attempted selection on option ${optionId}, but element did not confirm checked state.`,
      };
    }

    // Custom ARIA radio/checkbox or a clickable container
    if (targetElement.getAttribute('aria-checked') !== 'true') {
      this.dispatchClick(targetElement);
    }
    const role = targetElement.getAttribute('role');
    const verified = role === 'radio' || role === 'checkbox' ? targetElement.getAttribute('aria-checked') === 'true' : true;
    return {
      success: verified,
      message: verified
        ? `Triggered selection click for option ${optionId}`
        : `Clicked option ${optionId}, but the page did not mark it as selected.`,
    };
  }

  /** Full pointer + click sequence for custom (non-input) controls. */
  private dispatchClick(el: HTMLElement): void {
    const opts = { bubbles: true, cancelable: true, view: window };
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.click();
  }

  /**
   * Sets a radio/checkbox the way a real user would, so React/Vue/Angular state updates.
   *
   * The old code set `.checked = true` and then dispatched synthetic events. React tracks the
   * checked value through that same setter, so it saw "no change" and never fired onChange:
   * the circle looked filled but the portal's Submit had nothing selected. It also clicked the
   * wrapping <label> afterwards, which toggled checkboxes straight back off.
   */
  private setInputChecked(input: HTMLInputElement, checked: boolean): boolean {
    if (input.checked === checked) return true;

    // 1. Native click: toggles state and fires click/input/change exactly like a user click
    input.click();
    if (input.checked === checked) return true;

    // 2. Some components ignore the input and listen on their wrapper
    const wrapper =
      (input.labels && input.labels[0]) ||
      input.closest<HTMLElement>('label, [class*="radio" i], [class*="checkbox" i], [class*="option" i]');
    if (wrapper && wrapper !== input) {
      this.dispatchClick(wrapper as HTMLElement);
      if (input.checked === checked) return true;
    }

    // 3. Last resort: use the prototype setter (bypasses React's value tracker) and notify
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')?.set;
    setter?.call(input, checked);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return input.checked === checked;
  }

  private renderedOptionControls(): HTMLElement[] {
    return Array.from(
      document.querySelectorAll<HTMLElement>('input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]'),
    ).filter((el) => !el.closest('#ai-mcq-assistant-root') && isOptionRendered(el));
  }

  /** One visible option group: every visible radio shares a name, or there are only a handful. */
  private looksLikeSingleQuestion(controls: HTMLElement[]): boolean {
    const names = new Set(
      controls.filter((c): c is HTMLInputElement => c instanceof HTMLInputElement).map((c) => c.name).filter(Boolean),
    );
    return names.size <= 1 && controls.length <= 8;
  }

  private labelTextOf(el: HTMLElement): string {
    const norm = (t: string | null | undefined) => (t || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (el instanceof HTMLInputElement) {
      if (el.labels && el.labels.length > 0) return norm(el.labels[0].textContent);
      const parentLabel = el.closest('label');
      if (parentLabel && parentLabel.querySelectorAll('input').length === 1) return norm(parentLabel.textContent);
      if (el.parentElement && el.parentElement.querySelectorAll('input').length === 1) return norm(el.parentElement.textContent);
      return '';
    }
    return norm(el.getAttribute('aria-label')) || norm(el.textContent);
  }

  /** Finds a visible option control by its label text without partial-match accidents. */
  private findOptionByText(optionText: string): HTMLElement | null {
    const target = optionText.replace(/\s+/g, ' ').trim().toLowerCase();
    const stripPrefix = (t: string) => t.replace(/^\(?[a-h1-8][\)\.:]\s+/i, '').trim();
    const targetCore = stripPrefix(target);

    const controls = this.renderedOptionControls();
    const labelled = controls.map((el) => ({ el, text: this.labelTextOf(el) })).filter((c) => c.text);

    const exact = labelled.find((c) => c.text === target || stripPrefix(c.text) === targetCore);
    if (exact) return exact.el;

    if (targetCore.length >= 6) {
      const partial = labelled.filter((c) => c.text.includes(targetCore) || targetCore.includes(stripPrefix(c.text)));
      if (partial.length === 1) return partial[0].el;
    }
    return null;
  }

  /**
   * Selects multiple options for multi-answer MCQs (checkboxes).
   * Ensures all correct options are checked, and any incorrect pre-selected options are unchecked.
   * Dispatches full React/DOM event pipeline across inputs, labels, and parent wrappers.
   */
  public selectMultipleOptions(
    targetOptionIds: string[],
    options: OptionItem[] = [],
  ): { success: boolean; message: string; selectedCount: number } {
    const letterToNum: Record<string, string> = { A: '1', B: '2', C: '3', D: '4', E: '5', F: '6' };
    const numToLetter: Record<string, string> = { '1': 'A', '2': 'B', '3': 'C', '4': 'D', '5': 'E', '6': 'F' };

    const normTargets = new Set<string>();
    targetOptionIds
      .flatMap((id) => id.split(/[,;\s]+/))
      .map((id) => id.trim().toUpperCase())
      .filter(Boolean)
      .forEach((clean) => {
        normTargets.add(clean);
        if (letterToNum[clean]) normTargets.add(letterToNum[clean]);
        if (numToLetter[clean]) normTargets.add(numToLetter[clean]);
      });

    let selectedCount = 0;

    // Helper: Finds the best DOM target element for an option
    const findOptionElement = (opt: OptionItem): HTMLElement | null => {
      // 1. The exact control captured at extraction time
      const extracted = this.resolveExtractedOption(opt.elementSelector, opt.text);
      if (extracted) return extracted;

      // 2. Label text, exact match first (never lets "30" pick "3000")
      if (opt.text && opt.text.trim()) {
        const byText = this.findOptionByText(opt.text);
        if (byText) return byText;
      }

      // 3. Position, only when the page shows a single question
      const idx = this.getOptionIndex(opt.id);
      const controls = this.renderedOptionControls();
      if (idx >= 0 && idx < controls.length && this.looksLikeSingleQuestion(controls)) {
        return controls[idx];
      }

      return this.findOptionFallback(opt.id);
    };

    // Helper: Determine if element is currently checked
    const isElementChecked = (el: HTMLElement): boolean => {
      if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
        return el.checked;
      }
      const innerCheck = el.querySelector<HTMLInputElement>('input[type="checkbox"], input[type="radio"]');
      if (innerCheck) return innerCheck.checked;
      const aria = el.getAttribute('aria-checked');
      if (aria !== null) return aria === 'true';
      const cls = typeof el.className === 'string' ? el.className.toLowerCase() : '';
      return /\b(is-checked|checked|ant-checkbox-checked)\b/.test(cls);
    };

    // Helper: Safely toggle option with React/DOM event dispatches
    const toggleOption = (el: HTMLElement, select: boolean) => {
      if (typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
      el.focus?.();

      const innerInput =
        el instanceof HTMLInputElement
          ? el
          : el.querySelector<HTMLInputElement>('input[type="checkbox"], input[type="radio"]');

      if (innerInput && (innerInput.type === 'checkbox' || innerInput.type === 'radio')) {
        this.setInputChecked(innerInput, select);
        return;
      }

      const currentlyChecked = isElementChecked(el);
      if (currentlyChecked !== select) {
        this.dispatchClick(el);
        if (el.getAttribute('role') === 'checkbox' || el.getAttribute('role') === 'radio') {
          el.setAttribute('aria-checked', select ? 'true' : 'false');
        }
      }
    };

    if (options.length > 0) {
      let wanted = 0;
      for (const opt of options) {
        const optId = opt.id.replace(/^option\s*/i, '').trim().toUpperCase();
        const altId = letterToNum[optId] || numToLetter[optId];
        const shouldBeSelected = normTargets.has(optId) || (altId ? normTargets.has(altId) : false);
        if (shouldBeSelected) wanted++;

        const el = findOptionElement(opt);
        if (el) {
          if (isElementChecked(el) !== shouldBeSelected) {
            toggleOption(el, shouldBeSelected);
          }
          if (shouldBeSelected && isElementChecked(el)) selectedCount++;
        }
      }

      const success = wanted > 0 && selectedCount === wanted;
      return {
        success,
        message: success
          ? `Selected ${selectedCount} option(s): [${Array.from(normTargets).join(', ')}]`
          : `Only ${selectedCount} of ${wanted} option(s) ended up selected on the page.`,
        selectedCount,
      };
    }

    return {
      success: false,
      message: 'No options provided to selectMultipleOptions',
      selectedCount: 0,
    };
  }

  /**
   * Types an answer into the question's text box so the page's framework sees it.
   * Setting `.value` directly is invisible to React (same value-tracker issue as radios),
   * so the prototype setter is used and input/change events are fired like real typing.
   */
  public fillTextAnswer(inputSelector: string | undefined, answer: string): { success: boolean; message: string } {
    let box: HTMLInputElement | HTMLTextAreaElement | null = null;
    if (inputSelector) {
      try {
        box = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(inputSelector);
      } catch {
        box = null;
      }
    }
    if (!box || !isRendered(box)) {
      box = document.querySelector<HTMLTextAreaElement>('textarea:not([readonly]):not([disabled])');
    }
    if (!box) return { success: false, message: 'Could not find the answer box on the page.' };

    box.scrollIntoView?.({ block: 'center' });
    box.focus();
    const proto = box instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(box, answer);
    else box.value = answer;
    box.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: answer }));
    box.dispatchEvent(new Event('change', { bubbles: true }));
    box.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: answer.slice(-1) || 'a' }));
    box.blur();

    const ok = box.value === answer;
    return {
      success: ok,
      message: ok
        ? `Typed answer: "${answer.slice(0, 60)}"`
        : box instanceof HTMLInputElement && box.type === 'number'
          ? `The box only accepts numbers; the answer "${answer.slice(0, 40)}" was rejected.`
          : 'The page did not accept the typed answer.',
    };
  }

  /**
   * Resolves the selector saved during extraction, only if it is unambiguous,
   * rendered, and (when option text is known) still labelled with that text.
   */
  private resolveExtractedOption(elementSelector?: string, optionText?: string): HTMLElement | null {
    if (!elementSelector) return null;

    let matches: HTMLElement[] = [];
    try {
      matches = Array.from(document.querySelectorAll<HTMLElement>(elementSelector));
    } catch (e) {
      return null;
    }
    if (matches.length !== 1) return null;

    const el = matches[0];
    if (!isOptionRendered(el)) return null;

    const norm = (optionText || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!norm) return el;

    const texts: string[] = [];
    if (el instanceof HTMLInputElement) {
      if (el.labels) Array.from(el.labels).forEach((l) => texts.push(l.textContent || ''));
      texts.push(el.closest('label')?.textContent || '');
      if (el.parentElement && el.parentElement.querySelectorAll('input').length === 1) {
        texts.push(el.parentElement.textContent || '');
      }
    } else {
      texts.push(el.getAttribute('aria-label') || '', el.textContent || '');
    }

    const labelMatches = texts
      .map((t) => t.replace(/\s+/g, ' ').trim().toLowerCase())
      .filter(Boolean)
      .some((t) => t === norm || t.includes(norm) || norm.includes(t));

    return labelMatches ? el : null;
  }

  private getOptionIndex(optionId: string): number {
    const clean = optionId.trim().toUpperCase();
    if (clean === 'A' || clean === '1') return 0;
    if (clean === 'B' || clean === '2') return 1;
    if (clean === 'C' || clean === '3') return 2;
    if (clean === 'D' || clean === '4') return 3;
    if (clean === 'E' || clean === '5') return 4;
    const num = parseInt(clean, 10);
    return isNaN(num) ? -1 : num - 1;
  }

  /**
   * Reorders a drag-and-drop list into `targetSequence` (option IDs, first to last).
   *
   * Works through the page's own drag library so its state really changes:
   *   1. Keyboard dragging (react-beautiful-dnd / hello-pangea / dnd-kit all support it)
   *   2. Pointer + mouse drag with movement past the drag threshold
   *   3. HTML5 drag events (SortableJS, native draggable lists)
   * After every move it waits for the list to settle before judging the result, so one
   * technique finishing late is never followed by a second technique moving the item again.
   *
   * The old version started by moving the DOM nodes with appendChild. That made the list
   * *look* right while the portal's state stayed unchanged, so the original order was
   * submitted and React could crash on the next render.
   */
  public async reorderOptions(
    targetSequence: string[],
    options: OptionItem[] = [],
  ): Promise<{ success: boolean; isVerifiedCorrect: boolean; verifiedOrder: string[]; message: string }> {
    const targets = targetSequence
      .flatMap((id) => String(id).split(/[,;\->\s]+/))
      .map((s) => s.trim())
      .filter(Boolean);
    if (targets.length < 2) {
      return { success: false, isVerifiedCorrect: false, verifiedOrder: [], message: 'No target sequence provided for reordering.' };
    }
    if (document.hidden) {
      return {
        success: false,
        isVerifiedCorrect: false,
        verifiedOrder: [],
        message: 'Drag and drop needs this tab to be visible (browsers pause page animations in background tabs).',
      };
    }

    const ITEM_SELECTOR =
      '[data-rbd-draggable-id], [data-rfd-draggable-id], [aria-roledescription="sortable"], [aria-roledescription="draggable"], [draggable="true"]';
    const HANDLE_SELECTOR =
      '[data-rbd-drag-handle-draggable-id], [data-rfd-drag-handle-draggable-id], [aria-roledescription="sortable"], [aria-roledescription="draggable"], [class*="handle" i], [class*="grip" i]';
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

    const getItems = (): HTMLElement[] => {
      const droppable = document.querySelector<HTMLElement>('[data-rbd-droppable-id], [data-rfd-droppable-id]');
      if (droppable) {
        const children = (Array.from(droppable.children) as HTMLElement[]).filter((c) => isRendered(c) && norm(c.textContent || ''));
        if (children.length >= 2) return children;
      }
      let items = Array.from(document.querySelectorAll<HTMLElement>(ITEM_SELECTOR)).filter((el) => isRendered(el));
      // Keep the outermost draggable when both an item and its handle carry markers
      items = items.filter((el) => !items.some((other) => other !== el && other.contains(el)));
      if (items.length >= 2) return items.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);

      const fromSelectors = options
        .map((o) => {
          try {
            return o.elementSelector ? document.querySelector<HTMLElement>(o.elementSelector) : null;
          } catch {
            return null;
          }
        })
        .filter((el): el is HTMLElement => !!el && isRendered(el));
      return fromSelectors.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    };

    // Map a list item to the option whose text it contains best (longest match wins, so
    // "Load programs" never claims the item "Load multiple programs into memory").
    const optionNorms = options.map((o) => ({ id: o.id, n: norm(o.text) })).filter((o) => o.n.length > 0);
    const idOf = (el: HTMLElement): string => {
      const t = norm(el.textContent || '');
      let best = '';
      let bestLen = 0;
      for (const o of optionNorms) {
        if (t.includes(o.n) && o.n.length > bestLen) {
          best = o.id;
          bestLen = o.n.length;
        }
      }
      return best;
    };
    const currentOrder = () => getItems().map(idOf);
    const isDone = () => {
      const order = currentOrder();
      return order.length === targets.length && order.every((id, i) => id === targets[i]);
    };

    const handleOf = (el: HTMLElement): HTMLElement =>
      el.matches(HANDLE_SELECTOR) ? el : el.querySelector<HTMLElement>(HANDLE_SELECTOR) || el;

    const waitForChange = async (before: string, timeoutMs = 1500): Promise<boolean> => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        await sleep(100);
        if (currentOrder().join(',') !== before) {
          await sleep(350); // let the drop animation finish before the next move
          return true;
        }
      }
      return false;
    };

    const key = (el: HTMLElement, k: string, code: string, keyCode: number) => {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: k, code, keyCode, which: keyCode, bubbles: true, cancelable: true }));
    };

    const keyboardMove = async (el: HTMLElement, from: number, to: number) => {
      const handle = handleOf(el);
      handle.scrollIntoView({ block: 'center' });
      handle.focus();
      await sleep(80);
      key(handle, ' ', 'Space', 32);
      await sleep(250);
      const down = to > from;
      for (let s = 0; s < Math.abs(to - from); s++) {
        key(handle, down ? 'ArrowDown' : 'ArrowUp', down ? 'ArrowDown' : 'ArrowUp', down ? 40 : 38);
        await sleep(220);
      }
      key(handle, ' ', 'Space', 32);
    };

    const pointerMove = async (el: HTMLElement, dest: HTMLElement, down: boolean) => {
      const handle = handleOf(el);
      handle.scrollIntoView({ block: 'center' });
      await sleep(80);
      const s = handle.getBoundingClientRect();
      const d = dest.getBoundingClientRect();
      const x0 = s.left + s.width / 2;
      const y0 = s.top + s.height / 2;
      const x1 = d.left + d.width / 2;
      const y1 = down ? d.bottom - 4 : d.top + 4;
      const base = { bubbles: true, cancelable: true, view: window, button: 0, pointerId: 1, isPrimary: true, pointerType: 'mouse' };

      handle.dispatchEvent(new PointerEvent('pointerdown', { ...base, clientX: x0, clientY: y0, buttons: 1 }));
      handle.dispatchEvent(new MouseEvent('mousedown', { ...base, clientX: x0, clientY: y0, buttons: 1 }));
      await sleep(60);
      const steps = 12;
      for (let i = 1; i <= steps; i++) {
        const x = x0 + ((x1 - x0) * i) / steps;
        const y = y0 + ((y1 - y0) * i) / steps;
        const at = document.elementFromPoint(x, y) || window;
        for (const target of [at, window] as EventTarget[]) {
          target.dispatchEvent(new PointerEvent('pointermove', { ...base, clientX: x, clientY: y, buttons: 1 }));
          target.dispatchEvent(new MouseEvent('mousemove', { ...base, clientX: x, clientY: y, buttons: 1 }));
        }
        await sleep(40);
      }
      await sleep(120);
      const at = document.elementFromPoint(x1, y1) || window;
      for (const target of [at, window] as EventTarget[]) {
        target.dispatchEvent(new PointerEvent('pointerup', { ...base, clientX: x1, clientY: y1, buttons: 0 }));
        target.dispatchEvent(new MouseEvent('mouseup', { ...base, clientX: x1, clientY: y1, buttons: 0 }));
      }
    };

    const html5Move = async (el: HTMLElement, dest: HTMLElement, down: boolean) => {
      const dt = new DataTransfer();
      dt.setData('text/plain', el.textContent || '');
      const s = el.getBoundingClientRect();
      const d = dest.getBoundingClientRect();
      const x = d.left + d.width / 2;
      const y = down ? d.bottom - 4 : d.top + 4;
      el.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: s.left + 5, clientY: s.top + 5 }));
      await sleep(50);
      for (let i = 0; i < 3; i++) {
        dest.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
        dest.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
        await sleep(50);
      }
      dest.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
      el.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
    };

    const usesRbd = !!document.querySelector('[data-rbd-drag-handle-draggable-id], [data-rfd-drag-handle-draggable-id], [aria-roledescription="sortable"]');
    const techniques: ('keyboard' | 'pointer' | 'html5')[] = usesRbd
      ? ['keyboard', 'pointer', 'html5']
      : ['pointer', 'html5', 'keyboard'];
    let working: 'keyboard' | 'pointer' | 'html5' | null = null;

    // Selection-sort: put the right item at each position, top to bottom
    let movesLeft = targets.length * 3;
    for (let pos = 0; pos < targets.length && movesLeft > 0; pos++) {
      let items = getItems();
      if (items.length !== targets.length) break;
      let from = items.map(idOf).indexOf(targets[pos]);
      if (from < 0 || from === pos) continue;

      type Technique = 'keyboard' | 'pointer' | 'html5';
      const tryOrder: Technique[] = working ? [working, ...techniques.filter((t) => t !== working)] : techniques;
      for (const technique of tryOrder) {
        movesLeft--;
        items = getItems();
        from = items.map(idOf).indexOf(targets[pos]);
        if (from === pos) break;
        const before = items.map(idOf).join(',');
        const down = pos > from;
        if (technique === 'keyboard') await keyboardMove(items[from], from, pos);
        else if (technique === 'pointer') await pointerMove(items[from], items[pos], down);
        else await html5Move(items[from], items[pos], down);

        if (await waitForChange(before)) {
          working = technique;
          // If the item did not land exactly, retry this position on the next pass
          if (getItems().map(idOf).indexOf(targets[pos]) !== pos) pos--;
          break;
        }
      }
    }

    const finalOrder = currentOrder();
    const ok = isDone();
    return {
      success: ok,
      isVerifiedCorrect: ok,
      verifiedOrder: finalOrder,
      message: ok
        ? `Arranged in sequence: [${targets.join(' → ')}]${working ? ` using ${working} drag` : ''}`
        : `Could not finish the drag and drop. Page order: [${finalOrder.join(' → ')}], wanted: [${targets.join(' → ')}]`,
    };
  }

  /**
   * Finds an enabled, visible Submit or Next control.
   *
   * Matching is strict on purpose. The old finder clicked anything whose text merely contained
   * "next" or started with "submit": links like "Next.js docs", "Submit Test" or "Submit
   * Assessment". Those end the attempt or navigate away, which silently killed the Auto-Loop.
   */
  public findActionButton(kind: 'submit' | 'next', near?: Element | null): HTMLElement | null {
    const SUBMIT_TEXT = /^(submit|submit answer|check|check answer)$/;
    const NEXT_TEXT = /^(next|next question|save (and|&) next|save next|continue|proceed|go to next( question)?)$/;
    const ARROWS = new Set(['→', '›', '»', '>', '->', '⟶']);

    const labelOf = (btn: HTMLElement) =>
      (btn.innerText || btn.textContent || btn.getAttribute('value') || btn.getAttribute('aria-label') || '')
        .replace(/\s+/g, ' ')
        .trim();

    const matches = Array.from(
      document.querySelectorAll<HTMLElement>('button, input[type="button"], input[type="submit"], [role="button"], a'),
    ).filter((btn) => {
      if (btn.closest('#ai-mcq-assistant-root')) return false;
      if (btn.hasAttribute('disabled') || (btn as any).disabled || btn.getAttribute('aria-disabled') === 'true') return false;
      if (btn.tagName === 'A') {
        if (kind === 'submit') return false;
        const href = btn.getAttribute('href') || '';
        // A real link navigates away and ends the loop; only in-page links are allowed
        if (href && !href.startsWith('#') && !href.toLowerCase().startsWith('javascript:')) return false;
      }
      const raw = labelOf(btn);
      if (!raw || raw.length > 30) return false;
      const norm = raw
        .toLowerCase()
        .replace(/[^a-z& ]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      const textOk = kind === 'submit' ? SUBMIT_TEXT.test(norm) : NEXT_TEXT.test(norm) || (!norm && ARROWS.has(raw));
      return textOk && isRendered(btn);
    });

    if (matches.length <= 1 || !near) return matches[0] || null;

    // Several candidates: take the one closest to the question
    const r = near.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const dist = (el: HTMLElement) => {
      const b = el.getBoundingClientRect();
      return Math.hypot(b.left + b.width / 2 - cx, b.top + b.height / 2 - cy);
    };
    return matches.sort((a, b) => dist(a) - dist(b))[0];
  }

  private async waitAndClickAction(
    kind: 'submit' | 'next',
    timeoutMs: number,
    near?: Element | null,
  ): Promise<{ success: boolean; message: string }> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      const btn = this.findActionButton(kind, near);
      if (btn) {
        if (typeof btn.scrollIntoView === 'function') {
          btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        btn.click();
        const label = (btn.innerText || btn.textContent || btn.getAttribute('value') || '').trim();
        return { success: true, message: `Clicked ${kind.toUpperCase()} button: "${label}"` };
      }
      await sleep(200);
    }
    return {
      success: false,
      message: kind === 'submit' ? 'No active SUBMIT button found within timeout.' : 'Timed out waiting for NEXT button.',
    };
  }

  /**
   * Finds and clicks the Submit button on the webpage, waiting while it is disabled.
   */
  public async clickSubmitButton(timeoutMs: number = 5000, near?: Element | null): Promise<{ success: boolean; message: string }> {
    return this.waitAndClickAction('submit', timeoutMs, near);
  }

  /**
   * Waits until a NEXT button appears (portals often show it only after submitting) and clicks it.
   */
  public async waitForAndClickNextButton(timeoutMs: number = 15000, near?: Element | null): Promise<{ success: boolean; message: string }> {
    return this.waitAndClickAction('next', timeoutMs, near);
  }

  /**
   * Inspects the webpage DOM after submission to detect whether the answer was correct,
   * and extracts the verified ground-truth answer revealed by the portal.
   */
  public inspectSubmissionResult(
    options: OptionItem[],
    selectedOptionId?: string,
  ): {
    isCorrect?: boolean;
    actualCorrectOptionId?: string;
    actualCorrectOptionText?: string;
  } {
    let isCorrect: boolean | undefined = undefined;
    let actualCorrectOptionId: string | undefined = undefined;
    let actualCorrectOptionText: string | undefined = undefined;

    // 1. Check score badge (e.g. "0" with red cross vs "1" with green checkmark)
    const scoreBadges = Array.from(document.querySelectorAll<HTMLElement>('div, span, p')).filter((el) => {
      const t = el.textContent?.trim();
      return (t === '0' || t === '1') && el.clientWidth > 0 && el.clientHeight > 0;
    });

    for (const badge of scoreBadges) {
      const parent = badge.parentElement;
      const html = (parent?.innerHTML || '').toLowerCase();
      if (
        html.includes('red') ||
        html.includes('cross') ||
        html.includes('error') ||
        html.includes('wrong') ||
        html.includes('x') ||
        html.includes('close')
      ) {
        if (badge.textContent?.trim() === '0') isCorrect = false;
      }
      if (
        html.includes('green') ||
        html.includes('check') ||
        html.includes('success') ||
        html.includes('tick')
      ) {
        if (badge.textContent?.trim() === '1') isCorrect = true;
      }
    }

    // 2. Scan options on the webpage to find the verified green option(s) and red option(s)
    const allInputs = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[type="radio"], input[type="checkbox"]'),
    );
    const allOptionContainers = Array.from(
      document.querySelectorAll<HTMLElement>('label, li, [class*="option" i]'),
    ).filter((el) => el.querySelectorAll('input').length <= 1);

    const actualCorrectOptionIds: string[] = [];

    options.forEach((opt, idx) => {
      const normOptText = opt.text.trim().toLowerCase();
      let optElem: HTMLElement | null = null;
      if (idx < allInputs.length) {
        optElem = allInputs[idx].closest('label, li, div');
      }
      if (!optElem) {
        optElem =
          allOptionContainers.find((c) => (c.textContent || '').toLowerCase().includes(normOptText)) || null;
      }

      if (optElem) {
        const html = optElem.innerHTML.toLowerCase();
        const style = typeof window !== 'undefined' && window.getComputedStyle ? window.getComputedStyle(optElem) : ({} as any);
        const color = style.color || '';

        const isGreen =
          html.includes('green') ||
          html.includes('check') ||
          html.includes('tick') ||
          html.includes('correct') ||
          color.includes('green') ||
          color.includes('34, 197, 94') ||
          color.includes('40, 167, 69') ||
          optElem.querySelector('svg[class*="check" i], [class*="correct" i], [class*="success" i]');

        const isRed =
          html.includes('red') ||
          html.includes('cross') ||
          html.includes('incorrect') ||
          html.includes('wrong') ||
          color.includes('red') ||
          color.includes('239, 68, 68') ||
          color.includes('220, 53, 69') ||
          optElem.querySelector('svg[class*="cross" i], [class*="wrong" i], [class*="error" i]');

        if (isGreen) {
          actualCorrectOptionIds.push(opt.id);
          actualCorrectOptionId = opt.id;
          actualCorrectOptionText = opt.text;
          if (selectedOptionId && selectedOptionId.includes(opt.id)) {
            isCorrect = true;
          }
        }

        if (isRed) {
          if (selectedOptionId && selectedOptionId.includes(opt.id)) {
            isCorrect = false;
          }
        }
      }
    });

    if (actualCorrectOptionIds.length > 0) {
      actualCorrectOptionId = actualCorrectOptionIds.join(', ');
    }

    if (actualCorrectOptionId && selectedOptionId && actualCorrectOptionId !== selectedOptionId) {
      isCorrect = false;
    } else if (actualCorrectOptionId && selectedOptionId && actualCorrectOptionId === selectedOptionId) {
      isCorrect = true;
    }

    return {
      isCorrect,
      actualCorrectOptionId,
      actualCorrectOptionText,
    };
  }

  /**
   * Finds and clicks the Next Question / Continue button immediately if present.
   */
  public navigateNextQuestion(): { success: boolean; message: string } {
    const btn = this.findActionButton('next');
    if (!btn) {
      return { success: false, message: 'No suitable Next/Continue button detected on page.' };
    }
    if (typeof btn.scrollIntoView === 'function') {
      btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    btn.click();
    return { success: true, message: `Clicked navigation button: "${(btn.innerText || btn.textContent || '').trim()}"` };
  }

  private findOptionFallback(optionId: string): HTMLElement | null {
    // Check radio or checkbox inputs with matching value
    const inputWithValue = document.querySelector<HTMLElement>(
      `input[type="radio"][value="${CSS.escape(optionId)}"], input[type="checkbox"][value="${CSS.escape(optionId)}"]`,
    );
    if (inputWithValue) return inputWithValue;

    // Check labels or spans with matching data-id or text
    const labelWithText = Array.from(
      document.querySelectorAll('label, [role="radio"], [role="checkbox"]'),
    ).find((el) => el.textContent?.trim().startsWith(optionId));
    return (labelWithText as HTMLElement) || null;
  }
}
