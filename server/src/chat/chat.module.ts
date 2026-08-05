import { Module } from '@nestjs/common';

import { AppsModule } from '../apps/apps.module';
import { McpModule } from '../mcp/mcp.module';
import { ProvidersModule } from '../providers/providers.module';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';

@Module({
  imports: [AppsModule, McpModule, ProvidersModule],
  controllers: [ChatController],
  providers: [ChatService],
})
export class ChatModule {}
