import React, { useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import { Cpu, Wifi, WifiOff, ArrowLeft, Signal, Clock, MemoryStick, HardDrive, Activity, Sparkles } from 'lucide-react';
import AppShell from '../components/AppShell';
import { fetchDeviceById } from '../store/slices/devicesSlice';

const StatRow = ({ label, value, icon: Icon }) => (
  <div className="flex items-center justify-between py-3 border-b border-white/5 last:border-0">
    <div className="flex items-center gap-2 text-sm text-slate-400">
      {Icon && <Icon className="h-4 w-4" />}
      {label}
    </div>
    <span className="text-sm font-semibold text-white">{value ?? 'N/A'}</span>
  </div>
);

const DeviceDetail = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const dispatch = useDispatch();
  const { currentDevice, loading } = useSelector((state) => state.devices);

  useEffect(() => {
    dispatch(fetchDeviceById(id));
  }, [id, dispatch]);

  if (loading) {
    return (
      <AppShell>
        <div className="space-y-6">
          <div className="skeleton h-40 w-full rounded-2xl" />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="skeleton h-64 rounded-2xl" />
            <div className="skeleton h-64 rounded-2xl" />
          </div>
        </div>
      </AppShell>
    );
  }

  if (!currentDevice) {
    return (
      <AppShell>
        <div className="surface-card flex flex-col items-center justify-center py-20 text-center">
          <Cpu className="mb-4 h-12 w-12 text-slate-500 opacity-40" />
          <p className="text-lg font-semibold text-white">Device not found</p>
          <p className="mt-2 text-sm text-slate-400">This device may have been removed or the ID is incorrect.</p>
          <button onClick={() => navigate('/devices')} className="btn-secondary mt-6">
            <ArrowLeft className="h-4 w-4" /> Back to devices
          </button>
        </div>
      </AppShell>
    );
  }

  const isOnline = currentDevice.status === 'online';

  return (
    <AppShell>
      <div className="space-y-6">
        <section className="glass-panel overflow-hidden p-6 sm:p-8">
          <div className="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <button onClick={() => navigate('/devices')} className="mb-4 inline-flex items-center gap-2 text-sm text-slate-400 hover:text-white transition">
                <ArrowLeft className="h-4 w-4" /> All devices
              </button>
              <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-primary-500/20 bg-primary-500/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.24em] text-primary-200">
                <Sparkles className="h-3.5 w-3.5" />
                Device detail
              </div>
              <h1 className="section-title text-3xl">{currentDevice.name || currentDevice.deviceId}</h1>
              <p className="section-subtitle mt-1 font-mono text-xs">{currentDevice.deviceId}</p>
            </div>
            <div className="flex items-center gap-3">
              <span className={`status-pill ${isOnline ? 'online' : 'idle'}`}>
                {isOnline ? <><Wifi className="h-3 w-3" /> Online</> : <><WifiOff className="h-3 w-3" /> Offline</>}
              </span>
            </div>
          </div>
        </section>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div className="surface-card p-6">
            <div className="mb-4 flex items-center gap-2 text-base font-semibold text-white">
              <Activity className="h-5 w-5 text-primary-300" />
              Connection info
            </div>
            <StatRow label="Status" value={currentDevice.status} icon={Wifi} />
            <StatRow label="IP Address" value={currentDevice.telemetry?.ip} icon={Signal} />
            <StatRow label="Signal (RSSI)" value={currentDevice.telemetry?.rssi !== undefined ? `${currentDevice.telemetry.rssi} dBm` : null} icon={Signal} />
            <StatRow label="Last seen" value={currentDevice.lastSeenAt ? new Date(currentDevice.lastSeenAt).toLocaleString() : null} icon={Clock} />
            <StatRow label="Uptime" value={currentDevice.telemetry?.uptimeSec !== undefined ? `${Math.floor(currentDevice.telemetry.uptimeSec / 60)}m ${currentDevice.telemetry.uptimeSec % 60}s` : null} icon={Clock} />
          </div>

          <div className="surface-card p-6">
            <div className="mb-4 flex items-center gap-2 text-base font-semibold text-white">
              <Cpu className="h-5 w-5 text-violet-300" />
              Hardware info
            </div>
            <StatRow label="Firmware" value={currentDevice.telemetry?.firmware} icon={Cpu} />
            <StatRow label="Free heap" value={currentDevice.telemetry?.freeHeap !== undefined ? `${(currentDevice.telemetry.freeHeap / 1024).toFixed(1)} KB` : null} icon={MemoryStick} />
            <StatRow label="Free SPIFFS" value={currentDevice.telemetry?.freeSPIFFS !== undefined ? `${(currentDevice.telemetry.freeSPIFFS / 1024).toFixed(1)} KB` : null} icon={HardDrive} />
            <StatRow label="PSRAM" value={currentDevice.telemetry?.psram !== undefined ? `${(currentDevice.telemetry.psram / 1024).toFixed(1)} KB` : null} icon={MemoryStick} />
            <StatRow label="Chunk duration" value={currentDevice.telemetry?.chunkDuration !== undefined ? `${currentDevice.telemetry.chunkDuration}s` : null} icon={Clock} />
          </div>
        </div>

        {currentDevice.currentMeetingId && (
          <div className="surface-card p-6">
            <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-amber-300">
              <span className="h-2.5 w-2.5 rounded-full bg-red-400 animate-pulse" />
              Active recording in progress
            </div>
            <p className="text-sm text-slate-400">Meeting ID: <span className="font-mono text-white">{currentDevice.currentMeetingId}</span></p>
          </div>
        )}
      </div>
    </AppShell>
  );
};

export default DeviceDetail;