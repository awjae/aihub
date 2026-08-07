import { Module } from '@nestjs/common';

import { AppConfigModule } from './config/config.module';
import { AppsModule } from './apps/apps.module';
import { QueryModule } from './query/query.module';
import { RunModule } from './run/run.module';
import { HealthController } from './common/health.controller';
import { ProvidersModule } from './providers/providers.module';
import { VpnModule } from './vpn/vpn.module';

@Module({
  imports: [AppConfigModule, AppsModule, ProvidersModule, QueryModule, RunModule, VpnModule],
  controllers: [HealthController],
})
export class AppModule {}
