import { Module, forwardRef } from '@nestjs/common';
import {
  CaptchaController,
  LeadsController,
  LeadsOpenApiController,
  PublicLeadsController,
} from './leads.controller';
import { LeadsService } from './leads.service';
import { LeadGradingService } from './lead-grading.service';
import { NotifyModule } from '../notify/notify.module';
import { RoutingModule } from '../routing/routing.module';
import { SmsModule } from '../sms/sms.module';
import { AdminModule } from '../admin/admin.module';
import { SchemaMigrationModule } from '../migration/schema-migration.module';
import { AgentsModule } from '../agents/agents.module';
import { RequirementDeltaService } from './requirement-delta.service';

@Module({
  imports: [
    NotifyModule,
    forwardRef(() => RoutingModule),
    SmsModule,
    AdminModule,
    SchemaMigrationModule,
    AgentsModule,
  ],
  controllers: [CaptchaController, LeadsController, LeadsOpenApiController, PublicLeadsController],
  providers: [LeadsService, LeadGradingService, RequirementDeltaService],
  exports: [LeadsService, LeadGradingService, RequirementDeltaService],
})
export class LeadsModule {}
