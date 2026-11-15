import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { QuestionsService } from './questions.service';
import { AuthGuard } from '../common/auth.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import {
  SolveQuestionPayloadSchema,
  SolveQuestionPayload,
  ExtractedQuestion,
} from '@ai-mcq/shared-types';
import { z } from 'zod';

const ExtractPayloadSchema = z.object({
  sessionId: z.string().min(1),
  questions: z.array(z.any()).min(1),
});

@Controller('api/questions')
@UseGuards(AuthGuard)
export class QuestionsController {
  constructor(private readonly questionsService: QuestionsService) {}

  @Post('extract')
  @HttpCode(HttpStatus.OK)
  async extractQuestions(
    @Body(new ZodValidationPipe(ExtractPayloadSchema))
    body: { sessionId: string; questions: ExtractedQuestion[] },
  ) {
    return this.questionsService.extractQuestions(body.sessionId, body.questions);
  }

  @Post('solve')
  @HttpCode(HttpStatus.OK)
  async solveQuestion(
    @Body(new ZodValidationPipe(SolveQuestionPayloadSchema))
    payload: SolveQuestionPayload,
  ) {
    return this.questionsService.solveQuestion(payload);
  }

  @Post('feedback')
  @HttpCode(HttpStatus.OK)
  async recordFeedback(@Body() body: any) {
    return this.questionsService.recordQuestionFeedback(body);
  }

  @Get('topic/:topic')
  async getTopicKnowledge(@Param('topic') topic: string) {
    return this.questionsService.getTopicKnowledge(topic);
  }

  @Get('custom-knowledge')
  async getCustomKnowledge() {
    return this.questionsService.getCustomKnowledge();
  }

  @Post('custom-knowledge')
  @HttpCode(HttpStatus.OK)
  async saveCustomKnowledge(@Body() body: { topic?: string; content: string }) {
    return this.questionsService.saveCustomKnowledge(body.topic || 'General', body.content);
  }

  @Delete('custom-knowledge/:id')
  @HttpCode(HttpStatus.OK)
  async deleteCustomKnowledge(@Param('id') id: string) {
    return this.questionsService.deleteCustomKnowledge(id);
  }

  @Get(':id')
  async getQuestion(@Param('id') id: string) {
    return this.questionsService.getQuestionById(id);
  }
}

