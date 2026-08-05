import 'reflect-metadata';

import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { AppModule } from './app.module';
import { AppConfig, CONFIG } from './config/configuration';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: true,
  });

  const config = app.get<AppConfig>(CONFIG);
  const logger = new Logger('Bootstrap');

  app.enableCors({ origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(',') });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  // 긴 계약서 본문 등이 들어올 수 있으므로 기본 100kb 제한을 넉넉히 올린다.
  app.useBodyParser('json', { limit: '10mb' });

  // 빌드된 React 앱을 같은 서버에서 서빙 (Docker 이미지 하나로 배포).
  const webDist = join(__dirname, '..', 'public');
  if (existsSync(webDist)) {
    app.useStaticAssets(webDist, { index: false });
    // SPA 폴백: /api/* 가 아닌 GET 요청은 index.html 로 넘겨 클라이언트 라우팅에 맡긴다.
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
      res.sendFile(join(webDist, 'index.html'));
    });
    logger.log(`정적 파일 서빙: ${webDist}`);
  } else {
    logger.warn(`프론트 빌드 결과물이 없습니다 (${webDist}). API 만 제공합니다.`);
  }

  app.enableShutdownHooks();

  await app.listen(config.port, '0.0.0.0');
  logger.log(`AI Hub 가 http://0.0.0.0:${config.port} 에서 실행 중입니다.`);
}

void bootstrap();
