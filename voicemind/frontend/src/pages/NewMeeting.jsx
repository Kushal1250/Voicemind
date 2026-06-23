// frontend/src/pages/NewMeeting.jsx
import React, { useEffect, useMemo, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import { Mic, Cpu, Globe, Loader2, Settings2 } from 'lucide-react';
import { toast } from 'react-toastify';
import AppShell from '../components/AppShell';
import { startMeeting } from '../store/slices/meetingsSlice';
import { fetchDevices } from '../store/slices/devicesSlice';

const NewMeeting = () => {
  const dispatch = useDispatch();
  const navigate = useNavigate();

  const { items: devices = [] } = useSelector((state) => state.devices || {});
  const { loading } = useSelector((state) => state.meetings || {});

  const [source, setSource] = useState('web');
  const [deviceId, setDeviceId] = useState('');
  const [language, setLanguage] = useState('auto');
  const [title, setTitle] = useState('');
  const [audioMode, setAudioMode] = useState('mic');
  const [noiseReduction, setNoiseReduction] = useState(true);
  const [sampleRate, setSampleRate] = useState(48000);
  const [step, setStep] = useState('setup');

  useEffect(() => {
    dispatch(fetchDevices());
  }, [dispatch]);

  const onlineDevices = useMemo(() => {
    return devices.filter((device) => device?.status === 'online');
  }, [devices]);

  const handleStart = async () => {
    if (source === 'esp32' && !deviceId) {
      toast.error('Please select a device');
      return;
    }

    setStep('starting');

    try {
      const payload = {
        source,
        deviceId: source === 'esp32' ? deviceId : null,
        language,
        title: title?.trim() || `Meeting ${new Date().toLocaleString()}`,
      };

      if (source === 'web') {
        payload.audioMode = audioMode;
        payload.noiseReduction = noiseReduction;
        payload.sampleRate = sampleRate;
      }

      const result = await dispatch(startMeeting(payload)).unwrap();

      toast.success('Meeting started');

      if (source === 'esp32') {
        navigate('/live', {
          state: {
            queuedMeetingId: result?.meetingId || result?._id || null,
            deviceId,
          },
        });
      } else {
        navigate(`/meetings/${result?._id || result?.meetingId}`);
      }
    } catch (error) {
      toast.error(error?.message || error || 'Failed to start meeting');
      setStep('setup');
    }
  };

  return (
    <AppShell>
      <div className="max-w-3xl mx-auto">
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-white">New Meeting</h1>
          <p className="text-slate-400 mt-1">Start a new recording session</p>
        </div>

        {step === 'setup' && (
          <div className="surface-card p-6 space-y-6">
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-3">
                Recording Source
              </label>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <button
                  type="button"
                  onClick={() => setSource('web')}
                  className={`p-4 rounded-xl border-2 text-left transition-all ${
                    source === 'web'
                      ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/20'
                      : 'border-white/10 hover:border-gray-300'
                  }`}
                >
                  <div className="flex items-center gap-3 mb-2">
                    <div
                      className={`w-10 h-10 rounded-lg flex items-center justify-center ${
                        source === 'web'
                          ? 'bg-primary-600'
                          : 'bg-gray-100 dark:bg-slate-800'
                      }`}
                    >
                      <Globe
                        className={`w-5 h-5 ${
                          source === 'web' ? 'text-white' : 'text-gray-600'
                        }`}
                      />
                    </div>
                    <div className="font-medium text-white">Web Browser</div>
                  </div>
                  <p className="text-sm text-slate-400">
                    Record using browser microphone
                  </p>
                </button>

                <button
                  type="button"
                  onClick={() => setSource('esp32')}
                  className={`p-4 rounded-xl border-2 text-left transition-all ${
                    source === 'esp32'
                      ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/20'
                      : 'border-white/10 hover:border-gray-300'
                  }`}
                >
                  <div className="flex items-center gap-3 mb-2">
                    <div
                      className={`w-10 h-10 rounded-lg flex items-center justify-center ${
                        source === 'esp32'
                          ? 'bg-primary-600'
                          : 'bg-gray-100 dark:bg-slate-800'
                      }`}
                    >
                      <Cpu
                        className={`w-5 h-5 ${
                          source === 'esp32' ? 'text-white' : 'text-gray-600'
                        }`}
                      />
                    </div>
                    <div className="font-medium text-white">ESP32 Device</div>
                  </div>
                  <p className="text-sm text-slate-400">
                    Record using ESP32 hardware microphone
                  </p>
                </button>
              </div>
            </div>

            {source === 'esp32' && (
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">
                  Select Device
                </label>

                {onlineDevices.length === 0 ? (
                  <div className="p-4 rounded-lg text-sm bg-yellow-50 dark:bg-yellow-900/20 text-yellow-800 dark:text-yellow-400">
                    No online devices found. Please ensure your ESP32 is powered
                    on and connected.
                  </div>
                ) : (
                  <>
                    <select
                      value={deviceId}
                      onChange={(e) => setDeviceId(e.target.value)}
                      className="w-full px-4 py-2 border border-white/10 rounded-lg bg-transparent text-white"
                    >
                      <option value="">Select a device...</option>
                      {onlineDevices.map((device) => (
                        <option
                          key={device.deviceId}
                          value={device.deviceId}
                          className="text-black"
                        >
                          {device.name} ({device.deviceId}) - Signal:{' '}
                          {device.telemetry?.rssi ?? 'N/A'} dBm
                        </option>
                      ))}
                    </select>

                    <p className="mt-2 text-xs text-slate-400">
                      Supported meeting languages: Auto, Gujarati, Hindi, and
                      English.
                    </p>
                  </>
                )}
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-slate-300 mb-2">
                Language
              </label>

              <select
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
                className="w-full px-4 py-2 border border-white/10 rounded-lg bg-transparent text-white"
              >
                <option value="auto" className="text-black">
                  Auto Detect (Recommended)
                </option>
                <option value="gu" className="text-black">
                  Gujarati
                </option>
                <option value="hi" className="text-black">
                  Hindi
                </option>
                <option value="en" className="text-black">
                  English
                </option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-300 mb-2">
                Meeting Title (Optional)
              </label>

              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={`Meeting ${new Date().toLocaleString()}`}
                className="w-full px-4 py-2 border border-white/10 rounded-lg bg-transparent text-white placeholder:text-slate-500"
              />
            </div>

            {source === 'web' && (
              <div className="rounded-xl border border-gray-200 dark:border-slate-800 p-5 space-y-4 bg-white/5">
                <div className="flex items-center gap-2 text-sm font-medium text-slate-300">
                  <Settings2 className="w-4 h-4" />
                  Browser Audio Settings
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-2">
                    Audio Input
                  </label>
                  <select
                    value={audioMode}
                    onChange={(e) => setAudioMode(e.target.value)}
                    className="w-full px-4 py-2 border border-white/10 rounded-lg bg-transparent text-white"
                  >
                    <option value="mic" className="text-black">
                      Microphone Only
                    </option>
                    <option value="mic_system" className="text-black">
                      Microphone + System Audio
                    </option>
                  </select>
                  <p className="text-xs text-slate-400 mt-2">
                    System audio capture depends on Chrome or Edge screen-share
                    permissions.
                  </p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-2">
                    Noise Reduction
                  </label>
                  <select
                    value={noiseReduction ? 'enabled' : 'disabled'}
                    onChange={(e) =>
                      setNoiseReduction(e.target.value === 'enabled')
                    }
                    className="w-full px-4 py-2 border border-white/10 rounded-lg bg-transparent text-white"
                  >
                    <option value="enabled" className="text-black">
                      Enabled
                    </option>
                    <option value="disabled" className="text-black">
                      Disabled
                    </option>
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-2">
                    Audio Quality
                  </label>
                  <select
                    value={sampleRate}
                    onChange={(e) => setSampleRate(Number(e.target.value))}
                    className="w-full px-4 py-2 border border-white/10 rounded-lg bg-transparent text-white"
                  >
                    <option value={48000} className="text-black">
                      High 48kHz
                    </option>
                    <option value={44100} className="text-black">
                      Standard 44.1kHz
                    </option>
                    <option value={32000} className="text-black">
                      Balanced 32kHz
                    </option>
                    <option value={16000} className="text-black">
                      Speech 16kHz
                    </option>
                  </select>
                </div>
              </div>
            )}

            <button
              type="button"
              onClick={handleStart}
              disabled={loading || (source === 'esp32' && onlineDevices.length === 0)}
              className="w-full btn-primary py-3 flex items-center justify-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {loading ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : (
                <>
                  <Mic className="w-5 h-5" />
                  Start Recording
                </>
              )}
            </button>
          </div>
        )}

        {step === 'starting' && (
          <div className="surface-card p-12 text-center">
            <div className="w-16 h-16 bg-primary-100 dark:bg-primary-900/30 rounded-full flex items-center justify-center mx-auto mb-4">
              <Loader2 className="w-8 h-8 text-primary-600 animate-spin" />
            </div>
            <h3 className="text-lg font-semibold text-white mb-2">
              Starting Recording...
            </h3>
            <p className="text-slate-400">
              Preparing the meeting and connecting to the selected source.
            </p>
          </div>
        )}
      </div>
    </AppShell>
  );
};

export default NewMeeting;