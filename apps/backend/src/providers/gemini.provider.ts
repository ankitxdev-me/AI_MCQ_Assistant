import { Injectable, Logger } from '@nestjs/common';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { AIProvider } from './ai-provider.interface';
import { AIAnswerResult, AIAnswerResultSchema, QuestionType } from '@ai-mcq/shared-types';

@Injectable()
export class GeminiProvider implements AIProvider {
  readonly providerName = 'gemini';
  private readonly logger = new Logger(GeminiProvider.name);

  private readonly availableModels = [
    'gemini-3.1-flash-lite',
    'gemini-3.5-flash-lite',
    'gemini-2.5-flash',
    'gemini-1.5-flash',
    'gemini-1.5-pro',
  ];

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
        model: testConfig?.model || 'gemini-3.1-flash-lite',
      };
    }

    const modelName = testConfig?.model || 'gemini-3.1-flash-lite';

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
  ): Promise<AIAnswerResult> {
    const apiKey = apiKeyOverride || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('Gemini API key is not configured.');
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const isMultiAnswer = optionsMetadata?.isMultipleChoiceMultipleAnswer ?? false;
    const isOrdering = Boolean(optionsMetadata?.isOrderingQuestion || optionsMetadata?.questionType === 'ORDERING');

    const requestedModel = modelOverride || 'gemini-3.1-flash-lite';
    const fallbackList = ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite', 'gemini-2.5-flash'];
    const modelsToTry = [requestedModel, ...fallbackList.filter((m) => m !== requestedModel)];

    let systemPrompt = '';
    if (isOrdering) {
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
      questionType: isMultiAnswer ? 'MULTIPLE_CHOICE_MULTIPLE_ANSWER' : 'SINGLE_CHOICE',
    });

    let lastError: Error | null = null;

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
              temperature: 0.1,
              responseMimeType: 'application/json',
            },
            systemInstruction: systemPrompt,
          });

          const generatePromise = model.generateContent({
            contents: [{ role: 'user', parts: [{ text: userContent }] }],
          });

          const timeoutPromise = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('AI request timed out after 15 seconds')), 15000),
          );

          const response = await Promise.race([generatePromise, timeoutPromise]);
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
            selected_option_id: String(
              parsed.selected_option_id ||
                (orderedSeq ? orderedSeq.join(', ') : selectedIds ? selectedIds.join(', ') : ''),
            ),
            selected_option_ids: selectedIds,
            ordered_sequence: orderedSeq,
            answer_text: String(parsed.answer_text || (orderedSeq ? orderedSeq.join(' → ') : '')),
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

          if (isOrdering) {
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

          this.logger.log(`Successfully solved question using model: ${currentModelName}`);
          return validated;
        } catch (err: any) {
          lastError = err;
          const isQuota =
            err.message?.includes('429') ||
            err.message?.includes('quota') ||
            err.message?.includes('ResourceExhausted') ||
            err.message?.includes('not found') ||
            err.message?.includes('no longer available');

          this.logger.warn(`Model ${currentModelName} attempt ${attempts} error: ${err.message}`);

          if (isQuota) {
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

