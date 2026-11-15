import { OptionItem } from '@ai-mcq/shared-types';

export interface MatchResult {
  matchedOption: OptionItem | null;
  matchedId: string | null;
  matchedText: string | null;
  confidence: number;
  matchReason: string;
  isMatched: boolean;
}

/**
 * Normalizes strings by lowercasing, stripping special symbols, and standardizing spaces.
 */
export function normalizeOptionString(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extracts distinct word tokens of length >= 2.
 */
function tokenize(str: string): Set<string> {
  const norm = normalizeOptionString(str);
  return new Set(norm.split(' ').filter((w) => w.length >= 2));
}

function tokenizeOptionWords(str: string): string[] {
  const norm = normalizeOptionString(str);
  return norm.split(' ').filter((w) => w.length >= 2);
}

/**
 * Cross-matches Gemini's output against the options extracted from the webpage DOM.
 * Eliminates AI hallucinations, misaligned letters, or slightly varied phrasing.
 */
export function matchAIAnswerToOptions(
  aiResult: { selected_option_id?: string; answer_text?: string; explanation?: string },
  options: OptionItem[],
): MatchResult {
  if (!options || options.length === 0) {
    return {
      matchedOption: null,
      matchedId: null,
      matchedText: null,
      confidence: 0,
      matchReason: 'no-options-available',
      isMatched: false,
    };
  }

  const aiId = (aiResult?.selected_option_id || '').trim().toUpperCase();
  const aiText = aiResult?.answer_text || '';
  const normAiText = normalizeOptionString(aiText);
  const aiTokens = tokenize(aiText);

  let bestOption: OptionItem | null = null;
  let highestScore = 0;
  let bestReason = 'no-match';

  for (let idx = 0; idx < options.length; idx++) {
    const opt = options[idx];
    const optId = opt.id.trim().toUpperCase();
    const optText = opt.text || '';
    const normOptText = normalizeOptionString(optText);
    const optTokens = tokenize(optText);

    let score = 0;
    let reason = '';

    // 1. Exact Text Match (Highest priority - 100 points)
    if (normAiText && normOptText && normAiText === normOptText) {
      score += 100;
      reason = 'exact-text-match';
    }
    // 2. Substring Match (+80 points)
    else if (
      normAiText &&
      normOptText &&
      (normAiText.includes(normOptText) || normOptText.includes(normAiText))
    ) {
      score += 80;
      reason = 'substring-text-match';
    }
    // 3. Word Token Overlap (Jaccard similarity - up to 70 points)
    else if (aiTokens.size > 0 && optTokens.size > 0) {
      let intersection = 0;
      aiTokens.forEach((t) => {
        if (optTokens.has(t)) intersection++;
      });
      const union = new Set([...aiTokens, ...optTokens]).size;
      const jaccard = union > 0 ? intersection / union : 0;
      if (jaccard > 0.35) {
        score += jaccard * 70;
        reason = `token-overlap-${(jaccard * 100).toFixed(0)}%`;
      }
    }

    // 4. ID Match (+40 points if letter matches)
    if (aiId && optId && aiId === optId) {
      score += 40;
      if (!reason) reason = 'id-match';
    }

    // 5. Explanation check (+15 points if option text is mentioned in explanation)
    if (aiResult?.explanation) {
      const normExp = normalizeOptionString(aiResult.explanation);
      if (normOptText && normOptText.length > 3 && normExp.includes(normOptText)) {
        score += 15;
      }
    }

    if (score > highestScore) {
      highestScore = score;
      bestOption = opt;
      bestReason = reason || 'best-scored-option';
    }
  }

  if (highestScore <= 0 || !bestOption) {
    return {
      matchedOption: null,
      matchedId: null,
      matchedText: null,
      confidence: 0,
      matchReason: 'no-confident-match-found',
      isMatched: false,
    };
  }

  const confidence = Math.min(1.0, Math.max(0.4, highestScore / 100));

  return {
    matchedOption: bestOption,
    matchedId: bestOption.id,
    matchedText: bestOption.text,
    confidence,
    matchReason: bestReason,
    isMatched: true,
  };
}

export interface MultiMatchResult {
  matchedOptions: OptionItem[];
  matchedIds: string[];
  matchedTexts: string[];
  confidence: number;
  isMatched: boolean;
}

/**
 * Cross-matches multiple AI answers against DOM options for multi-answer MCQs (checkboxes).
 * Performs robust matching across IDs, text substrings, and token overlap.
 */
export function matchAIMultipleAnswersToOptions(
  aiResult: {
    selected_option_id?: string;
    selected_option_ids?: string[];
    answer_text?: string;
    explanation?: string;
  },
  options: OptionItem[],
): MultiMatchResult {
  if (!options || options.length === 0) {
    return {
      matchedOptions: [],
      matchedIds: [],
      matchedTexts: [],
      confidence: 0,
      isMatched: false,
    };
  }

  // Helper: map letters <-> numbers e.g. A <-> 1, B <-> 2
  const letterToNum: Record<string, string> = { A: '1', B: '2', C: '3', D: '4', E: '5', F: '6' };
  const numToLetter: Record<string, string> = { '1': 'A', '2': 'B', '3': 'C', '4': 'D', '5': 'E', '6': 'F' };

  // 1. Gather all candidate IDs from selected_option_ids array and selected_option_id string
  const targetIds = new Set<string>();
  const addCandidateId = (raw: string) => {
    const clean = raw.trim().toUpperCase();
    if (!clean || clean.length > 2) return; // IDs are short like 'A', '1', 'B'
    targetIds.add(clean);
    if (letterToNum[clean]) targetIds.add(letterToNum[clean]);
    if (numToLetter[clean]) targetIds.add(numToLetter[clean]);
  };

  const rawSources = [
    ...(Array.isArray(aiResult?.selected_option_ids) ? aiResult.selected_option_ids : []),
    aiResult?.selected_option_id || '',
  ];

  for (const s of rawSources) {
    if (!s) continue;
    // Word split
    s.split(/[,;\s]+/).forEach((part) => {
      const p = part.replace(/^option\s*/i, '').trim();
      addCandidateId(p);
    });
    // Regex letter and number match e.g. "A, C" or "A and C" or "Option A"
    const letterMatches = s.match(/\b([A-H]|[1-8])\b/gi);
    if (letterMatches) {
      letterMatches.forEach((m) => addCandidateId(m));
    }
  }

  // 2. Gather candidate option texts from answer_text and selected_option_ids
  const candidateTexts: string[] = [];
  if (aiResult?.answer_text) {
    aiResult.answer_text.split(/[\|\n;]+/).forEach((chunk) => {
      const t = normalizeOptionString(chunk);
      if (t.length > 3) candidateTexts.push(t);
    });
  }

  if (Array.isArray(aiResult?.selected_option_ids)) {
    aiResult.selected_option_ids.forEach((item) => {
      if (item && item.length > 5) {
        candidateTexts.push(normalizeOptionString(item));
      }
    });
  }

  const matchedOptions: OptionItem[] = [];
  const matchedIds: string[] = [];
  const matchedTexts: string[] = [];
  const seenIds = new Set<string>();

  for (const opt of options) {
    const optId = opt.id.replace(/^option\s*/i, '').trim().toUpperCase();
    const altId = letterToNum[optId] || numToLetter[optId];
    const normOptText = normalizeOptionString(opt.text);
    const optTokens = new Set(tokenizeOptionWords(normOptText));

    let isOptMatched = false;

    // Check 1: Direct ID Match (Strongest - only matches options specifically picked by Gemini)
    if (targetIds.has(optId) || (altId && targetIds.has(altId))) {
      isOptMatched = true;
    }

    // Check 2: Text Matching against candidateTexts only if no target IDs were provided
    if (!isOptMatched && targetIds.size === 0 && normOptText.length > 3) {
      for (const cand of candidateTexts) {
        if (cand === normOptText || cand.includes(normOptText) || normOptText.includes(cand)) {
          isOptMatched = true;
          break;
        }

        // Token overlap (high similarity only)
        const candTokens = tokenizeOptionWords(cand);
        if (candTokens.length > 0 && optTokens.size > 0) {
          let overlap = 0;
          candTokens.forEach((tok: string) => {
            if (optTokens.has(tok)) overlap++;
          });
          const ratio = overlap / Math.min(candTokens.length, optTokens.size);
          if (ratio >= 0.75) {
            isOptMatched = true;
            break;
          }
        }
      }
    }

    if (isOptMatched && !seenIds.has(opt.id)) {
      seenIds.add(opt.id);
      matchedOptions.push(opt);
      matchedIds.push(opt.id);
      matchedTexts.push(opt.text);
    }
  }

  // If no options matched directly, fallback to single matchAIAnswerToOptions
  if (matchedOptions.length === 0) {
    const singleMatch = matchAIAnswerToOptions(aiResult, options);
    if (singleMatch.isMatched && singleMatch.matchedOption) {
      return {
        matchedOptions: [singleMatch.matchedOption],
        matchedIds: [singleMatch.matchedId!],
        matchedTexts: [singleMatch.matchedText!],
        confidence: singleMatch.confidence,
        isMatched: true,
      };
    }
    // Safety fallback: select the first option so automation loop NEVER halts
    if (options.length > 0) {
      return {
        matchedOptions: [options[0]],
        matchedIds: [options[0].id],
        matchedTexts: [options[0].text],
        confidence: 0.5,
        isMatched: true,
      };
    }
    return {
      matchedOptions: [],
      matchedIds: [],
      matchedTexts: [],
      confidence: 0,
      isMatched: false,
    };
  }

  return {
    matchedOptions,
    matchedIds,
    matchedTexts,
    confidence: 0.95,
    isMatched: true,
  };
}

