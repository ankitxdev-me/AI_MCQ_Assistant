import * as dotenv from 'dotenv';
dotenv.config();

import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/http-exception.filter';
import { Logger } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    cors: {
      origin: (origin, callback) => {
        // Allow requests from Chrome extension, localhost, or without origin (like background script / curl)
        // Exact local hosts only. A substring check would also admit https://localhost.evil.com.
        const isLocalOrigin = !!origin && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin);
        if (!origin || origin.startsWith('chrome-extension://') || isLocalOrigin) {
          callback(null, true);
        } else {
          callback(new Error('Not allowed by CORS'));
        }
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'x-pairing-token'],
    },
  });

  // Questions can carry images (base64). Express's default 100kb body limit rejected them.
  app.useBodyParser('json', { limit: '25mb' });

  app.useGlobalFilters(new AllExceptionsFilter());

  const port = parseInt(process.env.PORT || '3000', 10);
  const host = process.env.HOST || '127.0.0.1';

  // Strictly bind to 127.0.0.1
  await app.listen(port, host);
  logger.log(`AI MCQ Assistant Backend running on http://${host}:${port}`);
}

bootstrap();

