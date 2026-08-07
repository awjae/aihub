import { Module } from '@nestjs/common';

import { AppConfigModule } from '../config/config.module';
import { VpnController } from './vpn.controller';
import { VpnService } from './vpn.service';

@Module({
  imports: [AppConfigModule],
  controllers: [VpnController],
  providers: [VpnService],
})
export class VpnModule {}
