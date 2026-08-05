import { Body, Controller, HttpCode, Logger, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';

import { ChatService } from './chat.service';
import { RunAppDto } from './run-app.dto';
import { StreamEvent } from '../common/types';

@Controller('api/run')
export class ChatController {
  private readonly logger = new Logger(ChatController.name);

  constructor(private readonly chat: ChatService) {}

  /**
   * 폼 제출 → SSE 스트림.
   *
   * POST 로 SSE 를 내려주기 때문에 EventSource 대신 프론트에서 fetch + ReadableStream 으로 읽는다.
   */
  @Post(':appId')
  @HttpCode(200)
  async run(
    @Param('appId') appId: string,
    @Body() body: RunAppDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // nginx 등 리버스 프록시가 SSE 를 버퍼링하지 않도록.
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();

    const controller = new AbortController();
    req.on('close', () => controller.abort());

    // 프록시가 유휴 커넥션을 끊지 않도록 주기적으로 주석 프레임을 보낸다.
    const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 15_000);

    const send = (event: StreamEvent): void => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    try {
      for await (const event of this.chat.run(appId, body.input ?? {}, controller.signal)) {
        if (controller.signal.aborted) break;
        send(event);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`앱 '${appId}' 실행 실패: ${message}`);
      if (!controller.signal.aborted) {
        send({ type: 'error', message });
      }
    } finally {
      clearInterval(heartbeat);
      res.end();
    }
  }
}
