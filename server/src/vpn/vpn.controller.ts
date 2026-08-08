import { Controller, Get, HttpCode, Post } from '@nestjs/common';

import { VpnService } from './vpn.service';
import { VpnStatus } from './vpn.types';

/**
 * 읽기 전용이다. 서브넷 연결(과금 대상)은 개발자가 `client-vpn.sh` 로 직접
 * 켜고 끄며, 이 컨테이너는 그 상태를 따라갈 뿐이다 — 그래서 조작 엔드포인트가 없다.
 */
@Controller('api/vpn')
export class VpnController {
  constructor(private readonly vpn: VpnService) {}

  @Get('status')
  status(): Promise<VpnStatus> {
    return this.vpn.status();
  }

  /**
   * 사용자가 누르는 "다시 확인". 상태를 새로 재고, VPN 이 켜졌는데 아직 안
   * 붙었으면 터널 재시도를 앞당긴다. 서브넷은 건드리지 않는다(과금 대상).
   */
  @Post('recheck')
  @HttpCode(200)
  recheck(): Promise<VpnStatus> {
    return this.vpn.recheck();
  }
}
