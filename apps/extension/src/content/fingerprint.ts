/**
 * Generates a stable fingerprint from question text and options.
 * Normalizes text (lowercases, removes excessive whitespace and punctuation)
 * to prevent duplicate AI queries on minor DOM re-renders.
 */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    // Strip countdown timers and timestamps like "01:59", "15:00", "0:45"
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, '')
    // Strip dynamic score/attempt counters e.g. "score: 3", "3/20", "questions attempted: 3/20"
    .replace(/\bscore\s*:\s*\d+\b/g, '')
    .replace(/\bquestions\s*attempted\s*:\s*\d+\s*\/\s*\d+\b/g, '')
    .replace(/\b\d+\s*\/\s*\d+\b/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s]/gi, '')
    .trim();
}

export function createQuestionFingerprint(
  questionText: string,
  options: { id?: string; text: string }[],
): string {
  const normQuestion = normalizeText(questionText);
  const normOptions = options
    .map((o) => normalizeText(o.text))
    .sort()
    .join('|');

  const combined = `${normQuestion}:::${normOptions}`;

  // Deterministic 32-bit FNV-1a hash formatted as hex string
  let hash = 2166136261;
  for (let i = 0; i < combined.length; i++) {
    hash ^= combined.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }

  const hexHash = (hash >>> 0).toString(16).padStart(8, '0');
  const shortSnippet = normQuestion.slice(0, 16).replace(/\s+/g, '_');
  return `q_${shortSnippet}_${hexHash}`;
}

