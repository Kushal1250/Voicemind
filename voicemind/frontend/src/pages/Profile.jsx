import React, { useState } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { toast } from 'react-toastify';
import { User, Mail, Save, Sparkles, Shield } from 'lucide-react';
import AppShell from '../components/AppShell';
import { updateProfile } from '../store/slices/authSlice';

const Profile = () => {
  const dispatch = useDispatch();
  const { user, loading } = useSelector((state) => state.auth);
  const [formData, setFormData] = useState({
    displayName: user?.displayName || user?.name || '',
    email: user?.email || '',
  });

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      await dispatch(updateProfile({ displayName: formData.displayName })).unwrap();
      toast.success('Profile updated successfully');
    } catch (err) {
      toast.error(err || 'Update failed');
    }
  };

  const getInitials = (name) => {
    if (!name) return 'U';
    return name.split(' ').map((n) => n[0]).join('').toUpperCase().slice(0, 2);
  };

  return (
    <AppShell>
      <div className="mx-auto max-w-2xl space-y-6">
        <section className="glass-panel overflow-hidden p-6 sm:p-8">
          <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-primary-500/20 bg-primary-500/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.24em] text-primary-200">
            <Sparkles className="h-3.5 w-3.5" />
            Account
          </div>
          <div className="flex items-center gap-5">
            <div className="flex h-16 w-16 flex-shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-primary-500 to-indigo-500 text-xl font-bold text-white shadow-lg shadow-primary-900/30">
              {getInitials(user?.name || user?.displayName)}
            </div>
            <div>
              <h1 className="section-title text-3xl">{user?.name || user?.displayName || 'Your profile'}</h1>
              <p className="section-subtitle">{user?.email}</p>
            </div>
          </div>
        </section>

        <div className="surface-card p-6">
          <h3 className="mb-5 text-base font-semibold text-white">Edit profile</h3>
          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label className="mb-2 block text-sm font-medium text-slate-300">Display name</label>
              <div className="relative">
                <User className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                <input
                  type="text"
                  value={formData.displayName}
                  onChange={(e) => setFormData({ ...formData, displayName: e.target.value })}
                  className="input-field pl-10"
                  placeholder="Your display name"
                />
              </div>
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium text-slate-300">Email address</label>
              <div className="relative">
                <Mail className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                <input
                  type="email"
                  value={formData.email}
                  disabled
                  className="input-field pl-10 opacity-50 cursor-not-allowed"
                />
              </div>
              <p className="mt-1.5 flex items-center gap-1.5 text-xs text-slate-500">
                <Shield className="h-3.5 w-3.5" /> Email address cannot be changed
              </p>
            </div>

            <button type="submit" disabled={loading} className="btn-primary">
              <Save className="h-4 w-4" />
              {loading ? 'Saving...' : 'Save changes'}
            </button>
          </form>
        </div>

        <div className="surface-card p-6">
          <h3 className="mb-4 text-base font-semibold text-white">Account info</h3>
          <div className="space-y-3 text-sm">
            <div className="flex items-center justify-between py-2 border-b border-white/5">
              <span className="text-slate-400">Member since</span>
              <span className="text-white">{user?.createdAt ? new Date(user.createdAt).toLocaleDateString() : 'N/A'}</span>
            </div>
            <div className="flex items-center justify-between py-2 border-b border-white/5">
              <span className="text-slate-400">Last login</span>
              <span className="text-white">{user?.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString() : 'N/A'}</span>
            </div>
            <div className="flex items-center justify-between py-2">
              <span className="text-slate-400">Role</span>
              <span className="status-pill online capitalize">{user?.role || 'user'}</span>
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  );
};

export default Profile;