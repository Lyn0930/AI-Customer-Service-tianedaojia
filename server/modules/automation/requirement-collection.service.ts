import { Injectable, Logger } from '@nestjs/common';
import type { Requirement, CollectionProgress, CollectionProgressItem } from '@shared/api.interface';
import {
  type RequirementField,
  getTemplate,
  getServiceTypeLabel,
  normalizeServiceType,
  OPENING_MESSAGES,
  DEFAULT_OPENING_MESSAGE,
} from './requirement-templates';

export interface CollectionStatus {
  collected: { label: string; value: string }[];
  pending: RequirementField[];
  nextField: RequirementField | null;
  completedCount: number;
  totalCount: number;
}

@Injectable()
export class RequirementCollectionService {
  private readonly logger = new Logger(RequirementCollectionService.name);

  getChecklist(serviceType: string | null | undefined): RequirementField[] {
    return getTemplate(serviceType);
  }

  getCollectionStatus(
    requirement: Requirement | null,
    serviceType: string | null | undefined,
  ): CollectionStatus {
    const fields = getTemplate(serviceType);
    const reqMap = this.requirementToMap(requirement);

    const collected: { label: string; value: string }[] = [];
    const pending: RequirementField[] = [];

    for (const field of fields) {
      const value = reqMap[field.key];
      if (value && value.trim()) {
        collected.push({ label: field.label, value });
      } else {
        pending.push(field);
      }
    }

    return {
      collected,
      pending,
      nextField: pending.length > 0 ? pending[0] : null,
      completedCount: collected.length,
      totalCount: fields.length,
    };
  }

  buildGuidancePrompt(
    serviceType: string | null | undefined,
    requirement: Requirement | null,
    serviceCity?: string | null,
  ): string {
    const status = this.getCollectionStatus(requirement, serviceType);
    const label = getServiceTypeLabel(serviceType);
    const parts: string[] = [`【需求采集清单】`, `服务类型：${label}`];
    if (serviceCity) parts.push(`服务城市：${serviceCity}`);

    if (status.collected.length > 0) {
      parts.push(`已收集：${status.collected.map((c) => `${c.label}=${c.value}`).join('; ')}`);
    } else {
      parts.push('已收集：暂无');
    }

    if (status.pending.length > 0) {
      parts.push(`待收集（按优先级）：${status.pending.map((f) => f.label).join(', ')}`);
    } else {
      parts.push('待收集：全部已收集');
    }

    if (status.nextField) {
      parts.push('');
      if (!serviceType && status.collected.length === 0) {
        parts.push(`【当前任务】服务类型尚未确认，请先询问客户需要哪种服务（钟点工保姆/白班保姆/住家保姆/育儿保姆/护工保姆/菲式保姆/月嫂等），不要直接询问老人照护、宝宝年龄等具体细节。`);
      } else {
        let question = status.nextField.question;
        if (status.nextField.key === 'serviceAddress' && serviceCity) {
          question = `您在${serviceCity}哪个区哪个街道呢？`;
        }
        parts.push(`【当前任务】请询问雇主关于"${status.nextField.label}"的信息："${question}"`);
      }
    } else {
      parts.push('');
      parts.push('【当前任务】需求已全部收集，请自然结束采集并感谢雇主。');
    }

    parts.push('【重要规则】每次只问一个问题。');
    parts.push('已收集的字段绝对不能重复询问。');
    parts.push('如果对话历史中客户已经回答过某个问题，不要再次询问。');
    parts.push('如果客户修改了之前的需求，确认后直接进入下一个未收集字段。');

    return parts.join('\n');
  }

  getOpeningMessage(serviceType: string | null | undefined): string {
    const key = normalizeServiceType(serviceType);
    return OPENING_MESSAGES[key] ?? DEFAULT_OPENING_MESSAGE;
  }

  getCollectionProgress(
    requirement: Requirement | null,
    serviceType: string | null | undefined,
  ): CollectionProgress {
    const fields = getTemplate(serviceType);
    const reqMap = this.requirementToMap(requirement);
    const label = getServiceTypeLabel(serviceType);

    const items: CollectionProgressItem[] = fields.map((field) => {
      const value = reqMap[field.key];
      const collected = !!(value && value.trim());
      return {
        field: field.key,
        label: field.label,
        question: field.question,
        required: field.required,
        value: collected ? value : null,
        collected,
      };
    });

    const collectedCount = items.filter((i) => i.collected).length;
    const totalCount = items.length;
    const requiredItems = items.filter((i) => i.required);
    const requiredCollected = requiredItems.filter((i) => i.collected).length;
    const percent = totalCount > 0 ? Math.round((collectedCount / totalCount) * 100) : 0;
    const nextPending = items.find((i) => !i.collected);

    return {
      serviceType: serviceType ?? null,
      serviceTypeLabel: label,
      items,
      collectedCount,
      totalCount,
      requiredCount: requiredItems.length,
      requiredCollected,
      percent,
      nextField: nextPending ?? null,
      status: requirement?.status ?? 'collecting',
      aiSummary: requirement?.aiSummary ?? null,
    };
  }

  private requirementToMap(req: Requirement | null): Record<string, string | null> {
    if (!req) return {};
    return {
      serviceType: req.serviceType,
      householdSize: req.householdSize,
      area: req.area,
      elderlyCare: req.elderlyCare,
      restDays: req.restDays,
      startTime: req.startTime,
      serviceAddress: req.serviceAddress,
      helperRequirements: req.helperRequirements,
      dietaryPreferences: req.dietaryPreferences,
      // 2026-09-05：budget 已是 number——本 map 的消费方（采集进度/引导话术）都按字符串处理，这里统一转回 string
      budget: req.budget != null ? String(req.budget) : null,
      serviceDuration: req.serviceDuration,
      livingPreference: req.livingPreference,
      specialRequirements: req.specialRequirements,
      familyInfo: req.familyInfo,
      workMode: req.workMode,
    };
  }
}
