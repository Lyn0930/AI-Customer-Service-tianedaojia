import { Module } from '@nestjs/common';
import { ChatModule } from '../chat/chat.module';
import { AiTestController } from './ai-test.controller';
import { AiTestService } from './ai-test.service';

@Module({
  imports: [ChatModule],
  controllers: [AiTestController],
  providers: [AiTestService],
})
export class AiTestModule {}
