import { Module } from '@nestjs/common';
import { QuestionsController } from './questions.controller';
import { QuestionsService } from './questions.service';
import { CommonModule } from '../common/common.module';
import { ConfigModule } from '../config/config.module';
import { ProvidersModule } from '../providers/providers.module';
import { SessionsModule } from '../sessions/sessions.module';
import { EventsModule } from '../events/events.module';

@Module({
  imports: [CommonModule, ConfigModule, ProvidersModule, SessionsModule, EventsModule],
  controllers: [QuestionsController],
  providers: [QuestionsService],
  exports: [QuestionsService],
})
export class QuestionsModule {}

