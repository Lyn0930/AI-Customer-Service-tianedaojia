import React, { useEffect, useState } from 'react';
import { Save, RotateCcw, Info } from 'lucide-react';
import { toast } from 'sonner';
import type { AIConfigItem } from '@shared/api.interface';
import { getAiConfig, updateAiConfig } from '@client/src/api/admin';
import { Button } from '@client/src/components/ui/button';
import { Input } from '@client/src/components/ui/input';
import { Textarea } from '@client/src/components/ui/textarea';
import { Spinner } from '@client/src/components/ui/spinner';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@client/src/components/ui/card';

const TEXTAREA_CONFIGS = ['swan_persona'];
const NUMBER_CONFIGS = ['extraction_interval', 'max_history_messages'];
const JSON_CONFIGS = ['notification_receivers'];

const CONFIG_LABELS: Record<string, string> = {
  swan_persona: 'AI 人设提示词（代码为事实源，每次部署自动覆盖，仅应急热修用）',
  extraction_interval: '需求提取间隔（轮）',
  max_history_messages: '对话历史最大条数',
  ai_reply_plugin_id: 'AI 对话回复插件 ID',
  requirement_extraction_plugin_id: '需求提取插件 ID',
  notification_receivers: '飞书通知接收人（逗号分隔）',
};

const AIConfigTab: React.FC = () => {
  const [configs, setConfigs] = useState<Record<string, string>>({});
  const [originalConfigs, setOriginalConfigs] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadConfigs();
  }, []);

  const loadConfigs = async () => {
    setLoading(true);
    try {
      const data = await getAiConfig();
      const map: Record<string, string> = {};
      for (const item of data) {
        if (JSON_CONFIGS.includes(item.key)) {
          try {
            const parsed = JSON.parse(item.value) as string[];
            map[item.key] = Array.isArray(parsed) ? parsed.join(', ') : item.value;
          } catch {
            map[item.key] = item.value;
          }
        } else {
          map[item.key] = item.value;
        }
      }
      setConfigs(map);
      setOriginalConfigs({ ...map });
    } catch {
      toast.error('加载配置失败');
    } finally {
      setLoading(false);
    }
  };

  const hasChanges = Object.keys(configs).some(
    (key) => configs[key] !== originalConfigs[key],
  );

  const handleSave = async () => {
    setSaving(true);
    try {
      const items = Object.entries(configs).map(([key, value]) => {
        if (JSON_CONFIGS.includes(key)) {
          const arr = value
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
          return { key, value: JSON.stringify(arr) };
        }
        return { key, value };
      });

      await updateAiConfig({ configs: items });
      setOriginalConfigs({ ...configs });
      toast.success('配置已保存，将在下次 AI 调用时生效');
    } catch {
      toast.error('保存配置失败');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    setConfigs({ ...originalConfigs });
  };

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <Spinner className="h-6 w-6" />
      </div>
    );
  }

  const configKeys = Object.keys(configs).sort();

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2 rounded-lg border border-blue-200 bg-blue-50 p-3">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-blue-500" />
        <div className="text-sm text-blue-700">
          修改提示词和运行参数后点击保存，配置将在下次 AI 调用时生效。
          模型参数（temperature、maxTokens、modelID）在插件实例 JSON 中配置，此处不可修改。
        </div>
      </div>

      {TEXTAREA_CONFIGS.map((key) =>
        configs[key] !== undefined ? (
          <Card key={key}>
            <CardHeader>
              <CardTitle className="text-sm">{CONFIG_LABELS[key] || key}</CardTitle>
            </CardHeader>
            <CardContent>
              <Textarea
                value={configs[key]}
                onChange={(e) =>
                  setConfigs((prev) => ({ ...prev, [key]: e.target.value }))
                }
                rows={key === 'swan_persona' ? 12 : 4}
                className="resize-y font-mono text-sm"
              />
            </CardContent>
          </Card>
        ) : null,
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">运行参数</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4">
            {NUMBER_CONFIGS.map((key) =>
              configs[key] !== undefined ? (
                <div key={key}>
                  <label className="mb-1 block text-sm font-medium text-gray-700">
                    {CONFIG_LABELS[key] || key}
                  </label>
                  <Input
                    type="number"
                    value={configs[key]}
                    onChange={(e) =>
                      setConfigs((prev) => ({ ...prev, [key]: e.target.value }))
                    }
                  />
                </div>
              ) : null,
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">插件配置</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {['ai_reply_plugin_id', 'requirement_extraction_plugin_id'].map((key) =>
              configs[key] !== undefined ? (
                <div key={key}>
                  <label className="mb-1 block text-sm font-medium text-gray-700">
                    {CONFIG_LABELS[key] || key}
                  </label>
                  <Input
                    value={configs[key]}
                    onChange={(e) =>
                      setConfigs((prev) => ({ ...prev, [key]: e.target.value }))
                    }
                    className="font-mono text-sm"
                  />
                </div>
              ) : null,
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">通知配置</CardTitle>
        </CardHeader>
        <CardContent>
          {JSON_CONFIGS.map((key) =>
            configs[key] !== undefined ? (
              <div key={key}>
                <label className="mb-1 block text-sm font-medium text-gray-700">
                  {CONFIG_LABELS[key] || key}
                </label>
                <Input
                  value={configs[key]}
                  onChange={(e) =>
                    setConfigs((prev) => ({ ...prev, [key]: e.target.value }))
                  }
                  placeholder="user_id_1, user_id_2"
                />
                <p className="mt-1 text-xs text-gray-400">
                  多个接收人用英文逗号分隔
                </p>
              </div>
            ) : null,
          )}
        </CardContent>
      </Card>

      <div className="flex gap-3">
        <Button onClick={handleSave} disabled={saving || !hasChanges} className="gap-1.5">
          <Save className="h-4 w-4" />
          {saving ? '保存中...' : '保存配置'}
        </Button>
        <Button
          variant="outline"
          onClick={handleReset}
          disabled={!hasChanges || saving}
          className="gap-1.5"
        >
          <RotateCcw className="h-4 w-4" />
          撤销修改
        </Button>
      </div>
    </div>
  );
};

export default AIConfigTab;
