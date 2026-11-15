import { OptionItem } from '@ai-mcq/shared-types';

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

    // 1. Target by Option Text Matching (Most reliable on dynamic portals)
    if (optionText && optionText.trim()) {
      const normTarget = optionText.trim().toLowerCase();

      // Check all inputs (radios & checkboxes) with their specific labels only
      const allInputs = Array.from(
        document.querySelectorAll<HTMLInputElement>('input[type="radio"], input[type="checkbox"]'),
      );
      for (const input of allInputs) {
        let labelText = '';

        // Check HTML5 label association
        if (input.labels && input.labels.length > 0) {
          labelText = (input.labels[0].textContent || '').trim().toLowerCase();
        } else if (input.id) {
          const lbl = document.querySelector(`label[for="${input.id}"]`);
          if (lbl) labelText = (lbl.textContent || '').trim().toLowerCase();
        }

        // Check closest label tag
        if (!labelText) {
          const parentLabel = input.closest('label');
          if (parentLabel && parentLabel.querySelectorAll('input').length === 1) {
            labelText = (parentLabel.textContent || '').trim().toLowerCase();
          }
        }

        // Check immediate parent or sibling only if isolated to this input
        if (!labelText && input.parentElement) {
          const parent = input.parentElement;
          if (parent.querySelectorAll('input').length === 1) {
            labelText = (parent.textContent || '').trim().toLowerCase();
          }
        }

        if (labelText && (labelText.includes(normTarget) || normTarget.includes(labelText))) {
          targetElement = input;
          break;
        }
      }

      // Check all isolated option containers / labels
      if (!targetElement) {
        const allLabels = Array.from(
          document.querySelectorAll<HTMLElement>(
            'label, [role="radio"], [role="checkbox"], .radio, .checkbox, .option, li',
          ),
        );
        for (const lbl of allLabels) {
          if (lbl.querySelectorAll('input').length > 1) continue;

          const text = lbl.textContent?.trim().toLowerCase() || '';
          if (text && (text.includes(normTarget) || normTarget.includes(text))) {
            const innerInput = lbl.querySelector<HTMLInputElement>(
              'input[type="radio"], input[type="checkbox"]',
            );
            targetElement = innerInput || lbl;
            break;
          }
        }
      }
    }

    // 2. Target by Positional Index (Option A -> index 0, Option B -> index 1, Option C -> index 2, Option D -> index 3)
    if (!targetElement) {
      const optionIndex = this.getOptionIndex(optionId);
      if (optionIndex >= 0) {
        const allInputs = Array.from(
          document.querySelectorAll<HTMLInputElement>('input[type="radio"], input[type="checkbox"]'),
        );
        if (allInputs.length > optionIndex) {
          targetElement = allInputs[optionIndex];
        } else {
          const ariaInputs = Array.from(
            document.querySelectorAll<HTMLElement>('[role="radio"], [role="checkbox"]'),
          );
          if (ariaInputs.length > optionIndex) {
            targetElement = ariaInputs[optionIndex];
          }
        }
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

    // Scroll into view gently
    if (typeof targetElement.scrollIntoView === 'function') {
      targetElement.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    // Focus
    targetElement.focus?.();

    if (targetElement instanceof HTMLInputElement) {
      if (targetElement.type === 'checkbox') {
        if (!targetElement.checked) {
          targetElement.click();
        }
      } else {
        targetElement.checked = true;
        targetElement.dispatchEvent(new Event('input', { bubbles: true }));
        targetElement.dispatchEvent(new Event('change', { bubbles: true }));
        targetElement.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        targetElement.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
        targetElement.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      }

      // Also dispatch click on enclosing label/div for React/Angular component frameworks
      const parentWrapper = targetElement.closest('label, [class*="radio" i], [class*="checkbox" i], [class*="option" i], li, div');
      if (parentWrapper && parentWrapper !== targetElement && parentWrapper !== document.body) {
        parentWrapper.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        parentWrapper.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
        parentWrapper.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      }

      const isVerified = targetElement.checked;
      return {
        success: isVerified,
        message: isVerified
          ? `Successfully selected option ${optionId}`
          : `Attempted selection on option ${optionId}, but element did not confirm checked state.`,
      };
    } else {
      // Click container, label or custom ARIA radio/checkbox
      const innerInput = targetElement.querySelector<HTMLInputElement>(
        'input[type="radio"], input[type="checkbox"]',
      );
      if (innerInput) {
        if (innerInput.type === 'checkbox') {
          if (!innerInput.checked) {
            innerInput.click();
          }
        } else {
          innerInput.checked = true;
          innerInput.dispatchEvent(new Event('input', { bubbles: true }));
          innerInput.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }

      targetElement.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      targetElement.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
      targetElement.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

      if (targetElement.getAttribute('role') === 'radio' || targetElement.getAttribute('role') === 'checkbox') {
        targetElement.setAttribute('aria-checked', 'true');
      }

      return {
        success: true,
        message: `Triggered selection click for option ${optionId}`,
      };
    }
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
      // 1. Target by Option Text Matching (most reliable on dynamic React portals)
      if (opt.text && opt.text.trim().length > 3) {
        const normTarget = opt.text.trim().toLowerCase();

        // Check all checkbox inputs
        const allInputs = Array.from(
          document.querySelectorAll<HTMLInputElement>('input[type="checkbox"], input[type="radio"]'),
        );
        for (const input of allInputs) {
          let labelText = '';
          if (input.labels && input.labels.length > 0) {
            labelText = (input.labels[0].textContent || '').trim().toLowerCase();
          } else if (input.id) {
            const lbl = document.querySelector(`label[for="${input.id}"]`);
            if (lbl) labelText = (lbl.textContent || '').trim().toLowerCase();
          }
          if (!labelText && input.closest('label')) {
            labelText = (input.closest('label')?.textContent || '').trim().toLowerCase();
          }
          if (labelText && (labelText.includes(normTarget) || normTarget.includes(labelText))) {
            return input;
          }
        }

        // Check custom checkbox/radio containers
        const allLabels = Array.from(
          document.querySelectorAll<HTMLElement>(
            'label, [role="checkbox"], [role="radio"], [class*="checkbox" i], [class*="option" i], li',
          ),
        );
        for (const lbl of allLabels) {
          if (lbl.querySelectorAll('input').length > 1) continue;
          const text = (lbl.textContent || '').trim().toLowerCase();
          if (text && (text.includes(normTarget) || normTarget.includes(text))) {
            const innerInput = lbl.querySelector<HTMLInputElement>('input[type="checkbox"], input[type="radio"]');
            return innerInput || lbl;
          }
        }
      }

      // 2. Target by elementSelector
      if (opt.elementSelector) {
        try {
          const el = document.querySelector<HTMLElement>(opt.elementSelector);
          if (el) return el;
        } catch (e) {}
      }

      // 3. Target by Positional Index
      const idx = this.getOptionIndex(opt.id);
      if (idx >= 0) {
        const allInputs = Array.from(
          document.querySelectorAll<HTMLElement>(
            'input[type="checkbox"], [role="checkbox"], [class*="checkbox" i], input[type="radio"]',
          ),
        );
        if (idx < allInputs.length) {
          return allInputs[idx];
        }
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
        if (innerInput.checked !== select) {
          innerInput.click();
          if (innerInput.checked !== select) {
            innerInput.checked = select;
            innerInput.dispatchEvent(new Event('input', { bubbles: true }));
            innerInput.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }
        return;
      }

      const currentlyChecked = isElementChecked(el);
      if (currentlyChecked !== select) {
        el.click();
        if (el.getAttribute('role') === 'checkbox' || el.getAttribute('role') === 'radio') {
          el.setAttribute('aria-checked', select ? 'true' : 'false');
        }
      }
    };

    if (options.length > 0) {
      for (const opt of options) {
        const optId = opt.id.replace(/^option\s*/i, '').trim().toUpperCase();
        const altId = letterToNum[optId] || numToLetter[optId];
        const shouldBeSelected = normTargets.has(optId) || (altId ? normTargets.has(altId) : false);

        const el = findOptionElement(opt);
        if (el) {
          const checked = isElementChecked(el);

          if (shouldBeSelected && !checked) {
            toggleOption(el, true);
            selectedCount++;
          } else if (!shouldBeSelected && checked) {
            toggleOption(el, false);
          } else if (shouldBeSelected && checked) {
            selectedCount++;
          }
        }
      }

      return {
        success: true,
        message: `Selected ${selectedCount} option(s): [${Array.from(normTargets).join(', ')}]`,
        selectedCount,
      };
    }

    return {
      success: false,
      message: 'No options provided to selectMultipleOptions',
      selectedCount: 0,
    };
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
   * Executes drag and drop reordering directly in the page's main context (MAIN WORLD).
   * Ensures React Beautiful DnD window listeners receive real events.
   */
  private async executePageContextReorder(
    targetSequence: string[],
    options: OptionItem[] = [],
  ): Promise<boolean> {
    try {
      const channel = 'dnd_reorder_' + Math.random().toString(36).substring(2, 9);
      const script = document.createElement('script');
      script.textContent = `
        (async function() {
          try {
            const targets = ${JSON.stringify(targetSequence)};
            const options = ${JSON.stringify(options)};
            const droppable = document.querySelector('[data-rbd-droppable-id], [data-rfd-droppable-id]');
            
            const getItems = () => {
              if (droppable && droppable.children.length >= 2) {
                return Array.from(droppable.children);
              }
              const found = Array.from(document.querySelectorAll('[data-rbd-draggable-id], [data-rfd-draggable-id], [draggable="true"], [class*="dnd-item"], [class*="draggable"]'));
              return found.filter(el => {
                const t = (el.textContent || '').trim().toLowerCase();
                return !t.startsWith('submit') && !t.startsWith('show') && !t.startsWith('skip') && el.clientHeight > 15;
              });
            };

            const findHandle = (el) => {
              return el.querySelector('[data-rbd-drag-handle-draggable-id], [data-rfd-drag-handle-draggable-id], [class*="handle"], [class*="grip"], span') || el;
            };

            for (let i = 0; i < targets.length; i++) {
              const desiredId = targets[i];
              const items = getItems();
              let currentIdx = -1;

              for (let j = 0; j < items.length; j++) {
                const text = (items[j].textContent || '').toLowerCase().replace(/[^a-z0-9]/g, '');
                const opt = options.find(o => o.id === desiredId);
                const optText = opt ? opt.text.toLowerCase().replace(/[^a-z0-9]/g, '') : '';
                if (j === parseInt(desiredId, 10) - 1 || (optText && text.includes(optText))) {
                  currentIdx = j;
                  break;
                }
              }

              if (currentIdx >= 0 && currentIdx !== i && i < items.length) {
                const src = items[currentIdx];
                const handle = findHandle(src);
                handle.focus();
                
                handle.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', keyCode: 32, which: 32, bubbles: true, cancelable: true }));
                await new Promise(r => setTimeout(r, 60));

                const isDown = i > currentIdx;
                const steps = Math.abs(i - currentIdx);
                const arrowKey = isDown ? 'ArrowDown' : 'ArrowUp';
                const arrowCode = isDown ? 40 : 38;

                for (let s = 0; s < steps; s++) {
                  handle.dispatchEvent(new KeyboardEvent('keydown', { key: arrowKey, code: arrowKey, keyCode: arrowCode, which: arrowCode, bubbles: true, cancelable: true }));
                  await new Promise(r => setTimeout(r, 50));
                }

                handle.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', keyCode: 32, which: 32, bubbles: true, cancelable: true }));
                await new Promise(r => setTimeout(r, 100));
              }
            }

            if (droppable && targets.length > 0) {
              const currentItems = Array.from(droppable.children);
              const targetItems = [];
              targets.forEach(tId => {
                const opt = options.find(o => o.id === tId);
                const optText = opt ? opt.text.toLowerCase().replace(/[^a-z0-9]/g, '') : '';
                const match = currentItems.find(it => {
                  const itText = (it.textContent || '').toLowerCase().replace(/[^a-z0-9]/g, '');
                  return optText && itText.includes(optText);
                });
                if (match) targetItems.push(match);
              });

              if (targetItems.length === currentItems.length) {
                targetItems.forEach(node => droppable.appendChild(node));
              }
            }

            window.postMessage({ channel: '${channel}', success: true }, '*');
          } catch (e) {
            window.postMessage({ channel: '${channel}', success: false, error: e.message }, '*');
          }
        })();
      `;

      return new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => {
          window.removeEventListener('message', onMsg);
          resolve(false);
        }, 3000);

        const onMsg = (evt: MessageEvent) => {
          if (evt.data && evt.data.channel === channel) {
            clearTimeout(timeout);
            window.removeEventListener('message', onMsg);
            resolve(!!evt.data.success);
          }
        };

        window.addEventListener('message', onMsg);
        (document.head || document.documentElement).appendChild(script);
        script.remove();
      });
    } catch (e) {
      return false;
    }
  }

  /**
   * Reorders draggable / sortable options on the webpage into targetSequence.
   * Employs keyboard navigation (react-beautiful-dnd), mouse/pointer drag simulation,
   * and HTML5 DragEvent dispatches. Verifies actual DOM element positions before finishing.
   */
  public async reorderOptions(
    targetSequence: string[],
    options: OptionItem[] = [],
  ): Promise<{
    success: boolean;
    isVerifiedCorrect: boolean;
    verifiedOrder: string[];
    message: string;
  }> {
    if (!targetSequence || targetSequence.length === 0) {
      return {
        success: false,
        isVerifiedCorrect: false,
        verifiedOrder: [],
        message: 'No target sequence provided for reordering.',
      };
    }

    const cleanTargets = targetSequence
      .flatMap((id) => id.split(/[,;\->\s]+/))
      .map((s) => s.trim())
      .filter(Boolean);

    // 0. Primary Strategy: Try page context React Beautiful DnD reordering
    await this.executePageContextReorder(cleanTargets, options);

    // 1. Locate all draggable elements currently in DOM
    const getDraggableElements = (): HTMLElement[] => {
      // Strategy 0: react-beautiful-dnd droppable container children
      const droppable = document.querySelector<HTMLElement>('[data-rbd-droppable-id], [data-rfd-droppable-id]');
      if (droppable && droppable.children.length >= 2) {
        const directChildren = Array.from(droppable.children) as HTMLElement[];
        if (directChildren.length >= 2) return directChildren;
      }

      // Strategy A: react-beautiful-dnd items
      let items = Array.from(
        document.querySelectorAll<HTMLElement>('[data-rbd-draggable-id], [data-rfd-draggable-id]'),
      );
      if (items.length >= 2) return items;

      // Strategy B: Drag handle parents
      const handles = Array.from(
        document.querySelectorAll<HTMLElement>(
          '[data-rbd-drag-handle-draggable-id], [data-rfd-drag-handle-draggable-id]',
        ),
      );
      if (handles.length >= 2) {
        const fromHandles = handles
          .map((h) => h.closest<HTMLElement>('[data-rbd-draggable-id], [data-rfd-draggable-id]') || (h.parentElement as HTMLElement))
          .filter(Boolean);
        if (fromHandles.length >= 2) return fromHandles;
      }

      // Strategy C: HTML5 draggable="true"
      items = Array.from(document.querySelectorAll<HTMLElement>('[draggable="true"]'));
      if (items.length >= 2) return items;

      // Strategy D: option elementSelectors
      if (options.length >= 2) {
        const fromSelectors = options
          .map((o) => (o.elementSelector ? document.querySelector<HTMLElement>(o.elementSelector) : null))
          .filter(Boolean) as HTMLElement[];
        if (fromSelectors.length >= 2) return fromSelectors;
      }

      // Strategy E: classes
      items = Array.from(
        document.querySelectorAll<HTMLElement>(
          '[class*="draggable" i], [class*="drag-item" i], [class*="sortable" i], [class*="reorder" i]',
        ),
      ).filter((el) => {
        const t = (el.textContent || '').trim().toLowerCase();
        return !t.startsWith('submit') && !t.startsWith('show answer') && !t.startsWith('skip') && el.clientHeight > 15;
      });
      return items;
    };

    let domItems = getDraggableElements();
    if (domItems.length < 2) {
      return {
        success: false,
        isVerifiedCorrect: false,
        verifiedOrder: [],
        message: 'Could not find draggable items on the webpage.',
      };
    }

    // Helper: Normalize strings for reliable text matching
    const normalizeForMatch = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

    // Helper: Map each current DOM element to an option ID by matching text
    const getElementId = (el: HTMLElement): string => {
      const normEl = normalizeForMatch(el.textContent || '');
      for (const opt of options) {
        const normOpt = normalizeForMatch(opt.text);
        if (normOpt && (normEl.includes(normOpt) || normOpt.includes(normEl))) {
          return opt.id;
        }
      }
      return '';
    };

    // Helper: Get current order of option IDs in DOM from top to bottom
    const getCurrentOrder = (): string[] => {
      const currentItems = getDraggableElements();
      return currentItems.map((el, idx) => {
        const matched = getElementId(el);
        return matched || String(idx + 1);
      });
    };

    const findHandle = (el: HTMLElement): HTMLElement => {
      return (
        el.querySelector<HTMLElement>(
          '[data-rbd-drag-handle-draggable-id], [data-rfd-drag-handle-draggable-id], [class*="handle" i], [class*="grip" i], svg, [role="button"]',
        ) || el
      );
    };

    // Method 1: Mouse and Pointer Drag simulation with interpolated movement and window events
    const tryPointerMouseDrag = async (
      sourceEl: HTMLElement,
      targetEl: HTMLElement,
      isMovingDown: boolean,
    ): Promise<void> => {
      try {
        const sourceHandle = findHandle(sourceEl);
        if (typeof sourceHandle.scrollIntoView === 'function') {
          sourceHandle.scrollIntoView({ behavior: 'instant', block: 'nearest' });
        }

        const sRect = sourceHandle.getBoundingClientRect();
        const tRect = targetEl.getBoundingClientRect();

        const startX = sRect.left + sRect.width / 2;
        const startY = sRect.top + sRect.height / 2;
        const endX = tRect.left + tRect.width / 2;
        const endY = isMovingDown ? tRect.bottom + 8 : tRect.top - 8;

        const pointerId = 1;

        // 1. Pointer & Mouse down on source handle
        sourceHandle.dispatchEvent(
          new PointerEvent('pointerdown', {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: startX,
            clientY: startY,
            button: 0,
            buttons: 1,
            pointerId,
            isPrimary: true,
          }),
        );
        sourceHandle.dispatchEvent(
          new MouseEvent('mousedown', {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: startX,
            clientY: startY,
            button: 0,
            buttons: 1,
          }),
        );
        await new Promise((r) => setTimeout(r, 40));

        // 2. Drag threshold overcome: move 8px
        const deltaYInit = isMovingDown ? 10 : -10;
        window.dispatchEvent(
          new PointerEvent('pointermove', {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: startX,
            clientY: startY + deltaYInit,
            button: 0,
            buttons: 1,
            pointerId,
            isPrimary: true,
          }),
        );
        window.dispatchEvent(
          new MouseEvent('mousemove', {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: startX,
            clientY: startY + deltaYInit,
            button: 0,
            buttons: 1,
          }),
        );
        await new Promise((r) => setTimeout(r, 30));

        // 3. Interpolate movement to destination
        const steps = 8;
        for (let s = 1; s <= steps; s++) {
          const curX = startX + (endX - startX) * (s / steps);
          const curY = startY + (endY - startY) * (s / steps);

          const pMove = new PointerEvent('pointermove', {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: curX,
            clientY: curY,
            button: 0,
            buttons: 1,
            pointerId,
            isPrimary: true,
          });
          const mMove = new MouseEvent('mousemove', {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: curX,
            clientY: curY,
            button: 0,
            buttons: 1,
          });

          window.dispatchEvent(pMove);
          window.dispatchEvent(mMove);
          targetEl.dispatchEvent(pMove);
          targetEl.dispatchEvent(mMove);

          await new Promise((r) => setTimeout(r, 25));
        }

        await new Promise((r) => setTimeout(r, 40));

        // 4. Pointer & Mouse up
        const pUp = new PointerEvent('pointerup', {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: endX,
          clientY: endY,
          button: 0,
          buttons: 0,
          pointerId,
          isPrimary: true,
        });
        const mUp = new MouseEvent('mouseup', {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: endX,
          clientY: endY,
          button: 0,
          buttons: 0,
        });

        targetEl.dispatchEvent(pUp);
        targetEl.dispatchEvent(mUp);
        window.dispatchEvent(pUp);
        window.dispatchEvent(mUp);
        document.dispatchEvent(mUp);

        await new Promise((r) => setTimeout(r, 120));
      } catch (e) {}
    };

    // Method 2: Accessible Keyboard simulation (react-beautiful-dnd standard)
    const tryKeyboardDrag = async (
      sourceEl: HTMLElement,
      stepsCount: number,
      isMovingDown: boolean,
    ): Promise<void> => {
      try {
        const sourceHandle = findHandle(sourceEl);
        sourceHandle.focus?.();
        await new Promise((r) => setTimeout(r, 40));

        const spaceDown = new KeyboardEvent('keydown', {
          key: ' ',
          code: 'Space',
          keyCode: 32,
          which: 32,
          bubbles: true,
          cancelable: true,
        });
        sourceHandle.dispatchEvent(spaceDown);
        await new Promise((r) => setTimeout(r, 80));

        const arrowKey = isMovingDown ? 'ArrowDown' : 'ArrowUp';
        const arrowCode = isMovingDown ? 40 : 38;

        for (let s = 0; s < stepsCount; s++) {
          const arrowEvt = new KeyboardEvent('keydown', {
            key: arrowKey,
            code: arrowKey,
            keyCode: arrowCode,
            which: arrowCode,
            bubbles: true,
            cancelable: true,
          });
          sourceHandle.dispatchEvent(arrowEvt);
          await new Promise((r) => setTimeout(r, 60));
        }

        const spaceDrop = new KeyboardEvent('keydown', {
          key: ' ',
          code: 'Space',
          keyCode: 32,
          which: 32,
          bubbles: true,
          cancelable: true,
        });
        sourceHandle.dispatchEvent(spaceDrop);
        await new Promise((r) => setTimeout(r, 120));
      } catch (e) {}
    };

    // Method 3: HTML5 native drag and drop
    const tryHtml5Drag = async (sourceEl: HTMLElement, targetEl: HTMLElement): Promise<void> => {
      try {
        let dt: DataTransfer;
        try {
          dt = new DataTransfer();
        } catch (e) {
          dt = {} as any;
        }
        if (dt.setData) {
          try {
            dt.setData('text/plain', sourceEl.textContent || '');
          } catch (e) {}
        }

        sourceEl.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
        await new Promise((r) => setTimeout(r, 40));

        targetEl.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
        targetEl.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
        await new Promise((r) => setTimeout(r, 40));

        targetEl.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
        await new Promise((r) => setTimeout(r, 40));

        sourceEl.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }));
        await new Promise((r) => setTimeout(r, 120));
      } catch (e) {}
    };

    // Helper: move single item from source to destination position using multi-strategy fallback
    const moveItem = async (
      sourceEl: HTMLElement,
      targetEl: HTMLElement,
      fromIdx: number,
      toIdx: number,
    ): Promise<boolean> => {
      const isMovingDown = toIdx > fromIdx;
      const steps = Math.abs(toIdx - fromIdx);
      const beforeOrder = getCurrentOrder().join(',');

      // 1. Try Pointer + Mouse Drag
      await tryPointerMouseDrag(sourceEl, targetEl, isMovingDown);
      let afterOrder = getCurrentOrder().join(',');
      if (afterOrder !== beforeOrder) return true;

      // 2. Try Keyboard Drag
      await tryKeyboardDrag(sourceEl, steps, isMovingDown);
      afterOrder = getCurrentOrder().join(',');
      if (afterOrder !== beforeOrder) return true;

      // 3. Try HTML5 Drag
      await tryHtml5Drag(sourceEl, targetEl);
      afterOrder = getCurrentOrder().join(',');
      if (afterOrder !== beforeOrder) return true;

      return false;
    };

    // Iteratively arrange items in target sequence
    for (let pass = 0; pass < 2; pass++) {
      let anyMovedInPass = false;

      for (let targetIndex = 0; targetIndex < cleanTargets.length; targetIndex++) {
        const desiredId = cleanTargets[targetIndex];
        domItems = getDraggableElements();

        // Check if item at targetIndex already matches desiredId
        if (targetIndex < domItems.length && getElementId(domItems[targetIndex]) === desiredId) {
          continue;
        }

        // Find which DOM item currently has desiredId
        let currentItemIndex = -1;
        for (let idx = 0; idx < domItems.length; idx++) {
          const id = getElementId(domItems[idx]);
          if (id === desiredId || (!id && idx === parseInt(desiredId, 10) - 1)) {
            currentItemIndex = idx;
            break;
          }
        }

        if (currentItemIndex >= 0 && currentItemIndex !== targetIndex && targetIndex < domItems.length) {
          const sourceItem = domItems[currentItemIndex];
          const destItem = domItems[targetIndex];
          const moved = await moveItem(sourceItem, destItem, currentItemIndex, targetIndex);
          if (moved) {
            anyMovedInPass = true;
          }
          await new Promise((r) => setTimeout(r, 120));
        }
      }

      // Check if current order matches cleanTargets
      const currentOrder = getCurrentOrder();
      if (
        currentOrder.length === cleanTargets.length &&
        currentOrder.every((id, i) => id === cleanTargets[i])
      ) {
        break;
      }

      if (!anyMovedInPass) {
        break;
      }
    }

    // Verify ground-truth DOM state
    const finalOrder = getCurrentOrder();
    const isVerifiedCorrect =
      finalOrder.length === cleanTargets.length &&
      finalOrder.every((id, idx) => id === cleanTargets[idx]);

    return {
      success: isVerifiedCorrect,
      isVerifiedCorrect,
      verifiedOrder: finalOrder,
      message: isVerifiedCorrect
        ? `Successfully arranged steps in sequence: [${cleanTargets.join(' → ')}]`
        : `Step reorder could not be fully verified on page. Current: [${finalOrder.join(' → ')}], Expected: [${cleanTargets.join(' → ')}]`,
    };
  }

  /**
   * Finds and clicks the Submit button on the webpage with dynamic wait if disabled.
   */
  public async clickSubmitButton(timeoutMs: number = 5000): Promise<{ success: boolean; message: string }> {
    const submitSelectors = [
      'button',
      'input[type="button"]',
      'input[type="submit"]',
      'div[role="button"]',
      'a.btn',
    ];

    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      const candidates = Array.from(document.querySelectorAll<HTMLElement>(submitSelectors.join(', ')));
      for (const btn of candidates) {
        const text = (btn.textContent || btn.getAttribute('value') || '').trim().toLowerCase();
        if (text === 'submit' || text.startsWith('submit')) {
          // Check if disabled
          const isDisabled = btn.hasAttribute('disabled') || (btn as any).disabled;
          if (!isDisabled) {
            if (typeof btn.scrollIntoView === 'function') {
              btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
            btn.click();
            return {
              success: true,
              message: 'Clicked SUBMIT button.',
            };
          }
        }
      }
      await new Promise((r) => setTimeout(r, 150));
    }

    return {
      success: false,
      message: 'No active SUBMIT button found within timeout.',
    };
  }

  /**
   * Dynamically waits until the NEXT button appears in the DOM and clicks it.
   * Completely eliminates static timeout errors when portal answer submission takes time.
   */
  public async waitForAndClickNextButton(timeoutMs: number = 15000): Promise<{ success: boolean; message: string }> {
    const nextSelectors = [
      'button',
      'input[type="button"]',
      'input[type="submit"]',
      'div[role="button"]',
      'a.btn',
      'a',
    ];

    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      const candidates = Array.from(document.querySelectorAll<HTMLElement>(nextSelectors.join(', ')));
      for (const btn of candidates) {
        const text = (btn.textContent || btn.getAttribute('value') || '').trim().toLowerCase();
        if (
          text === 'next' ||
          text === 'next question' ||
          text.startsWith('next') ||
          text.includes('next') ||
          text.includes('continue') ||
          text === '→'
        ) {
          // Ensure element is visible
          const style = typeof window !== 'undefined' && window.getComputedStyle ? window.getComputedStyle(btn) : (btn.style as any);
          const isHidden = style && (style.display === 'none' || style.visibility === 'hidden');
          const isDisabled = btn.hasAttribute('disabled') || (btn as any).disabled;

          if (!isHidden && !isDisabled) {
            if (typeof btn.scrollIntoView === 'function') {
              btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
            btn.click();
            return {
              success: true,
              message: `Detected and clicked NEXT button: "${text}"`,
            };
          }
        }
      }
      await new Promise((r) => setTimeout(r, 150));
    }

    return {
      success: false,
      message: 'Timed out waiting for NEXT button to appear after submission.',
    };
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
    const nextSelectors = [
      'button',
      'input[type="button"]',
      'input[type="submit"]',
      'div[role="button"]',
      'a.btn',
      'a',
    ];

    const candidates = Array.from(document.querySelectorAll<HTMLElement>(nextSelectors.join(', ')));
    for (const btn of candidates) {
      const text = (btn.textContent || btn.getAttribute('value') || '').trim().toLowerCase();
      if (
        text === 'next' ||
        text === 'next question' ||
        text.includes('next') ||
        text.includes('continue') ||
        text.includes('forward') ||
        text === '→'
      ) {
        if (typeof btn.scrollIntoView === 'function') {
          btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        btn.click();
        return {
          success: true,
          message: `Clicked navigation button: "${text}"`,
        };
      }
    }

    return {
      success: false,
      message: 'No suitable Next/Continue button detected on page.',
    };
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
