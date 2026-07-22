import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Smartphone, 
  Battery, 
  Cpu, 
  Wifi, 
  HardDrive, 
  ShieldAlert, 
  Lock, 
  Unlock, 
  RefreshCw, 
  SlidersHorizontal, 
  Loader2, 
  CheckCircle, 
  AlertTriangle, 
  Power,
  X,
  Info,
  Check
} from 'lucide-react';
import { Device } from '../types';

interface DevicesTabProps {
  devices: Device[];
  setDevices: React.Dispatch<React.SetStateAction<Device[]>>;
}

export default function DevicesTab({ devices, setDevices }: DevicesTabProps) {
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>(devices[0]?.id || '');
  const [isWiping, setIsWiping] = useState<string | null>(null);
  const [isSyncing, setIsSyncing] = useState<string | null>(null);

  // OTA remote config state
  const [wifiOnly, setWifiOnly] = useState(true);
  const [silenceThreshold, setSilenceThreshold] = useState(-55); // dB
  const [localRetention, setLocalRetention] = useState(0); // days
  const [forceConsentTone, setForceConsentTone] = useState(true);
  const [showConfigToast, setShowConfigToast] = useState(false);

  const activeDevice = devices.find(d => d.id === selectedDeviceId);

  // Trigger simulated wipe
  const handleRemoteWipe = (id: string) => {
    setIsWiping(id);
    setTimeout(() => {
      setDevices(prev => prev.map(d => {
        if (d.id === id) {
          return {
            ...d,
            status: 'Wiped',
            accessibilityEnabled: false,
            batteryLevel: 0,
            storageFreeMB: 0,
            pendingUploads: 0,
            lastSeen: 'Just Now'
          };
        }
        return d;
      }));
      setIsWiping(null);
    }, 2000);
  };

  // Trigger simulated remote logout
  const handleRemoteLogout = (id: string) => {
    setDevices(prev => prev.map(d => {
      if (d.id === id) {
        return {
          ...d,
          status: 'Logged Out',
          accessibilityEnabled: false,
          lastSeen: 'Just Now'
        };
      }
      return d;
    }));
  };

  // Re-connect device helper for demo
  const handleReconnectDevice = (id: string) => {
    setDevices(prev => prev.map(d => {
      if (d.id === id) {
        return {
          ...d,
          status: 'Active',
          accessibilityEnabled: true,
          batteryLevel: 92,
          storageFreeMB: 34000,
          lastSeen: 'Just Now'
        };
      }
      return d;
    }));
  };

  // Trigger Force Health Sync
  const handleForceHealthSync = (id: string) => {
    setIsSyncing(id);
    setTimeout(() => {
      setDevices(prev => prev.map(d => {
        if (d.id === id) {
          return {
            ...d,
            lastSeen: 'Just Now',
            batteryLevel: Math.min(100, d.batteryLevel + 1),
            storageFreeMB: d.storageFreeMB - 120, // simulate storage use shift
            lastUploadAt: 'Just Now'
          };
        }
        return d;
      }));
      setIsSyncing(null);
    }, 1500);
  };

  // Push OTA Remote Configuration overrides
  const handlePushRemoteConfig = () => {
    setShowConfigToast(true);
    setTimeout(() => {
      setShowConfigToast(false);
    }, 3000);
  };

  return (
    <div id="devices-tab" className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      
      {/* Sidebar Device List */}
      <div className="bg-white p-5 rounded-none border-2 border-black shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] space-y-4">
        <h4 className="text-xs font-mono text-black uppercase tracking-wider font-bold">Enrolled Handsets</h4>
        
        <div className="space-y-3">
          {devices.map((dev) => (
            <div
              key={dev.id}
              onClick={() => setSelectedDeviceId(dev.id)}
              className={`p-4 rounded-none border-2 text-left cursor-pointer transition-all relative ${
                selectedDeviceId === dev.id 
                  ? 'border-black bg-neutral-100 font-bold shadow-[2px_2px_0px_0px_rgba(0,0,0,1)]' 
                  : 'border-neutral-200 bg-white hover:bg-neutral-50'
              }`}
              id={`device-row-${dev.id}`}
            >
              <div className="flex justify-between items-start gap-2">
                <div className="flex gap-2.5 items-start">
                  <div className={`p-1.5 rounded-none border border-black mt-0.5 ${
                    dev.status === 'Wiped' ? 'bg-red-500 text-white' :
                    dev.status === 'Logged Out' ? 'bg-neutral-200 text-black' :
                    'bg-black text-white'
                  }`}>
                    <Smartphone className="h-4 w-4" />
                  </div>
                  <div className="space-y-0.5">
                    <span className="font-display font-black uppercase tracking-tight text-black text-xs block leading-snug">{dev.label}</span>
                    <span className="text-[10px] font-mono text-neutral-400 block font-bold">{dev.model}</span>
                  </div>
                </div>
                
                <span className={`text-[9px] font-mono font-bold uppercase px-1.5 py-0.5 rounded-none border border-black ${
                  dev.status === 'Active' ? 'bg-black text-white' :
                  dev.status === 'Wiped' ? 'bg-red-500 text-white animate-pulse' :
                  'bg-neutral-200 text-black'
                }`}>
                  {dev.status}
                </span>
              </div>

              {/* Status footer inside row */}
              {dev.status === 'Active' && (
                <div className="mt-3 pt-2.5 border-t border-neutral-200 flex justify-between items-center text-[10px] text-black font-mono font-bold uppercase">
                  <span className="flex items-center gap-1">
                    <Battery className={`h-3.5 w-3.5 ${dev.batteryLevel < 20 ? 'text-red-600' : 'text-black'}`} />
                    {dev.batteryLevel}%
                  </span>
                  <span>SEEN: {dev.lastSeen.toUpperCase()}</span>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Main Console Area */}
      {activeDevice ? (
        <div className="lg:col-span-2 space-y-6">
          
          {/* Handset Health Detail Box */}
          <div className="bg-white p-5 rounded-none border-2 border-black shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] space-y-5">
            <div className="flex justify-between items-start border-b-2 border-black pb-4 flex-wrap gap-2">
              <div className="flex gap-3 items-center">
                <div className="p-3 bg-black text-white rounded-none border-2 border-black">
                  <Smartphone className="h-6 w-6" />
                </div>
                <div>
                  <span className="text-[10px] font-mono text-neutral-400 uppercase font-bold block">Android MDM Core Endpoint</span>
                  <h3 className="text-xl font-display font-black text-black leading-snug uppercase tracking-tight">{activeDevice.label}</h3>
                  <p className="text-[10px] text-neutral-500 font-mono font-bold uppercase">ID: {activeDevice.id} • OS: {activeDevice.osVersion} • Build: {activeDevice.appVersion}</p>
                </div>
              </div>
              
              {/* Trigger Reconnect for Wiped/Logged out if demo purposes */}
              {activeDevice.status !== 'Active' && (
                <button
                  onClick={() => handleReconnectDevice(activeDevice.id)}
                  className="text-xs font-display font-bold uppercase tracking-wider bg-white hover:bg-neutral-50 border-2 border-black text-black px-3.5 py-2 rounded-none cursor-pointer"
                >
                  SIMULATE RECONNECT
                </button>
              )}
            </div>

            {/* Health Meter Gauges */}
            {activeDevice.status === 'Active' ? (
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                
                {/* Battery */}
                <div className="bg-neutral-50 p-4 rounded-none border-2 border-black flex flex-col justify-between">
                  <span className="text-[9px] text-neutral-400 font-mono block uppercase font-bold">Battery Status</span>
                  <div className="flex items-center gap-2.5 mt-3">
                    <Battery className={`h-6 w-6 ${activeDevice.batteryLevel < 20 ? 'text-red-600 animate-bounce' : 'text-black'}`} />
                    <span className="text-xl font-black font-mono text-black">{activeDevice.batteryLevel}%</span>
                  </div>
                  <span className="text-[9px] text-neutral-500 block mt-2 font-mono font-bold uppercase">
                    {activeDevice.batteryLevel < 20 ? 'CRITICAL (CHARGE NOW)' : 'DISCHARGING'}
                  </span>
                </div>

                {/* Storage */}
                <div className="bg-neutral-50 p-4 rounded-none border-2 border-black flex flex-col justify-between">
                  <span className="text-[9px] text-neutral-400 font-mono block uppercase font-bold">Free Storage</span>
                  <div className="flex items-center gap-2 mt-3">
                    <HardDrive className="h-5 w-5 text-black" />
                    <span className="text-lg font-black font-mono text-black">
                      {(activeDevice.storageFreeMB / 1024).toFixed(1)} GB
                    </span>
                  </div>
                  <div className="w-full bg-neutral-200 h-3 border-2 border-black rounded-none overflow-hidden mt-3">
                    <div className="bg-black h-full rounded-none" style={{ width: '45%' }} />
                  </div>
                </div>

                {/* Accessibility Status */}
                <div className="bg-neutral-50 p-4 rounded-none border-2 border-black flex flex-col justify-between col-span-1 md:col-span-2">
                  <span className="text-[9px] text-neutral-400 font-mono block uppercase font-bold">Accessibility Capture Service</span>
                  <div className="flex items-center gap-2 mt-2.5">
                    {activeDevice.accessibilityEnabled ? (
                      <CheckCircle className="h-5 w-5 text-black" />
                    ) : (
                      <AlertTriangle className="h-5 w-5 text-red-600 animate-pulse" />
                    )}
                    <span className="text-xs font-display font-black uppercase tracking-tight text-black">
                      {activeDevice.accessibilityEnabled ? 'SERVICE OPERATIONAL' : 'SERVICE BLOCKED / INACTIVE'}
                    </span>
                  </div>
                  <p className="text-[10px] text-neutral-600 leading-relaxed font-sans font-medium mt-2">
                    {activeDevice.accessibilityEnabled 
                      ? 'Service successfully capturing OFFHOOK call screen states in background.'
                      : 'WARNING: Automatic VoIP metadata capture and background call-state tracking will fail until user re-enables accessibility service in settings.'
                    }
                  </p>
                </div>

              </div>
            ) : (
              <div className="bg-neutral-50 border-2 border-black rounded-none p-5 text-center py-10">
                <AlertTriangle className="h-8 w-8 text-black mx-auto mb-2 animate-pulse" />
                <h4 className="font-display font-black uppercase text-black text-sm tracking-tight">HANDSET IS DISCONNECTED</h4>
                <p className="text-xs text-neutral-500 font-sans font-medium mt-1 max-w-md mx-auto">
                  This device was wiped or logged out by administrative directive. No health logs are available.
                </p>
              </div>
            )}

            {/* Hardware-Based Recording Capture Capability Profile */}
            <div className="bg-neutral-50 rounded-none p-4 border-2 border-black space-y-3">
              <span className="text-[9px] text-neutral-400 block font-mono uppercase tracking-wider font-bold">Hardware Capability Profile</span>
              
              <div className="flex items-start gap-3">
                <Cpu className="h-5 w-5 text-black flex-shrink-0 mt-0.5" />
                <div>
                  <span className="text-xs font-display font-black uppercase text-black block">
                    Recording Driver Level: {activeDevice.captureCapability}
                  </span>
                  
                  <p className="text-[11px] text-neutral-600 leading-relaxed mt-1 font-sans font-medium">
                    {activeDevice.captureCapability.includes('Full Duplex') && 
                      'This handset is verified to support full duplex native voice-call streams. Uplink and downlink audio channels are successfully mixed on this OS vendor profile.'
                    }
                    {activeDevice.captureCapability.includes('Near End') && 
                      'Warning: Hardware restrictions prevent downlink capture. The client app will automatically lock the device speakerphone to acoustically record the far end on the mic.'
                    }
                    {activeDevice.captureCapability.includes('Unsupported') && 
                      'CRITICAL: This vendor explicitly filters third-party microphone access during voice-call streams, resulting in digital silence. Automatic call recordings are blocked.'
                    }
                  </p>
                </div>
              </div>
            </div>

            {/* Remote Trigger Commands */}
            <div className="pt-2">
              <h4 className="text-xs font-mono text-black uppercase tracking-wider mb-3 font-bold">Admin OTA Directives</h4>
              <div className="flex flex-wrap gap-3">
                {/* Trigger Config Sync */}
                <button
                  onClick={() => handleForceHealthSync(activeDevice.id)}
                  disabled={isSyncing === activeDevice.id || activeDevice.status !== 'Active'}
                  className="flex items-center gap-2 border-2 border-black bg-white hover:bg-neutral-50 disabled:bg-neutral-200 disabled:text-neutral-400 text-black font-display font-bold uppercase tracking-wider px-4 py-2.5 rounded-none transition-all cursor-pointer shadow-[2px_2px_0px_0px_rgba(0,0,0,1)]"
                >
                  {isSyncing === activeDevice.id ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin text-black" />
                      SYNCING...
                    </>
                  ) : (
                    <>
                      <RefreshCw className="h-4 w-4 text-black animate-spin" style={{ animationDuration: '3s' }} />
                      FORCE HEALTH FETCH
                    </>
                  )}
                </button>

                {/* Remote Logout */}
                <button
                  onClick={() => handleRemoteLogout(activeDevice.id)}
                  disabled={activeDevice.status !== 'Active'}
                  className="flex items-center gap-2 border-2 border-black bg-white hover:bg-neutral-50 disabled:bg-neutral-200 disabled:text-neutral-400 text-black font-display font-bold uppercase tracking-wider px-4 py-2.5 rounded-none transition-all cursor-pointer shadow-[2px_2px_0px_0px_rgba(0,0,0,1)]"
                >
                  <Unlock className="h-4 w-4 text-black" />
                  REMOTE LOGOUT
                </button>

                {/* Remote Wipe */}
                <button
                  onClick={() => handleRemoteWipe(activeDevice.id)}
                  disabled={isWiping === activeDevice.id || activeDevice.status !== 'Active'}
                  className="flex items-center gap-2 bg-red-500 hover:bg-red-600 disabled:bg-neutral-200 disabled:text-neutral-400 border-2 border-black text-white font-display font-bold uppercase tracking-wider px-4 py-2.5 rounded-none transition-all cursor-pointer shadow-[2px_2px_0px_0px_rgba(0,0,0,1)]"
                >
                  {isWiping === activeDevice.id ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin text-white" />
                      WIPING STORAGE...
                    </>
                  ) : (
                    <>
                      <Lock className="h-4 w-4 text-white animate-pulse" />
                      REMOTE WIPE HANDSET
                    </>
                  )}
                </button>
              </div>
            </div>

          </div>

          {/* Remote Configuration document overrides */}
          {activeDevice.status === 'Active' && (
            <div className="bg-white p-5 rounded-none border-2 border-black shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] space-y-4">
              <div>
                <h4 className="text-lg font-display font-black uppercase text-black tracking-tight">REMOTE APP SETTINGS PROFILE</h4>
                <p className="text-xs text-neutral-400 font-sans font-medium mt-0.5">Push real-time capture policies overrides directly to the active handset</p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-5 pt-2 text-xs font-sans">
                {/* Upload Constraint */}
                <div className="space-y-2 border-2 border-black bg-neutral-50 p-4 rounded-none flex justify-between items-center">
                  <div>
                    <span className="font-display font-black text-black block uppercase text-xs">Restrict Upload to WiFi</span>
                    <span className="text-[10px] text-neutral-400 block mt-0.5">Defer uploads if handset is on mobile cellular data</span>
                  </div>
                  <input
                    type="checkbox"
                    className="h-5 w-5 text-black rounded-none border-2 border-black focus:ring-0 focus:ring-offset-0 cursor-pointer"
                    checked={wifiOnly}
                    onChange={(e) => setWifiOnly(e.target.checked)}
                  />
                </div>

                {/* Silence Threshold */}
                <div className="space-y-1.5 border-2 border-black bg-neutral-50 p-4 rounded-none">
                  <div className="flex justify-between font-display font-black uppercase text-xs">
                    <span className="text-black">Silence Gate Threshold</span>
                    <span className="font-mono text-black">{silenceThreshold} dB</span>
                  </div>
                  <input
                    type="range"
                    min="-80"
                    max="-30"
                    className="w-full h-3 bg-neutral-200 border-2 border-black rounded-none appearance-none cursor-pointer accent-black mt-2"
                    value={silenceThreshold}
                    onChange={(e) => setSilenceThreshold(Number(e.target.value))}
                  />
                  <span className="text-[9px] text-neutral-500 block mt-1 font-mono font-bold uppercase">Reject audio streams flatter than this decibel ceiling</span>
                </div>

                {/* Local Retention */}
                <div className="space-y-1.5 border-2 border-black bg-neutral-50 p-4 rounded-none">
                  <span className="font-display font-black uppercase text-xs text-black block">Local Cache Retention</span>
                  <select
                    className="w-full p-2 border-2 border-black bg-white rounded-none text-xs mt-2 text-black font-bold uppercase focus:ring-0 focus:outline-none"
                    value={localRetention}
                    onChange={(e) => setLocalRetention(Number(e.target.value))}
                  >
                    <option value="0">0 Days (Delete locally on upload verify)</option>
                    <option value="3">3 Days cached backup</option>
                    <option value="7">7 Days cached backup</option>
                  </select>
                </div>

                {/* Force play tone */}
                <div className="space-y-2 border-2 border-black bg-neutral-50 p-4 rounded-none flex justify-between items-center">
                  <div>
                    <span className="font-display font-black text-black block uppercase text-xs">Mandate Consent Tone</span>
                    <span className="text-[10px] text-neutral-400 block mt-0.5">Force local device hardware beep on call connected</span>
                  </div>
                  <input
                    type="checkbox"
                    className="h-5 w-5 text-black rounded-none border-2 border-black focus:ring-0 focus:ring-offset-0 cursor-pointer"
                    checked={forceConsentTone}
                    onChange={(e) => setForceConsentTone(e.target.checked)}
                  />
                </div>
              </div>

              <div className="pt-2 flex justify-end relative">
                <button
                  onClick={handlePushRemoteConfig}
                  className="flex items-center gap-1.5 text-xs bg-black text-white hover:bg-neutral-800 font-display font-bold uppercase tracking-wider px-4 py-2.5 rounded-none border-2 border-black transition-all cursor-pointer shadow-[2px_2px_0px_0px_rgba(0,0,0,1)]"
                  id="btn-push-config"
                >
                  PUSH CONFIG OVERRIDES
                </button>

                {/* Push Toast Notification */}
                <AnimatePresence>
                  {showConfigToast && (
                    <motion.div
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: 10 }}
                      className="absolute bottom-14 right-0 bg-black text-white text-xs px-3.5 py-2.5 rounded-none flex items-center gap-2 border-2 border-white font-mono uppercase tracking-wider font-bold shadow-2xl z-25"
                    >
                      <Check className="h-4 w-4" />
                      OTA Pushed & Acknowledged!
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

            </div>
          )}

        </div>
      ) : (
        <div className="lg:col-span-2 py-12 text-center text-black font-display font-black uppercase bg-white rounded-none border-2 border-black shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]">
          No device selected. Select a handset to inspect health and OTA metrics.
        </div>
      )}

    </div>
  );
}
