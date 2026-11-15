import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ConfigService } from './config.service';
import { AuthGuard } from '../common/auth.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import {
  AIProviderConfigSchema,
  ConfigStatusResponse,
  TestConnectionResponse,
} from '@ai-mcq/shared-types';
import { z } from 'zod';

const TestConfigSchema = z.object({
  apiKey: z.string().optional(),
  model: z.string().optional(),
});

@Controller('api/config')
@UseGuards(AuthGuard)
export class ConfigController {
  constructor(private readonly configService: ConfigService) {}

  @Get('status')
  getStatus(): ConfigStatusResponse {
    return this.configService.getConfigStatus();
  }

  @Post('gemini')
  @HttpCode(HttpStatus.OK)
  async saveGeminiConfig(
    @Body(new ZodValidationPipe(AIProviderConfigSchema))
    body: z.infer<typeof AIProviderConfigSchema>,
  ) {
    return this.configService.saveGeminiConfig(body.apiKey, body.model);
  }

  @Post('model')
  @HttpCode(HttpStatus.OK)
  async updateModel(@Body() body: { model: string }) {
    return this.configService.updateModel(body.model);
  }

  @Post('test')
  @HttpCode(HttpStatus.OK)
  async testConnection(
    @Body(new ZodValidationPipe(TestConfigSchema))
    body: z.infer<typeof TestConfigSchema>,
  ): Promise<TestConnectionResponse> {
    return this.configService.testConnection(body.apiKey, body.model);
  }

  @Delete('provider')
  @HttpCode(HttpStatus.OK)
  deleteProvider() {
    return this.configService.deleteProviderConfig();
  }
}

