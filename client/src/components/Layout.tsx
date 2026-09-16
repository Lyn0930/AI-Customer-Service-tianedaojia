import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import {
  MessageSquareText,
  ListChecks,
  UserCog,
  LayoutDashboard,
  BarChart3,
  Settings,
  LogOut,
  Users,
  FlaskConical,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { useRole } from '../hooks/useRole';
import AgentOnlineToggle from '../pages/AssignmentPage/AgentOnlineToggle';
import { useCurrentUserProfile } from '@lark-apaas/client-toolkit/hooks/useCurrentUserProfile';
import { UserDisplay } from './business-ui/user-display';
import { Image } from './ui/image';

interface NavItem {
  to: string;
  label: string;
  icon: typeof ListChecks;
  end: boolean;
  roles: ('manager' | 'agent')[];
}

const allNavItems: NavItem[] = [
  { to: '/dashboard', label: '数据概览', icon: LayoutDashboard, end: false, roles: ['manager'] },
  { to: '/leads', label: '线索管理', icon: ListChecks, end: false, roles: ['manager', 'agent'] },
  { to: '/chat-sessions', label: '会话监控', icon: MessageSquareText, end: false, roles: ['manager', 'agent'] },
  { to: '/assignments', label: '客服分配', icon: UserCog, end: false, roles: ['manager'] },
  { to: '/analytics', label: '经营分析', icon: BarChart3, end: false, roles: ['manager'] },
  { to: '/workers', label: '劳动者管理', icon: Users, end: false, roles: ['manager'] },
  { to: '/admin', label: '管理后台', icon: Settings, end: false, roles: ['manager'] },
  { to: '/ai-test', label: 'AI 实测', icon: FlaskConical, end: false, roles: ['manager'] },
];

const SIDEBAR_EXPANDED = 248;
const SIDEBAR_COLLAPSED = 64;

const SWAN_LOGO_URL =
  '/spark/app/app_17buybqcty0/runtime/api/v1/storage/object/bucket_aadkpgd7eesiq_static/static%2Faadksk2p22stu_ve_miaoda';

const Layout = () => {
  const { role, clearRole } = useRole();
  const navigate = useNavigate();
  const userInfo = useCurrentUserProfile();
  const [collapsed, setCollapsed] = useState(false);

  const navItems = allNavItems.filter(
    (item) => role && item.roles.includes(role),
  );

  const handleSwitchRole = () => {
    clearRole();
    navigate('/role-select');
  };

  const isManager = role === 'manager';

  return (
    <div className="flex w-full h-full bg-gray-50">
      <aside
        className="relative shrink-0 bg-white border-r border-gray-200 flex flex-col"
        style={{ width: collapsed ? SIDEBAR_COLLAPSED : SIDEBAR_EXPANDED, transition: 'width 300ms ease-out' }}
      >
        {/* 顶部 Logo 区 */}
        <div
          className={`relative flex items-center shrink-0 ${
            collapsed ? 'justify-center' : ''
          }`}
          style={{ height: 64, paddingLeft: collapsed ? 0 : 24, paddingRight: collapsed ? 0 : 24 }}
        >
          {collapsed ? (
            <Image
              src={SWAN_LOGO_URL}
              width={32}
              height={32}
              alt="天鹅到家线索系统"
            />
          ) : (
            <div className="flex items-center gap-3">
              <Image
                src={SWAN_LOGO_URL}
                width={28}
                height={28}
                alt="天鹅到家线索系统"
                className="shrink-0"
              />
              <span className="text-[18px] font-bold text-gray-900 truncate">
                天鹅到家线索系统
              </span>
            </div>
          )}

          {/* 折叠切换按钮 — 顶部右侧悬垂 */}
          <button
            type="button"
            onClick={() => setCollapsed((v) => !v)}
            className="absolute flex items-center justify-center text-gray-400 hover:text-gray-600 bg-white border border-gray-200 rounded-full shadow-sm hover:shadow transition-all"
            style={{
              top: '50%',
              right: -12,
              transform: 'translateY(-50%)',
              width: 24,
              height: 24,
              zIndex: 10,
            }}
            title={collapsed ? '展开侧边栏' : '收起侧边栏'}
          >
            {collapsed ? (
              <ChevronRight className="w-3.5 h-3.5" />
            ) : (
              <ChevronLeft className="w-3.5 h-3.5" />
            )}
          </button>
        </div>

        {/* 导航区（无边框分割） */}
        <nav
          className="flex-1 overflow-y-auto"
          style={{ paddingTop: 8, paddingBottom: 8, paddingLeft: 8, paddingRight: 8 }}
        >
          <div className="space-y-1">
            {navItems.map((item) => {
              const Icon = item.icon;
              return (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  title={collapsed ? item.label : undefined}
                  className={({ isActive }) =>
                    `relative flex items-center rounded-md text-sm font-medium transition-colors ${
                      collapsed ? 'justify-center' : 'gap-3 pl-3 pr-3'
                    } ${
                      isActive
                        ? 'bg-primary/10 text-primary'
                        : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
                    }`
                  }
                  style={{ height: 40 }}
                >
                  {({ isActive }) => (
                    <>
                      {isActive && (
                        <span
                          className="absolute left-0 top-1/2 -translate-y-1/2 rounded-r-sm bg-primary"
                          style={{ width: 3, height: 28 }}
                        />
                      )}
                      <Icon
                        className="shrink-0"
                        style={{ width: 18, height: 18, strokeWidth: 1.75 }}
                      />
                      {!collapsed && <span className="truncate">{item.label}</span>}
                    </>
                  )}
                </NavLink>
              );
            })}
          </div>
        </nav>

        {/* 底部用户与切换区（无边框分割） */}
        <div className="shrink-0 space-y-1" style={{ padding: 8 }}>
          {role === 'agent' && userInfo?.user_id && (
            <div
              className={`flex items-center ${
                collapsed ? 'justify-center' : 'gap-2.5 pl-2 pr-2'
              }`}
              style={{ paddingTop: 6, paddingBottom: 6 }}
            >
              <UserDisplay value={[userInfo.user_id]} size="small" showLabel={false} />
              {!collapsed && (
                <div className="flex flex-col min-w-0 flex-1">
                  <span className="text-sm font-medium text-gray-900 truncate">
                    {userInfo.name || userInfo.userName || '客服'}
                  </span>
                  <span className="text-xs text-gray-500">在线客服</span>
                </div>
              )}
            </div>
          )}
          <button
            type="button"
            onClick={handleSwitchRole}
            title={collapsed ? '切换角色' : undefined}
            className={`flex items-center rounded-md text-sm text-gray-500 hover:bg-gray-100 hover:text-gray-700 transition-colors w-full ${
              collapsed ? 'justify-center' : 'gap-3 pl-3 pr-3'
            }`}
            style={{ height: 40 }}
          >
            <LogOut
              className="shrink-0"
              style={{ width: 18, height: 18, strokeWidth: 1.75 }}
            />
            {!collapsed && <span className="truncate">切换角色</span>}
          </button>
        </div>
      </aside>

      <main className="flex-1 overflow-hidden flex flex-col">
        {role === 'agent' && (
          <div className="border-b border-gray-200 bg-white px-4 py-2.5 flex items-center justify-between shrink-0">
            <div className="text-xs text-gray-500">
              点击右侧按钮切换上线状态。上线后会周期性发送心跳，并接收新线索分配。
            </div>
            <AgentOnlineToggle />
          </div>
        )}
        <div className="flex-1 overflow-auto min-h-0">
          <Outlet />
        </div>
      </main>
    </div>
  );
};

export default Layout;
