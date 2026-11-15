import { Controller, Get, Res } from '@nestjs/common';
import { Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';

@Controller()
export class HealthController {
  @Get()
  root(@Res() res: Response) {
    return this.serveTestPortal(res);
  }

  @Get('api/health')
  checkHealth() {
    return {
      status: 'ok',
      service: 'ai-mcq-backend',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      version: '1.0.0',
    };
  }

  @Get('test-portal')
  serveTestPortal(@Res() res: Response) {
    const candidatePaths = [
      path.resolve(process.cwd(), 'test-portal.html'),
      path.resolve(process.cwd(), '../../test-portal.html'),
      path.resolve(__dirname, '../../../test-portal.html'),
      'c:\\Users\\ankit\\OneDrive\\Documents\\Chrome Extension\\test-portal.html',
    ];
    for (const p of candidatePaths) {
      if (fs.existsSync(p)) {
        res.setHeader('Content-Type', 'text/html');
        return res.sendFile(p);
      }
    }
    return res.status(404).send('test-portal.html not found');
  }
}

