import { Injectable, Logger } from '@nestjs/common';
import type { Requirement, CollectionProgress, CollectionProgressItem } from '@shared/api.interface';
import {
  type RequirementField,
  getTemplate,
  getServiceTypeLabel,
  normalizeServiceType,
  normalizeServiceSubType,
  getFieldCollectionStatus,
  isFieldCollected,
  OPENING_MESSAGES,
  DEFAULT_OPENING_MESSAGE,
} from './requirement-templates';

export interface CollectionStatus {
  collected: { label: string; value: string; status: 'clear' | 'vague' }[];
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

    const collected: { label: string; value: string; status: 'clear' | 'vague' }[] = [];
    const pending: RequirementField[] = [];

    for (const field of fields) {
      const value = reqMap[field.key];
      const status = getFieldCollectionStatus(value);
      if (status === 'clear' || status === 'vague') {
        collected.push({ label: field.label, value: value ?? '', status });
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
    // 2026-08-16 林琳拍板：住家保姆 / 钟点工保姆走一次性采集模式，不走通用多轮引导
    const sub = normalizeServiceSubType(serviceType);
    if (sub === 'zhujia') {
      return this.buildZhujiaOneShotPrompt(serviceType, requirement, serviceCity);
    }
    if (sub === 'zhongdian') {
      return this.buildZhongdianOneShotPrompt(serviceType, requirement, serviceCity);
    }
    const status = this.getCollectionStatus(requirement, serviceType);
    const label = getServiceTypeLabel(serviceType);
    const parts: string[] = [`【需求采集清单】`, `服务类型：${label}`];
    if (serviceCity) parts.push(`服务城市：${serviceCity}`);

    if (status.collected.length > 0) {
      const clearItems = status.collected.filter((c) => c.status === 'clear');
      const vagueItems = status.collected.filter((c) => c.status === 'vague');
      if (clearItems.length > 0) {
        parts.push(`已明确采集：${clearItems.map((c) => `${c.label}=${c.value}`).join('; ')}`);
      }
      if (vagueItems.length > 0) {
        parts.push(`已询问过（待确认）：${vagueItems.map((c) => `${c.label}=${c.value}`).join('; ')}`);
      }
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
    parts.push('【重要规则】已收集的字段**绝对不能重复询问**。');
    parts.push('【重要规则】采集状态分三级：');
    parts.push('  ① 已明确采集：客户给出了明确的"是"或"否"（含具体信息）→ 绝对不再问');
    parts.push('  ② 已询问过：客户回答了但是模糊的（随便/都行/看情况/待定/暂时不确定）→ 不反复追问，但可以在合适时机自然确认一下');
    parts.push('  ③ 未采集：客户没回答或转移话题 → 应该问');
    parts.push('【重要规则】客户说"不需要/没有" → 视为已明确采集，确认后进入下一项。');
    parts.push('【重要规则】客户说"随便/都行/看情况/待定" → 视为已询问过，不要反复追问，可以稍后自然确认。');
    parts.push('【重要规则】如果对话历史中客户已经回答过某个问题，不要再次询问。');
    parts.push('【重要规则】如果客户修改了之前的需求，确认后直接进入下一个未收集字段。');

    return parts.join('\n');
  }

  /**
   * 2026-08-16 林琳 20:53 拍板·钟点工保姆 5+1 步分阶段采集引导 prompt
   *
   * 与 v18:03 区别：v20:53 改为【5+1 步分阶段采集】，每步 1 个气泡，等客户答完再发下一步。
   *   - 阶段 0: chip 5+1（"主要想让阿姨负责哪些事"） — 由客户点选，不发文本问题
   *   - 阶段 1: 每天几小时（1 个气泡）
   *   - 阶段 2: 4 项 1 个 1 个问（4 个气泡）
   *     - 2.1: 家里几口人、房子多大平（1 气泡问 2 子项）
   *     - 2.2: 阿姨月休几天
   *     - 2.3: 什么时候到岗
   *     - 2.4: 在哪个区哪个街道
   *   - 阶段 3: 3 单独项（1 个气泡问 1 项）
   *   - 阶段 4: 9 字段全齐 → 转人工（无月休场景除外）
   *
   * 区别于 v18:03 的"4 项一次性清单"模式：
   *   - 旧版 4 项合并到 1 个气泡发（参考住家保姆 5 字段一次性采集）
   *   - 新版每项 1 个气泡，等客户答完再发下一项（林琳 20:53 明确"每一问都让客户回答，之后再继续发送"）
   *
   * 与 SWAN_PERSONA 的"钟点工 5+1 步流程"对齐
   */
  private buildZhongdianOneShotPrompt(
    serviceType: string | null | undefined,
    requirement: Requirement | null,
    serviceCity?: string | null,
  ): string {
    const req = requirement;
    const label = '钟点工保姆';

    // 2026-08-22 林琳拍板：serviceItems / serviceHours 从 collectedFields JSON 迁为独立列
    //   直接从 req.serviceItems / req.serviceHours 读
    const serviceItemsVal = req?.serviceItems || '';
    const serviceHoursVal = req?.serviceHours || '';
    // ===== 阶段 0：chip（serviceItems）=====
    const serviceItemsDone = !!serviceItemsVal;
    const serviceItemsDisp = serviceItemsVal || '（未填）';

    // ===== 阶段 1：serviceHours =====
    const serviceHoursDone = !!serviceHoursVal;
    const serviceHoursDisp = serviceHoursVal || '（未填）';

    // ===== 阶段 2：4 项 1 个 1 个问 =====
    const workContentVal = [req?.householdSize, req?.area].filter(Boolean).join(' / ') || '（未填）';
    const workContentDone = !!(req?.householdSize || req?.area);
    const restDaysDone = !!req?.restDays;
    const startTimeDone = !!req?.startTime;
    const serviceAddressDone = !!req?.serviceAddress;
    const stage2Done = workContentDone && restDaysDone && startTimeDone && serviceAddressDone;

    // ===== 阶段 3：3 单独项 =====
    const helperReqVal = req?.helperRequirements || '（未填）';
    const dietaryVal = req?.dietaryPreferences || '（未填）';
    const budgetVal = req?.budget || '（未填）';
    const helperReqDone = !!req?.helperRequirements;
    const dietaryDone = !!req?.dietaryPreferences;
    const budgetDone = !!req?.budget;
    const stage3Done = helperReqDone && dietaryDone && budgetDone;

    const allDone = stage2Done && stage3Done && serviceItemsDone && serviceHoursDone;

    const parts: string[] = [
      `【需求采集清单·钟点工保姆 5+1 步分阶段采集（2026-08-16 林琳 20:53 拍板）】`,
      `服务类型：${label}`,
    ];
    if (serviceCity) parts.push(`服务城市：${serviceCity}`);

    parts.push('');
    parts.push('═══════════════════════════════════════════════');
    parts.push('【采集进度（按 5+1 步流程展示）】');
    parts.push('═══════════════════════════════════════════════');
    parts.push(`阶段 0·chip  ①【工作内容】  做饭/洗衣/打扫卫生/买菜/接送孩子/自定义  →  ${serviceItemsDisp}`);
    parts.push(`阶段 1·单问  ②【工作小时】  每天几小时  →  ${serviceHoursDisp}`);
    parts.push(`阶段 2·单问  ③【工作内容】  几口人 + 多少平  →  ${workContentVal}`);
    parts.push(`阶段 2·单问  ④【阿姨休息】  无月休 / 月休 2 天 / 月休 4 天  →  ${restDaysDone ? req!.restDays : '（未填）'}`);
    parts.push(`阶段 2·单问  ⑤【到岗时间】  什么时候需要阿姨上岗  →  ${startTimeDone ? req!.startTime : '（未填）'}`);
    parts.push(`阶段 2·单问  ⑥【服务地址】  在哪个区哪个街道  →  ${serviceAddressDone ? req!.serviceAddress : '（未填）'}`);
    parts.push(`阶段 3·单问  ⑦【阿姨要求】  对阿姨的特别要求  →  ${helperReqVal}`);
    parts.push(`阶段 3·单问  ⑧【做饭口味】  做饭风格 / 忌口  →  ${dietaryVal}`);
    parts.push(`阶段 3·单问  ⑨【薪资预算】  月薪预算  →  ${budgetVal}`);

    if (!allDone) {
      parts.push('');
      parts.push('═══════════════════════════════════════════════');
      parts.push('【当前任务·5+1 步分阶段采集·每次只发 1 个问题】');
      parts.push('═══════════════════════════════════════════════');

      // 阶段 0：先发 chip 触发问
      if (!serviceItemsDone) {
        parts.push('当前阶段：阶段 0·chip');
        parts.push('下一步话术（**只发 1 个问题**，不要发"每天几小时"等其他问题）：');
        parts.push('"主要想让阿姨负责哪些事呢？"');
        parts.push('【重要规则】只发这一句文本，配合前端 chip 5+1 快捷标签（做饭/洗衣/打扫卫生/买菜/接送孩子 + 自定义）。');
        parts.push('【重要规则】**绝不能**在同一条消息里同时发"主要想让阿姨负责哪些事呢？"+"每天几小时？" —— 林琳 20:53 拍板"每一问都让客户回答，之后再继续发送"。');
      }
      // 阶段 1：每天几小时
      else if (!serviceHoursDone) {
        parts.push('当前阶段：阶段 1·单问');
        parts.push('下一步话术：');
        parts.push('"请问您每天需要阿姨上门几个小时呢？"');
        parts.push('【重要规则】只发这一句，等客户回答。**绝不能**同时问 4 项 1 个 1 个问里的其他问题。');
      }
      // 阶段 2：4 项 1 个 1 个问
      else if (!workContentDone) {
        parts.push('当前阶段：阶段 2·单问 2.1');
        parts.push('下一步话术（带"好嘞~"起手 + 一气泡问 2 子项）：');
        parts.push('"好嘞~ 跟您了解一下具体需求哈：家里几口人、房子多大平？"');
        parts.push('【重要规则】这一气泡同时问 2 子项（几口人 / 多少平），2 子项任一填就算采了"工作内容"。');
      } else if (!restDaysDone) {
        parts.push('当前阶段：阶段 2·单问 2.2');
        parts.push('下一步话术：');
        parts.push('"阿姨月休几天呢？无月休、月休2天、或月休4天？"');
        parts.push('【重要规则】钟点工 3 选项（"无月休/月休2天/月休4天"），不是其他服务的 2 选项。');
      } else if (!startTimeDone) {
        parts.push('当前阶段：阶段 2·单问 2.3');
        parts.push('下一步话术：');
        parts.push('"希望阿姨什么时候到岗呢？"');
      } else if (!serviceAddressDone) {
        parts.push('当前阶段：阶段 2·单问 2.4');
        parts.push(serviceCity
          ? `下一步话术："您在${serviceCity}哪个区哪个街道呢？"`
          : '下一步话术："您在北京哪个区哪个街道呢？"（无城市时用"北京"兜底）');
      }
      // 阶段 3：3 单独项
      else if (!helperReqDone) {
        parts.push('当前阶段：阶段 3·单问 ⑦');
        parts.push('下一步话术：');
        parts.push('"基础信息都齐啦～再问您一个小问题：对阿姨有什么特别要求吗？比如年龄、经验、做饭风格？没有具体要求的话，直接说"没要求"就行~"');
      } else if (!dietaryDone) {
        parts.push('当前阶段：阶段 3·单问 ⑧');
        parts.push('下一步话术：');
        parts.push('"阿姨要求也记下啦～做饭口味有偏好吗？比如菜系、忌口等？随便也行，告诉 AI 一下~"');
      } else if (!budgetDone) {
        parts.push('当前阶段：阶段 3·单问 ⑨');
        parts.push('下一步话术：');
        parts.push('"口味偏好记下啦～最后一个问题：薪资预算大概多少？比如月薪 7000-8000、8000-10000 等。如果还不确定，可以先说"待定"，AI 帮您转给客服协调~"');
      }

      parts.push('【重要规则】5+1 步分阶段采集**每步 1 个气泡**，等客户答完再发下一步。');
      parts.push('【重要规则】已采字段**绝对不能重复询问**（代码层有护栏）。');
      parts.push('【重要规则】采集状态分三级：已明确采集 / 已询问过 / 未采集。');
      parts.push('  · 客户说"不需要/没有" → 已明确采集，确认后进入下一项');
      parts.push('  · 客户说"随便/都行/看情况/待定" → 已询问过，不反复追问，稍后自然确认');
      parts.push('  · 客户没回答或转移话题 → 未采集，应该问');
    } else {
      // ===== 9 字段全齐 =====
      // 2026-08-16 林琳 19:44 拍板：钟点工+无月休 不转人工
      const isZhongdianNoRest = req?.restDays === '无月休';
      parts.push('');
      parts.push('═══════════════════════════════════════════════');
      if (isZhongdianNoRest) {
        parts.push('【当前任务】9 字段全采齐（钟点工选了【无月休】，**不**走转人工）');
        parts.push('═══════════════════════════════════════════════');
        parts.push('话术："收到～我把您的需求整理一下：工作内容=X、工作小时=X、家里几口人=X、房子多大=X、阿姨休息=无月休、到岗时间=X、服务地址=X、阿姨要求=X、做饭口味=X、薪资预算=X。客户工作忙不需要阿姨休息，直接结束采集即可~"');
        parts.push('【重要规则】**绝对不能**在回复中加【转人工】。整理需求 + 复述一遍后结束。');
      } else {
        parts.push('【当前任务】9 字段全采齐！请在回复开头加【转人工】');
        parts.push('═══════════════════════════════════════════════');
        parts.push('话术："收到～我把您的需求整理一下：工作内容=X、工作小时=X、家里几口人=X、房子多大=X、阿姨休息=X、到岗时间=X、服务地址=X、阿姨要求=X、做饭口味=X、薪资预算=X。现在为您转人工客服，由专员对接后续匹配~"');
      }
      parts.push('【重要规则】9 字段全采齐后不要再问任何问题。');
      parts.push('【重要规则】钟点工 restDays="无月休" 是合法选项，**不算"非标准月休"**，不触发早拦截。');
    }

    return parts.join('\n');
  }

  /**
   * 2026-08-16 林琳拍板·住家保姆 5+3 字段 2 阶段采集引导 prompt
   * v1: 5 字段一次性 → 转人工
   * v2 (当前): 5 字段一次性 → 3 单独项单独问 → 转人工
   *
   * 区别于通用 buildGuidancePrompt：
   *   - 阶段 1: 把 5 项内容列出来让客户一次性回答；不再说"每次只问一个问题"——5 字段可一次问完
   *   - 阶段 2: 5 字段采齐后，AI 单独问 3 单独项（一次一项，避免客户一次答太多）
   *   - 工作内容（3 子字段）任一填就算"工作内容"采了
   */
  private buildZhujiaOneShotPrompt(
    serviceType: string | null | undefined,
    requirement: Requirement | null,
    serviceCity?: string | null,
  ): string {
    const req = requirement;
    const label = '住家保姆';
    // ===== 阶段 1：5 字段 =====
    const workContentVal = [req?.householdSize, req?.area, req?.elderlyCare].filter(Boolean).join(' / ') || '（未填）';
    const workContentDone = !!workContentVal && workContentVal !== '（未填）';
    const restDaysDone = !!req?.restDays;
    const startTimeDone = !!req?.startTime;
    const serviceAddressDone = !!req?.serviceAddress;
    const stage1Done = workContentDone && restDaysDone && startTimeDone && serviceAddressDone;

    // ===== 阶段 2：3 单独项 =====
    const helperReqVal = req?.helperRequirements || '（未填）';
    const dietaryVal = req?.dietaryPreferences || '（未填）';
    const budgetVal = req?.budget || '（未填）';
    const helperReqDone = !!req?.helperRequirements;
    const dietaryDone = !!req?.dietaryPreferences;
    const budgetDone = !!req?.budget;
    const stage2Done = helperReqDone && dietaryDone && budgetDone;
    const allDone = stage1Done && stage2Done;

    const parts: string[] = [
      `【需求采集清单·住家保姆 5+3 字段 2 阶段模式（2026-08-16 林琳拍板 v2）】`,
      `服务类型：${label}`,
    ];
    if (serviceCity) parts.push(`服务城市：${serviceCity}`);

    parts.push('');
    parts.push('═══════════════════════════════════════════════');
    parts.push('【阶段 1：5 字段（一次性列出，等客户自由回答）】');
    parts.push('═══════════════════════════════════════════════');
    parts.push(`①【工作内容】  几口人 + 多少平 + 是否需要照顾老人/小孩  →  ${workContentVal}`);
    parts.push(`②【阿姨休息】  月休 4 天还是 2 天  →  ${restDaysDone ? req!.restDays : '（未填）'}`);
    parts.push(`③【到岗时间】  什么时候需要阿姨上岗  →  ${startTimeDone ? req!.startTime : '（未填）'}`);
    parts.push(`④【服务地址】  在哪个区哪个街道  →  ${serviceAddressDone ? req!.serviceAddress : '（未填）'}`);

    if (!stage1Done) {
      // ===== 阶段 1 未采齐：引导客户答 5 字段 =====
      parts.push('');
      parts.push('═══════════════════════════════════════════════');
      parts.push('【当前任务·阶段 1】一次性把 5 项列出来让客户回答');
      parts.push('═══════════════════════════════════════════════');
      parts.push('"咱们一次性把核心需求整理好～请告诉我：');
      parts.push('①家里几口人、房子多大平、是否需要照顾老人/小孩？');
      parts.push('②阿姨月休几天呢？4天还是2天？');
      parts.push('③希望阿姨什么时候到岗？');
      parts.push(serviceCity ? `④您在${serviceCity}哪个区哪个街道？` : '④服务地址在哪个区哪个街道？');
      parts.push('可以一条消息全答，也可以分开说，AI 实时整理~"');
      parts.push('【重要规则】已采字段**绝对不能重复询问**（代码层有护栏）。客户可能一条消息全答，也可能分多条——两种格式都要识别。');
      parts.push('【重要规则】采集状态分三级：已明确采集 / 已询问过 / 未采集。');
      parts.push('  · 客户说"不需要/没有" → 已明确采集，确认后进入下一项');
      parts.push('  · 客户说"随便/都行/看情况/待定" → 已询问过，不反复追问，稍后自然确认');
      parts.push('  · 客户没回答或转移话题 → 未采集，应该问');
    } else {
      // ===== 阶段 1 采齐：进入阶段 2 =====
      parts.push('');
      parts.push('═══════════════════════════════════════════════');
      parts.push('【阶段 2：3 单独项（5 字段已采齐，进入阶段 2）】');
      parts.push('═══════════════════════════════════════════════');
      parts.push(`⑤【阿姨要求】  对阿姨的特别要求  →  ${helperReqVal}`);
      parts.push(`⑥【做饭口味】  做饭风格 / 忌口  →  ${dietaryVal}`);
      parts.push(`⑦【薪资预算】  月薪预算  →  ${budgetVal}`);

      if (!stage2Done) {
        // ===== 阶段 2 未采齐：AI 单独问下一个未采项（一次一项）=====
        parts.push('');
        parts.push('═══════════════════════════════════════════════');
        parts.push('【当前任务·阶段 2】AI 单独问下一个未采项（一次只问 1 项）');
        parts.push('═══════════════════════════════════════════════');
        if (!helperReqDone) {
          parts.push('下一步问【阿姨要求】：');
          parts.push('"基础信息都齐啦～再问您一个小问题：对阿姨有什么特别要求吗？比如年龄、经验、做饭风格？没有具体要求的话，直接说"没要求"就行~"');
        } else if (!dietaryDone) {
          parts.push('下一步问【做饭口味】：');
          parts.push('"阿姨要求也记下啦～做饭口味有偏好吗？比如菜系、忌口等？随便也行，告诉 AI 一下~"');
        } else if (!budgetDone) {
          parts.push('下一步问【薪资预算】：');
          parts.push('"口味偏好记下啦～最后一个问题：薪资预算大概多少？比如月薪 7000-8000、8000-10000 等。如果还不确定，可以先说"待定"，AI 帮您转给客服协调~"');
        }
        parts.push('【重要规则】阶段 2 必须**一次只问 1 项**，让客户能简短回答。');
        parts.push('【重要规则】客户主动答了多项（如"阿姨 5 年经验、做饭清淡、7000-8000"）→ AI 实时识别并合并记录。');
        parts.push('【重要规则】客户说"不需要/没有/没要求/随便/待定" → 视为"已采"，AI 主动确认后进入下一项。');
      } else {
        // ===== 8 字段全齐：转人工 =====
        parts.push('');
        parts.push('═══════════════════════════════════════════════');
        parts.push('【当前任务】8 字段全采齐！请在回复开头加【转人工】');
        parts.push('═══════════════════════════════════════════════');
        parts.push('话术："收到～我把您的需求整理一下：工作内容=X、阿姨休息=X、到岗时间=X、服务地址=X、阿姨要求=X、做饭口味=X、薪资预算=X。现在为您转人工客服，由专员对接后续匹配~"');
        parts.push('【重要规则】8 字段全采齐后不要再问任何问题。');
      }
    }

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
    // 2026-08-22 林琳拍板：serviceItems / serviceHours 从 collectedFields JSON 迁为独立列
    return {
      serviceType: req.serviceType,
      householdSize: req.householdSize,
      area: req.area,
      elderlyCare: req.elderlyCare,
      childCare: req.childCare,
      restDays: req.restDays,
      startTime: req.startTime,
      serviceAddress: req.serviceAddress,
      helperRequirements: req.helperRequirements,
      dietaryPreferences: req.dietaryPreferences,
      budget: req.budget,
      specialRequirements: req.specialRequirements,
      serviceItems: req.serviceItems,
      serviceHours: req.serviceHours,
      hasPet: req.hasPet,
    };
  }
}
