import React, { useEffect } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import { Cpu, Wifi, WifiOff, ArrowRight, Signal, Clock, Sparkles } from 'lucide-react';
import AppShell from '../components/AppShell';
import { fetchDevices } from '../store/slices/devicesSlice';

const Devices = () => {
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const { items, loading } = useSelector((state) => state.devices);

  useEffect(() => {
    dispatch(fetchDevices());
  }, [dispatch]);

  const onlineCount = items.filter((d) => d.status === 'online').length;

  return (
    <AppShell>
      <div className="space-y-6">
        <section className="glass-panel overflow-hidden p-6 sm:p-8">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-primary-500/20 bg-primary-500/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.24em] text-primary-200">
                <Sparkles className="h-3.5 w-3.5" />
                Hardware fleet
              </div>
              <h1 className="section-title text-3xl">Registered devices</h1>
              <p className="section-subtitle mt-2 max-w-xl">
                Monitor ESP32 hardware status, signal strength, and firmware versions in real time.
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              <div className="surface-card-soft flex items-center gap-3 px-4 py-3 text-sm">
                <span className="h-2.5 w-2.5 rounded-full bg-green-400 animate-pulse" />
                <span className="text-white font-semibold">{onlineCount}</span>
                <span className="text-slate-400">online</span>
              </div>
              <div className="surface-card-soft flex items-center gap-3 px-4 py-3 text-sm">
                <span className="h-2.5 w-2.5 rounded-full bg-slate-500" />
                <span className="text-white font-semibold">{items.length - onlineCount}</span>
                <span className="text-slate-400">offline</span>
              </div>
            </div>
          </div>
        </section>

        {loading ? (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="surface-card p-6"><div className="skeleton h-40 w-full" /></div>
            ))}
          </div>
        ) : items.length === 0 ? (
          <div className="surface-card flex flex-col items-center justify-center py-20 text-center">
            <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl border border-white/10 bg-white/5">
              <Cpu className="h-8 w-8 text-slate-500" />
            </div>
            <p className="text-lg font-semibold text-white">No devices registered</p>
            <p className="mt-2 text-sm text-slate-400 max-w-sm">
              Power on your ESP32 device and it will appear here once it sends its first heartbeat.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {items.map((device) => (
              <button
                key={device.deviceId}
                onClick={() => navigate(`/devices/${device.deviceId}`)}
                className="surface-card card-hover group p-6 text-left w-full"
              >
                <div className="flex items-start justify-between mb-5">
                  <div className={`flex h-14 w-14 items-center justify-center rounded-2xl ${
                    device.status === 'online'
                      ? 'bg-gradient-to-br from-green-500/20 to-emerald-500/10 border border-green-500/20'
                      : 'bg-white/5 border border-white/10'
                  }`}>
                    <Cpu className={`h-7 w-7 ${device.status === 'online' ? 'text-green-300' : 'text-slate-500'}`} />
                  </div>
                  <span className={`status-pill ${device.status === 'online' ? 'online' : 'idle'}`}>
                    {device.status === 'online' ? <><Wifi className="h-3 w-3" /> Online</> : <><WifiOff className="h-3 w-3" /> Offline</>}
                  </span>
                </div>
                <div className="mb-4">
                  <h3 className="text-base font-semibold text-white truncate">{device.name || device.deviceId}</h3>
                  <p className="mt-1 text-xs text-slate-500 truncate font-mono">{device.deviceId}</p>
                </div>
                <div className="space-y-2.5 text-xs text-slate-400">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2"><Signal className="h-3.5 w-3.5" /><span>Signal</span></div>
                    <span className="text-white font-medium">{device.telemetry?.rssi !== undefined ? `${device.telemetry.rssi} dBm` : 'N/A'}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2"><Cpu className="h-3.5 w-3.5" /><span>Firmware</span></div>
                    <span className="text-white font-medium">{device.telemetry?.firmware || 'N/A'}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2"><Clock className="h-3.5 w-3.5" /><span>Last seen</span></div>
                    <span className="text-white font-medium">{device.lastSeenAt ? new Date(device.lastSeenAt).toLocaleTimeString() : 'Unknown'}</span>
                  </div>
                </div>
                <div className="mt-5 flex items-center justify-between border-t border-white/10 pt-4">
                  <span className="text-xs text-slate-500">View details</span>
                  <ArrowRight className="h-4 w-4 text-slate-500 transition group-hover:text-primary-300 group-hover:translate-x-1" />
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
};

export default Devices;