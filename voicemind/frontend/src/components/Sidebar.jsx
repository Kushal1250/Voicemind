import React from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useSelector, useDispatch } from 'react-redux';
import {
  LayoutDashboard,
  Calendar,
  PlusCircle,
  FileText,
  MessageCircleQuestion,
  BarChart3,
  Settings,
  Mic,
  Cpu,
  Menu,
  X,
  ChevronLeft,
  ChevronRight,
  Activity,
} from 'lucide-react';
import { toggleSidebar, setSidebarOpen } from '../store/slices/uiSlice';

const navItems = [
  { path: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { path: '/meetings', label: 'Meetings', icon: Calendar },
  { path: '/meetings/new', label: 'New Meeting', icon: PlusCircle },
  { path: '/transcripts', label: 'Transcripts', icon: FileText },
  { path: '/qa', label: 'Q&A', icon: MessageCircleQuestion },
  { path: '/statistics', label: 'Statistics', icon: BarChart3 },
  { path: '/devices', label: 'Devices', icon: Cpu },
  { path: '/settings', label: 'Settings', icon: Settings },
];

const Sidebar = () => {
  const dispatch = useDispatch();
  const location = useLocation();
  const { sidebarOpen } = useSelector((state) => state.ui);
  const { isConnected, connectionMode, activeMeetingStatus } = useSelector((state) => state.liveStatus);

  return (
    <>
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 [background-color:rgba(2,6,23,0.7)] backdrop-blur-sm lg:hidden"
          onClick={() => dispatch(setSidebarOpen(false))}
        />
      )}

      <aside
        className={`fixed left-0 top-0 z-50 flex h-full max-w-[85vw] flex-col border-r border-white/10 [background-color:var(--app-bg)] backdrop-blur-xl transition-all duration-300 ${
          sidebarOpen ? 'translate-x-0 w-72' : '-translate-x-full w-72 lg:translate-x-0 lg:w-24'
        }`}
      >
        <div className="flex h-20 items-center justify-between border-b border-white/10 px-4">
          <div className="flex min-w-0 items-center gap-3 overflow-hidden">
            <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-primary-500 to-indigo-500 shadow-lg shadow-primary-900/30">
              <Mic className="h-6 w-6 text-white" />
            </div>
            {sidebarOpen && (
              <div className="min-w-0">
                <div className="truncate text-lg font-bold tracking-tight text-white">VoiceMind</div>
                <div className="truncate text-xs text-slate-400">AI meeting intelligence</div>
              </div>
            )}
          </div>

          <button
            onClick={() => dispatch(toggleSidebar())}
            className="hidden rounded-xl border border-white/10 bg-white/5 p-2 text-slate-400 transition hover:bg-white/10 hover:text-white lg:flex"
            aria-label={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
          >
            {sidebarOpen ? <ChevronLeft className="h-5 w-5" /> : <ChevronRight className="h-5 w-5" />}
          </button>

          <button
            onClick={() => dispatch(setSidebarOpen(false))}
            className="rounded-xl border border-white/10 bg-white/5 p-2 text-slate-400 lg:hidden"
            aria-label="Close sidebar"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-3 py-4 scrollbar-thin">
          {sidebarOpen && (
            <div className="mb-4 rounded-2xl border border-primary-500/20 bg-gradient-to-br from-primary-500/15 to-transparent p-4 text-sm text-slate-300">
              <div className="mb-2 flex items-center gap-2 text-white">
                <Activity className="h-4 w-4 text-primary-300" />
                Live workspace
              </div>
              <div className="text-xs leading-5 text-slate-400">
                Manage meetings, review transcripts, ask grounded questions, and monitor live activity from one place.
              </div>
            </div>
          )}

          <nav className="space-y-1.5">
            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive =
                location.pathname === item.path ||
                (item.path !== '/dashboard' && location.pathname.startsWith(item.path));

              return (
                <NavLink
                  key={item.path}
                  to={item.path}
                  className={`sidebar-link group ${isActive ? 'active' : ''} ${sidebarOpen ? 'justify-start' : 'justify-center px-2'}`}
                  title={!sidebarOpen ? item.label : undefined}
                >
                  <Icon className={`h-5 w-5 flex-shrink-0 transition ${isActive ? 'text-primary-300' : 'group-hover:text-white'}`} />
                  {sidebarOpen && <span className="min-w-0 truncate">{item.label}</span>}
                </NavLink>
              );
            })}
          </nav>
        </div>

        <div className="p-4">
          <div className="surface-card-soft overflow-hidden p-4">
            <div className={`flex items-center gap-3 ${sidebarOpen ? '' : 'justify-center'}`}>
              <span className={`h-2.5 w-2.5 rounded-full ${isConnected ? 'animate-pulse bg-green-400' : 'bg-red-400'}`} />
              {sidebarOpen && (
                <div className="min-w-0">
                  <div className="text-sm font-medium text-white">{isConnected ? 'Connected' : 'Disconnected'}</div>
                  <div className="truncate text-xs text-slate-400">
                    {activeMeetingStatus?.status === 'recording'
                      ? `Recording • ${connectionMode}`
                      : `Monitoring • ${connectionMode}`}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </aside>

      <button
        onClick={() => dispatch(setSidebarOpen(true))}
        className="fixed left-3 top-3 z-30 rounded-2xl border border-white/10 [background-color:var(--app-surface)] p-2.5 text-slate-200 shadow-lg lg:hidden"
        aria-label="Open menu"
      >
        <Menu className="h-6 w-6" />
      </button>
    </>
  );
};

export default Sidebar;