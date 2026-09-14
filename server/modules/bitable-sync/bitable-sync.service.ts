import { Injectable, Inject, Logger } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
  CapabilityService,
} from '@lark-apaas/fullstack-nestjs-core';
import { eq, isNull, isNotNull, count, desc } from 'drizzle-orm';
import { leads, requirements } from '@server/database/schema';
import { normalizeSource, sanitizeCity } from '@shared/channels';
import type {
  BitableSyncStatus,
  BitableSyncResult,
  BitableSyncLeadItem,
} from '@shared/api.interface';

const BITABLE_SYNC_PLUGIN_ID = 'swan_home_bitable_sync_1';

interface BitableAddResponse {
  records?: Array<{ id?: string }>;
}

@Injectable()
export class BitableSyncService {
  private readonly logger = new Logger(BitableSyncService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly capabilityService: CapabilityService,
  ) {}

  async syncLeadToBitable(leadId: string): Promise<BitableSyncResult> {
    try {
      const leadRows = await this.db
        .select()
        .from(leads)
        .where(eq(leads.id, leadId))
        .limit(1);

      if (leadRows.length === 0) {
        return { success: false, message: '线索不存在' };
      }

      const lead = leadRows[0];

      const reqRows = await this.db
        .select()
        .from(requirements)
        .where(eq(requirements.leadId, leadId))
        .limit(1);

      const req = reqRows.length > 0 ? reqRows[0] : null;

      const fields: Record<string, string | number> = {
        '客户姓名': lead.customerName ?? '',
        '电话': lead.phoneNumber,
        '城市': sanitizeCity(lead.serviceCity),
        '来源': normalizeSource(lead.source),
        '线索状态': lead.status,
        '意图': lead.intent ?? '',
        '创建时间': lead.createdAt.getTime(),
      };

      if (req) {
        fields['服务类型'] = req.serviceType ?? '';
        fields['家庭人口'] = req.householdSize ?? '';
        fields['面积'] = req.area ?? '';
        fields['老人照顾'] = req.elderlyCare ?? '';
        fields['休息天数'] = req.restDays ?? '';
        fields['到岗时间'] = req.startTime ?? '';
        fields['服务地址'] = req.serviceAddress ?? '';
        fields['阿姨要求'] = req.helperRequirements ?? '';
        fields['口味偏好'] = req.dietaryPreferences ?? '';
        // 2026-09-05：requirements.budget 已是 integer——同步到多维表格时转回字符串（表格"预算"列按文本写入，行为与旧版一致）
        fields['预算'] = req.budget != null ? String(req.budget) : '';
      }

      if (lead.bitableRecordId) {
        await this.capabilityService
          .load(BITABLE_SYNC_PLUGIN_ID)
          .call('batchUpdateRecords', {
            records: [{ id: lead.bitableRecordId, record: fields }],
          });

        this.logger.log(`线索 ${leadId} 多维表格记录已更新`);
        return { success: true, message: '更新成功' };
      }

      const result = (await this.capabilityService
        .load(BITABLE_SYNC_PLUGIN_ID)
        .call('batchAddRecords', {
          records: [{ record: fields }],
        })) as BitableAddResponse;

      const recordId = result?.records?.[0]?.id;
      if (recordId) {
        await this.db
          .update(leads)
          .set({ bitableRecordId: recordId })
          .where(eq(leads.id, leadId));

        this.logger.log(
          `线索 ${leadId} 多维表格记录已创建，recordId: ${recordId}`,
        );
        return { success: true, message: '创建成功' };
      }

      return { success: false, message: '创建记录未返回ID' };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.warn(`线索 ${leadId} 多维表格同步失败: ${msg}`);
      return { success: false, message: msg };
    }
  }

  async getSyncStatus(): Promise<BitableSyncStatus> {
    const totalResult = await this.db.select({ value: count() }).from(leads);
    const total = Number(totalResult[0]?.value ?? 0);

    const syncedResult = await this.db
      .select({ value: count() })
      .from(leads)
      .where(isNotNull(leads.bitableRecordId));
    const synced = Number(syncedResult[0]?.value ?? 0);

    return { total, synced, unsynced: total - synced };
  }

  async getUnsyncedLeads(): Promise<BitableSyncLeadItem[]> {
    const rows = await this.db
      .select({
        id: leads.id,
        customerName: leads.customerName,
        phoneNumber: leads.phoneNumber,
        serviceCity: leads.serviceCity,
        bitableRecordId: leads.bitableRecordId,
        createdAt: leads.createdAt,
      })
      .from(leads)
      .where(isNull(leads.bitableRecordId))
      .orderBy(desc(leads.createdAt));

    return rows.map((row) => ({
      id: row.id,
      customerName: row.customerName,
      phoneNumber: row.phoneNumber,
      serviceCity: row.serviceCity,
      bitableRecordId: row.bitableRecordId,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async syncAllUnsynced(): Promise<BitableSyncResult> {
    const unsyncedLeads = await this.db
      .select({ id: leads.id })
      .from(leads)
      .where(isNull(leads.bitableRecordId));

    let successCount = 0;
    let failCount = 0;

    for (const lead of unsyncedLeads) {
      const result = await this.syncLeadToBitable(lead.id);
      if (result.success) {
        successCount++;
      } else {
        failCount++;
      }
    }

    return {
      success: failCount === 0,
      message: `同步完成：成功 ${successCount} 条，失败 ${failCount} 条`,
      syncedCount: successCount,
    };
  }
}
