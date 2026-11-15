import { Body, Controller, Get, HttpCode, HttpStatus, Logger, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from './common/auth.guard';

/**
 * Receives Auto-Loop events from each tab's content script so failures in the browser
 * show up in the backend log ("AutoLoop" lines), one tab per short id.
 * The last 500 events are also kept in memory: GET /api/debug/loop-log.
 */
@Controller('api/debug')
@UseGuards(AuthGuard)
export class DebugController {
  private readonly logger = new Logger('AutoLoop');
  private readonly recent: any[] = [];

  @Post('loop-log')
  @HttpCode(HttpStatus.OK)
  record(@Body() body: Record<string, any>) {
    const entry = { at: new Date().toISOString(), ...body };
    this.recent.push(entry);
    if (this.recent.length > 500) this.recent.shift();

    const { tab, event, hidden, solved, page, path, ...rest } = body || {};
    const detail = JSON.stringify(rest).slice(0, 700);
    const line = `[tab ${tab}${hidden ? ' hidden' : ''} | ${solved} done | ${page} ${path}] ${event} ${detail}`;
    if (event === 'stop' || event === 'stuck-question' || event === 'late-wakeup') this.logger.warn(line);
    else this.logger.log(line);
    return { ok: true };
  }

  @Get('loop-log')
  list() {
    return this.recent;
  }
}
