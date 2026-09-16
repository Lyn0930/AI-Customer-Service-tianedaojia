import { Module, forwardRef } from '@nestjs/common';
import { RoutingController } from './routing.controller';
import { RoutingService } from './routing.service';
import { AdminModule } from '../admin/admin.module';
import { SchemaMigrationModule } from '../migration/schema-migration.module';
import { ChatModule } from '../chat/chat.module';
import { AgentsModule } from '../agents/agents.module';

@Module({
  imports: [
    AdminModule,
    SchemaMigrationModule,
    forwardRef(() => ChatModule),
    AgentsModule,
  ],
  controllers: [RoutingController],
  providers: [RoutingService],
  exports: [RoutingService],
})
export class RoutingModule {}
