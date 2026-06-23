import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { Moon, Sun, Monitor, Radio, Sparkles, Check, Loader2 } from 'lucide-react';
import AppShell from '../components/AppShell';
import { setTheme } from '../store/slices/uiSlice';
import { updateProfile } from '../store/slices/authSlice';

/**
 * Settings page — fully wired to backend.
 *
 * Fixes applied:
 *  1. Reads initial values from auth.user.preferences (backend source of truth)
 *     instead of localStorage.
 *  2. Every change (theme / notification toggles / realtimeMode) calls
 *     PUT /api/auth/me via the existing updateProfile thunk so the backend
 *     persists the value and the Redux auth.user.preferences stays in sync.
 *  3. Theme change also dispatches setTheme so the UI updates immediately.
 *  4. Shows a per-section saving / saved indicator so the user gets feedback.
 */

const Settings = () => {
  const dispatch = useDispatch();
  const { theme } = useSelector((state) => state.ui);
  const { user, loading: authLoading } = useSelector((state) => state.auth);

  // ── local mirror of preferences ──────────────────────────────────────────
  const [notifications, setNotifications] = useState({
    system: true,
    device: true,
    meeting: true,
  });
  const [realtimeMode, setRealtimeMode] = useState('auto');

  // saving feedback: 'idle' | 'saving' | 'saved'
  const [saveStatus, setSaveStatus] = useState('idle');
  const saveTimerRef = useRef(null);

  // ── hydrate from backend user prefs once user is loaded ──────────────────
  useEffect(() => {
    if (!user?.preferences) return;
    const prefs = user.preferences;

    if (prefs.notifications) {
      setNotifications({
        system: prefs.notifications.system ?? true,
        device: prefs.notifications.device ?? true,
        meeting: prefs.notifications.meeting ?? true,
      });
    }
    if (prefs.realtimeMode) {
      setRealtimeMode(prefs.realtimeMode);
    }
    // Sync theme from backend too, in case another device changed it
    if (prefs.theme) {
      dispatch(setTheme(prefs.theme));
    }
  }, [user, dispatch]);

  // ── helper: persist preferences to backend ────────────────────────────────
  const persist = (preferences) => {
    setSaveStatus('saving');
    clearTimeout(saveTimerRef.current);

    dispatch(updateProfile({ preferences }))
      .unwrap()
      .then(() => {
        setSaveStatus('saved');
        saveTimerRef.current = setTimeout(() => setSaveStatus('idle'), 2000);
      })
      .catch(() => {
        setSaveStatus('idle');
      });
  };

  // ── handlers ─────────────────────────────────────────────────────────────
  const handleThemeChange = (value) => {
    // Immediately apply theme to the UI
    dispatch(setTheme(value));
    // Persist to backend
    persist({ theme: value });
  };

  const handleNotificationToggle = (key) => {
    const updated = { ...notifications, [key]: !notifications[key] };
    setNotifications(updated);
    persist({ notifications: updated });
  };

  const handleRealtimeChange = (event) => {
    const value = event.target.value;
    setRealtimeMode(value);
    persist({ realtimeMode: value });
  };

  // ── static data ───────────────────────────────────────────────────────────
  const themeOptions = useMemo(
    () => [
      { value: 'light', label: 'Light', icon: Sun },
      { value: 'dark', label: 'Dark', icon: Moon },
      { value: 'system', label: 'System', icon: Monitor },
    ],
    []
  );

  const notificationItems = [
    {
      key: 'system',
      label: 'System notifications',
      sub: 'Backend health, connectivity changes',
    },
    {
      key: 'device',
      label: 'Device status changes',
      sub: 'Online / offline transitions',
    },
    {
      key: 'meeting',
      label: 'Meeting updates',
      sub: 'Recording starts, transcripts ready',
    },
  ];

  // ── save status indicator ─────────────────────────────────────────────────
  const SaveIndicator = () => {
    if (saveStatus === 'saving') {
      return (
        <span className="flex items-center gap-1.5 text-xs text-slate-400">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Saving…
        </span>
      );
    }
    if (saveStatus === 'saved') {
      return (
        <span className="flex items-center gap-1.5 text-xs text-emerald-400">
          <Check className="h-3.5 w-3.5" />
          Saved
        </span>
      );
    }
    return null;
  };

  return (
    <AppShell>
      <div className="min-h-full px-4 pb-8 pt-24 sm:px-6 sm:pb-10 sm:pt-28 lg:px-8 lg:pt-32">
        <div className="mx-auto max-w-4xl space-y-6">
          {/* Header */}
          <section className="glass-panel overflow-hidden rounded-3xl p-6 sm:p-8">
            <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-primary-500/20 bg-primary-500/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.24em] text-primary-200">
              <Sparkles className="h-3.5 w-3.5" />
              Preferences
            </div>
            <div className="flex items-center justify-between">
              <div>
                <h1 className="section-title text-2xl sm:text-3xl">Settings</h1>
                <p className="section-subtitle mt-2">
                  Manage your workspace appearance, notifications, and realtime behavior.
                </p>
              </div>
              <SaveIndicator />
            </div>
          </section>

          <div className="surface-card space-y-8 rounded-3xl p-6 sm:p-8">
            {/* ── Appearance ── */}
            <section>
              <h3 className="mb-1 text-lg font-semibold" style={{color:"var(--app-text)"}}>Appearance</h3>
              <p className="mb-5 text-sm" style={{color:"var(--app-text-muted)"}}>Choose how VoiceMind looks to you.</p>

              <div className="flex flex-wrap gap-3">
                {themeOptions.map(({ value, label, icon: Icon }) => {
                  const active = theme === value;
                  return (
                    <button
                      key={value}
                      type="button"
                      disabled={authLoading}
                      onClick={() => handleThemeChange(value)}
                      style={active ? {
                        borderColor: 'rgba(59,130,246,0.5)',
                        backgroundColor: 'rgba(59,130,246,0.12)',
                        color: 'var(--app-text)',
                        boxShadow: '0 0 0 1px rgba(59,130,246,0.2)',
                      } : {
                        borderColor: 'var(--app-border)',
                        backgroundColor: 'var(--app-surface-s)',
                        color: 'var(--app-text-muted)',
                      }}
                      className="inline-flex min-w-[118px] items-center justify-center gap-2.5 rounded-2xl border px-5 py-3 text-sm font-semibold transition-all duration-200 disabled:opacity-50 hover:opacity-90"
                    >
                      <Icon className="h-4 w-4" />
                      <span>{label}</span>
                    </button>
                  );
                })}
              </div>
            </section>

            {/* ── Notifications ── */}
            <section className="border-t border-white/10 pt-8">
              <h3 className="mb-1 text-lg font-semibold" style={{color:"var(--app-text)"}}>Notifications</h3>
              <p className="mb-5 text-sm" style={{color:"var(--app-text-muted)"}}>
                Choose which events trigger notifications.
              </p>

              <div className="space-y-4">
                {notificationItems.map(({ key, label, sub }) => (
                  <label
                    key={key}
                    className="surface-card-soft flex cursor-pointer items-center justify-between gap-4 rounded-2xl border border-white/10 p-5 transition hover:border-white/20"
                  >
                    <div className="min-w-0">
                      <div className="text-base font-semibold" style={{color:"var(--app-text)"}}>{label}</div>
                      <div className="mt-1 text-sm" style={{color:"var(--app-text-muted)"}}>{sub}</div>
                    </div>

                    <input
                      type="checkbox"
                      checked={notifications[key]}
                      onChange={() => handleNotificationToggle(key)}
                      disabled={authLoading}
                      className="h-5 w-5 shrink-0 rounded border-white/20 bg-white/5 text-primary-500 focus:ring-2 focus:ring-primary-500/30 disabled:opacity-50"
                    />
                  </label>
                ))}
              </div>
            </section>

            {/* ── Realtime connection ── */}
            <section className="border-t border-white/10 pt-8">
              <h3 className="mb-1 text-lg font-semibold" style={{color:"var(--app-text)"}}>Realtime connection</h3>
              <p className="mb-5 text-sm" style={{color:"var(--app-text-muted)"}}>
                Control how the app receives live updates from the backend.
              </p>

              <select
                value={realtimeMode}
                onChange={handleRealtimeChange}
                disabled={authLoading}
                className="input-field w-full rounded-2xl disabled:opacity-50"
              >
                <option value="auto">Auto — SSE with polling fallback (recommended)</option>
                <option value="realtime">Realtime only (SSE)</option>
                <option value="polling">Polling only</option>
              </select>

              <p className="mt-3 flex items-start gap-2 text-xs sm:text-sm" style={{color:"var(--app-text-muted)"}}>
                <Radio className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  Auto mode falls back to 5-second polling if SSE is not available or gets
                  disconnected.
                </span>
              </p>
            </section>
          </div>
        </div>
      </div>
    </AppShell>
  );
};

export default Settings;