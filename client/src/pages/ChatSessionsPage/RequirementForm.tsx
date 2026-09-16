import React, { useState, useMemo } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { CheckCircle2, Loader2, FileText, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@client/src/components/ui/button';
import { Input } from '@client/src/components/ui/input';
import { Checkbox } from '@client/src/components/ui/checkbox';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@client/src/components/ui/form';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@client/src/components/ui/select';
import { submitForm, submitFormByToken } from '@client/src/api/chat';
import type { FormSubmitRequest } from '@shared/api.interface';

const HOUSEHOLD_OPTIONS = [
  { value: '1', label: '1 口人' },
  { value: '2', label: '2 口人' },
  { value: '3', label: '3 口人' },
  { value: '4', label: '4 口人' },
  { value: '5', label: '5 口人及以上' },
];
const PET_OPTIONS = ['没有宠物', '有（猫）', '有（狗）', '有（其他）'];
const ELDERLY_CARE_OPTIONS = ['能自理', '半自理', '不能自理'];
const CHILD_CARE_OPTIONS = ['宝宝 0-1 岁', '宝宝 1-3 岁', '宝宝 3-6 岁', '孩子 6 岁以上'];
const REST_DAYS_OPTIONS = ['月休 2 天', '月休 4 天'];
const START_TIME_OPTIONS = ['尽快到岗', '一周内到岗', '两周内到岗', '一个月内到岗', '时间还不确定'];

const requirementSchema = z
  .object({
    householdSize: z.string().min(1, '请选择家庭人口'),
    area: z.string().min(1, '请输入面积'),
    hasPet: z.string().min(1, '请选择宠物情况'),
    needElderlyCare: z.boolean(),
    elderlyCareLevel: z.string().optional(),
    needChildCare: z.boolean(),
    childCareAge: z.string().optional(),
    restDays: z.string().optional(),
    startTime: z.string().min(1, '请选择到岗时间'),
    serviceAddress: z.string().min(1, '请输入服务地址'),
  })
  .superRefine((data, ctx) => {
    if (data.needElderlyCare && !data.elderlyCareLevel) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['elderlyCareLevel'],
        message: '请选择老人身体状况',
      });
    }
    if (data.needChildCare && !data.childCareAge) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['childCareAge'],
        message: '请选择孩子年龄',
      });
    }
  });

type RequirementFormData = z.infer<typeof requirementSchema>;

interface RequirementFormProps {
  sessionId?: string;
  token?: string;
  serviceType: string;
  submitted: boolean;
  onSubmitted?: () => void;
}

const RequirementForm: React.FC<RequirementFormProps> = ({
  sessionId,
  token,
  serviceType,
  submitted,
  onSubmitted,
}) => {
  const [submitting, setSubmitting] = useState(false);

  const form = useForm<RequirementFormData>({
    resolver: zodResolver(requirementSchema),
    defaultValues: {
      householdSize: '',
      area: '',
      hasPet: '',
      needElderlyCare: false,
      elderlyCareLevel: '',
      needChildCare: false,
      childCareAge: '',
      restDays: '',
      startTime: '',
      serviceAddress: '',
    },
  });

  const onSubmit = async (values: RequirementFormData) => {
    setSubmitting(true);
    try {
      const formData: FormSubmitRequest = {
        householdSize: values.householdSize,
        area: values.area,
        hasPet: values.hasPet,
        elderlyCare: values.needElderlyCare ? values.elderlyCareLevel! : '不需要',
        childCare: values.needChildCare ? values.childCareAge! : '不需要',
        restDays: values.restDays || '',
        startTime: values.startTime,
        serviceAddress: values.serviceAddress,
      };
      if (token) {
        await submitFormByToken(token, formData);
      } else if (sessionId) {
        await submitForm(sessionId, formData);
      } else {
        throw new Error('缺少会话标识');
      }
      toast.success('表单提交成功');
      onSubmitted?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '提交失败');
    } finally {
      setSubmitting(false);
    }
  };

  const requiredFields = ['householdSize', 'area', 'hasPet', 'startTime', 'serviceAddress'];
  const { watch } = form;
  const watchedValues = watch();
  const progress = useMemo(() => {
    let filled = 0;
    let total = requiredFields.length;
    if (watchedValues.householdSize) filled++;
    if (watchedValues.area && String(watchedValues.area).trim()) filled++;
    if (watchedValues.hasPet) filled++;
    if (watchedValues.startTime) filled++;
    if (watchedValues.serviceAddress && String(watchedValues.serviceAddress).trim()) filled++;
    if (watchedValues.needElderlyCare) {
      total += 1;
      if (watchedValues.elderlyCareLevel) filled++;
    }
    if (watchedValues.needChildCare) {
      total += 1;
      if (watchedValues.childCareAge) filled++;
    }
    return { filled, total };
  }, [watchedValues]);

  if (submitted) {
    return (
      <div className="w-full max-w-md bg-gradient-to-br from-green-50 to-emerald-50 border border-green-200 rounded-2xl shadow-sm overflow-hidden">
        <div className="px-5 py-4 flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-green-100 flex items-center justify-center flex-shrink-0">
            <CheckCircle2 className="w-5 h-5 text-green-600" />
          </div>
          <div className="flex-1">
            <div className="text-sm font-semibold text-green-800">需求表单已提交</div>
            <div className="text-xs text-green-600 mt-0.5">我们会尽快为您匹配合适的阿姨～</div>
          </div>
        </div>
      </div>
    );
  }

  const disabled = submitting;

  return (
    <div className="w-full max-w-md bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden">
      {/* 顶部标题区 */}
      <div className="px-5 py-4 bg-gradient-to-r from-primary/5 to-primary/10 border-b border-gray-100">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
            <FileText className="w-4 h-4 text-primary" />
          </div>
          <div className="flex-1">
            <div className="text-sm font-semibold text-gray-900">{serviceType}需求采集</div>
            <div className="text-xs text-gray-500 mt-0.5">填写基本信息，帮您更快匹配阿姨</div>
          </div>
        </div>
      </div>

      {/* 表单内容区 */}
      <div className="px-5 py-4 space-y-4">
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            {/* 服务说明 */}
            <div className="bg-gradient-to-br from-amber-50 to-orange-50 border border-amber-100 rounded-xl px-4 py-3">
              <div className="text-sm font-semibold text-amber-900 mb-1.5">服务说明</div>
              <div className="text-xs leading-relaxed text-amber-800">
                住家保姆 24 小时住家服务，负责家务、做饭、照顾老人小孩，月休 2-4 天。
                具体价格会根据您所在城市调整，人工客服后续会给准确报价。
              </div>
            </div>
            {/* 家庭信息分组 */}
            <div className="space-y-3">
              <div className="text-xs font-medium text-gray-400 uppercase tracking-wider">家庭信息</div>
              <div className="grid grid-cols-2 gap-3">
                <FormField
                  control={form.control}
                  name="householdSize"
                  render={({ field }) => (
                    <FormItem className="space-y-1.5">
                      <FormLabel className="text-xs font-medium text-gray-600">
                        家庭人口 <span className="text-destructive">*</span>
                      </FormLabel>
                      <Select
                        onValueChange={field.onChange}
                        defaultValue={field.value}
                        disabled={disabled}
                      >
                        <FormControl>
                          <SelectTrigger className="h-9 text-sm">
                            <SelectValue placeholder="请选择" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {HOUSEHOLD_OPTIONS.map((opt) => (
                            <SelectItem key={opt.value} value={opt.value} className="text-sm">
                              {opt.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage className="text-xs" />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="area"
                  render={({ field }) => (
                    <FormItem className="space-y-1.5">
                      <FormLabel className="text-xs font-medium text-gray-600">
                        面积 <span className="text-destructive">*</span>
                      </FormLabel>
                      <FormControl>
                        <div className="relative">
                          <Input
                            type="number"
                            placeholder="如 90"
                            disabled={disabled}
                            className="h-9 text-sm pr-10"
                            {...field}
                          />
                          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400">㎡</span>
                        </div>
                      </FormControl>
                      <FormMessage className="text-xs" />
                    </FormItem>
                  )}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <FormField
                  control={form.control}
                  name="hasPet"
                  render={({ field }) => (
                    <FormItem className="space-y-1.5">
                      <FormLabel className="text-xs font-medium text-gray-600">
                        宠物 <span className="text-destructive">*</span>
                      </FormLabel>
                      <Select
                        onValueChange={field.onChange}
                        defaultValue={field.value}
                        disabled={disabled}
                      >
                        <FormControl>
                          <SelectTrigger className="h-9 text-sm">
                            <SelectValue placeholder="请选择" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {PET_OPTIONS.map((opt) => (
                            <SelectItem key={opt} value={opt} className="text-sm">
                              {opt}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage className="text-xs" />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="restDays"
                  render={({ field }) => (
                    <FormItem className="space-y-1.5">
                      <FormLabel className="text-xs font-medium text-gray-600">月休天数</FormLabel>
                      <Select
                        onValueChange={field.onChange}
                        defaultValue={field.value}
                        disabled={disabled}
                      >
                        <FormControl>
                          <SelectTrigger className="h-9 text-sm">
                            <SelectValue placeholder="选填" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {REST_DAYS_OPTIONS.map((opt) => (
                            <SelectItem key={opt} value={opt} className="text-sm">
                              {opt}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage className="text-xs" />
                    </FormItem>
                  )}
                />
              </div>
            </div>

            {/* 照护需求分组 */}
            <div className="space-y-3">
              <div className="text-xs font-medium text-gray-400 uppercase tracking-wider">照护需求</div>
              <div className="space-y-2.5">
                <FormField
                  control={form.control}
                  name="needElderlyCare"
                  render={({ field }) => (
                    <FormItem className="flex flex-row items-center gap-2.5 space-y-0 p-3 bg-gray-50 rounded-xl border border-gray-100">
                      <FormControl>
                        <Checkbox
                          checked={field.value}
                          onCheckedChange={field.onChange}
                          disabled={disabled}
                          className="data-[state=checked]:bg-primary data-[state=checked]:border-primary"
                        />
                      </FormControl>
                      <div className="space-y-0.5 leading-none flex-1">
                        <FormLabel className="text-sm font-medium text-gray-700 cursor-pointer">需要照护老人</FormLabel>
                        <p className="text-xs text-gray-400">勾选后请选择老人身体状况</p>
                      </div>
                    </FormItem>
                  )}
                />
                {form.watch('needElderlyCare') && (
                  <FormField
                    control={form.control}
                    name="elderlyCareLevel"
                    render={({ field }) => (
                      <FormItem className="space-y-1.5 ml-6">
                        <FormLabel className="text-xs font-medium text-gray-600">
                          老人身体状况 <span className="text-destructive">*</span>
                        </FormLabel>
                        <Select
                          onValueChange={field.onChange}
                          defaultValue={field.value}
                          disabled={disabled}
                        >
                          <FormControl>
                            <SelectTrigger className="h-9 text-sm">
                              <SelectValue placeholder="请选择" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {ELDERLY_CARE_OPTIONS.map((opt) => (
                              <SelectItem key={opt} value={opt} className="text-sm">
                                {opt}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage className="text-xs" />
                      </FormItem>
                    )}
                  />
                )}
                <FormField
                  control={form.control}
                  name="needChildCare"
                  render={({ field }) => (
                    <FormItem className="flex flex-row items-center gap-2.5 space-y-0 p-3 bg-gray-50 rounded-xl border border-gray-100">
                      <FormControl>
                        <Checkbox
                          checked={field.value}
                          onCheckedChange={field.onChange}
                          disabled={disabled}
                          className="data-[state=checked]:bg-primary data-[state=checked]:border-primary"
                        />
                      </FormControl>
                      <div className="space-y-0.5 leading-none flex-1">
                        <FormLabel className="text-sm font-medium text-gray-700 cursor-pointer">需要照护小孩</FormLabel>
                        <p className="text-xs text-gray-400">勾选后请选择孩子年龄</p>
                      </div>
                    </FormItem>
                  )}
                />
                {form.watch('needChildCare') && (
                  <FormField
                    control={form.control}
                    name="childCareAge"
                    render={({ field }) => (
                      <FormItem className="space-y-1.5 ml-6">
                        <FormLabel className="text-xs font-medium text-gray-600">
                          孩子年龄 <span className="text-destructive">*</span>
                        </FormLabel>
                        <Select
                          onValueChange={field.onChange}
                          defaultValue={field.value}
                          disabled={disabled}
                        >
                          <FormControl>
                            <SelectTrigger className="h-9 text-sm">
                              <SelectValue placeholder="请选择" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {CHILD_CARE_OPTIONS.map((opt) => (
                              <SelectItem key={opt} value={opt} className="text-sm">
                                {opt}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage className="text-xs" />
                      </FormItem>
                    )}
                  />
                )}
              </div>
            </div>

            {/* 到岗信息分组 */}
            <div className="space-y-3">
              <div className="text-xs font-medium text-gray-400 uppercase tracking-wider">到岗信息</div>
              <div className="space-y-3">
                <FormField
                  control={form.control}
                  name="startTime"
                  render={({ field }) => (
                    <FormItem className="space-y-1.5">
                      <FormLabel className="text-xs font-medium text-gray-600">
                        到岗时间 <span className="text-destructive">*</span>
                      </FormLabel>
                      <Select
                        onValueChange={field.onChange}
                        defaultValue={field.value}
                        disabled={disabled}
                      >
                        <FormControl>
                          <SelectTrigger className="h-9 text-sm">
                            <SelectValue placeholder="请选择" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {START_TIME_OPTIONS.map((opt) => (
                            <SelectItem key={opt} value={opt} className="text-sm">
                              {opt}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage className="text-xs" />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="serviceAddress"
                  render={({ field }) => (
                    <FormItem className="space-y-1.5">
                      <FormLabel className="text-xs font-medium text-gray-600">
                        服务地址 <span className="text-destructive">*</span>
                      </FormLabel>
                      <FormControl>
                        <Input
                          placeholder="如 朝阳区望京街道"
                          disabled={disabled}
                          className="h-9 text-sm"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage className="text-xs" />
                    </FormItem>
                  )}
                />
              </div>
            </div>

            {/* 提交按钮 */}
            <Button
              type="submit"
              disabled={disabled}
              className="w-full h-10 text-sm font-medium shadow-sm hover:shadow transition-shadow"
            >
              {submitting ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  提交中...
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4 mr-1.5" />
                  提交需求
                </>
              )}
            </Button>
          </form>
        </Form>
      </div>
    </div>
  );
};

export default RequirementForm;
