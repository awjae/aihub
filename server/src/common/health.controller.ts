import { Controller, Get } from '@nestjs/common';

import { AppsService } from '../apps/apps.service';

@Controller('api/health')
export class HealthController {
  constructor(private readonly apps: AppsService) {}

  @Get()
  check(): { status: string; apps: number; uptime: number } {
    return {
      status: 'ok',
      apps: this.apps.list().length,
      uptime: Math.round(process.uptime()),
    };
  }
}
