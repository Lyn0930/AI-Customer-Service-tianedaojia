import { useState } from 'react';
import { FlaskConical, Loader2, CheckCircle2, XCircle, Info } from 'lucide-react';
import { toast } from 'sonner';
import { logger } from '@lark-apaas/client-toolkit/logger';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@client/src/components/ui/card';
import { Button } from '@client/src/components/ui/button';
import { Input } from '@client/src/components/ui/input';
import { Badge } from '@client/src/components/ui/badge';
import { aiTestApi } from '@client/src/api';
import type { AiTestKind, AiTestResponse } from '@shared/api.interface';

const DEFAULT_INPUT = '你们阿姨一个月多少钱？';

const AI_INTENT_ENUM: string[] = [
  'transfer_human',
  'market_price',
  'service_scope',
  'none',
];

const TEST_BUTTONS: { kind: AiTestKind; label: string; desc: string }[] = [
  {
    kind: 'independent',
    label: '独立调用测试',
    desc: 'system prompt=「你是测试助手」，用户消息=输入框文字',
  },
  {
    kind: 'json_format',
    label: 'JSON 格式测试',
    desc: 'prompt 末尾追加「只输出 JSON…」，前端 JSON.parse 校验',
  },
  {
    kind: 'enum_lock',
    label: '枚举锁死测试',
    desc: 'textToJson 实例 schema 把 intent 锁在 6 个枚举值内',
  },
  {
    kind: 'instruction',
    label: '指令可控测试',
    desc: 'system prompt=「你是一只猫…结尾加喵」，用户消息固定「你是谁」',
  },
];

const TEST_LABELS: Record<AiTestKind, string> = {
  independent: '独立调用测试',
  json_format: 'JSON 格式测试',
  enum_lock: '枚举锁死测试',
  instruction: '指令可控测试',
  budget_caliber: '预算口径测试',
  swan_reply: '小书人设回复测试',
};

type VerdictTone = 'pass' | 'fail' | 'info';

interface Verdict {
  tone: VerdictTone;
  title: string;
  detail?: string;
}

interface ParseResult {
  ok: boolean;
  value?: unknown;
  error?: string;
}

function safeParseJson(raw: string): ParseResult {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function computeVerdict(result: AiTestResponse): Verdict {
  if (result.error) {
    return { tone: 'fail', title: 'AI 调用报错', detail: result.error };
  }
  if (result.test === 'independent') {
    if (!result.raw.trim()) {
      return {
        tone: 'fail',
        title: '返回空白',
        detail: '不能独立调用：L2 只能并入现有那次 AI 调用（架构小改）',
      };
    }
    return {
      tone: 'pass',
      title: 'AI 已回复，能独立调用',
      detail: 'L2 可做成独立一层（最优路线，图纸照走）',
    };
  }
  if (result.test === 'json_format') {
    const parsed: ParseResult = safeParseJson(result.raw);
    if (parsed.ok) {
      return {
        tone: 'pass',
        title: 'JSON.parse 解析成功',
        detail: '基础版 JSON 可用（配合代码白名单校验即可）',
      };
    }
    const startsWithJson: boolean = result.raw.trim().startsWith('{');
    return {
      tone: 'fail',
      title: 'JSON.parse 解析失败',
      detail: startsWithJson
        ? `解析错误：${parsed.error ?? ''}`
        : '返回夹了前言/后语等废话才解析失败 → 需要开平台 JSON mode 参数（response_format），或靠代码从整段里抠出 JSON',
    };
  }
  if (result.test === 'enum_lock') {
    const parsed: ParseResult = safeParseJson(result.raw);
    if (!parsed.ok) {
      return { tone: 'fail', title: '返回不是合法 JSON', detail: parsed.error };
    }
    const intent: unknown = (parsed.value as { intent?: unknown }).intent;
    if (typeof intent === 'string' && AI_INTENT_ENUM.includes(intent)) {
      return {
        tone: 'pass',
        title: `intent=${intent}，在枚举范围内`,
        detail: '枚举锁死生效（严格版）：L2 代码可写得最薄',
      };
    }
    return {
      tone: 'fail',
      title: `intent=${String(intent)}，超出枚举范围`,
      detail: '基础版：代码必须加白名单校验兜底（方案早已预留）',
    };
  }
  if (result.raw.includes('喵')) {
    return {
      tone: 'pass',
      title: '回复带「喵」，system prompt 生效',
      detail: 'L2 的分类规则可以完整塞进 prompt',
    };
  }
  return {
    tone: 'fail',
    title: '回复不带「喵」，指令未生效',
    detail: '该调用方式控制不了指令，需要另找入口（如对话人设配置）',
  };
}

const TONE_BADGE_CLASS: Record<VerdictTone, string> = {
  pass: 'border-transparent bg-green-100 text-green-700',
  fail: 'border-transparent bg-red-100 text-red-700',
  info: 'border-transparent bg-blue-100 text-blue-700',
};

const AiTestPage = () => {
  const [input, setInput] = useState<string>(DEFAULT_INPUT);
  const [running, setRunning] = useState<AiTestKind | null>(null);
  const [result, setResult] = useState<AiTestResponse | null>(null);

  const handleRun = async (kind: AiTestKind): Promise<void> => {
    if (running) return;
    setRunning(kind);
    try {
      const res: AiTestResponse = await aiTestApi.runAiTest({ test: kind, input });
      setResult(res);
    } catch (error) {
      logger.error('AI 实测请求失败', error);
      toast.error(
        `请求失败：${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setRunning(null);
    }
  };

  const verdict: Verdict | null = result ? computeVerdict(result) : null;
  const parsedResult: ParseResult | null =
    result && (result.test === 'json_format' || result.test === 'enum_lock')
      ? safeParseJson(result.raw)
      : null;

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-4">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <FlaskConical className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <h1 className="text-lg font-semibold text-gray-900">AI 能力最小实测</h1>
          <p className="text-xs text-gray-500 truncate">
            阶段三「L2 语义检测层」前置验证 · 仅测试环境手动点，不连真实客户会话
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">测试输入</CardTitle>
          <CardDescription>
            前三个测试用输入框文字作为用户消息；指令可控测试固定发送「你是谁」
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="输入要测试的客户消息"
          />
          <div className="grid grid-cols-2 gap-3" data-ai-section-type="button">
            {TEST_BUTTONS.map((item) => (
              <div key={item.kind} className="space-y-1.5">
                <Button
                  variant="outline"
                  className="w-full"
                  disabled={running !== null}
                  onClick={() => handleRun(item.kind)}
                >
                  {running === item.kind ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : null}
                  {item.label}
                </Button>
                <p className="text-xs text-gray-500 leading-relaxed">{item.desc}</p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {result && verdict ? (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <CardTitle className="text-base">{TEST_LABELS[result.test]} · 结果</CardTitle>
              <Badge variant="outline" className={TONE_BADGE_CLASS[verdict.tone]}>
                {verdict.tone === 'pass' ? '通过' : '不通过'}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div
              className={`flex items-start gap-2 rounded-md border p-3 text-sm ${
                verdict.tone === 'pass'
                  ? 'border-green-200 bg-green-50 text-green-800'
                  : verdict.tone === 'fail'
                    ? 'border-red-200 bg-red-50 text-red-800'
                    : 'border-blue-200 bg-blue-50 text-blue-800'
              }`}
            >
              {verdict.tone === 'pass' ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
              ) : verdict.tone === 'fail' ? (
                <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
              ) : (
                <Info className="mt-0.5 h-4 w-4 shrink-0" />
              )}
              <div className="min-w-0">
                <div className="font-medium">{verdict.title}</div>
                {verdict.detail ? (
                  <div className="mt-0.5 text-xs leading-relaxed break-words">
                    {verdict.detail}
                  </div>
                ) : null}
              </div>
            </div>

            {result.platformNote ? (
              <div className="flex items-start gap-2 rounded-md border border-blue-200 bg-blue-50 p-3 text-xs leading-relaxed text-blue-800 break-words">
                <Info className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{result.platformNote}</span>
              </div>
            ) : null}

            <div className="space-y-1.5">
              <div className="text-xs font-medium text-gray-500">本次实际调用参数</div>
              <div className="rounded-md bg-gray-50 border border-gray-200 p-3 space-y-1 text-xs text-gray-700">
                <div className="break-words">
                  <span className="text-gray-400">system prompt：</span>
                  {result.systemPrompt}
                </div>
                <div className="break-words">
                  <span className="text-gray-400">用户消息：</span>
                  {result.userMessage}
                </div>
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="text-xs font-medium text-gray-500">AI 原文返回</div>
              {result.error ? (
                <div className="rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-700 break-words">
                  {result.error}
                </div>
              ) : (
                <pre className="rounded-md border border-gray-200 bg-gray-50 p-3 text-xs text-gray-800 whitespace-pre-wrap break-words max-h-80 overflow-y-auto">
                  {result.raw || '（空返回）'}
                </pre>
              )}
            </div>

            <div className="space-y-1.5">
              <div className="text-xs font-medium text-gray-500">代码解析结果</div>
              {result.test === 'independent' ? (
                <div className="rounded-md border border-gray-200 p-3 text-xs text-gray-500">
                  本测试无需 JSON.parse，上方原文即 AI 直接返回的文本
                </div>
              ) : result.test === 'instruction' ? (
                <div className="rounded-md border border-gray-200 p-3 text-xs text-gray-700">
                  校验「回复是否包含喵」：
                  <span
                    className={
                      result.raw.includes('喵')
                        ? 'ml-1 font-medium text-green-700'
                        : 'ml-1 font-medium text-red-700'
                    }
                  >
                    {result.raw.includes('喵') ? '包含' : '不包含'}
                  </span>
                </div>
              ) : parsedResult ? (
                parsedResult.ok ? (
                  <pre className="rounded-md border border-green-200 bg-green-50 p-3 text-xs text-green-800 whitespace-pre-wrap break-words">
                    {`解析成功：\n${JSON.stringify(parsedResult.value, null, 2)}`}
                  </pre>
                ) : (
                  <div className="rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-700 break-words">
                    {`解析失败：${parsedResult.error ?? ''}`}
                  </div>
                )
              ) : null}
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="rounded-lg border border-dashed border-gray-300 p-8 text-center text-sm text-gray-400">
          点击上方任一按钮发起一次后端 AI 调用，结果显示在这里
        </div>
      )}
    </div>
  );
};

export default AiTestPage;
