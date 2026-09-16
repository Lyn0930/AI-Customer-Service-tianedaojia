import { Module, forwardRef } from '@nestjs/common';
import { ChatController, CustomerChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { ChatGuardService } from './chat-guard.service';
import { ChatPricingService } from './chat-pricing.service';
import { IntentRouter } from './intelligent-router/intent-router';
import { IntelligentRouterService } from './intelligent-router/intelligent-router.service';
import { ChatTransferService } from './chat-transfer.service';
import { ChatRequirementsService } from './chat-requirements.service';
import { ChatSessionService } from './chat-session.service';
import { ChatEventBus } from './chat-event-bus.service';
import { ReplyLearningService } from './reply-learning.service';
import { FaqService } from './faq/faq.service';
import { LlmIntentService } from './llm-intent/llm-intent.service';
import { IntentDiscoveryService } from './llm-intent/intent-discovery.service';
import { NotifyModule } from '../notify/notify.module';
import { AdminModule } from '../admin/admin.module';
import { RoutingModule } from '../routing/routing.module';
import { RequirementCollectionModule } from '../automation/requirement-collection.module';
import { LeadsModule } from '../leads/leads.module';
import { SalaryConfigModule } from '../salary-config/salary-config.module';
import { AgentsModule } from '../agents/agents.module';

@Module({
  imports: [
    NotifyModule,
    AdminModule,
    forwardRef(() => RoutingModule),
    RequirementCollectionModule,
    forwardRef(() => LeadsModule),
    SalaryConfigModule,
    AgentsModule,
  ],
  controllers: [ChatController, CustomerChatController],
  providers: [
    ChatService,
    ChatGuardService,
    ChatPricingService,
    IntentRouter,
    IntelligentRouterService,
    ChatTransferService,
    ChatRequirementsService,
    ChatSessionService,
    ChatEventBus,
    ReplyLearningService,
    LlmIntentService,
    IntentDiscoveryService,
    FaqService,
  ],
  exports: [
    ChatService,
    ChatSessionService,
    ChatRequirementsService,
    ChatTransferService,
    IntelligentRouterService,
    LlmIntentService,
  ],
})
export class ChatModule {}
