import React, { useState } from 'react';
import { Settings, MessageSquareText, BookOpen } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@client/src/components/ui/tabs';
import QAKnowledgeTab from './QAKnowledgeTab';
import TestChatTab from './TestChatTab';
import AIConfigTab from './AIConfigTab';

const AdminPage: React.FC = () => {
  const [activeTab, setActiveTab] = useState('qa');

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="border-b bg-white px-6 py-4">
        <div className="flex items-center gap-2">
          <Settings className="h-5 w-5 text-primary" />
          <h1 className="text-xl font-semibold">管理后台</h1>
        </div>
        <p className="mt-1 text-sm text-gray-500">
          管理 QA 知识库、测试 AI 客服效果、配置提示词、同步多维表格
        </p>
      </div>

      <div className="p-6">
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList>
            <TabsTrigger value="qa" className="gap-1.5">
              <BookOpen className="h-4 w-4" />
              QA 知识库
            </TabsTrigger>
            <TabsTrigger value="test" className="gap-1.5">
              <MessageSquareText className="h-4 w-4" />
              测试客服
            </TabsTrigger>
            <TabsTrigger value="config" className="gap-1.5">
              <Settings className="h-4 w-4" />
              AI 配置
            </TabsTrigger>
          </TabsList>
          <TabsContent value="qa" className="mt-4">
            <QAKnowledgeTab />
          </TabsContent>
          <TabsContent value="test" className="mt-4">
            <TestChatTab />
          </TabsContent>
          <TabsContent value="config" className="mt-4">
            <AIConfigTab />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
};

export default AdminPage;
