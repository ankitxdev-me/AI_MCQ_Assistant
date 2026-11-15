import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { SessionsService } from './sessions.service';
import { AuthGuard } from '../common/auth.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import {
  CreateSessionDtoSchema,
  CreateSessionDto,
  PracticeSession,
} from '@ai-mcq/shared-types';
import { z } from 'zod';

const ConfirmSelectionSchema = z.object({
  questionFingerprint: z.string().min(1),
  selectedOptionId: z.string().min(1),
});

@Controller('api/sessions')
@UseGuards(AuthGuard)
export class SessionsController {
  constructor(private readonly sessionsService: SessionsService) {}

  @Post()
  createSession(
    @Body(new ZodValidationPipe(CreateSessionDtoSchema))
    dto: CreateSessionDto,
  ): PracticeSession {
    return this.sessionsService.createSession(dto.pageUrl, dto.pageTitle, dto.tabId);
  }

  @Get(':id')
  getSession(@Param('id') id: string): PracticeSession {
    return this.sessionsService.getSession(id);
  }

  @Post(':id/pause')
  @HttpCode(HttpStatus.OK)
  pauseSession(@Param('id') id: string): PracticeSession {
    return this.sessionsService.pauseSession(id);
  }

  @Post(':id/resume')
  @HttpCode(HttpStatus.OK)
  resumeSession(@Param('id') id: string): PracticeSession {
    return this.sessionsService.resumeSession(id);
  }

  @Post(':id/stop')
  @HttpCode(HttpStatus.OK)
  stopSession(@Param('id') id: string): PracticeSession {
    return this.sessionsService.stopSession(id);
  }

  @Post(':id/confirm')
  @HttpCode(HttpStatus.OK)
  confirmSelection(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ConfirmSelectionSchema))
    body: { questionFingerprint: string; selectedOptionId: string },
  ): PracticeSession {
    return this.sessionsService.confirmQuestionAnswer(
      id,
      body.questionFingerprint,
      body.selectedOptionId,
    );
  }
}

