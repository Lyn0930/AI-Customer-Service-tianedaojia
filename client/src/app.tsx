import React from 'react';
import { Route, Routes, Navigate } from 'react-router-dom';

import Layout from './components/Layout';
import NotFound from './pages/NotFound/NotFound';
import LeadsPage from './pages/LeadsPage/LeadsPage';
import LeadDetailPage from './pages/LeadDetailPage/LeadDetailPage';
import ChatSessionsPage from './pages/ChatSessionsPage/ChatSessionsPage';
import CustomerChatPage from './pages/CustomerChatPage/CustomerChatPage';
import AssignmentPage from './pages/AssignmentPage/AssignmentPage';
import RoleSelectPage from './pages/RoleSelectPage/RoleSelectPage';
import DashboardPage from './pages/DashboardPage/DashboardPage';
import AnalyticsPage from './pages/AnalyticsPage/AnalyticsPage';
import CollectLeadPage from './pages/CollectLeadPage/CollectLeadPage';
import AdminPage from './pages/AdminPage/AdminPage';
import WorkersPage from './pages/WorkersPage/WorkersPage';
import WorkerDetailPage from './pages/WorkersPage/WorkerDetailPage';
import AiTestPage from './pages/AiTestPage/AiTestPage';
import { useRole } from './hooks/useRole';

const RoleGuard: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { role } = useRole();
  if (!role) return <Navigate to="/role-select" replace />;
  return <>{children}</>;
};

const IndexRedirect: React.FC = () => {
  const { role } = useRole();
  if (!role) return <Navigate to="/role-select" replace />;
  return <Navigate to={role === 'manager' ? '/dashboard' : '/chat-sessions'} replace />;
};

const RoutesComponent = () => {
  return (
    <Routes>
      <Route path="/role-select" element={<RoleSelectPage />} />
      <Route element={<RoleGuard><Layout /></RoleGuard>}>
        <Route index element={<IndexRedirect />} />
        <Route path="dashboard" element={<DashboardPage />} />
        <Route path="leads" element={<LeadsPage />} />
        <Route path="leads/:id" element={<LeadDetailPage />} />
        <Route path="chat-sessions" element={<ChatSessionsPage />} />
        <Route path="assignments" element={<AssignmentPage />} />
        <Route path="analytics" element={<AnalyticsPage />} />
        <Route path="admin" element={<AdminPage />} />
        <Route path="workers" element={<WorkersPage />} />
        <Route path="workers/:id" element={<WorkerDetailPage />} />
        <Route path="ai-test" element={<AiTestPage />} />
      </Route>
      <Route path="chat/:token" element={<CustomerChatPage />} />
      {/* 公开线索收集入口：6 渠道 × 2 服务类型组 = 12 个 URL 变体 */}
      <Route path="l/collect" element={<CollectLeadPage />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
};

export default RoutesComponent;
