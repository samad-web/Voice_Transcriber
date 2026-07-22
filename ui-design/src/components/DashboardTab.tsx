import React from 'react';
import { motion } from 'motion/react';
import { 
  ResponsiveContainer, 
  AreaChart, 
  Area, 
  XAxis, 
  YAxis, 
  Tooltip, 
  PieChart, 
  Pie, 
  Cell, 
  Legend, 
  BarChart, 
  Bar 
} from 'recharts';
import { 
  Phone, 
  Activity, 
  HardDrive, 
  DollarSign, 
  AlertCircle, 
  TrendingUp, 
  CheckCircle2, 
  ShieldAlert 
} from 'lucide-react';
import { Call, Device } from '../types';

interface DashboardTabProps {
  calls: Call[];
  devices: Device[];
}

export default function DashboardTab({ calls, devices }: DashboardTabProps) {
  // Aggregate data
  const totalCalls = calls.length;
  const completedCalls = calls.filter(c => c.status === 'Complete').length;
  const failedCalls = calls.filter(c => c.status === 'Failed').length;
  
  // Calculate capture success rate
  const successRate = totalCalls > 0 ? ((completedCalls / (totalCalls)) * 100).toFixed(1) : '0';
  
  const totalDurationMinutes = Math.round(
    calls.reduce((acc, call) => acc + call.duration, 0) / 60
  );
  
  const activeDevices = devices.filter(d => d.status === 'Active').length;
  const accessibilityEnabledCount = devices.filter(d => d.status === 'Active' && d.accessibilityEnabled).length;
  
  // Custom mock data for timeline charts (e.g. last 7 days of platform ingestion)
  const chartData = [
    { day: 'Jul 13', volume: 45, success: 42, cost: 2.1 },
    { day: 'Jul 14', volume: 52, success: 49, cost: 2.6 },
    { day: 'Jul 15', volume: 68, success: 62, cost: 3.4 },
    { day: 'Jul 16', volume: 72, success: 68, cost: 3.8 },
    { day: 'Jul 17', volume: 85, success: 81, cost: 4.3 },
    { day: 'Jul 18', volume: 94, success: 90, cost: 4.8 },
    { day: 'Jul 19', volume: 104, success: 99, cost: 5.2 },
  ];

  // Lead intent distribution for Pie Chart
  const intentCounts = calls.reduce((acc: { [key: string]: number }, call) => {
    if (call.status === 'Complete') {
      acc[call.leadIntent] = (acc[call.leadIntent] || 0) + 1;
    }
    return acc;
  }, {});

  const pieData = [
    { name: 'Hot Leads', value: intentCounts['Hot'] || 0, color: '#F59E0B' }, // Warm/amber
    { name: 'Warm Leads', value: intentCounts['Warm'] || 0, color: '#3B82F6' }, // Blue
    { name: 'Cold Leads', value: intentCounts['Cold'] || 0, color: '#6B7280' }, // Slate gray
  ].filter(item => item.value > 0);

  // Success rate by device OEM classification
  const deviceSuccessData = [
    { name: 'Pixel (Certified)', rate: 98, color: '#10B981' },
    { name: 'Samsung (Certified)', rate: 95, color: '#10B981' },
    { name: 'OnePlus (Fallback)', rate: 74, color: '#F59E0B' },
    { name: 'Redmi (Blocked)', rate: 0, color: '#EF4444' },
  ];

  return (
    <div id="dashboard-tab" className="space-y-6">
      {/* Overview Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
        
        {/* KPI 1: Call Capture Success Rate */}
        <motion.div 
          initial={{ opacity: 0, y: 15 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
          className="bg-white p-5 rounded-none border-2 border-black shadow-xs flex flex-col justify-between"
          id="kpi-capture-rate"
        >
          <div className="flex justify-between items-start">
            <div>
              <p className="text-[10px] font-mono text-neutral-400 uppercase tracking-[0.2em] font-bold">Capture Success</p>
              <h3 className="text-4xl font-display font-black text-black mt-2">{successRate}%</h3>
            </div>
            <div className="p-2 bg-black text-white rounded-none">
              <Activity className="h-5 w-5" />
            </div>
          </div>
          <div className="mt-4 pt-3 border-t border-neutral-200 flex items-center text-[10px] font-mono text-neutral-500 gap-1.5 uppercase tracking-wider font-bold">
            <CheckCircle2 className="h-3.5 w-3.5 text-black" />
            <span>98% certified google/samsung</span>
          </div>
        </motion.div>

        {/* KPI 2: Total Recorded Minutes */}
        <motion.div 
          initial={{ opacity: 0, y: 15 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.05 }}
          className="bg-white p-5 rounded-none border-2 border-black shadow-xs flex flex-col justify-between"
          id="kpi-recorded-minutes"
        >
          <div className="flex justify-between items-start">
            <div>
              <p className="text-[10px] font-mono text-neutral-400 uppercase tracking-[0.2em] font-bold">Recorded Time</p>
              <h3 className="text-4xl font-display font-black text-black mt-2">{totalDurationMinutes} <span className="text-lg font-normal text-neutral-400 uppercase font-mono tracking-tight">MINS</span></h3>
            </div>
            <div className="p-2 bg-black text-white rounded-none">
              <Phone className="h-5 w-5" />
            </div>
          </div>
          <div className="mt-4 pt-3 border-t border-neutral-200 flex items-center text-[10px] font-mono text-neutral-500 gap-1.5 uppercase tracking-wider font-bold">
            <TrendingUp className="h-3.5 w-3.5 text-black" />
            <span>+1,204 mins uploaded</span>
          </div>
        </motion.div>

        {/* KPI 3: Fleet Device Health */}
        <motion.div 
          initial={{ opacity: 0, y: 15 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.1 }}
          className="bg-white p-5 rounded-none border-2 border-black shadow-xs flex flex-col justify-between"
          id="kpi-device-health"
        >
          <div className="flex justify-between items-start">
            <div>
              <p className="text-[10px] font-mono text-neutral-400 uppercase tracking-[0.2em] font-bold">Fleet Device Health</p>
              <h3 className="text-4xl font-display font-black text-black mt-2">
                {accessibilityEnabledCount}/{activeDevices} <span className="text-xs uppercase bg-black text-white px-2 py-0.5 font-mono ml-1 font-bold">ACTIVE</span>
              </h3>
            </div>
            <div className="p-2 bg-black text-white rounded-none">
              <HardDrive className="h-5 w-5" />
            </div>
          </div>
          <div className="mt-4 pt-3 border-t border-neutral-200 flex items-center text-[10px] font-mono text-neutral-500 gap-1.5 uppercase tracking-wider font-bold">
            <AlertCircle className="h-3.5 w-3.5 text-black" />
            <span>
              {activeDevices - accessibilityEnabledCount > 0 
                ? `${activeDevices - accessibilityEnabledCount} DEVS DISABLED!`
                : 'All devices operational'
              }
            </span>
          </div>
        </motion.div>

        {/* KPI 4: Monthly AI Cost Attribution */}
        <motion.div 
          initial={{ opacity: 0, y: 15 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.15 }}
          className="bg-white p-5 rounded-none border-2 border-black shadow-xs flex flex-col justify-between"
          id="kpi-ai-cost"
        >
          <div className="flex justify-between items-start">
            <div>
              <p className="text-[10px] font-mono text-neutral-400 uppercase tracking-[0.2em] font-bold">AI Monthly Spend Cap</p>
              <h3 className="text-4xl font-display font-black text-black mt-2">$142.50 <span className="text-xs font-mono text-neutral-400 font-bold uppercase">/ $500</span></h3>
            </div>
            <div className="p-2 bg-black text-white rounded-none">
              <DollarSign className="h-5 w-5" />
            </div>
          </div>
          <div className="mt-4 w-full">
            <div className="w-full bg-neutral-200 h-2.5 rounded-none border border-black overflow-hidden">
              <div className="bg-black h-full rounded-none" style={{ width: '28.5%' }} />
            </div>
            <div className="flex justify-between items-center text-[9px] text-neutral-500 mt-1.5 font-mono font-bold uppercase tracking-wider">
              <span>28.5% CONSUMED</span>
              <span>$357.50 LEFT</span>
            </div>
          </div>
        </motion.div>

      </div>

      {/* Main Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        
        {/* Call Ingestion Success Timeline Area Chart */}
        <div className="bg-white p-5 rounded-none border-2 border-black shadow-xs lg:col-span-2">
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 mb-6">
            <div>
              <h4 className="text-base font-display font-black text-black uppercase tracking-tight">Call Ingest & Pipeline Health</h4>
              <p className="text-xs text-neutral-400 mt-0.5">Automated S3 uploads and ASR + AI extraction pipelines</p>
            </div>
            <div className="flex gap-4 text-[10px] font-mono font-bold uppercase tracking-wider">
              <span className="flex items-center gap-1.5 text-neutral-900">
                <span className="w-2.5 h-2.5 bg-black rounded-none inline-block" />
                Upload Volume
              </span>
              <span className="flex items-center gap-1.5 text-neutral-500">
                <span className="w-2.5 h-2.5 bg-neutral-400 rounded-none inline-block" />
                Ingest Success
              </span>
            </div>
          </div>
          
          <div className="h-72 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 10, right: 10, left: -25, bottom: 0 }}>
                <defs>
                  <linearGradient id="colorVolume" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#000000" stopOpacity={0.15}/>
                    <stop offset="95%" stopColor="#000000" stopOpacity={0}/>
                  </linearGradient>
                  <linearGradient id="colorSuccess" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#4B5563" stopOpacity={0.15}/>
                    <stop offset="95%" stopColor="#4B5563" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <XAxis dataKey="day" tickLine={false} axisLine={false} tick={{ fill: '#1A1A1A', fontSize: 10, fontFamily: 'monospace', fontWeight: 'bold' }} />
                <YAxis tickLine={false} axisLine={false} tick={{ fill: '#1A1A1A', fontSize: 10, fontFamily: 'monospace', fontWeight: 'bold' }} />
                <Tooltip 
                  contentStyle={{ backgroundColor: '#000000', borderRadius: '0px', border: 'none', color: '#fff' }}
                  labelStyle={{ fontWeight: 'bold', fontSize: '11px', fontFamily: 'monospace', color: '#9CA3AF' }}
                />
                <Area type="monotone" dataKey="volume" stroke="#000000" strokeWidth={3} fillOpacity={1} fill="url(#colorVolume)" name="Upload Volume" />
                <Area type="monotone" dataKey="success" stroke="#6B7280" strokeWidth={2} fillOpacity={1} fill="url(#colorSuccess)" name="Ingest Success" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Lead Quality Distribution Pie Chart */}
        <div className="bg-white p-5 rounded-none border-2 border-black shadow-xs">
          <div className="mb-4">
            <h4 className="text-base font-display font-black text-black uppercase tracking-tight">AI Lead Intent Triage</h4>
            <p className="text-xs text-neutral-400 mt-0.5">Real-time intent classification from sales transcripts</p>
          </div>
          
          <div className="h-56 w-full flex items-center justify-center relative">
            {pieData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={pieData}
                    cx="50%"
                    cy="50%"
                    innerRadius={65}
                    outerRadius={85}
                    paddingAngle={4}
                    dataKey="value"
                  >
                    {pieData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.name === 'Hot Leads' ? '#000000' : entry.name === 'Warm Leads' ? '#6B7280' : '#D1D5DB'} />
                    ))}
                  </Pie>
                  <Tooltip 
                    contentStyle={{ backgroundColor: '#000000', borderRadius: '0px', border: 'none', color: '#fff', fontSize: '12px' }}
                  />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <div className="text-xs text-neutral-400 font-mono font-bold uppercase">No qualified call audio data available</div>
            )}
            <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
              <span className="text-4xl font-display font-black text-black">{calls.filter(c => c.status === 'Complete').length}</span>
              <span className="text-[10px] text-neutral-400 uppercase font-mono tracking-[0.15em] font-bold mt-1">AI SCORED</span>
            </div>
          </div>

          {/* Pie Custom Legend */}
          <div className="space-y-2 mt-2">
            {pieData.map((item, index) => (
              <div key={index} className="flex justify-between items-center text-xs">
                <div className="flex items-center gap-2">
                  <span className="w-3 h-3 rounded-none inline-block border border-black" style={{ backgroundColor: item.name === 'Hot Leads' ? '#000000' : item.name === 'Warm Leads' ? '#6B7280' : '#D1D5DB' }} />
                  <span className="text-neutral-700 font-display font-bold uppercase text-[10px] tracking-wider">{item.name}</span>
                </div>
                <span className="font-mono text-black font-black text-xs">
                  {item.value} ({Math.round((item.value / completedCalls) * 100)}%)
                </span>
              </div>
            ))}
          </div>
        </div>

      </div>

      {/* Bottom Insights Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        
        {/* Device Compliance & Success Block Rate */}
        <div className="bg-white p-5 rounded-none border-2 border-black shadow-xs">
          <div>
            <h4 className="text-base font-display font-black text-black uppercase tracking-tight">OEM Hardware Compatibility Audit</h4>
            <p className="text-xs text-neutral-400 mt-0.5">Real recording success rate based on Android manufacturer restrictions</p>
          </div>
          
          <div className="mt-6 space-y-4">
            {deviceSuccessData.map((device, idx) => (
              <div key={idx} className="space-y-1.5">
                <div className="flex justify-between text-[11px] font-mono font-bold uppercase tracking-wider">
                  <span className="text-neutral-700 font-sans">{device.name}</span>
                  <span className={`font-black ${device.rate > 90 ? 'text-black' : device.rate > 50 ? 'text-neutral-500' : 'text-neutral-400'}`}>
                    {device.rate > 0 ? `${device.rate}% Success` : 'Blocked by OEM OS'}
                  </span>
                </div>
                <div className="w-full bg-neutral-200 h-2.5 rounded-none border border-neutral-300 overflow-hidden">
                  <div className="h-full rounded-none" style={{ width: `${device.rate}%`, backgroundColor: device.rate > 90 ? '#000000' : device.rate > 50 ? '#6B7280' : '#D1D5DB' }} />
                </div>
              </div>
            ))}
          </div>

          <div className="border-l-4 border-black bg-neutral-50 p-4 rounded-none flex gap-3 mt-5">
            <ShieldAlert className="h-5 w-5 text-black flex-shrink-0 mt-0.5" />
            <p className="text-[11px] text-neutral-800 leading-relaxed font-sans">
              <strong className="uppercase font-bold block mb-1">Enterprise Advisory:</strong> Android 13/14 restrictions on accessibility and microphone mapping block standard background capture on Xiaomi and OnePlus models without custom system profiles or forced speakerphone setups.
            </p>
          </div>
        </div>

        {/* Active Workspace / Team Insights */}
        <div className="bg-white p-5 rounded-none border-2 border-black shadow-xs flex flex-col justify-between">
          <div>
            <h4 className="text-base font-display font-black text-black uppercase tracking-tight">Workspace Pipeline Efficiency</h4>
            <p className="text-xs text-neutral-400 mt-0.5">Real-time tracking of platform pipeline speed thresholds</p>
          </div>

          <div className="grid grid-cols-3 gap-3 my-5 text-center">
            <div className="bg-white p-3.5 rounded-none border-2 border-black">
              <span className="text-[9px] font-mono text-neutral-400 block uppercase font-bold tracking-wider">Transcode</span>
              <span className="text-2xl font-display font-black text-black mt-1 block">1.8s</span>
              <span className="text-[9px] text-neutral-500 font-mono font-bold uppercase tracking-tight">OPUS</span>
            </div>
            <div className="bg-white p-3.5 rounded-none border-2 border-black">
              <span className="text-[9px] font-mono text-neutral-400 block uppercase font-bold tracking-wider">ASR Latency</span>
              <span className="text-2xl font-display font-black text-black mt-1 block">12.4s</span>
              <span className="text-[9px] text-neutral-500 font-mono font-bold uppercase tracking-tight">WHISPER</span>
            </div>
            <div className="bg-white p-3.5 rounded-none border-2 border-black">
              <span className="text-[9px] font-mono text-neutral-400 block uppercase font-bold tracking-wider">LLM Extract</span>
              <span className="text-2xl font-display font-black text-black mt-1 block">4.1s</span>
              <span className="text-[9px] text-neutral-500 font-mono font-bold uppercase tracking-tight">GEMINI 1.5</span>
            </div>
          </div>

          <div className="text-[11px] text-neutral-600 leading-relaxed border-t border-neutral-200 pt-4">
            <span className="font-display font-bold uppercase text-[10px] tracking-wider text-black block mb-1">Average Pipeline Turnaround Time (TAT)</span>
            The platform completes full call uploads, multi-speaker diarized transcriptions, structured business-fact extraction, and CRM pushes in an average of <strong className="text-black font-bold">18.3 seconds</strong>.
          </div>
        </div>

      </div>
    </div>
  );
}
