import { Module } from '@nestjs/common';
import { GeminiProvider } from './gemini.provider';
import { ProviderFactory } from './provider.factory';

@Module({
  providers: [GeminiProvider, ProviderFactory],
  exports: [GeminiProvider, ProviderFactory],
})
export class ProvidersModule {}

