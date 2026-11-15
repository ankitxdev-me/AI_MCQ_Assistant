import * as dotenv from 'dotenv';
dotenv.config();

import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/http-exception.filter';
import { Logger } from '@nestjs/common';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule, {
    cors: {
      origin: (origin, callback) => {
        // Allow requests from Chrome extension, localhost, or without origin (like background script / curl)
        if (!origin || origin.startsWith('chrome-extension://') || origin.includes('localhost') || origin.includes('127.0.0.1')) {
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

  app.useGlobalFilters(new AllExceptionsFilter());

  const port = parseInt(process.env.PORT || '3000', 10);
  const host = process.env.HOST || '127.0.0.1';

  // Strictly bind to 127.0.0.1
  await app.listen(port, host);
  logger.log(`AI MCQ Assistant Backend running on http://${host}:${port}`);
}

bootstrap();

