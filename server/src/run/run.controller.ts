import { Body, Controller, HttpCode, Logger, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';

import { AppsService } from '../apps/apps.service';
import { ChatService } from './chat.service';
import { DirectService } from './direct.service';
import { RunAppDto } from './run-app.dto';
import { StreamEvent } from '../common/types';

@Controller('api/run')
export class RunController {
  private readonly logger = new Logger(RunController.name);

  constructor(
    private readonly chat: ChatService,
    private readonly direct: DirectService,
    private readonly apps: AppsService,
  ) {}

  /**
   * 폼 제출 → SSE 스트림.
   *
   * 앱의 mode 로 실행기를 고른다 — 여기가 두 경로가 갈리는 유일한 지점이다.
   *   model : 폼 입력을 모델에 보내고 응답을 흘려보낸다
   *   query : 질문을 SQL 로 바꿔 조회하고 결과를 그대로 내려보낸다
   *
   * 스트리밍 계약은 둘이 공유하므로 프론트는 구분하지 않는다.
   * POST 로 SSE 를 내려주기 때문에 EventSource 대신 fetch + ReadableStream 으로 읽는다.
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
      // 앱이 direct 모드면 모델을 거치지 않는 경로로 보낸다.
      const runner = this.apps.get(appId).app.mode === 'query' ? this.direct : this.chat;
      for await (const event of runner.run(appId, body.input ?? {}, controller.signal)) {
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
