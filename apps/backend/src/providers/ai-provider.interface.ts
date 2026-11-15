import { AIAnswerResult, QuestionType } from '@ai-mcq/shared-types';

export interface AIProvider {
  readonly providerName: string;

  validateConnection(testConfig?: { apiKey: string; model?: string }): Promise<{
    success: boolean;
    message: string;
    model: string;
  }>;

  generateAnswer(
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
  ): Promise<AIAnswerResult>;

  getAvailableModels(): string[];
}

