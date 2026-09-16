import { Body, Controller, Post } from '@nestjs/common';
import { NeedLogin } from '@lark-apaas/fullstack-nestjs-core';
import type {
  AiTestRequest,
  AiTestResponse,
  L2TestRequest,
  L2TestResponse,
  RouteTestRequest,
  RouteTestResponse,
} from '@shared/api.interface';
import { AiTestService } from './ai-test.service';

@Controller('api/test')
export class AiTestController {
  constructor(private readonly aiTestService: AiTestService) {}

  @NeedLogin()
  @Post('call')
  async call(@Body() body: AiTestRequest): Promise<AiTestResponse> {
    return this.aiTestService.runTest(body);
  }

  @NeedLogin()
  @Post('route')
  async route(@Body() body: RouteTestRequest): Promise<RouteTestResponse> {
    return this.aiTestService.runRouteTest(body);
  }

  @NeedLogin()
  @Post('l2')
  async l2(@Body() body: L2TestRequest): Promise<L2TestResponse> {
    return this.aiTestService.runL2Test(body);
  }
}
