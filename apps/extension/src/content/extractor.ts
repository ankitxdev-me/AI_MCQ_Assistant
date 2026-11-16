import { ExtractedQuestion, OptionItem } from '@ai-mcq/shared-types';
import { createQuestionFingerprint } from './fingerprint';
import { isRendered, isOptionRendered } from './visibility';
import { collectQuestionContext, resolveOptionElement, nearbyQuestionText } from './media';
import { expandToItemRows, hasItemText } from './dnd';
import { isCodeBlock, findCodeBlocks, textWithoutCode, stripJunkChars } from './code';

/** Prompt used when a question exists only as an image or figure. */
export const VISUAL_PLACEHOLDER_PROMPT = 'Answer the question shown in the attached image or figure.';
const VISUAL_SELECTOR = 'img, svg, canvas, table, pre, .cm-editor, .CodeMirror, .monaco-editor, .ace_editor';

export interface QuestionMediaHandle {
  region: Element;
  imageElements: Element[];
}

export class DOMQuestionExtractor {
  /** Live elements behind each question from the latest scan, keyed by fingerprint. */
  private questionMedia = new Map<string, QuestionMediaHandle>();

  public getQuestionMedia(fingerprint: string): QuestionMediaHandle | undefined {
    return this.questionMedia.get(fingerprint);
  }

  /**
   * A real question mark, not the "?" inside a URL such as
   * "https://www.googletagmanager.com/ns.html?id=GTM-XXXX".
   */
  public hasQuestionMark(text: string): boolean {
    return /\?(?=\s|$|["'”’)\]])/.test(text);
  }

  /**
   * Could this element hold the question prompt? Rejects hidden nodes and non-content markup.
   * Pages often carry a Google Tag Manager <noscript><iframe src="...?id=GTM-..."> snippet; its
   * text used to be picked up as the "question", so Gemini answered from the options alone.
   */
  private isPromptCandidate(el: Element): boolean {
    if (el.closest('script, style, noscript, template, iframe, header, nav, footer, [role="banner"], [role="navigation"], #ai-mcq-assistant-root')) {
      return false;
    }
    const text = el.textContent || '';
    if (/<\/?[a-z][a-z0-9-]*[\s>]/i.test(text)) return false; // raw HTML/markup as text
    if (/questions?\s+attempted/i.test(text)) return false;
    return isRendered(el);
  }

  /** True when the prompt is a stand-in because the real question is visual. */
  public static isPlaceholderPrompt(text: string): boolean {
    const t = text.trim();
    return t === VISUAL_PLACEHOLDER_PROMPT || /^question \d+$/i.test(t) || t.length < 5;
  }

  /**
   * Adds tables, code and images around the question to its text and fingerprint.
   * Without this, "What is the output of this code?" asked twice with different code looked
   * like one already-answered question and the Auto-Loop stalled.
   */
  private attachRichContext(q: ExtractedQuestion, media: Map<string, QuestionMediaHandle>): void {
    const els = q.options
      .map((o) => resolveOptionElement(o.elementSelector))
      .filter((e): e is Element => !!e);
    // Typed-answer questions have no options; the answer box anchors the question instead
    if (els.length === 0 && q.inputSelector) {
      const box = resolveOptionElement(q.inputSelector);
      if (box) els.push(box);
    }
    if (els.length === 0) return;

    const ctx = collectQuestionContext(els, q.options.map((o) => o.id));
    if (!ctx) return;

    // True/False statements and other prompts without a "?" often fall back to "Question N".
    // Then every such question looks identical, the Auto-Loop thinks it already answered it and
    // stalls. Read the statement from the text around the options instead.
    if (DOMQuestionExtractor.isPlaceholderPrompt(q.questionText)) {
      const nearby = nearbyQuestionText(els, ctx.region);
      if (nearby) {
        q.questionText = nearby;
        q.fingerprint = createQuestionFingerprint(nearby, q.options);
      }
    }

    const newBlocks = ctx.textBlocks.filter((b) => {
      const body = b.slice(b.indexOf('\n') + 1).trim().slice(0, 80);
      return body.length > 0 && !q.questionText.includes(body);
    });
    if (newBlocks.length > 0) {
      q.questionText = `${q.questionText}\n\n${newBlocks.join('\n\n')}`;
    }
    if (ctx.images.length > 0) {
      q.images = ctx.images;
      q.hasVisualContent = true;
    }
    if (ctx.contextKey) {
      q.fingerprint = createQuestionFingerprint(`${q.questionText} ${ctx.contextKey}`, q.options);
    }
    media.set(q.fingerprint, { region: ctx.region, imageElements: ctx.imageElements });
  }

  /**
   * Main entry point: extracts questions from the current document.
   */
  public extractAllQuestions(): ExtractedQuestion[] {
    const results: ExtractedQuestion[] = [];
    const seenFingerprints = new Set<string>();
    const seenOptionElements = new Set<Element>();
    const anchors = new Map<ExtractedQuestion, Element>();

    const media = new Map<string, QuestionMediaHandle>();

    const addQuestion = (q: ExtractedQuestion) => {
      // Two strategies can find the same control (e.g. a .question-card that wraps a
      // role="radiogroup"). Their prompt text differs slightly, so the fingerprint does
      // not catch it. Dedupe on the actual first-option element instead.
      const anchor = this.resolveUniqueElement(q.options[0]?.elementSelector);
      if (anchor && seenOptionElements.has(anchor)) return;

      try {
        this.attachRichContext(q, media);
      } catch {
        // Context is a bonus; never lose the question over it
      }

      if (seenFingerprints.has(q.fingerprint)) return;
      if (anchor) {
        seenOptionElements.add(anchor);
        anchors.set(q, anchor);
      }
      seenFingerprints.add(q.fingerprint);
      results.push(q);
    };

    // Strategy 1: Explicit question containers (.question, .mcq, [data-question], fieldset)
    const containerQuestions = this.extractFromContainers();
    containerQuestions.forEach(addQuestion);

    // Strategy 2a: Grouped radio inputs (Single-Choice MCQs)
    const radioGroupQuestions = this.extractFromRadioGroups();
    radioGroupQuestions.forEach(addQuestion);

    // Strategy 2b: Grouped checkbox inputs (Multiple-Answer MCQs with squares)
    const checkboxGroupQuestions = this.extractFromCheckboxGroups();
    checkboxGroupQuestions.forEach(addQuestion);

    // Strategy 3: ARIA groups / role="radiogroup"
    const ariaQuestions = this.extractFromAriaGroups();
    ariaQuestions.forEach(addQuestion);

    // Strategy 4: Stepper / single question dynamic wizard
    if (results.length === 0) {
      const stepperQuestion = this.extractStepperSingleQuestion();
      if (stepperQuestion) {
        addQuestion(stepperQuestion);
      }
    }

    // Strategy 4b: True / False drawn as buttons or cards instead of radio inputs
    if (results.length === 0) {
      const binary = this.extractTrueFalseButtons();
      if (binary) addQuestion(binary);
    }

    // Strategy 5: Drag & Drop / Step Ordering Questions (if no standard MCQs detected)
    if (results.length === 0) {
      const orderingQuestion = this.extractOrderingQuestion();
      if (orderingQuestion) {
        addQuestion(orderingQuestion);
      }
    }

    // Strategy 6: Typed answer ("Enter your answer" box) when there is nothing to click
    if (results.length === 0) {
      const typed = this.extractTypedAnswerQuestion();
      if (typed) addQuestion(typed);
    }

    this.questionMedia = media;

    // Keep page order so questions[0] is always the top-most live question
    results.sort((a, b) => {
      const ea = anchors.get(a);
      const eb = anchors.get(b);
      if (!ea || !eb || ea === eb) return 0;
      const pos = ea.compareDocumentPosition(eb);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });

    return results;
  }

  /**
   * Resolves a selector only when it points at exactly one element.
   */
  private resolveUniqueElement(selector?: string): Element | null {
    if (!selector) return null;
    try {
      const matches = document.querySelectorAll(selector);
      return matches.length === 1 ? matches[0] : null;
    } catch {
      return null;
    }
  }

  /**
   * Strategy 1: Look for question containers
   */
  private extractFromContainers(): ExtractedQuestion[] {
    const questions: ExtractedQuestion[] = [];
    const selectors = [
      '.question-container',
      '.question-card',
      '.question',
      '.mcq-item',
      '.quiz-question',
      'fieldset[role="radiogroup"]',
      'fieldset',
      '[data-question-id]',
      '[data-question]',
    ];

    const elements = document.querySelectorAll(selectors.join(', '));
    elements.forEach((container, idx) => {
      if (!isRendered(container)) return;

      // If container contains child question elements, skip parent wrapper to avoid lumping sub-questions
      if (container.querySelector(selectors.join(', '))) {
        return;
      }

      // If container contains radios with multiple distinct 'name' attributes, or > 6 radios, or multiple prompts, skip to avoid collapsing
      const radios = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
      const radioNames = new Set(radios.map((r) => r.name).filter(Boolean));
      if (radioNames.size > 1 || radios.length > 6) {
        return; // Handled individually by extractFromRadioGroups!
      }

      const promptCandidates = container.querySelectorAll(
        '.question-title, .question-text, .prompt, h1, h2, h3, h4, h5, legend',
      );
      if (promptCandidates.length > 1) {
        return; // Multi-prompt container; let radio group clustering separate them
      }

      // 1. Extract options from container FIRST
      const { options, isMultipleAnswer } = this.extractOptionsFromContainer(container as HTMLElement);
      if (options.length < 2) return;

      const optionTexts = options.map((o) => this.cleanText(o.text).toLowerCase());

      // 2. Find real question text: must NOT match any of the options
      let rawText = '';
      const dedicatedElem = container.querySelector(
        '.question-text, .question-title, .q-text, .prompt, [data-question-text], legend, h1, h2, h3, h4',
      );
      if (dedicatedElem && !dedicatedElem.querySelector('input')) {
        const text = this.cleanText(dedicatedElem.textContent || '');
        if (text.length >= 8 && !optionTexts.includes(text.toLowerCase())) {
          rawText = text;
        }
      }

      // 3. If no dedicated element or text is in optionTexts, search for element with '?'
      if (!rawText || optionTexts.includes(rawText.toLowerCase()) || !this.hasQuestionMark(rawText)) {
        const firstInput = container.querySelector<HTMLElement>('input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]') || (container as HTMLElement);
        const realPrompt = this.findRealQuestionPrompt(firstInput, options);
        if (realPrompt) {
          rawText = realPrompt;
        }
      }

      // 4. Validate question text: must be >= 5 chars and NOT an option.
      //    Image-only questions have no text prompt; keep them and let the image carry it.
      if (!rawText || rawText.length < 5 || optionTexts.includes(rawText.toLowerCase())) {
        if (!container.querySelector(VISUAL_SELECTOR)) return;
        rawText = VISUAL_PLACEHOLDER_PROMPT;
      }

      const { questionNumber, questionText } = this.parseQuestionNumberAndText(rawText, idx + 1);

      const { fullQuestionText, contextText } = this.enrichQuestionWithContext(questionText, container as HTMLElement);
      const fingerprint = createQuestionFingerprint(questionText, options);
      const isMulti = isMultipleAnswer || this.detectMultiAnswerPrompt(questionText);
      questions.push({
        fingerprint,
        questionNumber,
        questionText: fullQuestionText,
        contextText,
        options,
        extractionStrategy: 'multi-question-list',
        extractionConfidence: 0.95,
        isMultipleChoiceMultipleAnswer: isMulti,
        status: 'READY_FOR_AI',
        detectedAt: new Date().toISOString(),
      });
    });

    return questions;
  }

  /**
   * Strategy 2: Extract by radio button grouping (handles standard name groups & nameless/cloze sub-questions)
   */
  private extractFromRadioGroups(): ExtractedQuestion[] {
    const questions: ExtractedQuestion[] = [];
    const allRadios = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
    if (allRadios.length === 0) return [];

    // Filter out hidden radios and extension container
    const visibleRadios = allRadios.filter((r) => {
      if (r.closest('#ai-mcq-assistant-root') || r.closest('.ai-mcq-container')) return false;
      return isOptionRendered(r);
    });

    if (visibleRadios.length === 0) return [];

    // Cluster radios into distinct questions
    const clusters = this.clusterRadioButtons(visibleRadios);

    clusters.forEach((cluster, idx) => {
      const groupRadios = cluster.radios;
      if (groupRadios.length < 2) return;

      const options: OptionItem[] = [];
      const optionLetters = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

      groupRadios.forEach((radio, rIdx) => {
        const labelText = this.findRadioLabelText(radio);
        const letter = optionLetters[rIdx] || String(rIdx + 1);
        const selector = this.generateUniqueSelector(radio);

        options.push({
          id: letter,
          text: labelText || `Option ${letter}`,
          originalLabel: letter,
          elementSelector: selector,
          isPreSelected: radio.checked,
        });
      });

      // Use cluster prompt if already identified, or find question text near ancestor
      let questionText = cluster.promptText;
      if (!questionText || questionText.length < 5) {
        const commonAncestor = this.findCommonAncestor(groupRadios);
        questionText = this.findQuestionTextNearAncestor(commonAncestor, groupRadios[0], options);
      }

      // If extracted question text is identical to one of the options or empty, use deep prompt finder
      const optionTexts = options.map((o) => o.text.trim().toLowerCase());
      if (!questionText || optionTexts.includes(questionText.trim().toLowerCase()) || !this.hasQuestionMark(questionText)) {
        const betterPrompt = this.findRealQuestionPrompt(groupRadios[0], options);
        if (betterPrompt) {
          questionText = betterPrompt;
        }
      }

      if (!questionText || questionText.length < 5) {
        questionText = `Question ${idx + 1}`;
      }

      const { questionNumber, questionText: cleanQText } = this.parseQuestionNumberAndText(
        questionText,
        idx + 1,
      );

      const { fullQuestionText, contextText } = this.enrichQuestionWithContext(cleanQText, groupRadios[0]);
      const fingerprint = createQuestionFingerprint(cleanQText, options);
      questions.push({
        fingerprint,
        questionNumber,
        questionText: fullQuestionText,
        contextText,
        options,
        extractionStrategy: 'radio-standard',
        extractionConfidence: 0.95,
        isMultipleChoiceMultipleAnswer: false,
        questionType: 'SINGLE_CHOICE',
        status: 'READY_FOR_AI',
        detectedAt: new Date().toISOString(),
      });
    });

    return questions;
  }

  /**
   * Strategy 2b: Extract questions with square checkbox groups (Multiple-Answer MCQs).
   */
  private extractFromCheckboxGroups(): ExtractedQuestion[] {
    const questions: ExtractedQuestion[] = [];
    const allCheckboxes = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[type="checkbox"], [role="checkbox"]'),
    );
    if (allCheckboxes.length === 0) return [];

    const visibleCheckboxes = allCheckboxes.filter((cb) => {
      if (cb.closest('#ai-mcq-assistant-root') || cb.closest('.ai-mcq-container')) return false;
      return isOptionRendered(cb);
    });

    if (visibleCheckboxes.length === 0) return [];

    const clusters = this.clusterRadioButtons(visibleCheckboxes);
    clusters.forEach((cluster, idx) => {
      const groupCheckboxes = cluster.radios;
      if (groupCheckboxes.length < 2) return;

      const options: OptionItem[] = [];
      const optionLetters = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

      groupCheckboxes.forEach((cb, cIdx) => {
        const labelText = this.findRadioLabelText(cb);
        const letter = optionLetters[cIdx] || String(cIdx + 1);
        const selector = this.generateUniqueSelector(cb);

        options.push({
          id: letter,
          text: labelText || `Option ${letter}`,
          originalLabel: letter,
          elementSelector: selector,
          isPreSelected:
            (cb instanceof HTMLInputElement && cb.checked) ||
            cb.getAttribute('aria-checked') === 'true',
        });
      });

      let questionText = cluster.promptText;
      if (!questionText || questionText.length < 5) {
        const commonAncestor = this.findCommonAncestor(groupCheckboxes);
        questionText = this.findQuestionTextNearAncestor(commonAncestor, groupCheckboxes[0], options);
      }

      const optionTexts = options.map((o) => o.text.trim().toLowerCase());
      if (!questionText || optionTexts.includes(questionText.trim().toLowerCase()) || !this.hasQuestionMark(questionText)) {
        const betterPrompt = this.findRealQuestionPrompt(groupCheckboxes[0], options);
        if (betterPrompt) {
          questionText = betterPrompt;
        }
      }

      if (!questionText || questionText.length < 5) {
        questionText = `Question ${idx + 1}`;
      }

      const { questionNumber, questionText: cleanQText } = this.parseQuestionNumberAndText(
        questionText,
        idx + 1,
      );

      const { fullQuestionText, contextText } = this.enrichQuestionWithContext(cleanQText, groupCheckboxes[0]);
      const fingerprint = createQuestionFingerprint(cleanQText, options);
      questions.push({
        fingerprint,
        questionNumber,
        questionText: fullQuestionText,
        contextText,
        options,
        extractionStrategy: 'custom-accessible',
        extractionConfidence: 0.95,
        isMultipleChoiceMultipleAnswer: true,
        questionType: 'MULTIPLE_CHOICE',
        status: 'READY_FOR_AI',
        detectedAt: new Date().toISOString(),
      });
    });

    return questions;
  }

  /**
   * Helper to cluster radio buttons into distinct question groups.
   * Handles:
   * 1. Standard name attribute grouping (when names are distinct).
   * 2. Cloze reading / multi-question tests where radios share the same name or have NO name attribute.
   */
  public clusterRadioButtons(radios: HTMLInputElement[]): { promptText: string; radios: HTMLInputElement[] }[] {
    if (radios.length === 0) return [];

    // 1. Check if radios have distinct, non-empty name attributes
    const byName = new Map<string, HTMLInputElement[]>();
    for (const r of radios) {
      const n = (r.name || '').trim();
      if (n.length > 0) {
        if (!byName.has(n)) byName.set(n, []);
        byName.get(n)!.push(r);
      }
    }

    const allHaveNames = radios.every((r) => r.name && r.name.trim().length > 0);
    // Every radio is named and each name group is a plausible option list: group by name.
    // (This used to require 2+ groups. With a single question on the page, the 4 radios
    // were split by "nearest heading" instead, and the first option was silently dropped.)
    if (allHaveNames && Array.from(byName.values()).every((g) => g.length >= 2 && g.length <= 8)) {
      return Array.from(byName.values()).map((groupRadios) => ({
        promptText: '',
        radios: groupRadios,
      }));
    }

    // 2. Otherwise cluster by nearest preceding question prompt or question card
    const clusters: { promptText: string; radios: HTMLInputElement[] }[] = [];

    for (const radio of radios) {
      const prompt = this.findNearestRadioHeading(radio);

      if (clusters.length > 0) {
        const lastCluster = clusters[clusters.length - 1];
        // If same prompt and current cluster hasn't exceeded 6 options
        if (lastCluster.promptText === prompt && lastCluster.radios.length < 6) {
          lastCluster.radios.push(radio);
          continue;
        }
      }

      clusters.push({
        promptText: prompt,
        radios: [radio],
      });
    }

    return clusters.filter((c) => c.radios.length >= 2);
  }

  /**
   * Locates the nearest preceding question heading / prompt for a radio element.
   */
  public findNearestRadioHeading(radio: HTMLElement): string {
    // 1. Check if radio is inside a dedicated question card
    const card = radio.closest(
      '.question-card, .cloze-q-card, .question-item, .question, .sub-question, fieldset, li, [data-question-id]',
    );
    if (card) {
      const heading = card.querySelector(
        '.question-title, .question-text, .prompt, h1, h2, h3, h4, h5, legend, strong',
      );
      if (heading && !heading.querySelector('input[type="radio"]')) {
        const text = this.cleanText(heading.textContent || '');
        if (text.length >= 6) return text;
      }
    }

    // 2. Traverse upwards and look backwards among preceding siblings
    let node: HTMLElement | null = radio.parentElement;
    while (node && node !== document.body) {
      let sibling = node.previousElementSibling;
      while (sibling) {
        if (!sibling.querySelector('input[type="radio"]')) {
          const headings = Array.from(
            sibling.querySelectorAll<HTMLElement>(
              '.question-title, .question-text, .prompt, h1, h2, h3, h4, h5, legend, p, div, strong',
            ),
          );
          headings.push(sibling as HTMLElement);

          for (let i = headings.length - 1; i >= 0; i--) {
            const h = headings[i];
            if (h.querySelector('input[type="radio"]')) continue;
            if (!this.isPromptCandidate(h)) continue;
            const txt = this.cleanText(h.textContent || '');
            if (
              (this.hasQuestionMark(txt) ||
                txt.toLowerCase().includes('blank') ||
                txt.toLowerCase().includes('which word') ||
                /^(?:question|q)\s*\d+/i.test(txt)) &&
              txt.length >= 6 &&
              txt.length < 300
            ) {
              return txt;
            }
          }
        } else {
          // Reached radios of a preceding question; stop searching backwards
          break;
        }
        sibling = sibling.previousElementSibling;
      }
      node = node.parentElement;
    }

    return '';
  }

  /**
   * Strategy 3: Extract from ARIA role="radiogroup" and role="radio"
   */
  private extractFromAriaGroups(): ExtractedQuestion[] {
    const questions: ExtractedQuestion[] = [];
    const ariaGroups = document.querySelectorAll('[role="radiogroup"]');

    ariaGroups.forEach((group, idx) => {
      if (!isRendered(group)) return;
      const ariaRadios = group.querySelectorAll('[role="radio"]');
      if (ariaRadios.length < 2) return;

      const qText =
        group.getAttribute('aria-label') ||
        group.getAttribute('aria-description') ||
        group.querySelector('[id*="label"], [class*="label"], h3, h4, p')?.textContent ||
        '';

      const cleanedText = this.cleanText(qText);
      if (!cleanedText) return;

      const options: OptionItem[] = [];
      const optionLetters = ['A', 'B', 'C', 'D', 'E'];

      ariaRadios.forEach((radio, rIdx) => {
        const text =
          radio.getAttribute('aria-label') ||
          this.cleanText(radio.textContent || '') ||
          `Option ${optionLetters[rIdx] || rIdx + 1}`;
        const selector = this.generateUniqueSelector(radio as HTMLElement);
        const isChecked =
          radio.getAttribute('aria-checked') === 'true' ||
          radio.classList.contains('selected') ||
          radio.classList.contains('active');

        options.push({
          id: optionLetters[rIdx] || String(rIdx + 1),
          text,
          elementSelector: selector,
          isPreSelected: isChecked,
        });
      });

      const { questionNumber, questionText } = this.parseQuestionNumberAndText(cleanedText, idx + 1);
      const { fullQuestionText, contextText } = this.enrichQuestionWithContext(questionText, group as HTMLElement);
      const fingerprint = createQuestionFingerprint(questionText, options);

      questions.push({
        fingerprint,
        questionNumber,
        questionText: fullQuestionText,
        contextText,
        options,
        extractionStrategy: 'custom-accessible',
        extractionConfidence: 0.92,
        status: 'READY_FOR_AI',
        detectedAt: new Date().toISOString(),
      });
    });

    return questions;
  }

  /**
   * Strategy 4: Extract from a single-question stepper / portal page
   */
  private extractStepperSingleQuestion(): ExtractedQuestion | null {
    const main = document.querySelector('main, #content, .content, form, .container, body') || document.body;

    // Check for checkboxes (squares / multi-answer) and radio buttons (circles / single-answer)
    const checkboxes = Array.from(
      main.querySelectorAll<HTMLElement>(
        'input[type="checkbox"], [role="checkbox"], [class*="checkbox" i], [class*="square" i], [class*="check-box" i], [data-testid*="checkbox" i]',
      ),
    );
    const radios = Array.from(main.querySelectorAll<HTMLElement>('input[type="radio"], [role="radio"]'));

    const isCheckboxMode = checkboxes.length >= 2 && (radios.length < 2 || checkboxes.length >= radios.length);
    const inputElements = (isCheckboxMode ? checkboxes : radios).filter((el) => isOptionRendered(el));
    if (inputElements.length < 2) return null;

    // 1. Extract options first so we can cross-reference
    const options: OptionItem[] = [];
    const optionLetters = ['A', 'B', 'C', 'D', 'E', 'F'];

    inputElements.forEach((inputEl, idx) => {
      let optText = '';
      if (inputEl instanceof HTMLInputElement) {
        optText = this.findRadioLabelText(inputEl);
      } else {
        optText = this.cleanText(inputEl.textContent || '');
      }

      const letter = optionLetters[idx] || String(idx + 1);
      options.push({
        id: letter,
        text: optText || `Option ${letter}`,
        elementSelector: this.generateUniqueSelector(inputEl),
        isPreSelected:
          (inputEl instanceof HTMLInputElement && inputEl.checked) ||
          inputEl.getAttribute('aria-checked') === 'true',
      });
    });

    const optionTexts = options.map((o) => this.cleanText(o.text).toLowerCase());

    // 2. Locate the question text preceding the input elements
    let text = this.findRealQuestionPrompt(inputElements[0], options);

    if (!text || text.length < 5 || optionTexts.includes(text.toLowerCase())) {
      // Heading fallback
      const heading = main.querySelector('h1, h2, h3, h4, .question-text, .prompt');
      if (heading && !heading.querySelector('input')) {
        const hText = this.cleanText(heading.textContent || '');
        if (hText.length >= 8 && !optionTexts.includes(hText.toLowerCase())) {
          text = hText;
        }
      }
    }

    if (!text || text.length < 5 || optionTexts.includes(text.toLowerCase())) {
      if (!main.querySelector(VISUAL_SELECTOR)) return null;
      text = VISUAL_PLACEHOLDER_PROMPT;
    }

    const { questionNumber, questionText } = this.parseQuestionNumberAndText(text, 1);
    const { fullQuestionText, contextText } = this.enrichQuestionWithContext(questionText, main as HTMLElement);
    const fingerprint = createQuestionFingerprint(questionText, options);
    const isMultiAnswer =
      isCheckboxMode ||
      checkboxes.length >= 2 ||
      inputElements.some((el) => this.hasSquareOrCheckbox(el)) ||
      this.detectMultiAnswerPrompt(questionText);

    return {
      fingerprint,
      questionNumber,
      questionText: fullQuestionText,
      contextText,
      options,
      extractionStrategy: 'single-question-stepper',
      extractionConfidence: 0.95,
      isMultipleChoiceMultipleAnswer: isMultiAnswer,
      questionType: isMultiAnswer ? 'MULTIPLE_CHOICE' : 'SINGLE_CHOICE',
      status: 'READY_FOR_AI',
      detectedAt: new Date().toISOString(),
    };
  }

  /**
   * Sanitizes question prompt text: strips student info, assessment headers,
   * live countdown clocks ("07 : 04", "01:59"), and score counters that destabilize fingerprints.
   */
  public sanitizeQuestionPrompt(text: string): string {
    let cleaned = this.cleanText(text);

    // Strip student ID / user info header: "AnkitID: N25P01A0046" or "Ankit ID: N25P01A0046"
    cleaned = cleaned.replace(/^[A-Za-z\s]*ID:\s*[A-Z0-9_\-]+/i, '').trim();

    // Strip assessment titles and navigation tokens
    cleaned = cleaned.replace(
      /^(?:MCQ\s*Practice|Practice\s*Instructions|Practice\s*Attempts|Instructions|End\s*Practice|Questions\s*Attempted:\s*\d+\/\d+)\s*/gi,
      '',
    ).trim();

    // Strip countdown clocks and score metadata: "07 : 04", "01:59", "Score: 3", "Questions Attempted: 3/20"
    cleaned = cleaned.replace(
      /(?:\b\d{1,2}\s*:\s*\d{2}(?::\d{2})?\b|\bScore:\s*\d+\b|\bQuestions\s*Attempted:\s*\d+\/\d+\b|\bEnd\s*Practice\b)/gi,
      '',
    ).trim();

    // Strip any preceding timer/score combination that precedes the real question text
    cleaned = cleaned.replace(/^(?:.*?Score:\s*\d+.*?End\s*Practice\s*)/i, '').trim();
    cleaned = cleaned.replace(/^(?:.*?\d{1,2}\s*:\s*\d{2}\s*Score:\s*\d+)/i, '').trim();

    // If the prompt has an ordering keyword like "Arrange...", "Rearrange...", "Put the following...",
    // slice directly to that keyword to eliminate any preceding header artifacts!
    const orderingStart = cleaned.search(/\b(?:rearrange|arrange|order|put\s+the|sort\s+the|sequence\s+the)\b/i);
    if (orderingStart > 0) {
      cleaned = cleaned.slice(orderingStart).trim();
    }

    // Strip trailing "Drag and Drop to Order" or options list that might have been glued
    cleaned = cleaned.replace(/(?:Drag\s*and\s*Drop\s*to\s*Order|Drag\s*and\s*Drop).*$/i, '').trim();

    // Strip trailing option text if it starts with "1" followed by uppercase letter e.g. "1Enforce..."
    cleaned = cleaned.replace(/1\s*[A-Z][a-z].*$/, '').trim();

    return cleaned;
  }

  /** Text boxes that could take a typed answer (not search, login, chat or code-editor internals). */
  public findAnswerBoxes(): HTMLElement[] {
    return Array.from(
      document.querySelectorAll<HTMLElement>('textarea, input[type="text"], input[type="number"], input:not([type])'),
    ).filter((el) => {
      const field = el as HTMLInputElement | HTMLTextAreaElement;
      if (field.disabled || field.readOnly) return false;
      if (
        el.closest(
          '#ai-mcq-assistant-root, header, nav, footer, [role="search"], [role="dialog"], .cm-editor, .CodeMirror, .monaco-editor, .ace_editor',
        )
      ) {
        return false;
      }
      const hint = [el.getAttribute('placeholder'), el.getAttribute('aria-label'), el.getAttribute('name'), el.id]
        .filter(Boolean)
        .join(' ');
      if (/search|e-?mail|password|user ?name|login|otp|phone|comment|chat|message|feedback|filter|coupon/i.test(hint)) {
        return false;
      }
      return isRendered(el);
    });
  }

  /**
   * Strategy 6: a question answered by typing into a single text box ("Enter your answer").
   */
  private extractTypedAnswerQuestion(): ExtractedQuestion | null {
    const boxes = this.findAnswerBoxes();
    if (boxes.length !== 1) return null; // several boxes = a form, not one practice question
    const box = boxes[0];

    const hint = `${box.getAttribute('placeholder') || ''} ${box.getAttribute('aria-label') || ''}`;
    const hasSubmit = Array.from(
      document.querySelectorAll<HTMLElement>('button, input[type="submit"], input[type="button"], [role="button"]'),
    ).some((b) => {
      const t = this.cleanText(b.textContent || b.getAttribute('value') || '').toLowerCase();
      return /^(submit|submit answer|check|check answer)$/.test(t) && isRendered(b);
    });
    if (!/answer|response|type here|your solution|enter/i.test(hint) && !hasSubmit) return null;

    let text = this.findRealQuestionPrompt(box, []);
    if (!text || text.length < 5) text = 'Question 1'; // replaced by the nearby statement later
    const { questionNumber, questionText } = this.parseQuestionNumberAndText(text, 1);

    const field = box as HTMLInputElement | HTMLTextAreaElement;
    return {
      fingerprint: createQuestionFingerprint(questionText, []),
      questionNumber,
      questionText,
      options: [],
      questionCategory: 'FILL_IN_THE_BLANKS',
      questionType: 'DESCRIPTIVE',
      extractionStrategy: 'fill-in-the-blank',
      extractionConfidence: 0.85,
      inputSelector: this.generateUniqueSelector(box),
      placeholder: box.getAttribute('placeholder') || undefined,
      maxLength: field.maxLength > 0 ? field.maxLength : undefined,
      status: 'READY_FOR_AI',
      detectedAt: new Date().toISOString(),
    };
  }

  /**
   * Strategy 4b: a True/False question whose answers are buttons or clickable cards.
   */
  private extractTrueFalseButtons(): ExtractedQuestion | null {
    const CLICKABLE = 'button, [role="button"], [role="option"], [role="radio"], label, li, [class*="option" i], [class*="choice" i]';
    const wordOf = (el: Element) =>
      this.cleanText(el.textContent || '')
        .toLowerCase()
        .replace(/^\(?[a-d][\)\.:]\s*/, '')
        .replace(/[.!]$/, '');

    const found: Record<'true' | 'false', HTMLElement[]> = { true: [], false: [] };
    const all = Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"], [role="option"], [role="radio"], label, li, div, span, p'));
    for (const el of all) {
      if (el.closest('#ai-mcq-assistant-root, header, nav, footer, [role="dialog"]')) continue;
      const w = wordOf(el);
      if (w !== 'true' && w !== 'false') continue;
      // innermost element with the word, then its clickable wrapper
      if (Array.from(el.children).some((c) => wordOf(c) === w)) continue;
      const clickable = (el.closest(CLICKABLE) as HTMLElement) || el;
      if (!isRendered(clickable) || wordOf(clickable) !== w) continue;
      if (!found[w].includes(clickable)) found[w].push(clickable);
    }
    if (found.true.length !== 1 || found.false.length !== 1) return null;

    const [tEl, fEl] = [found.true[0], found.false[0]];
    const ordered = tEl.compareDocumentPosition(fEl) & Node.DOCUMENT_POSITION_FOLLOWING ? [tEl, fEl] : [fEl, tEl];
    const options: OptionItem[] = ordered.map((el, i) => ({
      id: ['A', 'B'][i],
      text: wordOf(el) === 'true' ? 'True' : 'False',
      originalLabel: ['A', 'B'][i],
      elementSelector: this.generateUniqueSelector(el),
    }));

    let text = this.findRealQuestionPrompt(ordered[0], options);
    if (!text || text.length < 5) text = 'Question 1';
    const { questionNumber, questionText } = this.parseQuestionNumberAndText(text, 1);
    return {
      fingerprint: createQuestionFingerprint(questionText, options),
      questionNumber,
      questionText,
      options,
      extractionStrategy: 'custom-accessible',
      extractionConfidence: 0.85,
      isMultipleChoiceMultipleAnswer: false,
      questionType: 'SINGLE_CHOICE',
      status: 'READY_FOR_AI',
      detectedAt: new Date().toISOString(),
    };
  }

  /**
   * Strategy: Drag and Drop / Step Ordering Questions (e.g. "Rearrange the following steps...", "Drag and Drop to Order")
   */
  public extractOrderingQuestion(): ExtractedQuestion | null {
    const main = document.querySelector('main, #content, .content, form, .container, body') || document.body;

    // 1. Detect if page has ordering prompt or "Drag and Drop to Order" caption
    // Filter out page headers, sidebars, timers, and score displays
    const allTextElems = Array.from(
      main.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, p, div, span, label'),
    ).filter((el) => {
      return !el.closest('header, nav, aside, footer, .sidebar, .navbar, .user-info, [class*="timer" i], [class*="score" i]');
    });

    let promptEl: HTMLElement | null = null;
    let rawQuestionText = '';

    // Collect all candidates containing an ordering prompt
    const candidates = allTextElems.filter((el) => {
      const t = this.cleanText(el.textContent || '');
      return this.isOrderingPrompt(t) && t.length >= 15;
    });

    // Prefer innermost leaf candidates: candidate element must not contain another candidate element
    const leafCandidates = candidates.filter((el) => {
      return !Array.from(el.children).some((ch) => candidates.includes(ch as HTMLElement));
    });

    const sortedCandidates = leafCandidates.length > 0 ? leafCandidates : candidates;
    sortedCandidates.sort((a, b) => (a.textContent?.length || 0) - (b.textContent?.length || 0));

    if (sortedCandidates.length > 0) {
      promptEl = sortedCandidates[0];
      rawQuestionText = this.sanitizeQuestionPrompt(promptEl.textContent || '');
    }

    // Fallback: search for "Drag and Drop to Order" caption
    if (!promptEl || !rawQuestionText || rawQuestionText.length < 10) {
      const caption = allTextElems.find((el) => {
        const t = (el.textContent || '').trim().toLowerCase();
        return t === 'drag and drop to order' || t.startsWith('drag and drop to order') || t === 'drag and drop';
      });
      if (caption) {
        // Look at preceding sibling or parent previous sibling for question prompt
        let prev = caption.previousElementSibling;
        while (prev) {
          const pt = this.sanitizeQuestionPrompt(prev.textContent || '');
          if (pt.length >= 15) {
            rawQuestionText = pt;
            promptEl = caption;
            break;
          }
          prev = prev.previousElementSibling;
        }

        if (!rawQuestionText && caption.parentElement) {
          let pprev = caption.parentElement.previousElementSibling;
          while (pprev) {
            const pt = this.sanitizeQuestionPrompt(pprev.textContent || '');
            if (pt.length >= 15) {
              rawQuestionText = pt;
              promptEl = caption;
              break;
            }
            pprev = pprev.previousElementSibling;
          }
        }
      }
    }

    // Fallback: no recognisable wording, but the page clearly has a sortable list
    // (react-beautiful-dnd / hello-pangea / dnd-kit / HTML5 draggable). Use the nearest prompt.
    if (!promptEl || !rawQuestionText || rawQuestionText.length < 10) {
      const firstDraggable = main.querySelector<HTMLElement>(
        '[data-rbd-draggable-id], [data-rfd-draggable-id], [aria-roledescription="sortable"], [aria-roledescription="draggable"], [draggable="true"]',
      );
      const draggableCount = main.querySelectorAll(
        '[data-rbd-draggable-id], [data-rfd-draggable-id], [aria-roledescription="sortable"], [aria-roledescription="draggable"], [draggable="true"]',
      ).length;
      if (firstDraggable && draggableCount >= 2 && isRendered(firstDraggable)) {
        const prompt = this.sanitizeQuestionPrompt(this.findRealQuestionPrompt(firstDraggable, []));
        if (prompt.length >= 10) {
          rawQuestionText = prompt;
          promptEl = firstDraggable;
        }
      }
    }

    if (!promptEl || !rawQuestionText || rawQuestionText.length < 10) return null;

    // 2. Discover draggable items in DOM
    // Check React Beautiful DnD droppable list children
    const droppable = main.querySelector<HTMLElement>('[data-rbd-droppable-id], [data-rfd-droppable-id]');
    let draggableElements: HTMLElement[] = [];
    if (droppable && droppable.children.length >= 2) {
      draggableElements = Array.from(droppable.children) as HTMLElement[];
    }

    // Check React Beautiful DnD item attributes: [data-rbd-draggable-id] or [data-rfd-draggable-id]
    if (draggableElements.length < 2) {
      draggableElements = Array.from(
        main.querySelectorAll<HTMLElement>('[data-rbd-draggable-id], [data-rfd-draggable-id]'),
      );
    }

    // Check handles: [data-rbd-drag-handle-draggable-id]
    if (draggableElements.length < 2) {
      const handles = Array.from(
        main.querySelectorAll<HTMLElement>(
          '[data-rbd-drag-handle-draggable-id], [data-rfd-drag-handle-draggable-id]',
        ),
      );
      if (handles.length >= 2) {
        draggableElements = handles
          .map((h) => h.closest<HTMLElement>('[data-rbd-draggable-id], [data-rfd-draggable-id]') || (h.parentElement as HTMLElement))
          .filter(Boolean);
      }
    }

    // dnd-kit sortable items
    if (draggableElements.length < 2) {
      draggableElements = Array.from(
        main.querySelectorAll<HTMLElement>('[aria-roledescription="sortable"], [aria-roledescription="draggable"]'),
      );
    }

    // Check HTML5 draggable: [draggable="true"]
    if (draggableElements.length < 2) {
      draggableElements = Array.from(main.querySelectorAll<HTMLElement>('[draggable="true"]'));
    }

    // Check class names containing 'draggable', 'drag-item', 'sortable', 'reorder'
    if (draggableElements.length < 2) {
      const candidateList = Array.from(
        main.querySelectorAll<HTMLElement>(
          '[class*="draggable" i], [class*="drag-item" i], [class*="sortable" i], [class*="reorder" i]',
        ),
      );
      if (candidateList.length >= 2) {
        draggableElements = candidateList;
      }
    }

    // Plain list below the prompt (no drag-library markers). Only when the wording explicitly
    // asks to drag/arrange; otherwise any instructions list became a fake sequence question.
    const explicitDragWording = /\b(drag|re-?arrange|arrange)\b/i.test(rawQuestionText);
    if (draggableElements.length < 2 && explicitDragWording) {
      let curr: HTMLElement | null = promptEl.parentElement;
      while (curr && curr !== document.body) {
        const candidateContainers = Array.from(curr.querySelectorAll<HTMLElement>('ul, ol, div')).filter((c) => {
          const directChildren = Array.from(c.children).filter((ch) => {
            const txt = this.cleanText(ch.textContent || '');
            const isBtn = ch.tagName === 'BUTTON' || ch.getAttribute('role') === 'button';
            return !isBtn && txt.length > 5 && !this.isOrderingPrompt(txt) && ch.clientHeight > 15;
          });
          return directChildren.length >= 2 && directChildren.length <= 10;
        });

        if (candidateContainers.length > 0) {
          const list = candidateContainers[0];
          draggableElements = Array.from(list.children).filter((ch) => {
            const txt = this.cleanText(ch.textContent || '');
            const lower = txt.toLowerCase();
            return (
              txt.length > 5 &&
              !lower.startsWith('submit') &&
              !lower.startsWith('show answer') &&
              !lower.startsWith('skip') &&
              ch.clientHeight > 15
            );
          }) as HTMLElement[];
          if (draggableElements.length >= 2) break;
        }

        curr = curr.parentElement;
      }
    }

    // Drag markers often sit only on the ⋮⋮ handle (no text). Use the whole row/card instead,
    // otherwise every step reads as "Step N" and the order can't be solved or verified.
    draggableElements = expandToItemRows(draggableElements);

    // Filter out buttons like SUBMIT, SHOW ANSWER, SKIP, and captions
    const filteredItems = draggableElements.filter((el) => {
      const lower = (el.textContent || '').trim().toLowerCase();
      return (
        !lower.startsWith('submit') &&
        !lower.startsWith('show answer') &&
        !lower.startsWith('skip') &&
        !lower.startsWith('instructions') &&
        !lower.includes('drag and drop to order') &&
        el.clientHeight > 15 &&
        isRendered(el)
      );
    });

    if (filteredItems.length < 2) return null;
    // Without readable step text there is nothing for the AI to order
    if (filteredItems.filter((el) => hasItemText(el)).length < 2) return null;

    // 3. Build OptionItem array
    const options: OptionItem[] = [];
    filteredItems.forEach((itemEl, idx) => {
      let rawText = this.cleanText(itemEl.textContent || '');
      // Strip leading number or drag handle icons (e.g. "1 Continue switching..." or "1 :: Continue...")
      rawText = rawText.replace(/^\d+[\s\:\.\-\:\:\•]+\s*/, '');
      rawText = rawText.replace(/^[^\p{L}\p{N}"'(\[]+/u, '').trim(); // drag-handle glyphs like ⋮⋮

      const optionId = String(idx + 1);
      options.push({
        id: optionId,
        text: rawText || `Step ${optionId}`,
        originalLabel: optionId,
        elementSelector: this.generateUniqueSelector(itemEl),
      });
    });

    if (options.length < 2) return null;

    const { questionNumber, questionText } = this.parseQuestionNumberAndText(rawQuestionText, 1);
    const fingerprint = createQuestionFingerprint(questionText, options);

    return {
      fingerprint,
      questionNumber,
      questionText,
      options,
      extractionStrategy: 'ordering-dnd',
      extractionConfidence: 0.95,
      isOrderingQuestion: true,
      questionType: 'ORDERING',
      status: 'READY_FOR_AI',
      detectedAt: new Date().toISOString(),
    };
  }

  public isOrderingPrompt(text: string): boolean {
    const lower = text.toLowerCase();
    return (
      /\b(re)?arrange\b/.test(lower) ||
      /\bdrag\b/.test(lower) ||
      // "in order" but not the purpose phrase "in order to ..." (e.g. "in order to mark your practice")
      /\b(in|into) (the )?(correct |right |proper |logical |chronological )?(sequence|order)\b(?! to\b)/.test(lower) ||
      /\b(order|sort|sequence) (the|these) (following|steps|items|options|statements|events)\b/.test(lower) ||
      /\bput (the following|these)\b.*\b(order|sequence)\b/.test(lower) ||
      /\b(correct|right|proper) (sequence|order)\b/.test(lower) ||
      lower.includes('chronological order')
    );
  }

  /**
   * Detects if the question prompt phrasing strongly indicates multiple correct answers.
   */
  public detectMultiAnswerPrompt(text: string): boolean {
    const lower = text.toLowerCase();
    return (
      lower.includes('select one or more') ||
      lower.includes('select all that apply') ||
      lower.includes('choose all that apply') ||
      lower.includes('select all correct') ||
      lower.includes('multiple options can be correct') ||
      lower.includes('more than one option') ||
      lower.includes('which of the following statements are correct') ||
      lower.includes('which of the following statements correctly') ||
      lower.includes('which of the following are true') ||
      lower.includes('which of the following are correct') ||
      lower.includes('choose all correct')
    );
  }

  /**
   * Detects if an element or its children has a square checkbox indicator (multi-answer).
   */
  public hasSquareOrCheckbox(container: Element): boolean {
    if (!container) return false;
    const squareSelectors = [
      'input[type="checkbox"]',
      '[role="checkbox"]',
      '[class*="checkbox" i]',
      '[class*="square" i]',
      '[class*="check-box" i]',
      '[class*="multiselect" i]',
      '[class*="multi-select" i]',
      '[data-testid*="checkbox" i]',
      'svg[class*="square" i]',
      'svg[data-icon*="square" i]',
      '.ant-checkbox',
      '.MuiCheckbox-root',
    ];
    try {
      if (container.matches(squareSelectors.join(', '))) return true;
      if (container.querySelector(squareSelectors.join(', '))) return true;
    } catch (e) {}
    return false;
  }

  /**
   * Helper: Extracts options within a given container element
   */
  private extractOptionsFromContainer(container: HTMLElement): { options: OptionItem[]; isMultipleAnswer: boolean } {
    const options: OptionItem[] = [];
    const optionLetters = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

    // 1. Checkboxes inside container (squares / multi-choice)
    const checkboxes = Array.from(
      container.querySelectorAll<HTMLElement>(
        'input[type="checkbox"], [role="checkbox"], [class*="checkbox" i], [class*="square" i], [class*="check-box" i], [data-testid*="checkbox" i]',
      ),
    );
    // 2. Radio buttons inside container (circles / single-choice)
    const radios = Array.from(
      container.querySelectorAll<HTMLElement>('input[type="radio"], [role="radio"]'),
    );

    const isCheckboxMode = checkboxes.length >= 2 && (radios.length < 2 || checkboxes.length >= radios.length);
    const inputElements = (isCheckboxMode ? checkboxes : radios).filter((el) => isOptionRendered(el));

    if (inputElements.length >= 2) {
      inputElements.forEach((inputEl, idx) => {
        let text = '';
        if (inputEl instanceof HTMLInputElement) {
          text = this.findRadioLabelText(inputEl);
        } else {
          text = this.cleanText(inputEl.textContent || '');
        }
        const letter = optionLetters[idx] || String(idx + 1);
        options.push({
          id: letter,
          text: text || `Option ${letter}`,
          elementSelector: this.generateUniqueSelector(inputEl),
          isPreSelected:
            (inputEl instanceof HTMLInputElement && inputEl.checked) ||
            inputEl.getAttribute('aria-checked') === 'true',
        });
      });
      return { options, isMultipleAnswer: isCheckboxMode };
    }

    // 3. Labels inside container
    const labels = Array.from(container.querySelectorAll('label, .option, .answer-option, li'));
    if (labels.length >= 2) {
      let containsSquare = false;
      labels.forEach((label, idx) => {
        if (this.hasSquareOrCheckbox(label)) {
          containsSquare = true;
        }
        const text = this.cleanText(label.textContent || '');
        if (text) {
          const letter = optionLetters[idx] || String(idx + 1);
          options.push({
            id: letter,
            text,
            elementSelector: this.generateUniqueSelector(label as HTMLElement),
          });
        }
      });
      return { options, isMultipleAnswer: containsSquare };
    }

    return { options: [], isMultipleAnswer: false };
  }

  private findRadioLabelText(radio: HTMLInputElement): string {
    // 1. HTML5 input.labels
    if (radio.labels && radio.labels.length > 0) {
      const text = this.cleanText(radio.labels[0].textContent || '');
      if (text) return text;
    }

    // 2. Parent label element
    const parentLabel = radio.closest('label');
    if (parentLabel) {
      const clone = parentLabel.cloneNode(true) as HTMLElement;
      // remove input from clone text
      const inputInClone = clone.querySelector('input');
      if (inputInClone) inputInClone.remove();
      const text = this.cleanText(clone.textContent || '');
      if (text) return text;
    }

    // 3. Label with for="id"
    if (radio.id) {
      const labelFor = document.querySelector(`label[for="${radio.id}"]`);
      if (labelFor) {
        const text = this.cleanText(labelFor.textContent || '');
        if (text) return text;
      }
    }

    // 4. Next sibling text / element
    let sibling = radio.nextSibling;
    while (sibling) {
      if (sibling.nodeType === Node.TEXT_NODE && sibling.textContent?.trim()) {
        return this.cleanText(sibling.textContent);
      }
      if (sibling.nodeType === Node.ELEMENT_NODE) {
        const text = this.cleanText((sibling as HTMLElement).textContent || '');
        if (text) return text;
      }
      sibling = sibling.nextSibling;
    }

    // 5. Parent container text
    const parent = radio.parentElement;
    if (parent) {
      const clone = parent.cloneNode(true) as HTMLElement;
      const inputInClone = clone.querySelector('input');
      if (inputInClone) inputInClone.remove();
      return this.cleanText(clone.textContent || '');
    }

    return '';
  }

  private findCommonAncestor(elements: HTMLElement[]): HTMLElement {
    if (elements.length === 0) return document.body;
    let ancestor: HTMLElement | null = elements[0].parentElement;

    while (ancestor) {
      const containsAll = elements.every((el) => ancestor!.contains(el));
      if (containsAll) return ancestor;
      ancestor = ancestor.parentElement;
    }

    return document.body;
  }

  private findQuestionTextNearAncestor(
    ancestor: HTMLElement,
    firstInput: HTMLElement,
    options: OptionItem[] = [],
  ): string {
    const optionTexts = options.map((o) => o.text.trim().toLowerCase());

    // 1. Look inside ancestor for headings or prompts
    const candidates = ancestor.querySelectorAll<HTMLElement>(
      '.question-text, .q-text, .prompt, h1, h2, h3, h4, legend, p, div',
    );
    for (const cand of Array.from(candidates)) {
      if (cand.querySelector('input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]')) continue;
      if (!this.isPromptCandidate(cand) || isCodeBlock(cand)) continue;
      const text = this.cleanText(textWithoutCode(cand));
      if (this.hasQuestionMark(text) && text.length > 10 && !optionTexts.includes(text.toLowerCase())) {
        return text;
      }
    }

    // 2. Look at previous siblings of ancestor
    let prev = ancestor.previousElementSibling;
    while (prev) {
      // leave code panels out of the prompt; they are added separately as [CODE]
      const text = this.isPromptCandidate(prev) && !isCodeBlock(prev) ? this.cleanText(textWithoutCode(prev)) : '';
      if (text.length > 10 && !prev.querySelector('input') && !optionTexts.includes(text.toLowerCase())) {
        return text;
      }
      prev = prev.previousElementSibling;
    }

    // 3. Fallback to real question prompt search
    return this.findRealQuestionPrompt(firstInput, options) || 'Multiple Choice Question';
  }

  public findRealQuestionPrompt(firstInput: HTMLElement, options: OptionItem[]): string {
    const optionTexts = options.map((o) => this.cleanText(o.text).toLowerCase());

    // Code blocks, tables and figures are question context, never the prompt itself
    const CONTEXT_ONLY = 'pre, code, table, img, svg, canvas, .cm-editor, .CodeMirror, .monaco-editor, .ace_editor';
    const isContextOnly = (el: Element) =>
      el.matches(CONTEXT_ONLY) ||
      isCodeBlock(el) ||
      // nothing but code/figures inside (e.g. a wrapper around a custom code panel)
      (this.cleanText(el.textContent || '').length > 0 &&
        this.cleanText(textWithoutCode(el)).length === 0) ||
      (!!el.querySelector(CONTEXT_ONLY) &&
        Array.from(el.querySelectorAll(CONTEXT_ONLY)).reduce((n, c) => n + this.cleanText(c.textContent || '').length, 0) >=
          this.cleanText(el.textContent || '').length * 0.8);
    // Prompt text of an element with any code panels inside it left out
    const promptText = (el: Element) => this.cleanText(textWithoutCode(el));

    // Traverse upwards from firstInput to find enclosing question card
    let node: HTMLElement | null = firstInput.parentElement;
    while (node && node !== document.body) {
      // 1. Look backwards among preceding siblings of node and their children.
      //    A "?" prompt anywhere at this level beats the nearest plain-text block.
      let fallback = '';
      let sibling = node.previousElementSibling;
      while (sibling) {
        // Skip code/figures, hidden nodes, and page chrome (nav bars, "QUESTIONS ATTEMPTED: 2/9")
        if (
          isContextOnly(sibling) ||
          !this.isPromptCandidate(sibling) ||
          sibling.matches('header, nav, footer, aside, [role="banner"], [role="navigation"]') ||
          /questions?\s+attempted|end\s+(practice|test|exam)/i.test(sibling.textContent || '')
        ) {
          sibling = sibling.previousElementSibling;
          continue;
        }
        if (!sibling.querySelector('input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]')) {
          const text = promptText(sibling);
          if (this.hasQuestionMark(text) && text.length >= 8 && !optionTexts.includes(text.toLowerCase())) {
            return text;
          }

          // Check inner elements of sibling
          const childPrompts = Array.from(sibling.querySelectorAll<HTMLElement>('div, p, span, h1, h2, h3, h4')).filter(
            (c) => this.isPromptCandidate(c) && !isContextOnly(c),
          );
          for (let i = childPrompts.length - 1; i >= 0; i--) {
            const childText = promptText(childPrompts[i]);
            if (this.hasQuestionMark(childText) && childText.length >= 8 && !optionTexts.includes(childText.toLowerCase())) {
              return childText;
            }
          }

          if (!fallback && text.length >= 10 && !optionTexts.includes(text.toLowerCase())) {
            fallback = text;
          }
        }
        sibling = sibling.previousElementSibling;
      }
      if (fallback) return fallback;

      // 2. Check preceding elements inside node before firstInput
      const allInside = Array.from(node.querySelectorAll<HTMLElement>('*'));
      const idx = allInside.indexOf(firstInput);
      const preceding = idx > 0 ? allInside.slice(0, idx) : [];

      // Look backwards for element containing '?'
      for (let i = preceding.length - 1; i >= 0; i--) {
        const el = preceding[i];
        if (el.querySelector('input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]')) continue;
        if (!this.isPromptCandidate(el) || isContextOnly(el)) continue;
        const text = promptText(el);
        if (this.hasQuestionMark(text) && text.length >= 8 && !optionTexts.includes(text.toLowerCase())) {
          return text;
        }
      }

      // Check headings or question classes
      const headings = Array.from(
        node.querySelectorAll<HTMLElement>('h1, h2, h3, h4, .question-text, .q-text, [class*="question" i]'),
      );
      for (const h of headings) {
        if (h.querySelector('input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]')) continue;
        if (!this.isPromptCandidate(h) || isContextOnly(h)) continue;
        const text = promptText(h);
        if (text.length >= 8 && !optionTexts.includes(text.toLowerCase())) {
          return text;
        }
      }

      node = node.parentElement;
    }

    return '';
  }

  public parseQuestionNumberAndText(
    rawText: string,
    defaultIndex: number,
  ): { questionNumber: number; questionText: string } {
    const sanitized = this.sanitizeQuestionPrompt(rawText);
    const cleaned = this.cleanText(sanitized);
    // Regex matching "Question 1:", "Q2.", "3)", etc.
    const match = cleaned.match(/^(?:question\s*|q\.?\s*)?(\d+)[\.\:\)\-\s]+(.+)$/i);
    if (match) {
      const num = parseInt(match[1], 10);
      const text = match[2].trim();
      return { questionNumber: isNaN(num) ? defaultIndex : num, questionText: text };
    }
    return { questionNumber: defaultIndex, questionText: cleaned };
  }

  private escapeSelector(str: string): string {
    if (typeof window !== 'undefined' && (window as any).CSS && typeof (window as any).CSS.escape === 'function') {
      return (window as any).CSS.escape(str);
    }
    return str.replace(/([!"#$%&'()*+,.\/:;<=>?@[\\\]^`{|}~])/g, '\\$1');
  }

  public generateUniqueSelector(elem: HTMLElement): string {
    if (elem.id) {
      return `#${this.escapeSelector(elem.id)}`;
    }
    if (elem.getAttribute('name')) {
      const val = elem.getAttribute('value');
      if (val && val !== 'on' && val !== '') {
        return `${elem.tagName.toLowerCase()}[name="${this.escapeSelector(elem.getAttribute('name')!)}"][value="${this.escapeSelector(val)}"]`;
      }
    }

    const path: string[] = [];
    let current: HTMLElement | null = elem;
    while (current && current !== document.body) {
      let selector = current.tagName.toLowerCase();
      if (current.id) {
        selector += `#${this.escapeSelector(current.id)}`;
        path.unshift(selector);
        break;
      } else {
        const parent = current.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter(
            (c) => c.tagName === current!.tagName,
          );
          if (siblings.length > 1) {
            const index = siblings.indexOf(current) + 1;
            selector += `:nth-of-type(${index})`;
          }
        }
      }
      path.unshift(selector);
      current = current.parentElement;
    }
    return path.join(' > ');
  }

  /**
   * Strategy 5: Unified writable question extraction (handles textareas, text inputs, contenteditable, cloze blanks)
   */
  public extractWritableQuestions(): ExtractedQuestion[] {
    return [];
  }

  public cleanText(text: string): string {
    return stripJunkChars(text).replace(/\s+/g, ' ').trim();
  }

  public cleanMultilineText(text: string): string {
    return stripJunkChars(text)
      .split('\n')
      .map((line) => line.replace(/[ \t]+/g, ' ').trim())
      .filter((line, i, arr) => line.length > 0 || (i > 0 && arr[i - 1].length > 0))
      .join('\n')
      .trim();
  }

  /**
   * Identifies any adjacent or enclosing reading passage, article, or stimulus text
   * commonly present in split-pane or comprehension exam layouts.
   */
  public findReadingPassageContext(questionElement?: Element | null): string | null {
    // 1. Explicit passage containers by selector
    const passageSelectors = [
      '.passage-panel',
      '.reading-pane',
      '.passage',
      '.reading-passage',
      '.reading-text',
      '.reading-material',
      '.reading-content',
      '.comprehension-text',
      '.comprehension',
      '.stimulus',
      '.cloze-passage',
      '.article-text',
      '.story-text',
      '.left-panel',
      '.left-pane',
      '.reading-section',
      '.passage-container',
      '.content-section',
      '[data-passage]',
      '[data-reading]',
      'article',
    ];

    for (const sel of passageSelectors) {
      const el = document.querySelector<HTMLElement>(sel);
      if (el && !el.closest('#ai-mcq-assistant-root') && isRendered(el)) {
        // Ensure element doesn't contain radio buttons, textareas, or input fields
        if (!el.querySelector('input[type="radio"], [role="radio"], textarea, input[type="text"], input[type="number"]')) {
          const txt = this.cleanMultilineText(el.innerText || el.textContent || '');
          if (txt.length >= 35) {
            return txt;
          }
        }
      }
    }

    // 2. Split-pane layout detection: a text-only column rendered BESIDE the question column.
    //    Page headers, nav bars and wizard controls sit above/below the question, not beside it,
    //    so they must never be mistaken for a reading passage.
    if (questionElement) {
      let column: Element = questionElement;
      let parent: Element | null = questionElement.parentElement;
      while (parent && parent !== document.body) {
        const children = Array.from(parent.children);

        if (children.length >= 2) {
          const colRect = column.getBoundingClientRect();
          for (const child of children) {
            if (child === column || child.contains(questionElement)) continue;
            if (
              child.matches(
                'label, h1, h2, h3, h4, h5, header, nav, footer, aside, button, .prompt, .question-title, .question-text, .q-text',
              )
            ) {
              continue;
            }
            if (!isRendered(child)) continue;

            const CONTROLS_OR_EDITOR =
              'input, textarea, select, button, [role="radio"], [role="checkbox"], [role="button"], .cm-editor, .CodeMirror, .monaco-editor, .ace_editor, pre';
            const hasControls = child.matches(CONTROLS_OR_EDITOR) || child.querySelector(CONTROLS_OR_EDITOR);
            const isPalette = child.querySelector(
              '.palette, [class*="palette"], [class*="question-nav"], [id*="palette"]',
            );
            if (hasControls || isPalette) continue;
            if (isCodeBlock(child) || findCodeBlocks(child).length > 0) continue; // code is not a passage

            const rect = child.getBoundingClientRect();
            const sideBySide =
              rect.width > 0 &&
              colRect.width > 0 &&
              (rect.right <= colRect.left + 4 || rect.left >= colRect.right - 4) &&
              rect.top < colRect.bottom &&
              rect.bottom > colRect.top;
            if (!sideBySide) continue;

            const text = this.cleanMultilineText((child as HTMLElement).innerText || child.textContent || '');
            if (text.length >= 120) {
              return text;
            }
          }
        }

        column = parent;
        parent = parent.parentElement;
      }
    }

    // 3. Look for elements containing keywords like "Read the text", "Passage", "Comprehension" or gap markers (1) ___
    const allDivs = Array.from(document.querySelectorAll<HTMLElement>('div, section, p, article'));
    for (const div of allDivs) {
      if (div.closest('#ai-mcq-assistant-root')) continue;
      if (
        div.querySelector('input[type="radio"], [role="radio"], textarea, input[type="text"], input[type="number"]')
      ) {
        continue;
      }
      if (!isRendered(div)) continue;

      const raw = div.innerText || div.textContent || '';
      if (
        (raw.includes('Read the text') ||
          raw.includes('Read the following') ||
          raw.includes('Passage') ||
          raw.includes('Instruction:') ||
          raw.includes('Case Study') ||
          raw.includes('(1) ___') ||
          raw.includes('(1)___')) &&
        raw.length >= 35 &&
        raw.length < 3500
      ) {
        return this.cleanMultilineText(raw);
      }
    }

    return null;
  }

  /**
   * Helper to locate the exact sentence inside a reading passage that contains a specific blank number (e.g. "(1)")
   */
  public extractSentenceWithBlank(passage: string, blankNumber: string): string | null {
    if (!passage) return null;
    const cleanPassage = passage.replace(/\r/g, '');
    const sentences = cleanPassage.split(/(?<=[.?!])\s+/);

    const patterns = [
      new RegExp(`\\(${blankNumber}\\)\\s*_{1,}`, 'i'),
      new RegExp(`\\(${blankNumber}\\)`, 'i'),
      new RegExp(`\\[${blankNumber}\\]\\s*_{1,}`, 'i'),
      new RegExp(`\\[${blankNumber}\\]`, 'i'),
      new RegExp(`blank\\s*\\(?${blankNumber}\\)?`, 'i'),
    ];

    for (const sentence of sentences) {
      for (const pattern of patterns) {
        if (pattern.test(sentence)) {
          return sentence.trim();
        }
      }
    }

    return null;
  }

  /**
   * Helper to locate the exact sentence or transformation item inside a reading passage / context.
   * Supports:
   * 1. Cambridge English Key Word Transformation (e.g. "2. My sister can swim better than I can.\nAS\nI cannot swim _____________ my sister.")
   * 2. Cloze reading blanks with marker "(2) ___"
   */
  public extractTargetItemFromContext(contextText: string, itemNumber: string): string | null {
    if (!contextText) return null;
    const cleanContext = contextText.replace(/\r/g, '');

    // Pattern 1: Numbered transformation item (e.g. "2. My sister can swim better than I can. AS I cannot swim _____________ my sister.")
    const nextNum = String(parseInt(itemNumber, 10) + 1);
    const itemRegex = new RegExp(
      `(?:^|\\n)\\s*${itemNumber}[\\.\\:\\)]\\s*([\\s\\S]*?)(?=(?:\\n\\s*${nextNum}[\\.\\:\\)]|\\n\\s*Question|\\n\\s*Instructions?|$))`,
      'i',
    );
    const match = cleanContext.match(itemRegex);
    if (match && match[1]?.trim().length >= 8) {
      return `${itemNumber}. ${match[1].trim()}`;
    }

    // Pattern 2: Cloze sentence with blank marker like "(2) ___"
    return this.extractSentenceWithBlank(cleanContext, itemNumber);
  }

  /**
   * Discovers overarching panel/section instructions (e.g. "Do not change the word given. Use between 2 and 5 words...")
   */
  public findPaneInstruction(elem?: Element | null): string | null {
    if (!elem) return null;
    let curr: HTMLElement | null = elem.parentElement;
    while (curr && curr !== document.body) {
      const candidates = Array.from(
        curr.querySelectorAll<HTMLElement>(
          '.instruction, .instructions, .panel-instruction, .directions, p, div, span',
        ),
      );
      for (const cand of candidates) {
        if (cand.querySelector('textarea, input, [role="radio"]')) continue;
        const text = this.cleanMultilineText(cand.innerText || cand.textContent || '');
        if (
          text.length >= 15 &&
          text.length < 400 &&
          (text.toLowerCase().includes('do not change') ||
            text.toLowerCase().includes('including the word given') ||
            text.toLowerCase().includes('use between') ||
            text.toLowerCase().includes('write between') ||
            text.toLowerCase().includes('word given') ||
            text.toLowerCase().includes('complete the second sentence'))
        ) {
          return text;
        }
      }
      curr = curr.parentElement;
    }
    return null;
  }

  /**
   * Enriches a question prompt with any detected reading passage / context
   */
  public enrichQuestionWithContext(
    rawText: string,
    contextElement?: Element | null,
  ): { fullQuestionText: string; contextText?: string } {
    const contextText = this.findReadingPassageContext(contextElement);
    if (!contextText || rawText.includes(contextText.slice(0, 30))) {
      return { fullQuestionText: rawText, contextText: undefined };
    }

    // Match blank or sentence index: e.g. "blank (2)", "sentence(2)", "sentence 2", "blank 2", "item 2", "q2"
    const indexMatch = rawText.match(/(?:blank|sentence|item|question|q\.?)\s*\(?(\d+)\)?/i);
    let targetItemInfo = '';
    if (indexMatch) {
      const itemNum = indexMatch[1];
      const targetItem = this.extractTargetItemFromContext(contextText, itemNum);
      if (targetItem) {
        targetItemInfo = `\n\n[TARGET SENTENCE FOR BLANK (${itemNum})]:\n${targetItem}\n\n[TARGET TRANSFORMATION / SENTENCE TASK (${itemNum})]:\n${targetItem}`;
      }
    }

    const paneInstruction = this.findPaneInstruction(contextElement);
    let instructionInfo = '';
    if (paneInstruction && !contextText.includes(paneInstruction.slice(0, 20))) {
      instructionInfo = `\n\n[INSTRUCTIONS]:\n${paneInstruction}`;
    }

    const fullQuestionText = `[PASSAGE / READING CONTEXT]:\n${contextText}${targetItemInfo}${instructionInfo}\n\n[QUESTION]:\n${rawText}`;
    return { fullQuestionText, contextText };
  }
}
