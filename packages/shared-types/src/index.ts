import { z } from 'zod';

export type QuestionStatus =
  | 'DETECTED'
  | 'EXTRACTING'
  | 'READY_FOR_AI'
  | 'PROCESSING'
  | 'ANSWER_READY'
  | 'AWAITING_CONFIRMATION'
  | 'COMPLETED'
  | 'NEEDS_REVIEW'
  | 'FAILED';

export const QuestionStatusSchema = z.enum([
  'DETECTED',
  'EXTRACTING',
  'READY_FOR_AI',
  'PROCESSING',
  'ANSWER_READY',
  'AWAITING_CONFIRMATION',
  'COMPLETED',
  'NEEDS_REVIEW',
  'FAILED',
]);

export interface OptionItem {
  id: string; // e.g., "A", "B", "1", "2" or unique token
  text: string;
  originalLabel?: string;
  elementSelector?: string;
  isPreSelected?: boolean;
}

export const OptionItemSchema = z.object({
  id: z.string().min(1),
  text: z.string(),
  originalLabel: z.string().optional(),
  elementSelector: z.string().optional(),
  isPreSelected: z.boolean().optional(),
});

export type QuestionType = 'SINGLE_CHOICE' | 'MULTIPLE_CHOICE' | 'ORDERING' | 'CODING' | 'DESCRIPTIVE';

export type QuestionCategory =
  | 'MULTIPLE_CHOICE'
  | 'ORDERING'
  | 'CODING'
  | 'CODING_PRACTICE'
  | 'DESCRIPTIVE'
  | 'WRITTEN_ESSAY'
  | 'FILL_IN_THE_BLANKS';

export interface ExtractedQuestion {
  id?: string;
  fingerprint: string;
  questionNumber?: number;
  questionText: string;
  contextText?: string;
  questionCategory?: QuestionCategory;
  options: OptionItem[];
  extractionStrategy:
    | 'radio-standard'
    | 'label-wrapped'
    | 'custom-accessible'
    | 'single-question-stepper'
    | 'multi-question-list'
    | 'ordering-dnd'
    | 'written-essay'
    | 'fill-in-the-blank'
    | 'coding-practice'
    | 'fallback';
  extractionConfidence: number; // 0.0 to 1.0
  isMultipleChoiceMultipleAnswer?: boolean;
  isOrderingQuestion?: boolean;
  questionType?: QuestionType;
  inputSelector?: string;
  placeholder?: string;
  maxLength?: number;
  programmingLanguage?: string;
  starterCode?: string;
  codeInsertionMarker?: string;
  aiAnswer?: AIAnswerResult;
  elementSelector?: string;
  detectedAt?: string;
  status: QuestionStatus;
}

export const ExtractedQuestionSchema = z.object({
  id: z.string().optional(),
  fingerprint: z.string().min(1),
  questionNumber: z.number().optional(),
  questionText: z.string().min(1),
  contextText: z.string().optional(),
  questionCategory: z
    .enum([
      'MULTIPLE_CHOICE',
      'ORDERING',
      'CODING',
      'CODING_PRACTICE',
      'DESCRIPTIVE',
      'WRITTEN_ESSAY',
      'FILL_IN_THE_BLANKS',
    ])
    .optional(),
  options: z.array(OptionItemSchema),
  extractionStrategy: z.enum([
    'radio-standard',
    'label-wrapped',
    'custom-accessible',
    'single-question-stepper',
    'multi-question-list',
    'ordering-dnd',
    'written-essay',
    'fill-in-the-blank',
    'coding-practice',
    'fallback',
  ]),
  extractionConfidence: z.number().min(0).max(1),
  isMultipleChoiceMultipleAnswer: z.boolean().optional(),
  isOrderingQuestion: z.boolean().optional(),
  questionType: z.enum(['SINGLE_CHOICE', 'MULTIPLE_CHOICE', 'ORDERING', 'CODING', 'DESCRIPTIVE']).optional(),
  inputSelector: z.string().optional(),
  placeholder: z.string().optional(),
  maxLength: z.number().optional(),
  programmingLanguage: z.string().optional(),
  starterCode: z.string().optional(),
  codeInsertionMarker: z.string().optional(),
  aiAnswer: z.lazy(() => AIAnswerResultSchema).optional(),
  elementSelector: z.string().optional(),
  detectedAt: z.string().optional(),
  status: QuestionStatusSchema.default('DETECTED'),
});

export interface AIAnswerResult {
  selected_option_id: string;
  selected_option_ids?: string[];
  ordered_sequence?: string[];
  answer_text: string;
  explanation: string;
  confidence: number;
  needs_review: boolean;
  alternative_options?: string[];
  reasoning?: string;
  webEvidence?: string[];
}

export const AIAnswerResultSchema = z.object({
  selected_option_id: z.string().min(1),
  selected_option_ids: z.array(z.string()).optional(),
  ordered_sequence: z.array(z.string()).optional(),
  answer_text: z.string().min(1),
  explanation: z.string(),
  confidence: z.number().min(0).max(1),
  needs_review: z.boolean(),
  alternative_options: z.array(z.string()).optional(),
  reasoning: z.string().optional(),
  webEvidence: z.array(z.string()).optional(),
});

export interface SolveQuestionPayload {
  sessionId: string;
  question: string;
  options: { id: string; text: string }[];
  questionFingerprint: string;
  questionNumber?: number;
  forceFresh?: boolean;
  webSearchEvidence?: string[];
  isMultipleChoiceMultipleAnswer?: boolean;
  isOrderingQuestion?: boolean;
  questionType?: QuestionType;
}

export const SolveQuestionPayloadSchema = z.object({
  sessionId: z.string().min(1),
  question: z.string().min(1),
  options: z.array(
    z.object({
      id: z.string().min(1),
      text: z.string(),
    }),
  ).min(1),
  questionFingerprint: z.string().min(1),
  questionNumber: z.number().optional(),
  forceFresh: z.boolean().optional(),
  webSearchEvidence: z.array(z.string()).optional(),
  isMultipleChoiceMultipleAnswer: z.boolean().optional(),
  isOrderingQuestion: z.boolean().optional(),
  questionType: z.enum(['SINGLE_CHOICE', 'MULTIPLE_CHOICE', 'ORDERING']).optional(),
});

export interface SolveQuestionResponse {
  success: boolean;
  questionId: string;
  answer: AIAnswerResult;
  cached: boolean;
  timestamp: string;
  error?: string;
}

export interface QuestionFeedbackPayload {
  sessionId?: string;
  questionFingerprint: string;
  questionText: string;
  selectedOptionId: string;
  selectedOptionText?: string;
  isCorrect?: boolean;
  actualCorrectOptionId?: string;
  actualCorrectOptionText?: string;
  topic?: string;
}

export interface TopicKnowledgeItem {
  id: string;
  topic: string;
  questionFingerprint?: string;
  questionText: string;
  correctOptionId?: string;
  correctOptionText: string;
  wasIncorrectFirst?: boolean;
  wrongOptionText?: string;
  explanation?: string;
  createdAt: string;
}

export interface CustomKnowledgeItem {
  id: string;
  topic: string;
  content: string;
  isActive: boolean;
  createdAt: string;
}

export type SessionStatus = 'ACTIVE' | 'PAUSED' | 'STOPPED' | 'COMPLETED';

export interface PracticeSession {
  id: string;
  tabId?: number;
  pageUrl: string;
  pageTitle?: string;
  status: SessionStatus;
  totalDetected: number;
  processedCount: number;
  needsReviewCount: number;
  failedCount: number;
  currentQuestionIndex: number;
  currentQuestionFingerprint?: string;
  startTime: string;
  endTime?: string;
  questions: (ExtractedQuestion & {
    aiAnswer?: AIAnswerResult;
    userConfirmedSelection?: string;
    completedAt?: string;
  })[];
}

export interface CreateSessionDto {
  pageUrl: string;
  pageTitle?: string;
  tabId?: number;
}

export const CreateSessionDtoSchema = z.object({
  pageUrl: z.string().url(),
  pageTitle: z.string().optional(),
  tabId: z.number().optional(),
});

export interface AIProviderConfig {
  provider: 'gemini' | 'openai';
  apiKey: string;
  model: string;
}

export const AIProviderConfigSchema = z.object({
  provider: z.literal('gemini'),
  apiKey: z.string().min(10, 'Gemini API key is required'),
  model: z.string().min(1),
});

export interface ConfigStatusResponse {
  configured: boolean;
  provider: string;
  model: string;
  hasEnvFallback: boolean;
  source: 'database' | 'environment' | 'none';
  availableModels: string[];
  lastTested?: string;
  pairingTokenConfigured: boolean;
}

export interface TestConnectionResponse {
  success: boolean;
  message: string;
  modelTested: string;
  timestamp: string;
}

// WebSocket Event Names
export const WS_EVENTS = {
  SESSION_UPDATED: 'session:updated',
  QUESTION_DETECTED: 'question:detected',
  QUESTION_SOLVED: 'question:solved',
  SESSION_ERROR: 'session:error',
  CONNECTION_STATUS: 'connection:status',
} as const;

// Chrome Runtime Internal Message Types
export type ExtensionMessage =
  | { type: 'GET_BACKEND_STATUS' }
  | { type: 'START_PRACTICE_SESSION'; payload: { tabId: number; url: string; title: string } }
  | { type: 'PAUSE_SESSION'; payload: { sessionId: string } }
  | { type: 'RESUME_SESSION'; payload: { sessionId: string } }
  | { type: 'STOP_SESSION'; payload: { sessionId: string } }
  | { type: 'DOM_EXTRACT_QUESTIONS'; payload: { force?: boolean } }
  | { type: 'DOM_QUESTIONS_EXTRACTED'; payload: { questions: ExtractedQuestion[]; currentQuestion?: ExtractedQuestion } }
  | { type: 'CONFIRM_SELECTION'; payload: { optionId: string; elementSelector?: string; optionText?: string } }
  | { type: 'SUBMIT_ANSWER' }
  | { type: 'SOLVE_CURRENT_QUESTION'; payload: { question: ExtractedQuestion; sessionId: string } }
  | { type: 'NAVIGATE_NEXT_QUESTION' };

