import { Module } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { AuthGuard } from './auth.guard';
import { WebSearchService } from './web-search.service';

@Module({
  providers: [DatabaseService, AuthGuard, WebSearchService],
  exports: [DatabaseService, AuthGuard, WebSearchService],
})
export class CommonModule {}

