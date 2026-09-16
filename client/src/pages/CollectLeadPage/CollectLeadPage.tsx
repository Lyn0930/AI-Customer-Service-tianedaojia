import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { CheckCircle2, Home, Loader2, MessageCircle, RefreshCw } from 'lucide-react';

import { Button } from '@client/src/components/ui/button';
import { Checkbox } from '@client/src/components/ui/checkbox';
import { Image } from '@client/src/components/ui/image';
import { Input } from '@client/src/components/ui/input';
import { Label } from '@client/src/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@client/src/components/ui/select';
import { Spinner } from '@client/src/components/ui/spinner';
import CitySelector from '@client/src/components/CitySelector/CitySelector';
import { createPublicLead } from '@client/src/api/leads';
import {
  CITY_GROUPS,
  CITY_INDEX_LETTERS,
  SERVICE_CITIES,
  type ServiceCity,
} from '@shared/cities';
import {
  CHANNEL_LABELS,
  SERVICE_TYPE_GROUP_LABELS,
  getServiceTypeOptions,
  parseChannelParam,
  parseGroupParam,
  type Channel,
  type ServiceType,
  type ServiceTypeGroup,
} from '@shared/channels';

/* ============ 表单状态 ============ */

type SubmitStatus = 'idle' | 'submitting' | 'success' | 'error';

/** 保姆报价表图片（妙搭 app storage）—— 所有渠道（小红书/抖音/美团/SEO/APP）共用 */
const PRICE_TABLE_URL =
  '/spark/app/app_17buybqcty0/runtime/api/v1/storage/object/bucket_aadkpgd7eesiq/1873415930346628.png';

const PHONE_REGEX = /^1[3-9]\d{9}$/;

const isValidPhone = (s: string): boolean => PHONE_REGEX.test(s);

/** 从 axios 错误中提取后端返回的具体错误信息 */
const extractApiError = (err: unknown, fallback: string): string => {
  if (err && typeof err === 'object' && 'response' in err) {
    const resp = (err as {
      response?: {
        status?: number;
        data?: {
          error?: {
            message?: string;
            stack?: string;
            cause?: string;
            code?: string | number;
          };
          message?: string | string[];
        };
      };
    }).response;
    const status = resp?.status;
    const errObj = resp?.data?.error;
    const errMsg = errObj?.message;
    const stack = errObj?.stack;
    const cause = errObj?.cause;
    const directMsg = resp?.data?.message;
    const msg = Array.isArray(directMsg) ? directMsg.join('; ') : directMsg;
    const parts: string[] = [];
    parts.push(`[${status ?? '?'}]`);
    if (errMsg) parts.push(errMsg);
    if (msg && msg !== errMsg) parts.push(msg);
    if (cause) parts.push(`cause: ${String(cause).slice(0, 200)}`);
    if (stack) {
      const firstLine = String(stack).split('\n').find((l) => l.trim().length > 0) || '';
      parts.push(`at: ${firstLine.slice(0, 200)}`);
    }
    // 403 大概率是 CSRF 问题，附加诊断信息
    if (status === 403) {
      const hasToken = typeof window !== 'undefined' && !!(window as any).csrfToken;
      const cookieHasToken = typeof document !== 'undefined' && document.cookie.includes('suda-csrf-token');
      parts.push(`(CSRF诊断: window.csrfToken=${hasToken ? '有' : '无'}, cookie=${cookieHasToken ? '有' : '无'})`);
    }
    return parts.join(' | ');
  }
  if (err && typeof err === 'object' && 'request' in err) {
    return '网络无响应，请检查连接';
  }
  return err instanceof Error ? err.message : fallback;
};

/** 把浏览器 GeolocationPosition 解析为最近的城市（粗略：直接拿 City[] 中第一个能匹配经度范围的；POC 简化：默认北京） */
function nearestCityFromCoords(_lat: number, _lng: number): ServiceCity {
  // 简化版：直接返回 null，让用户自己点；后续接入逆地理 API（高德/百度/腾讯）
  // 这里仅作为占位，避免返回不准确城市
  return '北京';
}

/* ============ 页面主体 ============ */

const CollectLeadPage: React.FC = () => {
  const [searchParams] = useSearchParams();

  // 解析 URL 参数
  const channel: Channel | null = useMemo(
    () => parseChannelParam(searchParams.get('channel')),
    [searchParams],
  );
  const group: ServiceTypeGroup | null = useMemo(
    () => parseGroupParam(searchParams.get('group')),
    [searchParams],
  );

  // 表单状态
  const [serviceCity, setServiceCity] = useState<ServiceCity | ''>('');
  const [serviceType, setServiceType] = useState<string>('');
  const [phoneNumber, setPhoneNumber] = useState<string>('');
  const [agreed, setAgreed] = useState<boolean>(false);
  const [submitStatus, setSubmitStatus] = useState<SubmitStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [chatToken, setChatToken] = useState<string>('');

  // 当前定位
  const [detectedCity, setDetectedCity] = useState<ServiceCity | null>(null);
  const [locating, setLocating] = useState<boolean>(false);

  const serviceTypeOptions = group ? getServiceTypeOptions(group) : [];

  // 动态标题（2026-08-10 用户反馈:保姆/月嫂用不同标题）
  const formTitle = group === 'yuesao' ? '找月嫂' : '找保姆';

  // group 自动选中第一个 serviceType（仅月嫂组有 1 个）
  useEffect(() => {
    if (group && serviceTypeOptions.length > 0 && !serviceType) {
      setServiceType(serviceTypeOptions[0].value);
    }
  }, [group, serviceTypeOptions, serviceType]);


  // 浏览器定位
  const requestLocation = useCallback(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setErrorMessage('当前浏览器不支持定位');
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const city = nearestCityFromCoords(pos.coords.latitude, pos.coords.longitude);
        if (SERVICE_CITIES.includes(city as ServiceCity)) {
          setDetectedCity(city as ServiceCity);
        }
        setLocating(false);
      },
      () => {
        setErrorMessage('定位失败，请手动选择城市');
        setLocating(false);
      },
      { timeout: 8000, maximumAge: 60000 },
    );
  }, []);

  // 校验
  const validationError = useMemo<string | null>(() => {
    if (!channel || !group) {
      return '链接参数无效，请确认使用了正确的渠道链接';
    }
    if (!serviceCity) {
      return '请选择服务城市';
    }
    if (!serviceType) {
      return '请选择服务类型';
    }
    if (!isValidPhone(phoneNumber)) {
      return '请输入正确的 11 位手机号';
    }
    if (!agreed) {
      return '请先同意隐私协议';
    }
    return null;
  }, [channel, group, serviceCity, serviceType, phoneNumber, agreed]);

  // 缺参数 / 异常链接：直接展示错误
  if (!channel || !group) {
    return (
      <main className="fixed inset-0 overflow-y-auto flex bg-gradient-to-b from-blue-50 to-white p-6">
        <div className="m-auto max-w-md w-full bg-white rounded-xl shadow-sm border border-gray-200 p-8 text-center">
          <h1 className="text-xl font-semibold text-gray-800 mb-2">链接无效</h1>
          <p className="text-sm text-gray-500">
            请确认使用了正确的渠道链接（应包含 <code className="px-1 bg-gray-100 rounded">channel</code> 与{' '}
            <code className="px-1 bg-gray-100 rounded">group</code> 参数）。
          </p>
        </div>
      </main>
    );
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (validationError) {
      setErrorMessage(validationError);
      return;
    }
    setSubmitStatus('submitting');
    setErrorMessage('');
    try {
      const lead = await createPublicLead({
        serviceCity,
        phoneNumber,
        source: CHANNEL_LABELS[channel],
        serviceTypeGroup: group,
        serviceType: serviceType as ServiceType,
        channel: (channel && ['openapi', 'bitable_form', 'chat', 'phone', 'manual'].includes(channel))
          ? channel as 'openapi' | 'bitable_form' | 'chat' | 'phone' | 'manual' : 'openapi',
      });
      setChatToken(lead.chatToken);
      setSubmitStatus('success');
    } catch (err) {
      setSubmitStatus('error');
      setErrorMessage(extractApiError(err, '提交失败，请稍后再试'));
    }
  };

  // 成功页
  if (submitStatus === 'success') {
    return (
      <main className="fixed inset-0 overflow-y-auto flex bg-gradient-to-b from-blue-50 to-white p-6">
        <div className="m-auto max-w-md w-full bg-white rounded-xl shadow-sm border border-gray-200 p-8 text-center">
          <div className="flex justify-center mb-4">
            <CheckCircle2 className="w-16 h-16 text-green-500" />
          </div>
          <h1 className="text-2xl font-semibold text-gray-800 mb-2">提交成功</h1>
          <p className="text-sm text-gray-500 leading-relaxed">
            我们已收到您的需求，专属顾问会在 30 分钟内联系您。
            <br />
            城市：{serviceCity} · 服务类型：{
              serviceTypeOptions.find((o) => o.value === serviceType)?.label
            }
          </p>
          {chatToken && (
            <Link to={`/chat/${chatToken}`}>
              <Button type="button" className="mt-6 w-full">
                <MessageCircle className="w-4 h-4 mr-2" />
                立即在线咨询
              </Button>
            </Link>
          )}
          <Button
            type="button"
            variant="outline"
            className="mt-3 w-full"
            onClick={() => {
              setSubmitStatus('idle');
              setChatToken('');
              setServiceCity('');
              setServiceType(serviceTypeOptions[0]?.value ?? '');
              setPhoneNumber('');
              setAgreed(false);
              setErrorMessage('');
            }}
          >
            再提交一条
          </Button>
        </div>
      </main>
    );
  }

  return (
    <main className="fixed inset-0 overflow-y-auto bg-gradient-to-b from-blue-50 to-white px-4 py-10">
      <div className="max-w-md mx-auto bg-white rounded-xl shadow-sm border border-gray-200 p-6 sm:p-8">
        {/* 保姆报价表（所有渠道共用）—— 作为 form 顶部门面 */}
        <Image
          src={PRICE_TABLE_URL}
          alt="天鹅到家保姆报价表"
          width={1080}
          height={1440}
          loading="eager"
          className="w-full h-auto rounded-lg shadow-sm border border-gray-100 mb-5 -mt-1 object-cover bg-white"
        />

        {/* 顶部：渠道 + 服务类型组标识 */}
        <div className="mb-6">
          <h1 className="text-2xl font-semibold text-gray-800 leading-tight">
            {formTitle}，<span className="text-blue-600">1 对 1</span> 咨询
          </h1>
          <p className="mt-2 text-sm text-gray-500">
            来源：{CHANNEL_LABELS[channel]} · {SERVICE_TYPE_GROUP_LABELS[group]}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          {/* 服务城市（带定位 + 字母索引） */}
          <div>
            <Label htmlFor="serviceCity" className="text-sm font-medium text-gray-700">
              服务城市 <span className="text-red-500">*</span>
            </Label>
            <CitySelector
              value={serviceCity}
              onChange={(c) => setServiceCity(c)}
              disabled={submitStatus === 'submitting'}
              detectedCity={detectedCity}
              onRequestLocation={requestLocation}
              locating={locating}
            />
          </div>

          {/* 服务类型 */}
          <div>
            <Label htmlFor="serviceType" className="text-sm font-medium text-gray-700">
              服务类型 <span className="text-red-500">*</span>
            </Label>
            {group === 'yuesao' ? (
              // 月嫂组只有 1 个选项，直接展示
              <div className="mt-1.5 px-3 py-2 rounded-md border border-gray-200 bg-gray-50 text-sm text-gray-700">
                26天月嫂
              </div>
            ) : (
              <Select value={serviceType} onValueChange={setServiceType}>
                <SelectTrigger id="serviceType" className="mt-1.5 w-full" disabled={submitStatus === 'submitting'}>
                  <SelectValue placeholder="请选择服务类型" />
                </SelectTrigger>
                <SelectContent>
                  {serviceTypeOptions.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          {/* 手机号 */}
          <div>
            <Label htmlFor="phoneNumber" className="text-sm font-medium text-gray-700">
              手机号 <span className="text-red-500">*</span>
            </Label>
            <Input
              id="phoneNumber"
              type="tel"
              inputMode="numeric"
              maxLength={11}
              placeholder="请输入 11 位手机号"
              className="mt-1.5"
              value={phoneNumber}
              onChange={(e) => setPhoneNumber(e.target.value.replace(/\D/g, ''))}
              disabled={submitStatus === 'submitting'}
            />
          </div>

          {/* 隐私授权 */}
          <div className="flex items-start gap-2.5 pt-1">
            <Checkbox
              id="agreement"
              checked={agreed}
              onCheckedChange={(v) => setAgreed(v === true)}
              disabled={submitStatus === 'submitting'}
              className="mt-0.5"
            />
            <Label htmlFor="agreement" className="text-xs text-gray-500 leading-relaxed cursor-pointer">
              我已阅读并同意{' '}
              <Link to="#" className="text-blue-600 hover:underline">
                《隐私协议》
              </Link>{' '}
              和{' '}
              <Link to="#" className="text-blue-600 hover:underline">
                《服务条款》
              </Link>
              ，授权平台处理我提交的信息以便联系我。
            </Label>
          </div>

          {/* 错误信息 */}
          {errorMessage && (
            <div className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2 break-all">
              {errorMessage}
            </div>
          )}

          {/* 提交按钮 */}
          <Button
            type="submit"
            className="w-full"
            size="lg"
            disabled={submitStatus === 'submitting' || !!validationError}
          >
            {submitStatus === 'submitting' ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                正在提交…
              </>
            ) : (
              '立即提交'
            )}
          </Button>

          <p className="text-center text-xs text-gray-400 pt-2">
            提交即代表您同意平台以电话或短信方式与您联系
          </p>
        </form>
      </div>

      {/* 底部品牌（轻量） */}
      <div className="mt-6 flex items-center justify-center gap-1.5 text-xs text-gray-400">
        <Home className="w-3.5 h-3.5" />
        <span>天鹅到家 · 客服线索收集</span>
      </div>

      {submitStatus === 'submitting' && (
        <div className="fixed inset-0 bg-white/40 backdrop-blur-[1px] flex items-center justify-center z-50">
          <Spinner className="w-8 h-8 text-blue-600" />
        </div>
      )}
    </main>
  );
};

export default CollectLeadPage;
