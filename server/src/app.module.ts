import { Module } from '@nestjs/common';

import { AppConfigModule } from './config/config.module';
import { AppsModule } from './apps/apps.module';
import { ChatModule } from './chat/chat.module';
import { HealthController } from './common/health.controller';
import { McpModule } from './mcp/mcp.module';
import { ProvidersModule } from './providers/providers.module';
import { VpnModule } from './vpn/vpn.module';

@Module({
  imports: [AppConfigModule, AppsModule, McpModule, ProvidersModule, ChatModule, VpnModule],
  controllers: [HealthController],
})
export class AppModule {}
