import { Module } from '@nestjs/common';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';
import { CommonModule } from '../common/common.module';
import { EventsModule } from '../events/events.module';

@Module({
  imports: [CommonModule, EventsModule],
  controllers: [SessionsController],
  providers: [SessionsService],
  exports: [SessionsService],
})
export class SessionsModule {}

