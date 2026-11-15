import { Module } from '@nestjs/common';
import { ConfigController } from './config.controller';
import { ConfigService } from './config.service';
import { CommonModule } from '../common/common.module';
import { ProvidersModule } from '../providers/providers.module';

@Module({
  imports: [CommonModule, ProvidersModule],
  controllers: [ConfigController],
  providers: [ConfigService],
  exports: [ConfigService],
})
export class ConfigModule {}

