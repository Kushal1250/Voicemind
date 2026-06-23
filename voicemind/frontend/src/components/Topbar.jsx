import React, { useState, useRef, useEffect, useMemo } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import {
  Search,
  Bell,
  LogOut,
  Settings,
  ChevronDown,
  Mic,
  Calendar,
  X,
  ExternalLink,
  Radio,
  FileText,
  Trash2,
  CircleDot,
} from 'lucide-react';
import { logout } from '../store/slices/authSlice';
import { setFilters } from '../store/slices/meetingsSlice';
import {
  fetchNotifications,
  markAsRead,
  markAllAsRead,
  setFilter,
  markLocalAsRead,
  dismissNotification,
  clearAllNotificationsRemote,
  selectNotification,
  isNotificationRead,
} from '../store/slices/notificationsSlice';
import { useDebounce } from '../hooks/useDebounce';

const NOTIFICATION_TABS = ['all', 'system', 'device', 'meeting', 'qa', 'transcript'];

const typeStyles = {
  system: 'border-sky-500/20 bg-sky-500/10 text-sky-200',
  device: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-200',
  meeting: 'border-violet-500/20 bg-violet-500/10 text-violet-200',
  qa: 'border-amber-500/20 bg-amber-500/10 text-amber-200',
  transcript: 'border-cyan-500/20 bg-cyan-500/10 text-cyan-200',
};

const severityDotStyles = {
  success: 'bg-emerald-400',
  info: 'bg-sky-400',
  warning: 'bg-amber-400',
  error: 'bg-rose-400',
  critical: 'bg-red-500',
};

const Topbar = () => {
  const dispatch = useDispatch();
  const navigate = useNavigate();

  const { user } = useSelector((state) => state.auth);
  const { items: meetings, pagination } = useSelector((state) => state.meetings);
  const {
    items: notifications,
    unreadCount,
    filter: notifFilter,
    selectedNotificationId,
    loading: notificationsLoading,
    hasFetchedOnce,
    countsByType,
  } = useSelector((state) => state.notifications);

  // Read per-type toggles from user preferences (default all on)
  const notifPrefs = useMemo(() => {
    const p = user?.preferences?.notifications || {};
    return {
      system: p.system ?? true,
      device: p.device ?? true,
      meeting: p.meeting ?? true,
    };
  }, [user?.preferences?.notifications]);
  const { connectionMode, isConnected } = useSelector((state) => state.liveStatus);

  const [showUserMenu, setShowUserMenu] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeRecordingCount, setActiveRecordingCount] = useState(0);

  const userMenuRef = useRef(null);
  const notificationsRef = useRef(null);

  const debouncedSearch = useDebounce(searchQuery, 350);
  const searchRef = useRef(null);
  const [showSearchDropdown, setShowSearchDropdown] = useState(false);

  // Navigate to meetings page with search pre-filled when user types
  useEffect(() => {
    if (!debouncedSearch.trim()) return;
    dispatch(setFilters({ search: debouncedSearch }));
  }, [debouncedSearch, dispatch]);

  const handleSearchSubmit = (e) => {
    if (e.key === 'Enter' && searchQuery.trim()) {
      dispatch(setFilters({ search: searchQuery.trim() }));
      navigate('/meetings');
      setShowSearchDropdown(false);
      searchRef.current?.blur();
    }
    if (e.key === 'Escape') {
      setSearchQuery('');
      setShowSearchDropdown(false);
      searchRef.current?.blur();
    }
  };

  const handleSearchFocus = () => setShowSearchDropdown(searchQuery.length > 0);
  const handleSearchBlur = () => setTimeout(() => setShowSearchDropdown(false), 150);

  const handleSearchChange = (e) => {
    setSearchQuery(e.target.value);
    setShowSearchDropdown(e.target.value.length > 0);
  };

  const clearSearch = () => {
    setSearchQuery('');
    dispatch(setFilters({ search: '' }));
    setShowSearchDropdown(false);
  };

  const commitSearch = (query) => {
    setSearchQuery(query);
    dispatch(setFilters({ search: query }));
    navigate('/meetings');
    setShowSearchDropdown(false);
  };

  useEffect(() => {
    setActiveRecordingCount(meetings.filter((m) => m.status === 'recording').length);
  }, [meetings]);

  useEffect(() => {
    dispatch(fetchNotifications({ limit: 50 }));
  }, [dispatch]);

  useEffect(() => {
    if (showNotifications) {
      dispatch(fetchNotifications({ limit: 50 }));
    }
  }, [dispatch, showNotifications]);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (userMenuRef.current && !userMenuRef.current.contains(event.target)) {
        setShowUserMenu(false);
      }
      if (notificationsRef.current && !notificationsRef.current.contains(event.target)) {
        setShowNotifications(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleLogout = () => {
    dispatch(logout());
    navigate('/login');
  };

  const getInitials = (name) => {
    if (!name) return 'U';
    return name
      .split(' ')
      .map((n) => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  };

  // Only hide categories that are explicitly disabled in Settings.
  const visibleNotifications = useMemo(
    () => notifications.filter((n) => !n.dismissed && notifPrefs[n.type] !== false),
    [notifications, notifPrefs]
  );

  const filteredNotifications = useMemo(() => {
    return visibleNotifications.filter((n) => (notifFilter === 'all' ? true : n.type === notifFilter));
  }, [visibleNotifications, notifFilter]);

  // Bell badge: only count unread from preference-enabled types
  const dynamicUnreadCount = useMemo(
    () => visibleNotifications.filter((n) => !n.dismissed && !(Array.isArray(n.readBy) && n.readBy.length > 0)).length,
    [visibleNotifications]
  );

  const tabCounts = useMemo(
    () => ({
      all: visibleNotifications.length,
      system: visibleNotifications.filter((n) => n.type === 'system').length,
      device: visibleNotifications.filter((n) => n.type === 'device').length,
      meeting: visibleNotifications.filter((n) => n.type === 'meeting').length,
      qa: visibleNotifications.filter((n) => n.type === 'qa').length,
      transcript: visibleNotifications.filter((n) => n.type === 'transcript').length,
    }),
    [visibleNotifications]
  );

  const selectedNotification = useMemo(
    () =>
      filteredNotifications.find(
        (notification) =>
          notification.localId === selectedNotificationId || notification._id === selectedNotificationId
      ) || filteredNotifications[0] || null,
    [filteredNotifications, selectedNotificationId]
  );

  const formatNotificationDate = (notification) => {
    const value = notification?.createdAt || notification?.at || notification?.updatedAt || null;
    if (!value) return 'Just now';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Just now';
    return `${date.toLocaleDateString()} ${date.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    })}`;
  };

  const handleNotificationClick = (notification) => {
    const id = notification.localId || notification._id;
    dispatch(selectNotification(id));
    if (!isNotificationRead(notification)) {
      if (notification._id) {
        dispatch(markAsRead(notification._id));
      } else {
        dispatch(markLocalAsRead(id));
      }
    }
  };

  const handleDismissNotification = (event, notification) => {
    event.stopPropagation();
    dispatch(dismissNotification(notification.localId || notification._id));
  };

  // Resolve the best destination path + human-readable label for a notification
  const resolveNotificationLink = (notification) => {
    if (!notification) return null;

    // Explicit backend-supplied link takes first priority
    if (notification.link?.path) {
      return { path: notification.link.path, label: notification.link.label || 'Open related page' };
    }

    // System notifications → dedicated SystemHealth page with the error key
    if (notification.type === 'system') {
      const key =
        notification.dedupeKey ||
        (notification.title?.toLowerCase().includes('network') ? 'network-error' :
         notification.title?.toLowerCase().includes('offline') ? 'backend-offline' :
         notification.title?.toLowerCase().includes('online') ? 'backend-online' :
         'server-error-500');
      return { path: `/system-health?error=${encodeURIComponent(key)}`, label: 'View details & fix guide' };
    }

    // Meeting notifications
    if (notification.type === 'meeting' || notification.meetingId) {
      const id = notification.meetingId;
      if (!id) return { path: '/meetings', label: 'View meetings' };
      const isTranscript =
        notification.dedupeKey?.startsWith('meeting_status:') &&
        (notification.title?.toLowerCase().includes('transcript') ||
         notification.title?.toLowerCase().includes('ready'));
      if (isTranscript) return { path: `/transcripts/${id}`, label: 'View transcript' };
      return { path: `/meetings/${id}`, label: 'Open meeting' };
    }

    // Device notifications
    if (notification.type === 'device' || notification.deviceId) {
      const id = notification.deviceId;
      if (id) return { path: `/devices/${id}`, label: 'View device' };
      return { path: '/devices', label: 'View devices' };
    }

    return null;
  };

  const openNotificationLink = (notification) => {
    if (!notification) return;
    const resolved = resolveNotificationLink(notification);
    if (resolved?.path) navigate(resolved.path);
    setShowNotifications(false);
  };

  return (
    <header className="sticky top-0 z-30 border-b border-white/10 [background-color:var(--app-surface)] backdrop-blur-xl">
      <div className="mx-auto flex min-h-20 w-full max-w-[1600px] flex-wrap items-center justify-between gap-3 px-3 py-3 sm:px-6 lg:flex-nowrap lg:px-8">
        <div className="flex min-w-0 items-center gap-3">
          <div className="rounded-2xl border border-white/10 bg-white/5 p-2.5 lg:hidden">
            <Radio className={`h-4 w-4 ${isConnected ? 'text-green-400' : 'text-red-400'}`} />
          </div>
          <div className="hidden rounded-2xl border border-white/10 bg-white/5 p-3 md:flex">
            <Radio className={`h-5 w-5 ${isConnected ? 'text-green-400' : 'text-red-400'}`} />
          </div>
          <div className="min-w-0 md:hidden">
            <div className="text-[10px] uppercase tracking-[0.24em] text-slate-500">VoiceMind</div>
            <div className="truncate text-sm font-semibold text-white">Workspace</div>
          </div>
          <div className="hidden md:block">
            <div className="text-xs uppercase tracking-[0.28em] text-slate-500">Workspace</div>
            <div className="flex items-center gap-3 text-sm text-slate-300">
              <span className="font-semibold text-white">VoiceMind Control Center</span>
              <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-slate-400">
                {isConnected ? (connectionMode === 'realtime' ? 'Realtime' : 'Polling') : 'Disconnected'}
              </span>
            </div>
          </div>
        </div>

        <div className="order-3 w-full lg:order-none lg:block lg:max-w-xl lg:flex-1" ref={searchRef}>
          <div className="relative">
            <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
            <input
              type="text"
              placeholder="Search meetings… press Enter to filter"
              value={searchQuery}
              onChange={handleSearchChange}
              onKeyDown={handleSearchSubmit}
              onFocus={handleSearchFocus}
              onBlur={handleSearchBlur}
              className="input-field w-full pl-11 pr-10"
            />
            {searchQuery && (
              <button
                onClick={clearSearch}
                className="absolute right-3 top-1/2 -translate-y-1/2 rounded p-0.5 text-slate-500 hover:text-white transition"
                aria-label="Clear search"
              >
                <X className="h-4 w-4" />
              </button>
            )}

            {/* Search dropdown */}
            {showSearchDropdown && searchQuery.trim() && (
              <div className="absolute left-0 right-0 top-full mt-2 overflow-hidden rounded-2xl border border-white/10 [background-color:var(--app-bg)] shadow-2xl backdrop-blur-xl z-50">
                <div className="p-3">
                  <p className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">
                    Quick search
                  </p>
                  <button
                    onMouseDown={() => commitSearch(searchQuery)}
                    className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm hover:bg-white/5 transition"
                  >
                    <Search className="h-4 w-4 flex-shrink-0 text-primary-400" />
                    <span className="flex-1 text-white">
                      Search meetings for <span className="font-semibold text-primary-300">"{searchQuery}"</span>
                    </span>
                    <span className="rounded-lg border border-white/10 bg-white/5 px-2 py-0.5 text-[11px] text-slate-400">Enter ↵</span>
                  </button>

                  {/* Quick nav shortcuts */}
                  <div className="mt-2 border-t border-white/5 pt-2">
                    <p className="mb-1.5 px-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">Jump to</p>
                    {[
                      { label: 'Meetings', path: '/meetings', icon: Calendar },
                      { label: 'Transcripts', path: '/transcripts', icon: FileText },
                    ].map(({ label, path, icon: Icon }) => (
                      <button
                        key={path}
                        onMouseDown={() => { navigate(path); setShowSearchDropdown(false); setSearchQuery(''); }}
                        className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm text-slate-400 hover:bg-white/5 hover:text-white transition"
                      >
                        <Icon className="h-4 w-4 flex-shrink-0" />
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="ml-auto flex items-center gap-2 sm:gap-3">
          <div className="hidden items-center gap-3 rounded-2xl border border-white/10 bg-white/5 px-4 py-2.5 lg:flex">
            <div className="flex items-center gap-2">
              <Calendar className="h-4 w-4 text-primary-300" />
              <div>
                <div className="text-[11px] uppercase tracking-[0.24em] text-slate-500">Meetings</div>
                <div className="text-sm font-semibold text-white">{pagination.total || 0}</div>
              </div>
            </div>
            <div className="h-8 w-px bg-white/10" />
            <div className="flex items-center gap-2">
              <Mic className={`h-4 w-4 ${activeRecordingCount > 0 ? 'text-red-300' : 'text-slate-400'}`} />
              <div>
                <div className="text-[11px] uppercase tracking-[0.24em] text-slate-500">Recording</div>
                <div className={`text-sm font-semibold ${activeRecordingCount > 0 ? 'text-red-300' : 'text-white'}`}>
                  {activeRecordingCount > 0 ? `${activeRecordingCount} active` : 'Idle'}
                </div>
              </div>
            </div>
          </div>

          <div className="relative" ref={notificationsRef}>
            <button
              onClick={() => setShowNotifications((prev) => !prev)}
              className="relative rounded-2xl border border-white/10 bg-white/5 p-3 text-slate-300 transition hover:bg-white/10"
              aria-label="Notifications"
            >
              <Bell className="h-5 w-5" />
              {dynamicUnreadCount > 0 && (
                <span className="absolute -right-1 -top-1 flex h-5 min-w-[20px] items-center justify-center rounded-full bg-red-500 px-1 text-[11px] font-bold text-white">
                  {dynamicUnreadCount > 99 ? '99+' : dynamicUnreadCount}
                </span>
              )}
            </button>

            {showNotifications && (
              <div className="absolute right-0 top-full mt-3 w-[min(92vw,24rem)] overflow-hidden rounded-3xl border border-white/10 [background-color:var(--app-bg)] shadow-2xl backdrop-blur-xl md:w-[min(92vw,40rem)]">
                <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
                  <div>
                    <h3 className="text-base font-semibold text-white">Notifications</h3>
                    <p className="text-xs text-slate-400">Grouped updates for system, devices, and meetings.</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => dispatch(clearAllNotificationsRemote(notifFilter))}
                      className="inline-flex items-center gap-1 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-semibold text-slate-200 transition hover:bg-white/10"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      Clear all
                    </button>
                    <button
                      onClick={() => dispatch(markAllAsRead())}
                      className="rounded-xl border border-primary-500/20 bg-primary-500/10 px-3 py-2 text-xs font-semibold text-primary-200 transition hover:bg-primary-500/15"
                    >
                      Mark all read
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-[0.95fr_1.05fr]">
                  <div className="border-b border-white/10 md:border-b-0 md:border-r">
                    <div className="grid grid-cols-2 gap-2 px-4 py-3 sm:grid-cols-3">
                      {NOTIFICATION_TABS.filter((tab) => tab === 'all' || notifPrefs[tab] !== false).map((filter) => (
                        <button
                          key={filter}
                          onClick={() => dispatch(setFilter(filter))}
                          className={`flex min-h-[52px] items-center justify-between rounded-2xl border px-3 py-2 text-left transition ${
                            notifFilter === filter
                              ? 'border-primary-500/30 bg-primary-500/15 text-primary-100 shadow-[0_0_0_1px_rgba(59,130,246,0.15)]'
                              : 'border-white/10 bg-white/5 text-slate-300 hover:bg-white/10'
                          }`}
                        >
                          <span className="text-sm font-semibold capitalize leading-none">{filter}</span>
                          <span className="rounded-full bg-black/20 px-2 py-1 text-xs font-semibold text-slate-300">
                            {tabCounts[filter] || 0}
                          </span>
                        </button>
                      ))}
                    </div>

                    <div className="max-h-[30rem] overflow-auto scrollbar-thin">
                      {filteredNotifications.length === 0 ? (
                        <div className="flex min-h-[18rem] flex-col items-center justify-center px-5 py-14 text-center text-slate-500">
                          <Bell className="mx-auto mb-3 h-10 w-10 opacity-30" />
                          {notificationsLoading
                            ? 'Loading notifications...'
                            : !hasFetchedOnce
                              ? 'Opening notification center...'
                              : notifFilter !== 'all' && !notifPrefs[notifFilter]
                                ? `${notifFilter.charAt(0).toUpperCase() + notifFilter.slice(1)} notifications are disabled in Settings`
                                : 'No notifications yet'}
                        </div>
                      ) : (
                        filteredNotifications.map((notification) => {
                          const selected =
                            selectedNotificationId === notification.localId ||
                            selectedNotificationId === notification._id;
                          const unread = !isNotificationRead(notification);

                          return (
                            <div
                              key={notification.localId || notification._id}
                              role="button"
                              tabIndex={0}
                              onClick={() => handleNotificationClick(notification)}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter' || event.key === ' ') {
                                  event.preventDefault();
                                  handleNotificationClick(notification);
                                }
                              }}
                              className={`block w-full cursor-pointer border-b border-white/5 px-4 py-4 text-left transition hover:bg-white/5 ${
                                selected ? 'bg-white/10' : ''
                              }`}
                            >
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0 flex-1">
                                  <div className="mb-2 flex items-center gap-2">
                                    <span className={`rounded-full border px-2 py-1 text-[11px] font-semibold uppercase tracking-wide ${typeStyles[notification.type] || 'border-white/10 bg-white/5 text-slate-300'}`}>
                                      {notification.type || 'system'}
                                    </span>
                                    <span className={`inline-flex h-2.5 w-2.5 rounded-full ${severityDotStyles[notification.severity] || severityDotStyles.info}`} />
                                    {unread && <CircleDot className="h-3.5 w-3.5 text-primary-300" />}
                                  </div>
                                  <div className="truncate text-sm font-semibold text-white">
                                    {notification.title || 'Notification'}
                                  </div>
                                  <div className="mt-1 line-clamp-2 text-xs leading-5 text-slate-400">
                                    {notification.message}
                                  </div>
                                  <div className="mt-2 text-[11px] text-slate-500">
                                    {formatNotificationDate(notification)}
                                  </div>
                                </div>
                                <button
                                  onClick={(event) => handleDismissNotification(event, notification)}
                                  className="rounded-xl p-1.5 text-slate-500 transition hover:bg-white/5 hover:text-slate-200"
                                  aria-label="Dismiss notification"
                                >
                                  <X className="h-4 w-4" />
                                </button>
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>

                  <div className="flex min-h-[20rem] flex-col">
                    {selectedNotification ? (
                      <div className="flex h-full flex-col px-5 py-5">
                        <div className="mb-3 flex flex-wrap items-center gap-2">
                          <span className={`rounded-full border px-2 py-1 text-[11px] font-semibold uppercase tracking-wide ${typeStyles[selectedNotification.type] || 'border-white/10 bg-white/5 text-slate-300'}`}>
                            {selectedNotification.type || 'system'}
                          </span>
                          <span className={`inline-flex items-center rounded-full px-2 py-1 text-[11px] font-semibold uppercase tracking-wide ${selectedNotification.severity === 'critical' ? 'bg-red-500/15 text-red-200' : selectedNotification.severity === 'error' ? 'bg-rose-500/15 text-rose-200' : selectedNotification.severity === 'warning' ? 'bg-amber-500/15 text-amber-200' : selectedNotification.severity === 'success' ? 'bg-emerald-500/15 text-emerald-200' : 'bg-sky-500/15 text-sky-200'}`}>
                            {selectedNotification.severity || 'info'}
                          </span>
                          <span className="text-xs text-slate-500">{formatNotificationDate(selectedNotification)}</span>
                        </div>
                        <h4 className="text-lg font-semibold text-white">
                          {selectedNotification.title || 'Notification details'}
                        </h4>
                        <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-slate-300">
                          {selectedNotification.message || 'No additional details available.'}
                        </p>
                        <dl className="mt-4 grid grid-cols-1 gap-3 text-sm text-slate-300 sm:grid-cols-2">
                          <div className="rounded-2xl border border-white/10 bg-white/5 px-3 py-2">
                            <dt className="text-[11px] uppercase tracking-[0.2em] text-slate-500">Source</dt>
                            <dd className="mt-1 font-medium text-white">{selectedNotification.source || 'system'}</dd>
                          </div>
                          <div className="rounded-2xl border border-white/10 bg-white/5 px-3 py-2">
                            <dt className="text-[11px] uppercase tracking-[0.2em] text-slate-500">Service</dt>
                            <dd className="mt-1 font-medium text-white">{selectedNotification.service || '—'}</dd>
                          </div>
                          <div className="rounded-2xl border border-white/10 bg-white/5 px-3 py-2">
                            <dt className="text-[11px] uppercase tracking-[0.2em] text-slate-500">Meeting</dt>
                            <dd className="mt-1 font-medium text-white">{selectedNotification.meetingId || '—'}</dd>
                          </div>
                          <div className="rounded-2xl border border-white/10 bg-white/5 px-3 py-2">
                            <dt className="text-[11px] uppercase tracking-[0.2em] text-slate-500">Device</dt>
                            <dd className="mt-1 font-medium text-white">{selectedNotification.deviceId || '—'}</dd>
                          </div>
                        </dl>
                        <div className="mt-auto pt-5">
                          {(() => {
                            const resolved = resolveNotificationLink(selectedNotification);
                            if (!resolved) return null;
                            return (
                              <button
                                onClick={() => openNotificationLink(selectedNotification)}
                                className="btn-secondary w-full"
                              >
                                <ExternalLink className="h-4 w-4" />
                                {resolved.label}
                              </button>
                            );
                          })()}
                        </div>
                      </div>
                    ) : (
                      <div className="flex h-full items-center justify-center px-5 text-center text-slate-500">
                        Select a notification to view details
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="relative" ref={userMenuRef}>
            <button
              onClick={() => setShowUserMenu((prev) => !prev)}
              className="flex max-w-[56vw] items-center gap-2 rounded-2xl border border-white/10 bg-white/5 px-2.5 py-2.5 transition hover:bg-white/10 sm:max-w-none sm:gap-3 sm:px-3"
            >
              <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-gradient-to-br from-primary-500 to-indigo-500 text-sm font-bold text-white">
                {getInitials(user?.name)}
              </div>
              <div className="hidden text-left sm:block">
                <div className="max-w-[9rem] truncate text-sm font-semibold text-white">{user?.name || 'User'}</div>
                <div className="max-w-[9rem] truncate text-xs text-slate-400">{user?.email || 'workspace@local'}</div>
              </div>
              <ChevronDown className="h-4 w-4 flex-shrink-0 text-slate-400" />
            </button>

            {showUserMenu && (
              <div className="absolute right-0 top-full mt-3 w-56 overflow-hidden rounded-3xl border border-white/10 [background-color:var(--app-bg)] shadow-2xl backdrop-blur-xl">
                <button
                  onClick={() => {
                    navigate('/settings');
                    setShowUserMenu(false);
                  }}
                  className="flex w-full items-center gap-3 px-4 py-3 text-sm text-slate-300 transition hover:bg-white/5"
                >
                  <Settings className="h-4 w-4" />
                  Settings
                </button>
                <button
                  onClick={handleLogout}
                  className="flex w-full items-center gap-3 px-4 py-3 text-sm text-red-300 transition hover:bg-red-500/10"
                >
                  <LogOut className="h-4 w-4" />
                  Logout
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </header>
  );
};

export default Topbar;