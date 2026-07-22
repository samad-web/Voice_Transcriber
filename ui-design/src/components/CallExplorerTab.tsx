import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Phone, 
  PhoneIncoming, 
  PhoneOutgoing, 
  Search, 
  Sparkles, 
  Clock, 
  Database, 
  UploadCloud, 
  Check, 
  Loader2, 
  Play, 
  Pause, 
  Volume2, 
  RefreshCw, 
  FileText, 
  CheckCircle2, 
  XCircle, 
  AlertCircle, 
  Calendar, 
  DollarSign, 
  X, 
  ChevronRight,
  ExternalLink,
  Smartphone,
  ShieldCheck,
  Zap,
  Tag
} from 'lucide-react';
import { Call, Device, TranscriptSegment } from '../types';

interface CallExplorerTabProps {
  calls: Call[];
  setCalls: React.Dispatch<React.SetStateAction<Call[]>>;
  devices: Device[];
}

// Preset templates for the Ingestion Simulator
interface SimulatorPreset {
  id: string;
  name: string;
  contactName: string;
  number: string;
  direction: 'Incoming' | 'Outgoing';
  device: string;
  model: string;
  audioSource: 'VOICE_CALL' | 'MIC';
  duration: number;
  transcript: TranscriptSegment[];
  summary: string;
  budget: string;
  intent: 'Hot' | 'Warm' | 'Cold';
  score: number;
  objections: string[];
  followUp: string;
}

const SIMULATOR_PRESETS: SimulatorPreset[] = [
  {
    id: 'preset-enterprise',
    name: 'B2B Software Deal (Hot Intent)',
    contactName: 'Nikhil Sen (VP Engineering, FinTech India)',
    number: '+91 94450 12345',
    direction: 'Outgoing',
    device: 'Mumbai Sales Desk #1',
    model: 'Google Pixel 7 Pro',
    audioSource: 'VOICE_CALL',
    duration: 165,
    transcript: [
      { speaker: 'Agent', text: 'Hi Nikhil, Amit here from CloudTech. Standard disclaimer: this call is captured for compliance audits.', time: '0:02' },
      { speaker: 'Customer', text: 'Yes, Amit, fine. We need a secure call recording solution. We have 150 sales agents on Android.', time: '0:12' },
      { speaker: 'Agent', text: 'Excellent. Our platform integrates directly with HubSpot and runs standard AES-256 at-rest encryption.', time: '0:22' },
      { speaker: 'Customer', text: 'Perfect. We have a budget of roughly $35,000 for this license. What is the deployment timeframe?', time: '0:34' },
      { speaker: 'Agent', text: 'We can enroll all 150 devices via MDM QR codes in under 15 minutes. Can we book a configuration demo tomorrow?', time: '0:48' },
      { speaker: 'Customer', text: 'Yes, let us do tomorrow at 11 AM. Send the link.', time: '1:02' }
    ],
    summary: 'Nikhil represents a 150-device opportunity for FinTech India. They have a budget of $35k and need a secure, compliant Android recording platform integrated with HubSpot. Demo scheduled for tomorrow at 11 AM.',
    budget: '$35,000 / year',
    intent: 'Hot',
    score: 95,
    objections: ['Requires bulk MDM enrollments', 'HubSpot deals sync must be instantaneous'],
    followUp: 'Demo booked tomorrow at 11 AM IST'
  },
  {
    id: 'preset-escalation',
    name: 'Support Complaint (High Severity)',
    contactName: 'Karan Mehra (Founder, Mehra Logistics)',
    number: '+91 80551 98765',
    direction: 'Incoming',
    device: 'Bangalore Field Rep #4',
    model: 'OnePlus 11 5G',
    audioSource: 'MIC',
    duration: 110,
    transcript: [
      { speaker: 'Agent', text: 'CloudTech Support, Rohan speaking. This call is recorded for quality monitoring.', time: '0:03' },
      { speaker: 'Customer', text: 'Rohan, I am extremely frustrated. Your Android app is showing "Accessibility Disabled" on our Samsung fleet and 5 reps missed recording compliance logs!', time: '0:15' },
      { speaker: 'Agent', text: 'I am very sorry to hear that, Karan. Sometimes Android power management puts accessibility services to sleep. Let me help you lock the app in RAM.', time: '0:28' },
      { speaker: 'Customer', text: 'This is costing us customer trust. If this accessibility issue keeps failing, we are going to cancel our contract next month.', time: '0:42' },
      { speaker: 'Agent', text: 'Understood. I will escalate this to our enterprise tier-3 support immediately and have an engineer call you back in 15 minutes to configure a persistent MDM policy.', time: '0:58' },
      { speaker: 'Customer', text: 'Okay. I expect a call in 15 minutes. Goodbye.', time: '1:10' }
    ],
    summary: 'Karan Mehra reported a critical accessibility service sleep issue on Samsung devices, leading to missing call logs. Threatened contract cancellation (churn threat). Escalated to Tier-3 support with a 15-min callback SLA.',
    budget: 'Contract value: $12k/yr',
    intent: 'Cold',
    score: 15,
    objections: ['System reliability concerns', 'Threatened to cancel next month (churn risk)'],
    followUp: 'Tier-3 callback within 15 minutes'
  }
];

export default function CallExplorerTab({ calls, setCalls, devices }: CallExplorerTabProps) {
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedIntent, setSelectedIntent] = useState<string>('All');
  const [selectedStatus, setSelectedStatus] = useState<string>('All');
  const [selectedCallId, setSelectedCallId] = useState<string | null>(null);
  
  // Drawer active tab
  const [drawerTab, setDrawerTab] = useState<'transcript' | 'insights' | 'crm'>('transcript');
  
  // Player state
  const [isPlaying, setIsPlaying] = useState(false);
  const [playerProgress, setPlayerProgress] = useState(0);
  const [playerDuration, setPlayerDuration] = useState(0);
  
  // CRM Sync Loading State
  const [isSyncingCrm, setIsSyncingCrm] = useState<string | null>(null);

  // Ingestion Simulator States
  const [isSimulatorOpen, setIsSimulatorOpen] = useState(false);
  const [selectedPresetId, setSelectedPresetId] = useState(SIMULATOR_PRESETS[0].id);
  const [simulatorStage, setSimulatorStage] = useState<'idle' | 'awaiting' | 'transcoding' | 'transcribing' | 'analyzing' | 'syncing' | 'complete'>('idle');
  const [simulatorLog, setSimulatorLog] = useState<string[]>([]);
  const [simulatedProgress, setSimulatedProgress] = useState(0);
  const [activeStreamingSegmentIdx, setActiveStreamingSegmentIdx] = useState<number>(-1);
  const [streamedSegments, setStreamedSegments] = useState<TranscriptSegment[]>([]);

  const selectedCall = calls.find(c => c.id === selectedCallId);

  // Audio player effect
  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (isPlaying && selectedCall) {
      setPlayerDuration(selectedCall.duration);
      interval = setInterval(() => {
        setPlayerProgress(prev => {
          if (prev >= selectedCall.duration) {
            setIsPlaying(false);
            return 0;
          }
          return prev + 1;
        });
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [isPlaying, selectedCallId]);

  // Handle call selection
  const handleSelectCall = (id: string) => {
    setSelectedCallId(id);
    setIsPlaying(false);
    setPlayerProgress(0);
    setDrawerTab('transcript');
  };

  // Format seconds to M:SS
  const formatTime = (secs: number) => {
    const mins = Math.floor(secs / 60);
    const remaining = secs % 60;
    return `${mins}:${remaining < 10 ? '0' : ''}${remaining}`;
  };

  // Filtered Calls
  const filteredCalls = calls.filter(call => {
    const matchesSearch = 
      call.remoteName.toLowerCase().includes(searchTerm.toLowerCase()) ||
      call.remoteNumber.includes(searchTerm) ||
      call.agentName.toLowerCase().includes(searchTerm.toLowerCase()) ||
      call.id.toLowerCase().includes(searchTerm.toLowerCase());
    
    const matchesIntent = selectedIntent === 'All' || call.leadIntent === selectedIntent;
    const matchesStatus = selectedStatus === 'All' || call.status === selectedStatus;

    return matchesSearch && matchesIntent && matchesStatus;
  });

  // Trigger simulated CRM sync
  const handleForceCrmSync = (callId: string) => {
    setIsSyncingCrm(callId);
    setTimeout(() => {
      setCalls(prev => prev.map(c => {
        if (c.id === callId) {
          return {
            ...c,
            crmSyncStatus: 'Synced',
            crmExternalId: `hs-deal-${Math.floor(100000 + Math.random() * 900000)}`,
            crmAttempts: c.crmAttempts + 1,
            crmError: undefined
          };
        }
        return c;
      }));
      setIsSyncingCrm(null);
    }, 1500);
  };

  // Start Ingestion Simulator
  const handleStartSimulator = () => {
    const preset = SIMULATOR_PRESETS.find(p => p.id === selectedPresetId);
    if (!preset) return;

    setSimulatorStage('awaiting');
    setSimulatedProgress(5);
    setStreamedSegments([]);
    setActiveStreamingSegmentIdx(-1);
    setSimulatorLog(['[07:38:55] PhoneStateReceiver: OFFHOOK detected.', '[07:38:55] Capture Engine: Starting VOICE_CALL hardware recorder.', '[07:38:57] PhoneStateReceiver: ONHOOK detected.', '[07:38:57] Storage: Compressed raw M4A chunk created (3.2MB).']);

    // Stage 1: Uploading & Awaiting
    setTimeout(() => {
      setSimulatorStage('transcoding');
      setSimulatedProgress(25);
      setSimulatorLog(prev => [...prev, '[07:38:59] S3 Ingest: Streaming multipart upload initiated.', '[07:39:01] S3 Ingest: Chunk 1-5 upload complete. SHA256 matches.', '[07:39:02] Pipeline: Ingest event published to RabbitMQ.', '[07:39:03] Transcoder: Re-sampling from 44.1kHz to optimized 16kHz mono.']);
    }, 2500);

    // Stage 2: Transcoding -> Transcribing
    setTimeout(() => {
      setSimulatorStage('transcribing');
      setSimulatedProgress(45);
      setSimulatorLog(prev => [...prev, '[07:39:05] Transcoder: Transcoded to 16kHz Opus mono. Metadata saved.', '[07:39:06] ASR Worker: Invoking diarized Whisper engine.', '[07:39:07] ASR Worker: Capturing word timestamps and separating speaker tracks...']);
      
      // Start streaming transcript segments typewriter style
      let segmentIdx = 0;
      const streamInterval = setInterval(() => {
        if (segmentIdx < preset.transcript.length) {
          setStreamedSegments(prev => [...prev, preset.transcript[segmentIdx]]);
          setActiveStreamingSegmentIdx(segmentIdx);
          setSimulatorLog(prev => [...prev, `[ASR Segment] ${preset.transcript[segmentIdx].speaker}: "${preset.transcript[segmentIdx].text.substring(0, 30)}..."`]);
          segmentIdx++;
        } else {
          clearInterval(streamInterval);
        }
      }, 1000);

    }, 5500);

    // Stage 3: Transcribing -> AI Analyzing
    setTimeout(() => {
      setSimulatorStage('analyzing');
      setSimulatedProgress(75);
      setSimulatorLog(prev => [...prev, '[07:39:14] ASR Worker: Transcription full text cached in Postgres.', '[07:39:15] AI Engine: Compiling prompt schemas for Agent: ' + preset.device, '[07:39:16] AI Engine: Invoking server-side Gemini 1.5 Flash in JSON mode.', '[07:39:17] AI Engine: Custom fields parsed. Budget, Intent, and Objections structured successfully.']);
    }, 12500);

    // Stage 4: AI Analyzing -> CRM Syncing
    setTimeout(() => {
      setSimulatorStage('syncing');
      setSimulatedProgress(90);
      setSimulatorLog(prev => [...prev, '[07:39:19] CRM Worker: Resolving HubSpot OAuth credentials.', '[07:39:20] CRM Worker: Creating HubSpot Contact cards and updating pipeline deals.']);
    }, 15500);

    // Stage 5: CRM Syncing -> Complete
    setTimeout(() => {
      setSimulatorStage('complete');
      setSimulatedProgress(100);
      setSimulatorLog(prev => [...prev, '[07:39:22] HubSpot: Sync Successful. External ID: hs-deal-simulated', '[07:39:22] Ingestion Engine: Pipeline run completed. State marked terminal: COMPLETE.']);

      // Add call to list
      const newCall: Call = {
        id: `call-sim-${Math.floor(100 + Math.random() * 900)}`,
        direction: preset.direction,
        remoteNumber: preset.number,
        remoteName: preset.contactName,
        startedAt: new Date().toISOString(),
        duration: preset.duration,
        audioSource: preset.audioSource,
        status: 'Complete',
        consentStatus: 'Verified (Played)',
        agentId: 'agent-sales',
        agentName: preset.name,
        deviceId: 'dev-1',
        deviceLabel: preset.device,
        deviceModel: preset.model,
        leadScore: preset.score,
        leadIntent: preset.intent,
        budget: preset.budget,
        followUpDate: preset.followUp,
        objections: preset.objections,
        summary: preset.summary,
        transcript: preset.transcript,
        crmSyncStatus: 'Synced',
        crmExternalId: `hs-deal-${Math.floor(100000 + Math.random() * 900000)}`,
        crmAttempts: 1
      };

      setCalls(prev => [newCall, ...prev]);
    }, 18000);
  };

  return (
    <div id="call-explorer-tab" className="space-y-5">
      
      {/* Search and Filters Toolbar */}
      <div className="bg-white p-4 rounded-none border-2 border-black shadow-xs flex flex-col md:flex-row justify-between items-center gap-4">
        <div className="relative w-full md:w-80">
          <Search className="absolute left-3.5 top-3 h-4.5 w-4.5 text-black" />
          <input
            type="text"
            placeholder="Search contact, number, or ID..."
            className="w-full pl-10 pr-4 py-2 border-2 border-black rounded-none text-sm focus:outline-hidden focus:border-black font-sans"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>
        
        <div className="flex flex-wrap items-center gap-3 w-full md:w-auto">
          {/* Intent Filter */}
          <div className="flex items-center gap-1.5 text-xs">
            <span className="text-neutral-400 font-mono font-bold uppercase tracking-wider">INTENT:</span>
            <select
              className="border-2 border-black rounded-none px-2.5 py-1.5 bg-white font-display font-bold text-black uppercase text-[10px] tracking-wider"
              value={selectedIntent}
              onChange={(e) => setSelectedIntent(e.target.value)}
            >
              <option value="All">All Intents</option>
              <option value="Hot">🔥 Hot</option>
              <option value="Warm">⚡ Warm</option>
              <option value="Cold">❄️ Cold</option>
              <option value="Unclassified">Unclassified</option>
            </select>
          </div>

          {/* Pipeline Status Filter */}
          <div className="flex items-center gap-1.5 text-xs">
            <span className="text-neutral-400 font-mono font-bold uppercase tracking-wider">STATUS:</span>
            <select
              className="border-2 border-black rounded-none px-2.5 py-1.5 bg-white font-display font-bold text-black uppercase text-[10px] tracking-wider"
              value={selectedStatus}
              onChange={(e) => setSelectedStatus(e.target.value)}
            >
              <option value="All">All Pipeline States</option>
              <option value="Complete">Complete</option>
              <option value="Failed">Failed</option>
              <option value="Awaiting Audio">Awaiting Audio</option>
            </select>
          </div>

          {/* Simulator Trigger */}
          <button
            onClick={() => {
              setIsSimulatorOpen(true);
              setSimulatorStage('idle');
            }}
            className="ml-auto md:ml-0 flex items-center gap-2 bg-black hover:bg-neutral-800 text-white font-sans text-xs font-bold uppercase tracking-wider px-4 py-2 border-2 border-black rounded-none transition-all"
            id="btn-simulator-trigger"
          >
            <UploadCloud className="h-4 w-4" />
            Live Ingestion Simulator
          </button>
        </div>
      </div>

      {/* Main Table Area */}
      <div className="bg-white rounded-none border-2 border-black shadow-xs overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[800px] text-left border-collapse">
            <thead>
              <tr className="bg-neutral-100 border-b-2 border-black font-mono text-[10px] text-black font-bold uppercase tracking-wider">
                <th className="py-3.5 px-5">ID / Date</th>
                <th className="py-3.5 px-4">Contact Person</th>
                <th className="py-3.5 px-4">Duration</th>
                <th className="py-3.5 px-4">Captured By</th>
                <th className="py-3.5 px-4 text-center">Pipeline Stage</th>
                <th className="py-3.5 px-4 text-center">AI Triage</th>
                <th className="py-3.5 px-4 text-right">CRM Sync</th>
              </tr>
            </thead>
            <tbody className="divide-y-2 divide-neutral-100 text-sm">
              {filteredCalls.length > 0 ? (
                filteredCalls.map((call) => {
                  const startedDate = new Date(call.startedAt);
                  const formattedDate = startedDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + startedDate.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
                  
                  return (
                    <tr 
                      key={call.id} 
                      onClick={() => handleSelectCall(call.id)}
                      className={`hover:bg-neutral-50 cursor-pointer transition-colors ${selectedCallId === call.id ? 'bg-neutral-100 font-bold' : ''}`}
                      id={`call-row-${call.id}`}
                    >
                      <td className="py-4 px-5">
                        <span className="font-mono text-xs font-bold text-black">#{call.id}</span>
                        <span className="text-[10px] text-neutral-400 block font-mono mt-0.5">{formattedDate}</span>
                      </td>
                      <td className="py-4 px-4">
                        <div className="flex items-center gap-2.5">
                          <div className={`p-1.5 rounded-none border border-black ${call.direction === 'Incoming' ? 'bg-black text-white' : 'bg-neutral-100 text-black'}`}>
                            {call.direction === 'Incoming' ? <PhoneIncoming className="h-3.5 w-3.5" /> : <PhoneOutgoing className="h-3.5 w-3.5" />}
                          </div>
                          <div>
                            <span className="font-display font-bold text-neutral-900 block">{call.remoteName}</span>
                            <span className="text-xs text-neutral-400 font-mono mt-0.5 block">{call.remoteNumber}</span>
                          </div>
                        </div>
                      </td>
                      <td className="py-4 px-4 font-mono text-xs text-black font-bold">
                        {formatTime(call.duration)}
                      </td>
                      <td className="py-4 px-4">
                        <span className="text-xs font-sans text-black block font-bold">{call.deviceLabel}</span>
                        <span className="text-[10px] font-mono text-neutral-400 block mt-0.5">{call.deviceModel}</span>
                      </td>
                      <td className="py-4 px-4 text-center">
                        <span className={`inline-flex items-center gap-1 text-[10px] font-bold font-mono px-2.5 py-1 rounded-none border border-black ${
                          call.status === 'Complete' ? 'bg-black text-white' :
                          call.status === 'Failed' ? 'bg-neutral-100 text-red-600' :
                          'bg-neutral-100 text-black animate-pulse'
                        }`}>
                          {call.status === 'Complete' && <Check className="h-3 w-3 text-white" />}
                          {call.status === 'Failed' && <X className="h-3 w-3 text-red-600" />}
                          {call.status !== 'Complete' && call.status !== 'Failed' && <Loader2 className="h-3 w-3 animate-spin" />}
                          {call.status.toUpperCase()}
                        </span>
                      </td>
                      <td className="py-4 px-4 text-center">
                        {call.status === 'Complete' ? (
                          <div className="flex items-center justify-center gap-2">
                            <span className={`inline-flex items-center gap-1 text-[9px] font-black uppercase tracking-wider font-mono px-2 py-0.5 rounded-none border border-black ${
                              call.leadIntent === 'Hot' ? 'bg-black text-white' :
                              call.leadIntent === 'Warm' ? 'bg-neutral-200 text-neutral-800' :
                              'bg-white text-neutral-500'
                            }`}>
                              {call.leadIntent}
                            </span>
                            <span className="text-xs font-mono font-black text-black">{call.leadScore}%</span>
                          </div>
                        ) : (
                          <span className="text-xs text-neutral-400 font-mono">—</span>
                        )}
                      </td>
                      <td className="py-4 px-5 text-right">
                        <span className={`inline-flex items-center gap-1 text-xs font-mono font-bold uppercase tracking-wide ${
                          call.crmSyncStatus === 'Synced' ? 'text-black font-black' :
                          call.crmSyncStatus === 'Failed' ? 'text-red-600' :
                          'text-neutral-500'
                        }`}>
                          {call.crmSyncStatus === 'Synced' ? 'HUBSPOT OK' : 
                           call.crmSyncStatus === 'Failed' ? 'SYNC FAIL' : 'PENDING'}
                          {call.crmSyncStatus === 'Synced' && <ExternalLink className="h-3 w-3" />}
                        </span>
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-neutral-400 font-mono font-bold uppercase">
                    No call logs found matching current search/filters
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Details Slide-Over Drawer Overlay */}
      <AnimatePresence>
        {selectedCallId && selectedCall && (
          <>
            {/* Backdrop */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 0.3 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 bg-black z-40"
              onClick={() => setSelectedCallId(null)}
            />
            
            {/* Drawer */}
            {/* Drawer */}
            <motion.div
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ type: 'tween', duration: 0.3 }}
              className="fixed right-0 top-0 bottom-0 w-full max-w-2xl bg-white shadow-none border-l-4 border-black z-50 flex flex-col justify-between"
              id="call-details-drawer"
            >
              {/* Header */}
              <div className="p-5 border-b-2 border-black flex justify-between items-start">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[9px] text-neutral-400 font-bold uppercase tracking-wider">CALL PROFILE RECORD</span>
                    <span className="w-1.5 h-1.5 bg-black rounded-none" />
                    <span className="font-mono text-xs font-bold text-black">#{selectedCall.id}</span>
                  </div>
                  <h3 className="text-2xl font-display font-black text-black uppercase tracking-tight">{selectedCall.remoteName}</h3>
                  <p className="text-xs text-neutral-400 font-mono font-bold uppercase">{selectedCall.remoteNumber} • Captured via {selectedCall.audioSource} ({selectedCall.deviceLabel})</p>
                </div>
                <button
                  onClick={() => setSelectedCallId(null)}
                  className="p-1.5 hover:bg-neutral-100 border border-black rounded-none transition-colors text-black"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              {/* Sub-Header Player */}
              <div className="px-5 py-4 bg-neutral-50 border-b-2 border-black flex items-center justify-between gap-4">
                <button
                  onClick={() => setIsPlaying(!isPlaying)}
                  disabled={selectedCall.status === 'Failed'}
                  className={`p-3.5 rounded-none border-2 border-black text-white flex-shrink-0 transition-all ${
                    selectedCall.status === 'Failed' 
                      ? 'bg-neutral-200 text-neutral-400 border-neutral-300 cursor-not-allowed' 
                      : isPlaying ? 'bg-black text-white hover:bg-neutral-800' : 'bg-black text-white hover:bg-neutral-800'
                  }`}
                >
                  {isPlaying ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5" />}
                </button>
                
                {/* Visual Audio Waveform Simulation */}
                <div className="flex-1 space-y-1.5">
                  <div className="flex justify-between text-[10px] font-mono text-neutral-400 font-bold uppercase tracking-wider">
                    <span>{formatTime(playerProgress)}</span>
                    <span className="flex items-center gap-1">
                      <Volume2 className="h-3 w-3 text-black" />
                      {selectedCall.status === 'Failed' ? 'Digital Silence Fallback' : '16kHz Mono Stream'}
                    </span>
                    <span>{formatTime(selectedCall.duration)}</span>
                  </div>
                  
                  {/* Waveform Bars */}
                  <div className="h-8 flex items-end gap-[2px] pt-1">
                    {Array.from({ length: 48 }).map((_, i) => {
                      // Generate stylized procedural heights
                      let heightPct = 15;
                      if (selectedCall.status !== 'Failed') {
                        // High wave variance based on speaking spikes
                        const speakerToggle = i % 8 < 4 ? 'Agent' : 'Customer';
                        heightPct = Math.sin(i * 0.4) * 35 + 50;
                        if (isPlaying) {
                          // Make active visual shifts
                          const offset = playerProgress * 1.5;
                          heightPct = Math.sin((i + offset) * 0.45) * 40 + 55;
                        }
                        // Zero out dead channels
                        if (i % 12 === 0 || i % 15 === 0) heightPct = 10;
                      }
                      
                      const isActiveBar = (i / 48) * selectedCall.duration <= playerProgress;

                      return (
                        <div
                          key={i}
                          className={`flex-1 rounded-none transition-all duration-300 ${
                            selectedCall.status === 'Failed' 
                              ? 'bg-red-200 h-[10%]' 
                              : isActiveBar 
                                ? 'bg-black' 
                                : 'bg-neutral-200'
                          }`}
                          style={{ height: `${Math.max(10, Math.min(100, heightPct))}%` }}
                        />
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* Drawer Content Area (Tabs list) */}
              <div className="flex border-b-2 border-black text-xs font-mono font-bold uppercase tracking-wider bg-neutral-100">
                <button
                  onClick={() => setDrawerTab('transcript')}
                  className={`flex-1 py-3 text-center border-b-4 transition-all ${drawerTab === 'transcript' ? 'border-black text-black bg-white font-black' : 'border-transparent text-neutral-400 hover:text-black'}`}
                >
                  <span className="flex items-center justify-center gap-1.5">
                    <FileText className="h-3.5 w-3.5" />
                    Transcript
                  </span>
                </button>
                <button
                  onClick={() => setDrawerTab('insights')}
                  className={`flex-1 py-3 text-center border-b-4 transition-all ${drawerTab === 'insights' ? 'border-black text-black bg-white font-black' : 'border-transparent text-neutral-400 hover:text-black'}`}
                >
                  <span className="flex items-center justify-center gap-1.5">
                    <Sparkles className="h-3.5 w-3.5" />
                    AI Intelligence
                  </span>
                </button>
                <button
                  onClick={() => setDrawerTab('crm')}
                  className={`flex-1 py-3 text-center border-b-4 transition-all ${drawerTab === 'crm' ? 'border-black text-black bg-white font-black' : 'border-transparent text-neutral-400 hover:text-black'}`}
                >
                  <span className="flex items-center justify-center gap-1.5">
                    <Database className="h-3.5 w-3.5" />
                    HubSpot Sync
                  </span>
                </button>
              </div>

              {/* Scrollable Tab Pane */}
              <div className="flex-1 overflow-y-auto p-5 bg-neutral-50">
                
                {/* 1. Transcript Pane */}
                {drawerTab === 'transcript' && (
                  <div className="space-y-4 font-sans">
                    {selectedCall.transcript.map((seg, idx) => {
                      const isAgent = seg.speaker === 'Agent';
                      return (
                        <div 
                          key={idx} 
                          className={`flex flex-col max-w-[85%] ${isAgent ? 'mr-auto items-start' : 'ml-auto items-end'}`}
                        >
                          <div className="flex items-center gap-2 mb-1">
                            <span className={`text-[10px] font-mono font-bold uppercase ${isAgent ? 'text-black' : 'text-neutral-500'}`}>
                              {isAgent ? 'REP (AGENT)' : 'CUSTOMER'}
                            </span>
                            <span className="text-[10px] text-neutral-400 font-mono">[{seg.time}]</span>
                          </div>
                          <div className={`p-3.5 rounded-none text-sm leading-relaxed border-2 border-black ${
                            isAgent 
                              ? 'bg-white text-black shadow-xs' 
                              : 'bg-black text-white shadow-xs'
                          }`}>
                            {seg.text}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* 2. AI Insights Pane */}
                {drawerTab === 'insights' && (
                  <div className="space-y-5 font-sans">
                    
                    {/* Executive Summary */}
                    <div className="bg-white p-4 rounded-none border-2 border-black shadow-xs">
                      <h4 className="text-xs font-mono text-black uppercase tracking-wider font-bold mb-2 flex items-center gap-1.5">
                        <Sparkles className="h-3.5 w-3.5 text-black" />
                        Executive Call Summary
                      </h4>
                      <p className="text-sm text-black leading-relaxed font-sans">{selectedCall.summary}</p>
                    </div>

                    {/* Quality Lead Score Gauge */}
                    <div className="bg-white p-4 rounded-none border-2 border-black shadow-xs">
                      <h4 className="text-xs font-mono text-black uppercase tracking-wider font-bold mb-3">Structured Extraction Findings</h4>
                      
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {/* Budget */}
                        <div className="bg-neutral-50 p-3 rounded-none border-2 border-black flex items-center gap-3">
                          <div className="p-2 bg-black text-white rounded-none border border-black">
                            <DollarSign className="h-4 w-4" />
                          </div>
                          <div>
                            <span className="text-[9px] text-neutral-400 block font-mono font-bold uppercase">Stated Budget</span>
                            <span className="text-sm font-display font-black text-black">{selectedCall.budget}</span>
                          </div>
                        </div>

                        {/* Follow-up */}
                        <div className="bg-neutral-50 p-3 rounded-none border-2 border-black flex items-center gap-3">
                          <div className="p-2 bg-black text-white rounded-none border border-black">
                            <Calendar className="h-4 w-4" />
                          </div>
                          <div>
                            <span className="text-[9px] text-neutral-400 block font-mono font-bold uppercase">Action Follow-up</span>
                            <span className="text-sm font-display font-black text-black">{selectedCall.followUpDate}</span>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Scorings & Intent Triage */}
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      {/* Intent */}
                      <div className="bg-white p-4 rounded-none border-2 border-black shadow-xs text-center flex flex-col justify-center items-center">
                        <span className="text-[9px] text-neutral-400 block font-mono uppercase font-bold tracking-wider">AI Intent Class</span>
                        <span className={`mt-2 inline-flex items-center gap-1.5 text-xs font-mono font-black px-3 py-1 rounded-none border-2 border-black ${
                          selectedCall.leadIntent === 'Hot' ? 'bg-black text-white' :
                          selectedCall.leadIntent === 'Warm' ? 'bg-neutral-200 text-black' :
                          'bg-white text-neutral-500'
                        }`}>
                          {selectedCall.leadIntent === 'Hot' ? '🔥 HOT' :
                           selectedCall.leadIntent === 'Warm' ? '⚡ WARM' : '❄️ COLD'}
                        </span>
                      </div>

                      {/* Score Gauge */}
                      <div className="bg-white p-4 rounded-none border-2 border-black shadow-xs text-center md:col-span-2">
                        <span className="text-[9px] text-neutral-400 block font-mono uppercase font-bold tracking-wider">Lead Qualification Score</span>
                        <div className="mt-3 flex items-center gap-4 justify-center md:justify-start">
                          <div className="relative flex items-center justify-center">
                            {/* Simple circular visual */}
                            <svg className="w-14 h-14 transform -rotate-90">
                              <circle cx="28" cy="28" r="24" fill="transparent" stroke="#E5E5E5" strokeWidth="6" />
                              <circle 
                                cx="28" cy="28" r="24" fill="transparent" 
                                stroke="#000000" 
                                strokeWidth="6" 
                                strokeDasharray="150"
                                strokeDashoffset={150 - (150 * selectedCall.leadScore) / 100}
                              />
                            </svg>
                            <span className="absolute text-xs font-mono font-black text-black">{selectedCall.leadScore}%</span>
                          </div>
                          <div className="text-left">
                            <span className="text-xs font-display font-black text-black uppercase tracking-tight block">
                              {selectedCall.leadScore > 75 ? 'Qualified Opportunity' : selectedCall.leadScore > 40 ? 'Moderate Interest - Warm' : 'Low Lead Potential'}
                            </span>
                            <span className="text-[9px] text-neutral-400 font-mono font-bold block uppercase mt-0.5">Scored by system agent version v{SIMULATOR_PRESETS[0].id ? '4' : '1'}</span>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Customer Objections */}
                    <div className="bg-white p-4 rounded-none border-2 border-black shadow-xs">
                      <h4 className="text-xs font-mono text-black uppercase tracking-wider font-bold mb-2 flex items-center gap-1.5">
                        <Tag className="h-3.5 w-3.5 text-black" />
                        Extracted Friction / Objections
                      </h4>
                      {selectedCall.objections.length > 0 ? (
                        <ul className="space-y-2 mt-2">
                          {selectedCall.objections.map((obj, idx) => (
                            <li key={idx} className="text-xs text-black flex items-start gap-2 leading-relaxed font-sans font-medium">
                              <span className="w-2.5 h-2.5 bg-black rounded-none flex-shrink-0 mt-1" />
                              {obj}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <span className="text-xs text-neutral-400 font-mono font-bold uppercase">No customer objections or bottlenecks detected in this conversation.</span>
                      )}
                    </div>

                  </div>
                )}

                {/* 3. CRM Sync Pane */}
                {drawerTab === 'crm' && (
                  <div className="space-y-5 font-sans">
                    
                    {/* Synced Card */}
                    <div className="bg-white p-5 rounded-none border-2 border-black shadow-xs flex flex-col items-center text-center">
                      <div className={`p-4 rounded-none border-2 border-black mb-3 ${
                        selectedCall.crmSyncStatus === 'Synced' ? 'bg-black text-white' : 'bg-neutral-100 text-black'
                      }`}>
                        {selectedCall.crmSyncStatus === 'Synced' ? (
                          <CheckCircle2 className="h-10 w-10 text-white" />
                        ) : (
                          <AlertCircle className="h-10 w-10 animate-pulse text-red-600" />
                        )}
                      </div>
                      
                      <h4 className="font-display font-black text-black text-base uppercase tracking-tight">
                        {selectedCall.crmSyncStatus === 'Synced' ? 'HubSpot Deal Synchronized' : 'CRM Integration Failure'}
                      </h4>
                      <p className="text-xs text-neutral-400 font-sans font-bold uppercase mt-1 max-w-sm">
                        {selectedCall.crmSyncStatus === 'Synced' 
                          ? 'This call transcript and key parameters have been automatically cataloged on your HubSpot sales dashboard.'
                          : 'The CRM Sync pipeline could not resolve an active OAuth connection with HubSpot.'
                        }
                      </p>

                      <div className="w-full bg-neutral-50 rounded-none p-4 border-2 border-black grid grid-cols-2 gap-4 mt-5 text-left font-mono text-xs">
                        <div>
                          <span className="text-[10px] text-neutral-400 font-bold uppercase">External ID</span>
                          <span className="font-black text-black mt-0.5 block">{selectedCall.crmExternalId}</span>
                        </div>
                        <div>
                          <span className="text-[10px] text-neutral-400 font-bold uppercase">Attempts</span>
                          <span className="font-black text-black mt-0.5 block">{selectedCall.crmAttempts} / 3</span>
                        </div>
                      </div>

                      {/* Error details if failed */}
                      {selectedCall.crmError && (
                        <div className="w-full bg-red-50 border-2 border-red-600 rounded-none p-3.5 text-left mt-4 flex gap-2.5">
                          <XCircle className="h-4 w-4 text-red-600 flex-shrink-0 mt-0.5" />
                          <div>
                            <span className="text-[10px] font-mono text-red-800 block uppercase font-bold">Error Log</span>
                            <p className="text-xs text-red-700 font-sans leading-relaxed mt-0.5 font-bold">{selectedCall.crmError}</p>
                          </div>
                        </div>
                      )}

                      <div className="flex gap-3 w-full mt-5">
                        <button
                          onClick={() => handleForceCrmSync(selectedCall.id)}
                          disabled={isSyncingCrm === selectedCall.id}
                          className="flex-1 flex items-center justify-center gap-2 border-2 border-black bg-white hover:bg-neutral-50 text-black font-display font-bold uppercase tracking-wider py-2.5 rounded-none transition-all cursor-pointer"
                        >
                          {isSyncingCrm === selectedCall.id ? (
                            <>
                              <Loader2 className="h-4 w-4 animate-spin text-black" />
                              PUSHING...
                            </>
                          ) : (
                            <>
                              <RefreshCw className="h-4.5 w-4.5 text-black" />
                              FORCE HUBSPOT PUSH
                            </>
                          )}
                        </button>
                      </div>
                    </div>

                  </div>
                )}

              </div>

              {/* Drawer Footer Status */}
              <div className="p-4 border-t-2 border-black bg-neutral-100 flex justify-between items-center text-xs text-black font-mono font-bold uppercase">
                <span className="flex items-center gap-1">
                  <ShieldCheck className="h-3.5 w-3.5 text-black" />
                  At-Rest AES-256 Enabled
                </span>
                <span>Jurisdiction: India (DPDP Compliant)</span>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Ingestion Simulator Modal */}
      <AnimatePresence>
        {isSimulatorOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            {/* Backdrop */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 0.5 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 bg-black"
              onClick={() => {
                if (simulatorStage === 'idle' || simulatorStage === 'complete') {
                  setIsSimulatorOpen(false);
                }
              }}
            />
            
            {/* Modal Box */}
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 15 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 15 }}
              className="bg-white rounded-none border-4 border-black w-full max-w-2xl overflow-hidden relative z-50 flex flex-col max-h-[85vh]"
            >
              <div className="p-5 border-b-2 border-black flex justify-between items-center bg-black text-white">
                <div className="flex items-center gap-2">
                  <Zap className="h-5 w-5 text-white" />
                  <h3 className="text-lg font-display font-black uppercase tracking-tight text-white">REAL-TIME PIPELINE SIMULATOR</h3>
                </div>
                {(simulatorStage === 'idle' || simulatorStage === 'complete') && (
                  <button
                    onClick={() => setIsSimulatorOpen(false)}
                    className="p-1 hover:bg-neutral-800 rounded-none border border-white text-white transition-colors"
                  >
                    <X className="h-5 w-5" />
                  </button>
                )}
              </div>

              {/* Main Dialog body */}
              <div className="p-6 flex-1 overflow-y-auto space-y-6">
                
                {/* 1. Selection screen */}
                {simulatorStage === 'idle' && (
                  <div className="space-y-4">
                    <p className="text-sm text-neutral-500 leading-relaxed font-sans font-medium">
                      This interactive tool demonstrates the multi-stage ingestion architecture. Select an Android call capture scenario below to execute the background workers, transcoder engines, diarized ASR, Gemini AI analysis, and CRM sync.
                    </p>

                    <div className="space-y-3 mt-4">
                      <span className="text-[10px] text-black font-mono uppercase font-bold tracking-wider block">Scenario Templates</span>
                      {SIMULATOR_PRESETS.map((preset) => (
                        <div
                          key={preset.id}
                          onClick={() => setSelectedPresetId(preset.id)}
                          className={`p-4 rounded-none border-2 cursor-pointer transition-all flex justify-between items-start ${
                            selectedPresetId === preset.id 
                              ? 'border-black bg-neutral-100 font-bold' 
                              : 'border-neutral-200 bg-white hover:bg-neutral-50'
                          }`}
                        >
                          <div className="space-y-1">
                            <span className="font-sans font-bold text-neutral-900 text-sm block">{preset.name}</span>
                            <span className="text-xs text-neutral-400 font-sans block">{preset.contactName} • ({preset.duration}s call)</span>
                          </div>
                          <span className={`text-[10px] font-mono font-bold uppercase tracking-wider px-2 py-0.5 rounded-none border border-black ${
                            preset.intent === 'Hot' ? 'bg-black text-white' : 'bg-neutral-200 text-black'
                          }`}>
                            {preset.intent} Intent
                          </span>
                        </div>
                      ))}
                    </div>

                    <div className="pt-4">
                      <button
                        onClick={handleStartSimulator}
                        className="w-full flex items-center justify-center gap-2 bg-black hover:bg-neutral-800 text-white font-display font-bold uppercase tracking-wider py-3 border-2 border-black rounded-none transition-all cursor-pointer"
                      >
                        <Play className="h-4.5 w-4.5" />
                        Initiate Pipeline Execution
                      </button>
                    </div>
                  </div>
                )}

                {/* 2. Executing Screen */}
                {simulatorStage !== 'idle' && (
                  <div className="space-y-6">
                    {/* Overall Progress */}
                    <div className="space-y-2">
                      <div className="flex justify-between items-center text-xs">
                        <span className="font-sans font-bold text-black uppercase tracking-wide flex items-center gap-2">
                          {simulatorStage === 'awaiting' && 'Step 1/5: S3 Uploading Chunks...'}
                          {simulatorStage === 'transcoding' && 'Step 2/5: Transcoding Audio...'}
                          {simulatorStage === 'transcribing' && 'Step 3/5: ASR Whisper Diarization...'}
                          {simulatorStage === 'analyzing' && 'Step 4/5: Gemini AI Structured Extraction...'}
                          {simulatorStage === 'syncing' && 'Step 5/5: HubSpot CRM Syncing...'}
                          {simulatorStage === 'complete' && '🎉 Pipeline Complete & Saved!'}
                        </span>
                        <span className="font-mono font-bold text-black">{simulatedProgress}%</span>
                      </div>
                      <div className="w-full bg-neutral-100 h-4 border-2 border-black rounded-none overflow-hidden">
                        <div 
                          className="h-full rounded-none transition-all duration-500 bg-black"
                          style={{ width: `${simulatedProgress}%` }}
                        />
                      </div>
                    </div>

                    {/* Stage Pipeline Node Visualizer */}
                    <div className="grid grid-cols-5 gap-2 text-center text-[10px] font-mono font-bold text-black">
                      <div className={`p-2 rounded-none border-2 flex flex-col justify-center items-center gap-1 ${
                        simulatorStage === 'awaiting' ? 'border-black bg-black text-white font-black' : 
                        ['transcoding', 'transcribing', 'analyzing', 'syncing', 'complete'].includes(simulatorStage) ? 'border-black bg-neutral-100 text-black' : 'border-neutral-200 text-neutral-400 bg-white'
                      }`}>
                        <Smartphone className="h-4 w-4" />
                        UPLOAD
                      </div>
                      <div className={`p-2 rounded-none border-2 flex flex-col justify-center items-center gap-1 ${
                        simulatorStage === 'transcoding' ? 'border-black bg-black text-white font-black' : 
                        ['transcribing', 'analyzing', 'syncing', 'complete'].includes(simulatorStage) ? 'border-black bg-neutral-100 text-black' : 'border-neutral-200 text-neutral-400 bg-white'
                      }`}>
                        <Volume2 className="h-4 w-4" />
                        CODEC
                      </div>
                      <div className={`p-2 rounded-none border-2 flex flex-col justify-center items-center gap-1 ${
                        simulatorStage === 'transcribing' ? 'border-black bg-black text-white font-black' : 
                        ['analyzing', 'syncing', 'complete'].includes(simulatorStage) ? 'border-black bg-neutral-100 text-black' : 'border-neutral-200 text-neutral-400 bg-white'
                      }`}>
                        <FileText className="h-4 w-4" />
                        ASR
                      </div>
                      <div className={`p-2 rounded-none border-2 flex flex-col justify-center items-center gap-1 ${
                        simulatorStage === 'analyzing' ? 'border-black bg-black text-white font-black' : 
                        ['syncing', 'complete'].includes(simulatorStage) ? 'border-black bg-neutral-100 text-black' : 'border-neutral-200 text-neutral-400 bg-white'
                      }`}>
                        <Sparkles className="h-4 w-4" />
                        AI WORK
                      </div>
                      <div className={`p-2 rounded-none border-2 flex flex-col justify-center items-center gap-1 ${
                        simulatorStage === 'syncing' ? 'border-black bg-black text-white font-black' : 
                        ['complete'].includes(simulatorStage) ? 'border-black bg-neutral-100 text-black' : 'border-neutral-200 text-neutral-400 bg-white'
                      }`}>
                        <Database className="h-4 w-4" />
                        SYNC
                      </div>
                    </div>

                    {/* Double-Channel Text Streaming Log (only in ASR stage) */}
                    {['transcribing', 'analyzing', 'syncing', 'complete'].includes(simulatorStage) && (
                      <div className="bg-black rounded-none p-4 text-xs font-mono text-white max-h-48 overflow-y-auto space-y-2 border-2 border-black">
                        <span className="text-[9px] text-neutral-400 block mb-2 uppercase tracking-wider font-bold">Typewriter ASR Stream log:</span>
                        {streamedSegments.map((seg, idx) => (
                          <div key={idx} className="leading-relaxed border-b border-neutral-900 pb-1">
                            <span className={seg.speaker === 'Agent' ? 'text-blue-300 font-bold' : 'text-purple-300 font-bold'}>
                              [{seg.speaker.toUpperCase()}]
                            </span>{' '}
                            <span className="text-neutral-200">{seg.text}</span>
                          </div>
                        ))}
                        {activeStreamingSegmentIdx < SIMULATOR_PRESETS.find(p => p.id === selectedPresetId)!.transcript.length - 1 && (
                          <div className="flex items-center gap-1.5 text-yellow-400 font-bold uppercase text-[10px]">
                            <Loader2 className="h-3 w-3 animate-spin" />
                            <span>ASR DECODING NEXT TURN...</span>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Console Logger Logs */}
                    <div className="bg-black text-green-400 rounded-none p-4 h-40 font-mono text-[11px] overflow-y-auto space-y-1.5 border-2 border-black">
                      {simulatorLog.map((log, idx) => (
                        <div key={idx} className="leading-relaxed">
                          {log}
                        </div>
                      ))}
                      {simulatorStage !== 'complete' && (
                        <div className="flex items-center gap-1.5 text-green-300 font-bold uppercase text-[10px]">
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          <span>Spawning background worker process...</span>
                        </div>
                      )}
                    </div>

                    {/* Finish Controls */}
                    {simulatorStage === 'complete' && (
                      <div className="pt-4 flex gap-3">
                        <button
                          onClick={() => {
                            setIsSimulatorOpen(false);
                            // Highlight the newly added call
                            const newlyAdded = calls[0];
                            if (newlyAdded) {
                              handleSelectCall(calls[0]?.id || 'call-sim-');
                            }
                          }}
                          className="flex-1 bg-black hover:bg-neutral-800 text-white font-display font-bold uppercase tracking-wider py-3 border-2 border-black rounded-none transition-all text-center cursor-pointer"
                        >
                          View Newly Ingested Call
                        </button>
                        <button
                          onClick={() => setSimulatorStage('idle')}
                          className="border-2 border-black bg-white hover:bg-neutral-50 text-black font-display font-bold uppercase tracking-wider py-3 rounded-none transition-all cursor-pointer"
                        >
                          Simulate Another
                        </button>
                      </div>
                    )}

                  </div>
                )}

              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

    </div>
  );
}
