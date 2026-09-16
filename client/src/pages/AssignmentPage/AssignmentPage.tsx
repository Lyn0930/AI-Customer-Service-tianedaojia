import React from 'react';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs';
import AgentSkillsTab from './AgentSkillsTab';
import AgentWorkloadTab from './AgentWorkloadTab';
import SalaryConfigTab from './SalaryConfigTab';

const AssignmentPage: React.FC = () => {
  return (
    <div className="p-6 space-y-4">
      <h1 className="text-2xl font-bold text-gray-800">智能路由管理</h1>
      <Tabs defaultValue="skills">
        <TabsList>
          <TabsTrigger value="skills">技能管理</TabsTrigger>
          <TabsTrigger value="workload">负载看板</TabsTrigger>
          <TabsTrigger value="salary">薪资话术</TabsTrigger>
        </TabsList>
        <TabsContent value="skills">
          <AgentSkillsTab />
        </TabsContent>
        <TabsContent value="workload">
          <AgentWorkloadTab />
        </TabsContent>
        <TabsContent value="salary">
          <SalaryConfigTab />
        </TabsContent>
      </Tabs>
    </div>
  );
};

export default AssignmentPage;
