import React, { useEffect, Suspense, lazy } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useSelector, useDispatch } from 'react-redux';
import { setTheme } from './store/slices/uiSlice';
import { fetchMe } from './store/slices/authSlice';
import { addNotification } from './store/slices/notificationsSlice';
import { useLiveStatus } from './hooks/useLiveStatus';
import { useNotificationStream } from './hooks/useNotificationStream';

// Lazy load pages for code splitting
const Landing = lazy(() => import('./pages/Landing'));
const Login = lazy(() => import('./pages/Login'));
const Signup = lazy(() => import('./pages/Signup'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Meetings = lazy(() => import('./pages/Meetings'));
const NewMeeting = lazy(() => import('./pages/NewMeeting'));
const MeetingDetail = lazy(() => import('./pages/MeetingDetail'));
const LiveMonitor = lazy(() => import('./pages/LiveMonitor'));
const Transcripts = lazy(() => import('./pages/Transcripts'));
const TranscriptViewer = lazy(() => import('./pages/TranscriptViewer'));
const TranscriptSummary = lazy(() => import('./pages/TranscriptSummary'));
const QADashboard = lazy(() => import('./pages/QADashboard'));
const QAMeeting = lazy(() => import('./pages/QAMeeting'));
const Statistics = lazy(() => import('./pages/Statistics'));
const Devices = lazy(() => import('./pages/Devices'));
const DeviceDetail = lazy(() => import('./pages/DeviceDetail'));
const Profile = lazy(() => import('./pages/Profile'));
const Settings = lazy(() => import('./pages/Settings'));
const NotFound = lazy(() => import('./pages/NotFound'));
const SystemHealthPage = lazy(() => import('./pages/SystemHealthPage'));

// Loading component
const PageLoader = () => (
  <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-slate-950">
    <div className="flex flex-col items-center gap-4">
      <div className="w-12 h-12 border-4 border-primary-200 border-t-primary-600 rounded-full animate-spin"></div>
      <p className="text-gray-600 dark:text-gray-400">Loading...</p>
    </div>
  </div>
);

// Protected route wrapper
const ProtectedRoute = ({ children }) => {
  const { isAuthenticated } = useSelector((state) => state.auth);
  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }
  return children;
};

// Public route wrapper (redirect if authenticated)
const PublicRoute = ({ children }) => {
  const { isAuthenticated } = useSelector((state) => state.auth);
  if (isAuthenticated) {
    return <Navigate to="/dashboard" replace />;
  }
  return children;
};

/**
 * AppConnections — mounts all global hooks that need to live at the app level.
 * Keeping them in a child component (instead of directly in App) avoids
 * re-creating hooks when the outer <div> re-renders.
 */
function AppConnections() {
  const dispatch = useDispatch();
  useLiveStatus();
  useNotificationStream();

  useEffect(() => {
    const handler = (event) => {
      const payload = event?.detail;
      if (!payload) return;
      dispatch(addNotification(payload));
    };

    window.addEventListener('voicemind:notification', handler);
    return () => window.removeEventListener('voicemind:notification', handler);
  }, [dispatch]);

  return null;
}

function App() {
  const dispatch = useDispatch();
  const { isAuthenticated, user } = useSelector((state) => state.auth);

  // Apply theme on first load and whenever user.preferences.theme changes
  useEffect(() => {
    // If user has a backend-persisted theme, prefer it; otherwise fall back to localStorage
    const backendTheme = user?.preferences?.theme;
    const savedTheme = backendTheme || localStorage.getItem('voicemind_theme') || 'system';
    dispatch(setTheme(savedTheme));
  }, [dispatch, user?.preferences?.theme]);

  // Fetch user profile on auth (populates preferences for Settings page)
  useEffect(() => {
    if (isAuthenticated) {
      dispatch(fetchMe());
    }
  }, [dispatch, isAuthenticated]);

  return (
    <div>
      <AppConnections />
      <Suspense fallback={<PageLoader />}>
        <Routes>
          {/* Public routes */}
          <Route path="/" element={<Landing />} />
          <Route path="/login" element={<PublicRoute><Login /></PublicRoute>} />
          <Route path="/signup" element={<PublicRoute><Signup /></PublicRoute>} />

          {/* Protected routes */}
          <Route path="/dashboard" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
          <Route path="/meetings" element={<ProtectedRoute><Meetings /></ProtectedRoute>} />
          <Route path="/meetings/new" element={<ProtectedRoute><NewMeeting /></ProtectedRoute>} />
          <Route path="/meetings/:id" element={<ProtectedRoute><MeetingDetail /></ProtectedRoute>} />
          <Route path="/live" element={<ProtectedRoute><LiveMonitor /></ProtectedRoute>} />
          <Route path="/transcripts" element={<ProtectedRoute><Transcripts /></ProtectedRoute>} />
          <Route path="/transcripts/:meetingId" element={<ProtectedRoute><TranscriptViewer /></ProtectedRoute>} />
          <Route path="/transcripts/:meetingId/summary" element={<ProtectedRoute><TranscriptSummary /></ProtectedRoute>} />
          <Route path="/qa" element={<ProtectedRoute><QADashboard /></ProtectedRoute>} />
          <Route path="/qa/:meetingId" element={<ProtectedRoute><QAMeeting /></ProtectedRoute>} />
          <Route path="/statistics" element={<ProtectedRoute><Statistics /></ProtectedRoute>} />
          <Route path="/devices" element={<ProtectedRoute><Devices /></ProtectedRoute>} />
          <Route path="/devices/:id" element={<ProtectedRoute><DeviceDetail /></ProtectedRoute>} />
          <Route path="/profile" element={<ProtectedRoute><Profile /></ProtectedRoute>} />
          <Route path="/settings" element={<ProtectedRoute><Settings /></ProtectedRoute>} />

          {/* Fallback */}
          <Route path="/system-health" element={<ProtectedRoute><SystemHealthPage /></ProtectedRoute>} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
    </div>
  );
}

export default App;