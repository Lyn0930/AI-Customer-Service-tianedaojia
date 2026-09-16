import { Module, forwardRef } from '@nestjs/common';
import { CardIntegrationService } from './card-integration.service';
import { CardSignatureService } from './card-signature.service';
import { CardCallbackController } from './card-callback.controller';
import { FeishuService } from './feishu.service';
import { AITriggerService } from './ai-trigger.service';
import { LeadsModule } from '../leads/leads.module';

@Module({
  imports: [forwardRef(() => LeadsModule)],
  controllers: [CardCallbackController],
  providers: [CardIntegrationService, CardSignatureService, FeishuService, AITriggerService],
  exports: [CardIntegrationService, CardSignatureService, FeishuService],
})
export class CardIntegrationModule {}
