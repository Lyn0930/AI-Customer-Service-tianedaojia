import { Logger } from '@nestjs/common';
import { Automation, BindTrigger } from '@lark-apaas/fullstack-nestjs-core';
import { Inject } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { and, eq, sql } from 'drizzle-orm';
import { leads } from '@server/database/schema';
import { LeadsService } from '../leads/leads.service';

@Automation()
export class LeadsAutomationService {
  private readonly logger = new Logger(LeadsAutomationService.name);

  constructor(
    private readonly leadsService: LeadsService,
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
  ) {}

  @BindTrigger('leads_recycle_daily')
  async recycleStaleLeads() {
    this.logger.log('开始执行线索回收任务');
    const result = await this.leadsService.recycleStaleLeads();
    this.logger.log(`线索回收完成，回收 ${result.recycledCount} 条`);
  }

  @BindTrigger('leads_auto_assign_periodic')
  async autoAssignPool() {
    this.logger.log('开始执行公海自动分配任务');
    const result = await this.leadsService.autoAssignPool();
    this.logger.log(`自动分配完成，分配 ${result.assignedCount} 条`);
  }

  // 2026-08-28 旧 5/10/30 分钟无响应监控（routing_inactive_warn_5min）已废弃，
  // 由新派单服务的超时自动转派（A/C1高=2分钟，B/C1普通=5分钟）覆盖。

  // ===== 2026-08-14 B 触达时间表 - 自动化触达 =====
  /**
   * 按 B 5 子类分阶段自动触达：
   * - B-price：1d / 3d（议价后 1d 再发 1 次，3d 再发 1 次）
   * - B-quality：1d / 3d / 7d（推 3 个新简历）
   * - B-time：1h / 1d / 3d（档期方案）
   * - B-pace：1h / 1d / 3d（案例故事）
   * - B-trust：1h / 1d / 3d（合同模板）
   *
   * 每个 lead 每个 B 子类最多 3 次触达，第 3 次后停止。
   * 触达后客户回复 → 立即停止自动触达（人工跟进）。
   */
  @BindTrigger('b_subtype_auto_touch_hourly')
  async autoTouchBSubtypes() {
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60_000);
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60_000);
    const threeDayAgo = new Date(now.getTime() - 3 * 24 * 60 * 60_000);
    const sevenDayAgo = new Date(now.getTime() - 7 * 24 * 60 * 60_000);

    // 找 B 类且还在培育池/公海池的线索
    const bLeads = await this.db
      .select()
      .from(leads)
      .where(
        and(
          eq(leads.leadGrade, 'B'),
          sql`${leads.status} IN ('nurturing', 'public_pool', 'chatting')`,
          sql`${leads.intent} LIKE 'B-%'`,
        ),
      )
      .limit(100);

    let touched = 0;
    for (const lead of bLeads) {
      const lastFollowed = lead.lastFollowedUpAt ?? lead.assignedAt ?? lead.createdAt;
      if (!lastFollowed) continue;
      const bSubtype = lead.intent ?? '';
      const touchCount = lead.routingAttempts ?? 0; // 复用此字段做触达计数

      if (touchCount >= 3) continue; // 触达上限

      let shouldTouch = false;
      let touchReason = '';
      if (bSubtype === 'B-time' || bSubtype === 'B-pace' || bSubtype === 'B-trust') {
        if (touchCount === 0 && lastFollowed < oneHourAgo) {
          shouldTouch = true;
          touchReason = `${bSubtype} 第 1 次触达（1h）`;
        } else if (touchCount === 1 && lastFollowed < oneDayAgo) {
          shouldTouch = true;
          touchReason = `${bSubtype} 第 2 次触达（1d）`;
        } else if (touchCount === 2 && lastFollowed < threeDayAgo) {
          shouldTouch = true;
          touchReason = `${bSubtype} 第 3 次触达（3d）`;
        }
      } else {
        if (touchCount === 0 && lastFollowed < oneDayAgo) {
          shouldTouch = true;
          touchReason = `${bSubtype} 第 1 次触达（1d）`;
        } else if (touchCount === 1 && lastFollowed < threeDayAgo) {
          shouldTouch = true;
          touchReason = `${bSubtype} 第 2 次触达（3d）`;
        } else if (touchCount === 2 && lastFollowed < sevenDayAgo) {
          shouldTouch = true;
          touchReason = `${bSubtype} 第 3 次触达（7d）`;
        }
      }

      if (!shouldTouch) continue;

      // 更新触达次数 + 触发推送（实际推送由 NotifyModule 完成）
      await this.db
        .update(leads)
        .set({
          lastFollowedUpAt: now,
          routingAttempts: touchCount + 1,
          routingReason: `${lead.routingReason} | ${touchReason}`,
        })
        .where(eq(leads.id, lead.id));

      touched++;
      this.logger.log(
        `[B 触达] lead=${lead.id} subtype=${bSubtype} reason=${touchReason}`,
      );
    }

    if (touched > 0) {
      this.logger.log(`B 触达时间表执行: 共触达 ${touched} 条`);
    }
  }
  // ====================================================
}
