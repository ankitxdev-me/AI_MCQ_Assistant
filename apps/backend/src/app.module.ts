import { Module } from '@nestjs/common';
import { CommonModule } from './common/common.module';
import { ConfigModule } from './config/config.module';
import { ProvidersModule } from './providers/providers.module';
import { SessionsModule } from './sessions/sessions.module';
import { QuestionsModule } from './questions/questions.module';
import { EventsModule } from './events/events.module';
import { HealthController } from './health.controller';

@Module({
  imports: [
    CommonModule,
    ConfigModule,
    ProvidersModule,
    SessionsModule,
    QuestionsModule,
    EventsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}

