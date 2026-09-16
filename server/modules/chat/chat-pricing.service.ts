import { Injectable, Logger } from '@nestjs/common';
import { SalaryConfigService } from '../salary-config/salary-config.service';
import { chineseServiceType } from '../automation/requirement-templates';
import { detectAreaFromText, detectCityTier } from './chat.prompt';

type PricingRequirement = {
  serviceType?: string | null;
  area?: string | null;
  serviceAddress?: string | null;
};

@Injectable()
export class ChatPricingService {
  private readonly logger = new Logger(ChatPricingService.name);

  constructor(
    private readonly salaryConfigService: SalaryConfigService,
  ) {}


  /**
   * 检测客户消息是否为"月休和价格的关系"类高频问题
   * 命中后会被代码强制覆写为短答模板（避免 LLM 输出"城市调整"错答或长版薪资换算）
   */
  /**
   * 检测"月休4天嫌贵想换月休6天"这一专项场景
   * 客户因月休4天报价贵，主动提出换月休6天——是合理月休调整，不是议价
   * 用于护栏：阻止 LLM 误触发 B-price 转人工
   */
  public isMonthRest4TooExpensiveSwitchTo6(content: string): boolean {
    // 关键三件套：月休4天(或4天/月休4) + 贵/便宜 + 换/改成/试试/月休6天
    const has4Days = /4\s*天|月休\s*4/.test(content);
    const hasPriceWord = /贵|便宜|价高|价格高|有点贵|太贵|不划算|费用高|太高|贵了|贵了点|贵了一些|贵哦|贵呀|贵啊|贵呐/.test(content);
    const has6DaysOrSwitch = /6\s*天|月休\s*6|换\s*月休|改\s*月休|换\s*成|改\s*成|改\s*一下|试试\s*6|想\s*6|想要\s*6|看看\s*6/.test(content);
    return has4Days && hasPriceWord && has6DaysOrSwitch;
  }

  /**
   * 检测客户消息是否为"月休和价格的关系"类高频问题
   * 命中后会被代码强制覆写为短答模板（避免 LLM 输出"城市调整"错答或长版薪资换算）
   */
  public isRestDaysPriceQuestion(content: string): boolean {
    // 客户消息同时含"月休" + "价格/价钱/费用/报价/月薪/工资/薪资" + 任意问句形式
    const hasRest = /月休|休息天数|休假/.test(content);
    const hasPrice = /价格|价钱|费用|报价|贵|便宜|月薪|工资|薪资|收入|多少钱/.test(content);
    const isQuestion = /[？?]/.test(content) || /^(是|有|会|能|怎|什|哪|多少|几)/.test(content) || /(吗|呢|呀|啊|哈|嘛|的|关系|影响|挂钩)/.test(content);
    return hasRest && hasPrice && isQuestion;
  }

  /**
   * 检测客户消息是否为市场价/行情信息询问（不是议价/还价）
   * 用于"市场价有模板时强制按模板答，剥离误加的【转人工】"的护栏
   *
   * 2026-08-15 加固：补"一般市场价是多少"（"一般"在"市场价"前）这类同义变体，
   * 以及"市场价X""什么价位""X 一个月多少钱"等更宽的问法
   */
  public detectMarketPriceQuestion(content: string): boolean {
    const patterns = [
      // 直接含"市场价"任何位置
      /市场价/,
      /行情/,
      /市面上/,
      /参考(一下|价|价格)/,
      // "怎么算钱/怎么计费/怎么定价/怎么报价/怎么算价格"（明确问计算方式=问价格）
      /(怎么|如何|咋).{0,2}(算钱|计费|定价|报价|算价格)/,
      // "价格/价钱/价位/报价 + 标准/是多少/怎么算/怎么定/大概多少/一般多少"（明确问金额）
      /(价格|价钱|价位|报价)(标准|是多少|怎么算|怎么定|大概多少|一般多少|多少[钱]?)/,
      // "一般/大概/通常/市面上 + 多少钱/价格"（中间允许 0~4 字口语化衔接，如"一般是多少""大概得多少"）
      /(一般|大概|差不多|通常|一般行情|通常的?|通常情况下?).{0,4}(多少|几|多少[钱块钱元]?|什么样的?价|什么样的?价位|价位)/,
      // "X 一般 / X 大概 + 多少"（如"住家保姆一般多少钱"）
      /(住家|白班|育儿|护工|菲式|月嫂|钟点|保姆|阿姨).{0,8}(一般|大概|差不多)(多少|几|价|价位)/,
      // "住家保姆多少钱 / 月嫂多少钱 / 育儿嫂价格" —— 必须含钱/块/元/价/位/价格/费用等钱相关词
      /(住家|白班|育儿|护工|菲式|月嫂|钟点|保姆|阿姨).{0,5}(多少钱|多少块|多少元|什么价|什么价位|价位|价格是多少|价格怎么样|费用是多少|费用大概)/,
      // "保姆怎么收费 / 住家保姆怎么收费" —— 服务类型+怎么收费=问价格
      /(住家|白班|育儿|护工|菲式|月嫂|钟点|保姆|阿姨).{0,5}怎么收费/,
      // "X 一个月多少钱 / X 月薪多少"
      /(一个月|每月|月薪|月工资|月薪资|月收入|一个月薪)(多少|几|大概多少)/,
      // "多少钱一个月 / 一个月多少钱 / 一个月大概多少"
      /(多少钱|多少块|多少元)(一个月|每月|一个月薪|每个月)/,
      // "现在多少钱 / 现在什么价位"
      /现在(多少|几|什么价|什么价位|价位)/,
      // 模糊钱问法（2026-09-12 口径：无明确费用对象一律默认 market_price 按总账直答，不反问）
      /怎么收费|如何收费|收费模式|收费标准|收费规则|收费怎么算|怎么收钱/,
      /收多少钱|收多少费用|你们.{0,6}(收多少|怎么收)/,
      /费用(是多少|多少|怎么算|怎么收|怎么算的)/,
      /还有(别的|其他|什么)(费用|收费)/,
      // 孤零零一句"多少钱 / 费用多少"（句尾，无对象无上下文 → 默认问总花费）
      /(多少钱|多少元|多少块|费用多少)\s*[?？。]?$/,
    ];
    return patterns.some((p) => p.test(content));
  }

  /**
   * 混合意图检测：消息中既有询价句又有其他独立问题/信息。
   * 分句后至少一句命中询价、且另有 ≥4 字的非询价分句 → true（应走老路让 LLM 一并处理）
   */
  public hasNonPriceContent(content: string): boolean {
    const segments = content
      .split(/[？?。!！;；\n，,]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const hasPriceSegment = segments.some((s) => this.detectMarketPriceQuestion(s));
    if (!hasPriceSegment) return false;
    return segments.some(
      (s) => !this.detectMarketPriceQuestion(s) && s.length >= 4,
    );
  }

  /**
   * 检测 LLM 输出是否使用了 persona 禁答的"城市调整 + 客服后续给报价"错答模板
   * 2026-08-15 新增：林琳反馈"一般市场价是多少"AI 仍答"价格会根据您所在城市调整，【客服后续会给准确报价】"
   * 这是 OPENING_MESSAGE 的兜底语，persona【流程 C】明示不该用在市场价问题上
   */
  public isWrongPriceTemplate(response: string): boolean {
    // 错答信号：宽松匹配"城市 / 客服后续给报价"系列兜底语
    const wrongSignals = [
      // "根据您所在城市调整 / 根据您所在的城市，价格会...不同"
      /根据.{0,6}所在(的)?城市/,
      /所在(的)?城市.{0,15}(不同|调整|影响|有差异|有(所)?不同)/,
      // "价格会根据城市调整 / 价格会因城市不同"
      /价格(会|将)?根据.{0,8}(城市|地区|区域)/,
      /价格(会|将)?(因|因.{0,4}城市|跟|随着).{0,12}(不同|调整|有差异|有(所)?不同)/,
      // "客服后续给报价 / 客服会给您最终确认"
      /客服(后续|之后|会)(会)?给(您)?(准确|最终|具体|精确)?(报价|确认|价格|答复|回复|沟通)/,
      /客服(后续|之后|会).{0,8}(联系|回复|沟通|对接)/,
      /后续(会|由|交给).{0,8}(客服|人工|专员|顾问).{0,8}(联系|回复|沟通|对接|给到)/,
      /由(我们|人工|客服|专员|顾问).{0,8}(联系|对接|给到|确认|沟通)/,
    ];
    // 命中"城市调整/客服后续给报价"任一错答信号即可
    return wrongSignals.some((p) => p.test(response));
  }

  /**
   * 6.5 市场价护栏的强制覆写模板（v4，2026-08-15 林琳反馈"AI 答得太宽，没针对客户情况"）
   *
   * 设计原则：
   *   - 业务维护的 salary_config 表里只有【住家保姆】的 6 条区间（一/二/三线 × 大/小面积），
   *     所以"有数据"时给住家保姆参考；其他服务类型没数据，老实说"差异较大要看具体需求"
   *   - 按对话中已知的 cityTier + area 精准过滤（v4 新增）：
   *     cityTier+area 都已知 → 1 条；仅 cityTier → 2 条（同一城市 2 个 areaType）；
   *     仅 area → 3 条（同一 areaType 3 个 cityTier）；都没采到 → 6 条（住家保姆默认场景）
   *   - 不报"城市调整/客服后续给准确报价"等 persona 禁答模板
   *   - 删去 v3 末尾"您想了解的是住家保姆，还是其他几类？"反问（"按客户路径来，灵活的聊天"）
   *
   * 三个分支：
   *   1) serviceType=住家保姆 → 按已知 cityTier/area 过滤 cfgList，1/2/3/6 条
   *   2) serviceType 是其他 5 类（白班/月嫂/育儿/护工/菲式/钟点工）→ 说差异大要看具体需求
   *   3) serviceType 未采到 → 按已知 cityTier/area 过滤 cfgList，1/2/3/6 条
   *
   * 2026-08-16 v4.1 加固（林琳 20:29 反馈"已采集北京为啥还给我二三线"）：
   *   - 分支 2 之前 bug：只 sort 不过滤，cityTier 已知时仍输出所有 tier 行（"一线：3000-4500 + 二三线：2000-3500"）
   *   - 修法：分支 2 也按 cityTier 过滤（跟分支 1/3 一致），cityTier 已知 → 只 1 条该 tier 行
   *   - 兜底：filter 后为空（极端：表里没对应 cityTier）→ 退回全部行
   * 2026-08-16 v4.2 加固（林琳 20:29 反馈截图 serviceCity="海淀区上地街道"未识别）：
   *   - detectCityTier 加 3 路径：①完整城市名 ②文本包含城市名（如"北京市"）③区/县→城市映射（一线 16+10+11+10 区）
   *   - 客户只说区名也能识别（一线 4 城所有区都覆盖了）
   *
   * @param currentRequirement 已采集的需求（含 serviceType）
   * @param serviceCity lead 关联的服务城市（用于查 cityTier）
   * @param historyMessages 对话历史（用于从客户消息中识别面积）
   */
   public async buildMarketPriceCanonical(
      currentRequirement: PricingRequirement | null | undefined,
      serviceCity?: string | null,
     historyMessages?: Array<{ role: string; content: string }>,
   ): Promise<string> {
     const rawType = currentRequirement?.serviceType?.trim() ?? '';
     const cnType = chineseServiceType(rawType) || rawType;
     const serviceType = cnType;

      // 公共：识别 cityTier + area（城市兜底链：lead.serviceCity → 已采集 serviceAddress → 客户原话）
      const { cityTier, area } = this.resolveTierAndArea(
        currentRequirement,
        serviceCity,
        historyMessages,
      );

    // 工具：把 cfgList 按已知 cityTier/area 过滤，返回格式化好的若干行
    const filterCfgList = (cfgList: Array<{
      cityTier: string;
      areaType: string;
      baseLow: number;
      baseHigh: number;
      altLow: number;
      altHigh: number;
    }>): string[] => {
      const order = ['一线', '二线', '三线'];
      const sorted = [...cfgList].sort(
        (a, b) =>
          order.indexOf(a.cityTier) - order.indexOf(b.cityTier) ||
          (a.areaType === '大面积' ? -1 : 1) - (b.areaType === '大面积' ? -1 : 1),
      );
      let filtered = sorted;
      const areaTypeMatches = (cfgAreaType: string, knownArea: '大' | '小') =>
        (knownArea === '大' && cfgAreaType === '大面积') ||
        (knownArea === '小' && cfgAreaType === '小面积');
      if (cityTier && area) {
        // 都已知 → 只 1 条
        filtered = sorted.filter((c) => c.cityTier === cityTier && areaTypeMatches(c.areaType, area));
      } else if (cityTier) {
        // 仅 cityTier → 同城市的 2 个 areaType
        filtered = sorted.filter((c) => c.cityTier === cityTier);
      } else if (area) {
        // 仅 area → 同 areaType 的 3 个 cityTier
        filtered = sorted.filter((c) => areaTypeMatches(c.areaType, area));
      }
      // 过滤后为空（极端情况：salary_config 没数据）→ 退回全部 6 条兜底
      if (filtered.length === 0) filtered = sorted;
      return filtered.map(
        (c) =>
          `• ${c.cityTier}${c.areaType}：${c.baseLow}-${c.baseHigh} 元/月（对阿姨要求不高可尝试 ${c.altLow}-${c.altHigh} 元/月）`,
      );
    };

    // 工具：根据对话场景生成最终文案
    const formatByContext = (
      lines: string[],
      serviceTypeName: string,
    ): string => {
      if (lines.length === 0) {
        return `【${serviceTypeName}】市场价大概在【4500-8500 元/月】区间，具体看城市和房屋面积~`;
      }
      if (lines.length === 1) {
        // cityTier+area 都已知：单句直接给数（去掉项目符号 + 简化措辞）
        const first = lines[0].replace(/^• /, '').replace('：', '参考：');
        return `【${serviceTypeName}】${first}。`;
      }
      // 2/3/6 条：保留项目符号列表
      const header = lines.length === 6
        ? `【${serviceTypeName}】市场价参考：`
        : `【${serviceTypeName}】${cityTier ?? (area === '大' ? '大面积' : '小面积')}参考：`;
      return `${header}\n${lines.join('\n')}`;
    };

    // 分支 1：客户已确认是住家保姆 → 按已知 cityTier/area 过滤
    if (serviceType && (serviceType === '住家保姆' || serviceType.includes('住家'))) {
      const cfgList = await this.salaryConfigService
        .listByServiceType('住家保姆')
        .catch(() => []);
      if (cfgList.length > 0) {
        const lines = filterCfgList(cfgList);
        return formatByContext(lines, '住家保姆');
      }
      // 极端情况：表里没数据，兜底给一个笼统范围
      return '【住家保姆】市场价大概在【4500-8500 元/月】区间，具体看城市（一线会到 8000+，二线 5000-7000，三线 4500-6000）和房屋面积~';
    }

    // 分支 2：客户已确认是其他服务类型（白班保姆/月嫂/育儿保姆/护工/菲式/钟点工）→ 查表给区间
    // 2026-08-16 林琳 20:29 拍板：已采集城市时**只**给该城市档位（之前 v4 bug：只 sort 不 filter，输出所有 tier 跟未采集城市一样）
    if (serviceType) {
      const otherTypes = ['白班保姆', '月嫂', '育儿保姆', '育儿嫂', '护工', '菲式', '钟点工'];
      const matched = otherTypes.find(
        (t) => serviceType === t || serviceType.includes(t),
      );
      if (matched) {
        // 育儿嫂 → 育儿保姆（salary_config 表用的是'育儿保姆'）
        const SALARY_TYPE_MAP: Record<string, string> = { '育儿嫂': '育儿保姆' };
        const salaryType = SALARY_TYPE_MAP[matched] ?? matched;
        const cfgList = await this.salaryConfigService
          .listByServiceType(salaryType)
          .catch(() => []);
        if (cfgList.length > 0) {
          const order = ['一线', '二线', '三线', '二三线'];
          const sorted = [...cfgList].sort(
            (a, b) => order.indexOf(a.cityTier) - order.indexOf(b.cityTier),
          );
          // 2026-08-16 v4.1 加固：按已知 cityTier 过滤（之前 v4 bug：只 sort 不过滤，输出 4 行跟未采集城市一样）
          // 兜底：filter 后为空（极端情况：表里没对应 cityTier）→ 退回全部行
          const filtered = cityTier
            ? sorted.filter((c) => c.cityTier === cityTier)
            : sorted;
          const effective = filtered.length > 0 ? filtered : sorted;
          const lines = effective.map(
            (c) =>
              c.subDimension
                ? `• ${c.cityTier} ${c.subDimension}：${c.baseLow}-${c.baseHigh} 元/月${c.altLow > 0 ? `（要求不高可尝试 ${c.altLow}-${c.altHigh} 元/月）` : ''}`
                : `• ${c.cityTier}：${c.baseLow}-${c.baseHigh} 元/月${c.altLow > 0 ? `（要求不高可尝试 ${c.altLow}-${c.altHigh} 元/月）` : ''}`,
          );
          // 1 条：单行直接给数（与住家保姆分支 1 的 formatByContext 一致）
          if (lines.length === 1) {
            // 2026-08-16 23:01 林琳反馈：去掉"具体看您所在城市和具体需求~"（显得 AI 在 deflect / 价格不靠谱）
            //   换成"具体价格由人工客服向您推荐阿姨之后确定。"——给客户定心丸，明确后续有人工跟进
            //   截图原句："【钟点工】一线参考：3000-4500 元/月。具体看您所在城市和具体需求~"
            //   修改后：  "【钟点工】一线参考：3000-4500 元/月。具体价格由人工客服向您推荐阿姨之后确定。"
            return `【${matched}】${cityTier ?? '当前城市'}参考：${effective[0].baseLow}-${effective[0].baseHigh} 元/月${effective[0].altLow > 0 ? `（要求不高可尝试 ${effective[0].altLow}-${effective[0].altHigh} 元/月）` : ''}。具体价格由人工客服向您推荐阿姨之后确定。`;
          }
          // 2+ 条：保留项目符号列表（未采集 cityTier 的兜底）
          // 同步修改（2026-08-16 23:01）：后缀与单行场景保持一致
          return `【${matched}】市场价参考：\n${lines.join('\n')}\n具体价格由人工客服向您推荐阿姨之后确定。`;
        }
        return `【${matched}】价格差异较大，要看具体需求（工作制 / 月子天数 / 宝宝月龄 / 老人身体状况 / 是否带睡 等）才能报参考区间。您方便说一下具体需求吗？`;
      }
    }

    // 分支 3：serviceType 未采到 → 给住家保姆参考（业务最常见），按已知 cityTier/area 过滤
    // 不再末尾加"您想了解的是住家保姆，还是其他几类？"反问（v4 删）
    const cfgList = await this.salaryConfigService
      .listByServiceType('住家保姆')
      .catch(() => []);
    if (cfgList.length > 0) {
      const lines = filterCfgList(cfgList);
      return formatByContext(lines, '住家保姆');
    }
    return '【住家保姆】市场价大概在【4500-8500 元/月】区间，具体看城市和房屋面积~';
  }

  /**
   * 第三道防线：回复后价格校验（2026-08-30 新增）
   * 扫描 LLM 输出中的价格数字，凡不在 salary_config 合理区间内的视为编造，
   * 拦截并换成标准话术；调用方负责打告警日志。
   * 豁免：①无价格数字 ②数字是复述客户自己说的（预算等）
   *       ③含转人工标记（流程即将交人工）④配置表无数据（fail-open）
   */
  public async sanitizeAiPriceReply(
    reply: string,
    currentRequirement: PricingRequirement | null | undefined,
    serviceCity: string | null | undefined,
    historyMessages: Array<{ role: string; content: string }> | undefined,
    isPriceQuestion: boolean,
  ): Promise<{ blocked: boolean; invalidNumbers: number[]; replacement: string | null }> {
    if (/【转人工】|<transfer>/i.test(reply)) {
      return { blocked: false, invalidNumbers: [], replacement: null };
    }
    const numbers = this.extractPriceNumbers(reply);
    if (numbers.length === 0) {
      return { blocked: false, invalidNumbers: [], replacement: null };
    }
    // 复述客户自己说过的数字（如预算）不算编造，跳过（±2% 或 50 元内视为同一数字）
    const customerText = (historyMessages ?? [])
      .filter((m) => m.role === 'customer' || m.role === 'user')
      .map((m) => m.content)
      .join('\n');
    const customerNumbers = this.extractPriceNumbers(customerText);
    const candidates = numbers.filter(
      (n) => !customerNumbers.some((c) => Math.abs(n - c) <= Math.max(c * 0.02, 50)),
    );
    if (candidates.length === 0) {
      return { blocked: false, invalidNumbers: [], replacement: null };
    }
    const intervals = await this.resolveContextIntervals(
      currentRequirement,
      serviceCity,
      historyMessages,
    );
    if (intervals.length === 0) {
      return { blocked: false, invalidNumbers: [], replacement: null };
    }
    // ±5% 容差吸收口语取整（如区间 4550-6499 时说"4500 左右"）
    const invalidNumbers = candidates.filter(
      (n) => !intervals.some(([lo, hi]) => n >= lo * 0.95 && n <= hi * 1.05),
    );
    if (invalidNumbers.length === 0) {
      return { blocked: false, invalidNumbers: [], replacement: null };
    }
    const replacement = isPriceQuestion
      ? await this.buildMarketPriceCanonical(currentRequirement, serviceCity, historyMessages)
      : '具体价格需要根据您的需求和城市来定，我帮您详细了解后给您准确报价~';
    return { blocked: true, invalidNumbers, replacement };
  }

  /** 从文本中提取带金额单位的价格数字（元/块/千/万，含区间写法） */
  public extractPriceNumbers(text: string): number[] {
    const result: number[] = [];
    const re = /(\d+(?:\.\d+)?)\s*(?:[-~～至到]\s*(\d+(?:\.\d+)?)\s*)?(万|千|元|块)/g;
    for (let m = re.exec(text); m !== null; m = re.exec(text)) {
      const unit = m[3] === '万' ? 10000 : m[3] === '千' ? 1000 : 1;
      const first = Number(m[1]) * unit;
      if (!Number.isNaN(first)) result.push(first);
      if (m[2]) {
        const second = Number(m[2]) * unit;
        if (!Number.isNaN(second)) result.push(second);
      }
    }
    return result;
  }

  /** 解析城市档 + 面积（城市兜底链：lead 城市 → 已采集地址 → 客户原话） */
  private resolveTierAndArea(
    currentRequirement: PricingRequirement | null | undefined,
    serviceCity?: string | null,
    historyMessages?: Array<{ role: string; content: string }>,
  ): { cityTier: '一线' | '二线' | '三线' | null; area: '大' | '小' | null } {
    const customerText = (historyMessages ?? [])
      .filter((m) => m.role === 'customer' || m.role === 'user')
      .map((m) => m.content)
      .join('\n');
    let cityTier = detectCityTier(serviceCity);
    if (!cityTier) {
      cityTier = detectCityTier(currentRequirement?.serviceAddress ?? null);
    }
    if (!cityTier) cityTier = detectCityTier(customerText);
    let area: '大' | '小' | null = null;
    const reqArea = currentRequirement?.area?.trim() ?? '';
    if (reqArea) {
      const m = reqArea.match(/(\d{2,4})/);
      if (m) {
        const n = Number(m[1]);
        if (!Number.isNaN(n)) area = n > 120 ? '大' : '小';
      } else if (/大|别墅|复式|大平层/.test(reqArea)) {
        area = '大';
      } else if (/小/.test(reqArea)) {
        area = '小';
      }
    }
    if (!area) area = detectAreaFromText(customerText);
    return { cityTier, area };
  }

  /** 客户上下文（服务类型+城市档+面积）过滤后的有效价格区间集合 */
  private async resolveContextIntervals(
    currentRequirement: PricingRequirement | null | undefined,
    serviceCity: string | null | undefined,
    historyMessages: Array<{ role: string; content: string }> | undefined,
  ): Promise<Array<[number, number]>> {
    const rawType = currentRequirement?.serviceType?.trim() ?? '';
    const serviceType = chineseServiceType(rawType) || rawType;
    const { cityTier, area } = this.resolveTierAndArea(
      currentRequirement,
      serviceCity,
      historyMessages,
    );

    let queryType = '住家保姆';
    if (serviceType && !(serviceType === '住家保姆' || serviceType.includes('住家'))) {
      const otherTypes = ['白班保姆', '月嫂', '育儿保姆', '育儿嫂', '护工', '菲式', '钟点工'];
      const matched = otherTypes.find((t) => serviceType === t || serviceType.includes(t));
      if (matched) {
        queryType = matched === '育儿嫂' ? '育儿保姆' : matched;
      }
    }
    const rows = await this.salaryConfigService.listByServiceType(queryType).catch(() => []);
    if (rows.length === 0) return [];

    let filtered = rows;
    if (queryType === '住家保姆') {
      const areaOk = (cfgAreaType: string): boolean =>
        (area === '大' && cfgAreaType === '大面积') ||
        (area === '小' && cfgAreaType === '小面积');
      if (cityTier && area) {
        filtered = rows.filter((r) => r.cityTier === cityTier && areaOk(r.areaType));
      } else if (cityTier) {
        filtered = rows.filter((r) => r.cityTier === cityTier);
      } else if (area) {
        filtered = rows.filter((r) => areaOk(r.areaType));
      }
    } else {
      filtered = cityTier ? rows.filter((r) => r.cityTier === cityTier) : rows;
    }
    if (filtered.length === 0) filtered = rows;

    return filtered.flatMap((r) => {
      const list: Array<[number, number]> = [[r.baseLow, r.baseHigh]];
      if (r.altLow > 0) list.push([r.altLow, r.altHigh]);
      return list;
    });
  }
}
