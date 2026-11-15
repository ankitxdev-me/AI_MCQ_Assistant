import { Injectable } from '@nestjs/common';
import { AIProvider } from './ai-provider.interface';
import { GeminiProvider } from './gemini.provider';

@Injectable()
export class ProviderFactory {
  constructor(private readonly geminiProvider: GeminiProvider) {}

  getProvider(providerName: string = 'gemini'): AIProvider {
    switch (providerName.toLowerCase()) {
      case 'gemini':
        return this.geminiProvider;
      default:
        return this.geminiProvider;
    }
  }
}

