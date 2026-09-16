import { Injectable, Logger, Inject, OnModuleInit } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { faqs } from '@server/database/schema';
import { detectServiceCity, hasCity } from './service-cities';

/** FAQ = 内容型话题货架：命中触发词 → 直接展示已审核标准文本 */
interface FaqEntry {
  id: string;
  topic: string;
  triggerWords: string[];
  answer: string;
  priority: number;
  hasLead: boolean;
}

export interface FaqHit {
  topic: string;
  matchedWord: string;
  reply: string;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const PUBLISHED = 'published';
const SERVICE_CITIES_TOPIC = 'service_cities';

@Injectable()
export class FaqService implements OnModuleInit {
  private readonly logger = new Logger(FaqService.name);
  private cache: FaqEntry[] = [];
  private cacheLoadedAt = 0;

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.ensureLoaded().catch((error: unknown) => {
      this.logger.error(
        `[faq] 预热缓存失败（不阻塞启动）: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  /** 异步刷新缓存（懒加载 + 5 分钟 TTL），tryRoute 每轮先过这里再做同步匹配 */
  async ensureLoaded(): Promise<void> {
    if (Date.now() - this.cacheLoadedAt < CACHE_TTL_MS) return;
    const rows = await this.db
      .select()
      .from(faqs)
      .where(eq(faqs.status, PUBLISHED));
    this.cache = rows.map(
      (row): FaqEntry => ({
        id: row.id,
        topic: row.topic,
        triggerWords: row.triggerWords ?? [],
        answer: row.answer,
        priority: row.priority,
        hasLead: row.hasLead,
      }),
    );
    this.cacheLoadedAt = Date.now();
  }

  /** 同步匹配（供 hasQaIntent 等无异步上下文处使用；缓存冷时返回 null） */
  matchFaq(content: string): FaqHit | null {
    if (this.cache.length === 0) return null;

    let best: { entry: FaqEntry; word: string } | null = null;
    for (const entry of this.cache) {
      for (const word of entry.triggerWords) {
        if (!word || !content.includes(word)) continue;
        // 排序：命中词越长越精确优先，其次优先级数字小者优先
        const better =
          !best ||
          word.length > best.word.length ||
          (word.length === best.word.length && entry.priority < best.entry.priority);
        if (better) {
          best = { entry, word };
        }
      }
    }
    if (!best) return null;

    return {
      topic: best.entry.topic,
      matchedWord: best.word,
      reply: this.buildReply(best.entry, content),
    };
  }

  hasFaqHit(content: string): boolean {
    return this.matchFaq(content) !== null;
  }

  /** 服务城市条目按客户提到的城市动态前置判断句，其余条目原样返回已审核文案 */
  private buildReply(entry: FaqEntry, content: string): string {
    if (entry.topic !== SERVICE_CITIES_TOPIC) {
      return entry.answer;
    }
    const city: string | null = detectServiceCity(content);
    if (!city) return entry.answer;
    const prefix: string = hasCity(city)
      ? `${city}有服务的～\n`
      : `${city}目前不在上面的城市名单里～\n`;
    return prefix + entry.answer;
  }
}
