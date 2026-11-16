import { Injectable, Logger } from '@nestjs/common';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { AIProvider } from './ai-provider.interface';
import { AIAnswerResult, AIAnswerResultSchema, QuestionType, QuestionImagePayload } from '@ai-mcq/shared-types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Seconds Gemini asks us to wait on a 429, if it says. */
/** Milliseconds until the next midnight in US Pacific time (when Gemini daily quotas reset). */
export function msUntilPacificMidnight(now = new Date()): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((x) => x.type === t)?.value || 0);
  const elapsed = (get('hour') * 3600 + get('minute') * 60 + get('second')) * 1000;
  return Math.max(60000, 24 * 3600 * 1000 - elapsed);
}

/**
 * What to type into an answer box: the bare answer, without wrapping quotes/backticks,
 * "Answer:" prefixes or a trailing full stop on short answers.
 */
export function cleanTypedAnswer(raw: string): string {
  let t = String(raw || '').trim();
  t = t.replace(/^(final\s+)?answer\s*[:=-]\s*/i, '');
  const fenced = t.match(/^```[a-z]*\n?([\s\S]*?)\n?```$/i);
  if (fenced) t = fenced[1].trim();
  if (/^(["'`])[\s\S]*\1$/.test(t) && t.length >= 2) t = t.slice(1, -1).trim();
  if (!t.includes('\n') && t.length <= 40) t = t.replace(/\.$/, '');
  return t;
}

export function parseRetryDelayMs(message: string): number | null {
  const m = message.match(/retry(?:Delay)?["':\s]*(?:in\s*)?"?(\d+(?:\.\d+)?)\s*s/i);
  return m ? Math.ceil(parseFloat(m[1]) * 1000) : null;
}

@Injectable()
export class GeminiProvider implements AIProvider {
  readonly providerName = 'gemini';
  private readonly logger = new Logger(GeminiProvider.name);

  // Kept to models Google lists as available. 1.5 / 2.0 are shut down, 2.5 is limited to
  // existing users. Update this list when Google retires a model.
  // Alias Google keeps pointed at its newest Flash-Lite (chosen in c1979fe for its rate limits)
  static readonly DEFAULT_MODEL = 'gemini-flash-lite-latest';

  /**
   * Gemini calls are queued. Several tabs running Auto-Loop at once used to fire requests in
   * parallel, hit the per-minute quota together and all fail, which stopped every loop.
   */
  private readonly maxConcurrent = Math.max(1, parseInt(process.env.GEMINI_MAX_CONCURRENCY || '2', 10));
  private active = 0;
  private waiting: (() => void)[] = [];

  private async acquireSlot(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve)); // slot is handed over on release
  }

  private releaseSlot(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.active--;
  }

  /** Requests currently waiting for a Gemini slot (for logs / health). */
  get queueLength(): number {
    return this.waiting.length;
  }
  private readonly availableModels = [
    'gemini-flash-lite-latest',
    'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite',
    'gemini-3.6-flash',
    'gemini-3.8-flash',
    'gemma-4-26b-a4b-it',
  ];

  /**
   * Models tried in order when the chosen one is rate limited. Each model has its OWN free
   * quota, so rotating through them keeps a long practice set going. Gemma is slower but has a
   * separate quota and is the last resort.
   */
  static readonly FALLBACK_MODELS = [
    'gemini-flash-lite-latest',
    'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite',
    'gemini-3.6-flash',
    'gemini-3.8-flash',
    'gemma-4-26b-a4b-it',
  ];

  /** Model -> time (ms) until which it is rate limited. Skipped until then, no waiting. */
  private readonly cooldownUntil = new Map<string, number>();

  /** Rate-limit state per model, for logs and the health endpoint. */
  getCooldowns(): { model: string; secondsLeft: number }[] {
    const now = Date.now();
    return Array.from(this.cooldownUntil.entries())
      .filter(([, until]) => until > now)
      .map(([model, until]) => ({ model, secondsLeft: Math.ceil((until - now) / 1000) }));
  }

  getAvailableModels(): string[] {
    return this.availableModels;
  }

  async validateConnection(testConfig?: { apiKey: string; model?: string }): Promise<{
    success: boolean;
    message: string;
    model: string;
  }> {
    const apiKey = testConfig?.apiKey || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return {
        success: false,
        message: 'No Gemini API key provided or found in configuration/environment.',

        model: testConfig?.model || 'gemini-flash-lite-latest',
      };
    }

    const modelName = testConfig?.model || 'gemini-flash-lite-latest';


    try {
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({ model: modelName });

      // Minimal test prompt with timeout
      const testPromise = model.generateContent({
        contents: [
          {
            role: 'user',
            parts: [{ text: 'Respond with exactly: {"status":"connected"}' }],
          },
        ],
      });

      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Connection test timed out after 10 seconds')), 10000),
      );

      const result = await Promise.race([testPromise, timeoutPromise]);
      const text = result.response.text();

      if (text && text.length > 0) {
        return {
          success: true,
          message: `Successfully connected to Gemini API with model ${modelName}`,
          model: modelName,
        };
      } else {
        return {
          success: false,
          message: 'Received empty response from Gemini API',
          model: modelName,
        };
      }
    } catch (error: any) {
      this.logger.error(`Gemini connection test failed: ${error.message}`);
      return {
        success: false,
        message: `Connection failed: ${error.message || 'Unknown error'}`,
        model: modelName,
      };
    }
  }

  async generateAnswer(
    question: string,
    options: { id: string; text: string }[],
    optionsMetadata?: {
      isMultipleChoiceMultipleAnswer?: boolean;
      isOrderingQuestion?: boolean;
      questionType?: QuestionType;
    },
    apiKeyOverride?: string,
    modelOverride?: string,
    topicKnowledge?: any[],
    customKnowledgeText?: string,
    webSearchEvidence?: string[],
    images?: QuestionImagePayload[],
  ): Promise<AIAnswerResult> {
    const apiKey = apiKeyOverride || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('Gemini API key is not configured.');
    }

    await this.acquireSlot();
    try {
      return await this.generateAnswerUnqueued(
        apiKey,
        question,
        options,
        optionsMetadata,
        modelOverride,
        topicKnowledge,
        customKnowledgeText,
        webSearchEvidence,
        images,
      );
    } finally {
      this.releaseSlot();
    }
  }

  private async generateAnswerUnqueued(
    apiKey: string,
    question: string,
    options: { id: string; text: string }[],
    optionsMetadata:
      | { isMultipleChoiceMultipleAnswer?: boolean; isOrderingQuestion?: boolean; questionType?: QuestionType }
      | undefined,
    modelOverride?: string,
    topicKnowledge?: any[],
    customKnowledgeText?: string,
    webSearchEvidence?: string[],
    images?: QuestionImagePayload[],
  ): Promise<AIAnswerResult> {

    const genAI = new GoogleGenerativeAI(apiKey);
    const isMultiAnswer = optionsMetadata?.isMultipleChoiceMultipleAnswer ?? false;
    const isOrdering = Boolean(optionsMetadata?.isOrderingQuestion || optionsMetadata?.questionType === 'ORDERING');
    // Typed answer ("Enter your answer" box): no options to pick from
    const isText = !isOrdering && (optionsMetadata?.questionType === 'DESCRIPTIVE' || options.length === 0);

    const requestedModel = modelOverride || GeminiProvider.DEFAULT_MODEL;
    const allModels = [requestedModel, ...GeminiProvider.FALLBACK_MODELS.filter((m) => m !== requestedModel)];
    // Skip models that are rate limited right now instead of waiting on them
    const now = Date.now();
    const modelsToTry = allModels.filter((m) => (this.cooldownUntil.get(m) || 0) <= now);
    if (modelsToTry.length === 0) {
      const soonest = Math.min(...allModels.map((m) => this.cooldownUntil.get(m) || now));
      const secs = Math.max(1, Math.ceil((soonest - now) / 1000));
      throw new Error(`429 All Gemini models are busy or rate limited. Please retry in ${secs}s.`);
    }

    let systemPrompt = '';
    if (isText) {
      systemPrompt = `You are an expert academic tutor solving a TYPED-ANSWER question.
There are no options: the student must type the answer into a text box, and the portal compares it with the expected answer.

STRICT INSTRUCTIONS:
1. Work the problem out carefully step by step in "reasoning" (show calculations).
2. "answer_text" must contain ONLY what should be typed into the box: the shortest exact answer
   (a number, word, short phrase, expression, or code snippet). No explanation, no units unless the
   question asks for them, no "Answer:" prefix, no surrounding quotes, no trailing full stop.
3. Match the format the question implies (e.g. an integer stays "17", not "17.0"; keep list/array
   formatting like [1, 2, 3] if a list is asked for; keep exact casing for code/keywords).
4. Set "selected_option_id" to "TEXT".
5. If the question is ambiguous or you are unsure, still give your best answer and set "needs_review": true.
6. Output ONLY a raw JSON object (no markdown, no code fences):
{
  "selected_option_id": "TEXT",
  "answer_text": "17",
  "explanation": "One or two sentences on why.",
  "confidence": 0.95,
  "needs_review": false,
  "reasoning": "Step-by-step working"
}`;
    } else if (isOrdering) {
      systemPrompt = `You are an expert academic tutor and AI ordering/sequencing solver.
IMPORTANT: This is a REARRANGE / DRAG-AND-DROP ORDERING QUESTION.
The user must arrange the given items/steps into the correct chronological, logical, or procedural sequence from first step (beginning) to last step (end).

The items currently displayed on the webpage are:
${options.map((o) => `[ID ${o.id}] "${o.text}"`).join('\n')}

STRICT INSTRUCTIONS:
1. Determine the exact logical order from first step (beginning) to last step (end).
2. In "ordered_sequence", return an array containing ALL option IDs in their correct chronological order. For example, if item 4 comes first, then 3, then 2, then 1, return:
   "ordered_sequence": ["4", "3", "2", "1"]
3. In "selected_option_id", return the comma-separated IDs of the sequence, e.g. "4, 3, 2, 1".
4. In "answer_text", write the sequence clearly, e.g. "Step 1: [4] ... -> Step 2: [3] ... -> Step 3: [2] ... -> Step 4: [1] ...".
5. In "explanation", explain step-by-step why this sequence is correct.
6. You must output ONLY a raw JSON object matching this structure (no markdown formatting, no comments, no code fences):
{
  "selected_option_id": "4, 3, 2, 1",
  "ordered_sequence": ["4", "3", "2", "1"],
  "answer_text": "4 -> 3 -> 2 -> 1",
  "explanation": "Clear explanation of why this is the correct sequence.",
  "confidence": 0.98,
  "needs_review": false,
  "alternative_options": [],
  "reasoning": "Step-by-step logical order breakdown"
}`;
    } else if (isMultiAnswer) {
      systemPrompt = `You are an expert academic tutor and AI MCQ solver.
IMPORTANT: This is a MULTIPLE-CHOICE QUESTION WITH ONE OR MORE CORRECT ANSWERS (Square checkboxes).
Evaluate EACH option independently as TRUE or FALSE based on sound academic knowledge, verified facts, and principles.
SELECT ALL options that are correct statements. More than one option can be correct!

STRICT INSTRUCTIONS:
1. ONLY pick from the provided option IDs: ${options.map((o) => `"${o.id}"`).join(', ')}.
2. You MUST evaluate every single option carefully. Do NOT stop after finding one correct option. Include ALL correct options!
3. In "selected_option_ids", return an array of strings containing all correct option IDs, e.g. ["A", "C"].
4. In "selected_option_id", return the comma-separated IDs, e.g. "A, C".
5. In "answer_text", list the full text of all selected options separated by " | ".
6. You must output ONLY a raw JSON object matching this structure (no markdown formatting, no comments, no code fences):
{
  "selected_option_id": "A, C",
  "selected_option_ids": ["A", "C"],
  "answer_text": "Text of option A | Text of option C",
  "explanation": "Clear explanation stating why each selected option is correct and why unselected options are incorrect.",
  "confidence": 0.95,
  "needs_review": false,
  "alternative_options": [],
  "reasoning": "Step-by-step evaluation of each option"
}`;
    } else {
      systemPrompt = `You are an expert academic tutor and AI MCQ solver.
Analyze the given multiple-choice question and options carefully.
Select the most accurate option based on sound principles, standard curriculum, or verified facts.

STRICT INSTRUCTIONS:
1. ONLY pick from the provided option IDs: ${options.map((o) => `"${o.id}"`).join(', ')}.
2. NEVER invent new options or alter option IDs.
3. If the question is ambiguous, contains errors, or multiple options seem equally valid, set "needs_review": true and explain why in "reasoning".
4. You must output ONLY a raw JSON object matching this structure (no markdown formatting, no comments, no code fences):
{
  "selected_option_id": "B",
  "answer_text": "Exact text of the chosen option",
  "explanation": "Clear, concise 1-3 sentence explanation of why this answer is correct.",
  "confidence": 0.95,
  "needs_review": false,
  "alternative_options": [],
  "reasoning": "Brief analytical breakdown"
}`;
    }

    const imageList = (images || []).slice(0, 8);
    if (imageList.length > 0) {
      systemPrompt += `\n\nATTACHED IMAGES: ${imageList.length} image(s) are attached and are PART OF THE QUESTION (diagrams, code screenshots, tables, graphs, or pictures used as options). Read every image carefully before answering. Image order and meaning:\n${imageList
        .map((img, i) => `Image ${i + 1}: ${img.label || 'Question figure'}`)
        .join('\n')}\nIf a screenshot shows the question and options, use the option IDs given in the JSON, matching them to the option texts.`;
    }

    if (webSearchEvidence && webSearchEvidence.length > 0) {
      const searchSnippets = webSearchEvidence.slice(0, 5).join('\n\n');
      systemPrompt += `\n\nLIVE WEB & BROWSER SEARCH EVIDENCE (Retrieved via Web Search Tool):\n${searchSnippets}\n\nHIGH PRIORITY SEARCH MATCHING RULE:\n1. If the web search evidence above contains the exact question or identical problem setup, MATCH it to the provided options and SELECT the verified answer directly!\n2. If the web search evidence does not directly answer this question, proceed to use the user notes and logical reasoning rules below.`;
    }

    if (customKnowledgeText && customKnowledgeText.trim().length > 0) {
      systemPrompt += `\n\n[USER-PROVIDED CONTEXT / CHEAT-SHEET / KNOWLEDGE BASE]:\n"""\n${customKnowledgeText.trim()}\n"""\nCRITICAL TOP PRIORITY: The user has explicitly loaded the custom knowledge / context above to solve these questions. Thoroughly read and apply these rules, formulas, facts, and definitions. If this context answers or informs the question, STRICTLY follow it to pick the correct option(s)!`;
    }

    if (topicKnowledge && topicKnowledge.length > 0) {
      const topicName = topicKnowledge[0].topic || 'Current Assessment';
      const facts = topicKnowledge
        .slice(0, 8)
        .map((k) => {
          let line = `- Verified Fact: For question "${k.questionText.slice(0, 70)}", the correct option is "${k.correctOptionText}".`;
          if (k.wrongOptionText) {
            line += ` (Known mistake: "${k.wrongOptionText}" is INCORRECT; avoid it).`;
          }
          return line;
        })
        .join('\n');

      systemPrompt += `\n\nVERIFIED SUBJECT KNOWLEDGE BASE (From topic: ${topicName}):\n${facts}\nUse these verified facts to ensure high accuracy for related questions on this topic.`;
    }

    // Specialized high-accuracy reasoning instructions for Aptitude & Logic Puzzles
    if (
      question.toLowerCase().includes('sitting') ||
      question.toLowerCase().includes('seated') ||
      question.toLowerCase().includes('table') ||
      question.toLowerCase().includes('row') ||
      question.toLowerCase().includes('bench')
    ) {
      systemPrompt += `\n\nCRITICAL RULES FOR SEATING ARRANGEMENT PUZZLES:
1. CIRCULAR TABLE FACING CENTER:
   - "Facing Center" means:
     * Immediate LEFT = Next position in CLOCKWISE order (+1 seat)
     * Immediate RIGHT = Next position in ANTI-CLOCKWISE order (-1 seat)
   - Step A: Count total individuals (e.g. 5, 6, 7, 8). Number seats 1 to N in clockwise order.
   - Step B: Fix the first anchor person at Seat 1.
   - Step C: Map each clue carefully. If A is second to the left of F, calculate the seat offset accurately.
   - Step D: Verify negative clues (e.g., "S is not a neighbor of O").
   - Step E: Double-check whether the question asks "to the left of X" or "to the right of X".
2. LINEAR ROW FACING NORTH:
   - Facing North means: Left is West (←), Right is East (→).
   - "X is to the immediate right of Y" means sequence is [Y, X].
   - "X is second to the left of Y" means sequence is [X, _, Y].
3. Dedicate the entire "reasoning" field to writing out the complete seat-by-seat layout map before choosing your final option.`;
    }

    const userContent = JSON.stringify({
      question,
      options,
      questionType: isText ? 'TYPED_ANSWER' : isMultiAnswer ? 'MULTIPLE_CHOICE_MULTIPLE_ANSWER' : 'SINGLE_CHOICE',
    });

    let lastError: Error | null = null;
    // Flash-Lite answers text in ~1-3s. Waiting 40s on an overloaded model only stalls the
    // loop; give up sooner and let the next model answer.
    const timeoutMs = imageList.length > 0 ? 45000 : 20000;
    const parts: any[] = [
      { text: userContent },
      ...imageList.map((img) => ({ inlineData: { mimeType: img.mimeType, data: img.data } })),
    ];

    for (const currentModelName of modelsToTry) {
      let attempts = 0;
      const maxAttempts = 2;
      let delay = 800;

      while (attempts < maxAttempts) {
        attempts++;
        try {
          const model = genAI.getGenerativeModel({
            model: currentModelName,
            generationConfig: {
              responseMimeType: 'application/json',
            },
            systemInstruction: systemPrompt,
          });

          const generatePromise = model.generateContent({
            contents: [{ role: 'user', parts }],
          });

          let timer: NodeJS.Timeout | undefined;
          const timeoutPromise = new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`AI request timed out after ${timeoutMs / 1000} seconds`)),
              timeoutMs,
            );
          });

          const response = await Promise.race([generatePromise, timeoutPromise]).finally(() => clearTimeout(timer));
          const responseText = response.response.text();

          const cleanedJson = this.cleanJsonResponse(responseText);
          const parsed = JSON.parse(cleanedJson);

          // Parse selected_option_ids
          let selectedIds: string[] | undefined = undefined;
          if (Array.isArray(parsed.selected_option_ids) && parsed.selected_option_ids.length > 0) {
            selectedIds = parsed.selected_option_ids.map(String);
          } else if (parsed.selected_option_id && (parsed.selected_option_id.includes(',') || parsed.selected_option_id.includes(';'))) {
            selectedIds = String(parsed.selected_option_id)
              .split(/[,;]+/)
              .map((s) => s.trim())
              .filter(Boolean);
          }

          // Parse ordered_sequence if ordering question
          let orderedSeq: string[] | undefined = undefined;
          if (Array.isArray(parsed.ordered_sequence) && parsed.ordered_sequence.length > 0) {
            orderedSeq = parsed.ordered_sequence.map(String);
          } else if (isOrdering && parsed.selected_option_id) {
            orderedSeq = String(parsed.selected_option_id)
              .split(/[,;\->\s]+/)
              .map((s) => s.trim())
              .filter(Boolean);
          }

          // Validate structure with Zod
          const validated = AIAnswerResultSchema.parse({
            selected_option_id: isText ? 'TEXT' : String(
              parsed.selected_option_id ||
                (orderedSeq ? orderedSeq.join(', ') : selectedIds ? selectedIds.join(', ') : ''),
            ),
            selected_option_ids: isText ? undefined : selectedIds,
            ordered_sequence: orderedSeq,
            answer_text: String(
              parsed.answer_text ||
                (orderedSeq
                  ? orderedSeq.join(' → ')
                  : (selectedIds || [String(parsed.selected_option_id || '')])
                      .map((id) => options.find((o) => o.id === id)?.text || id)
                      .join(' | ')) ||
                'No answer text',
            ),
            explanation: String(parsed.explanation || 'No explanation provided.'),
            confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.9,
            needs_review: Boolean(parsed.needs_review),
            alternative_options: Array.isArray(parsed.alternative_options)
              ? parsed.alternative_options.map(String)
              : [],
            reasoning: parsed.reasoning ? String(parsed.reasoning) : undefined,
          });

          // Cross-match verification: ensure selected_option_id aligns with option texts
          const validOptionIds = options.map((o) => o.id);
          const normAns = validated.answer_text.trim().toLowerCase();

          if (isText) {
            validated.answer_text = cleanTypedAnswer(validated.answer_text);
            if (!validated.answer_text) throw new Error('Empty typed answer from model');
          } else if (isOrdering) {
            if (orderedSeq && orderedSeq.length > 0) {
              const invalidIds = orderedSeq.filter((id) => !validOptionIds.includes(id));
              if (invalidIds.length > 0) {
                this.logger.warn(`AI returned invalid IDs in ordering sequence: ${invalidIds.join(', ')}`);
              }
            }
          } else if (!isMultiAnswer) {
            const textMatchingOpt = options.find((o) => {
              const normOpt = o.text.trim().toLowerCase();
              return (
                normOpt === normAns ||
                (normAns.length > 5 && normOpt.length > 5 && (normOpt.includes(normAns) || normAns.includes(normOpt)))
              );
            });

            if (textMatchingOpt) {
              if (textMatchingOpt.id !== validated.selected_option_id) {
                this.logger.log(
                  `Corrected letter ID from "${validated.selected_option_id}" to "${textMatchingOpt.id}" based on text match: "${textMatchingOpt.text}"`,
                );
                validated.selected_option_id = textMatchingOpt.id;
                validated.answer_text = textMatchingOpt.text;
              }
            } else if (!validOptionIds.includes(validated.selected_option_id)) {
              validated.needs_review = true;
              validated.confidence = 0.5;
              this.logger.warn(
                `AI returned option "${validated.selected_option_id}" which is not in valid IDs: ${validOptionIds.join(', ')}`,
              );
            }
          } else {
            // Multi-answer verification
            if (selectedIds && selectedIds.length > 0) {
              const invalidIds = selectedIds.filter((id) => !validOptionIds.includes(id));
              if (invalidIds.length > 0) {
                this.logger.warn(`AI returned some invalid IDs in multi-answer: ${invalidIds.join(', ')}`);
              }
            }
          }

          if (webSearchEvidence && webSearchEvidence.length > 0) {
            validated.webEvidence = webSearchEvidence;
          }
          if (imageList.length > 0) {
            validated.imagesUsed = imageList.length;
          }

          this.logger.log(`Successfully solved question using model: ${currentModelName}`);
          return validated;
        } catch (err: any) {
          lastError = err;
          const msg: string = err.message || '';
          const isRateLimited = /429|quota|resource.?exhausted|rate.?limit/i.test(msg);
          const isUnavailable = /not found|no longer available|404|deprecated/i.test(msg);

          this.logger.warn(`Model ${currentModelName} attempt ${attempts} error: ${msg}`);

          // Rate limited: park this model until its quota frees up and move on to the next
          // model immediately (each model has its own quota). A daily limit parks it until
          // midnight Pacific; a per-minute limit for as long as Gemini asks (default 60s).
          if (isRateLimited) {
            const daily = /per.?day|perday|daily/i.test(msg);
            const waitMs = daily ? msUntilPacificMidnight() : (parseRetryDelayMs(msg) ?? 60000) + 1000;
            this.cooldownUntil.set(currentModelName, Date.now() + waitMs);
            this.logger.warn(
              `${currentModelName} rate limited (${daily ? 'daily quota' : 'per-minute'}). Skipping it for ${Math.round(waitMs / 1000)}s.`,
            );
            break;
          }
          // Google-side trouble: 503 "high demand", 500 "internal error", network drop, or too slow.
          // These clear up on their own: park the model for a minute and use the next one.
          const isOverloaded =
            /\b50[0234]\b|overloaded|high demand|service unavailable|internal (server )?error|timed out|fetch failed|ECONNRESET|socket hang up/i.test(
              msg,
            );
          if (isOverloaded) {
            this.cooldownUntil.set(currentModelName, Date.now() + 60000);
            this.logger.warn(`${currentModelName} overloaded/unavailable. Skipping it for 60s.`);
            break;
          }

          if (isUnavailable) {
            // Retired or not enabled for this key: never try it again this run
            this.cooldownUntil.set(currentModelName, Date.now() + 24 * 3600 * 1000);
          }

          if (isUnavailable) {
            this.logger.warn(
              `Quota/availability issue on ${currentModelName}. Switching to fallback model...`,
            );
            break; // Break attempt loop to move to the next candidate model immediately!
          }

          if (attempts < maxAttempts) {
            await new Promise((resolve) => setTimeout(resolve, delay));
            delay *= 2;
          }
        }
      }
    }

    // Everything we tried was rate limited: say when the first model frees up again
    const after = Date.now();
    const parked = allModels.map((m) => this.cooldownUntil.get(m) || 0).filter((t) => t > after);
    if (parked.length === allModels.length) {
      const secs = Math.max(1, Math.ceil((Math.min(...parked) - after) / 1000));
      throw new Error(`429 All Gemini models are busy or rate limited. Please retry in ${secs}s.`);
    }
    throw new Error(
      `Failed to generate answer across all available models: ${lastError?.message || 'Unknown error'}`,
    );
  }

  private cleanJsonResponse(text: string): string {
    let cleaned = text.trim();
    // Remove markdown code fence if present
    if (cleaned.startsWith('```json')) {
      cleaned = cleaned.substring(7);
    } else if (cleaned.startsWith('```')) {
      cleaned = cleaned.substring(3);
    }
    if (cleaned.endsWith('```')) {
      cleaned = cleaned.substring(0, cleaned.length - 3);
    }
    return cleaned.trim();
  }
}

