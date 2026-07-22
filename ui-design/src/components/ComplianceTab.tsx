import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  ShieldCheck, 
  Trash2, 
  FileText, 
  Lock, 
  Search, 
  Check, 
  Loader2, 
  Database, 
  UserX, 
  Download, 
  Scale, 
  Clock, 
  AlertCircle,
  FileCheck2,
  RefreshCw
} from 'lucide-react';
import { AuditLog, INITIAL_AUDIT_LOGS } from '../types';

interface ComplianceTabProps {
  auditLogs: AuditLog[];
  setAuditLogs: React.Dispatch<React.SetStateAction<AuditLog[]>>;
}

export default function ComplianceTab({ auditLogs, setAuditLogs }: ComplianceTabProps) {
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedActionFilter, setSelectedActionFilter] = useState('All');
  
  // Subject Erasure Tool States
  const [erasureNumber, setErasureNumber] = useState('');
  const [erasureStage, setErasureStage] = useState<'idle' | 's3' | 'postgres' | 'crm' | 'audit' | 'complete'>('idle');
  const [erasureLogs, setErasureLogs] = useState<string[]>([]);
  const [erasureReceipt, setErasureReceipt] = useState<any | null>(null);

  // Policy Settings States
  const [consentRegime, setConsentRegime] = useState('tone'); // tone, tts, none, prohibited
  const [onConsentFail, setOnConsentFail] = useState('block'); // block, flag
  const [retentionDays, setRetentionDays] = useState('90'); // 30, 90, 365, never
  const [showSaveSuccess, setShowSaveSuccess] = useState(false);

  // Filter logs
  const filteredLogs = auditLogs.filter(log => {
    const matchesSearch = 
      log.actor.toLowerCase().includes(searchTerm.toLowerCase()) ||
      log.target.toLowerCase().includes(searchTerm.toLowerCase()) ||
      log.action.toLowerCase().includes(searchTerm.toLowerCase());
    
    const matchesAction = selectedActionFilter === 'All' || log.action === selectedActionFilter;

    return matchesSearch && matchesAction;
  });

  // Unique actions for filters
  const uniqueActions = Array.from(new Set(auditLogs.map(l => l.action)));

  // Save general policy configs
  const handleSavePolicy = () => {
    setShowSaveSuccess(true);
    setTimeout(() => {
      setShowSaveSuccess(false);
    }, 2000);
  };

  // Run Cascading Erasure Simulator
  const handleRunErasure = () => {
    if (!erasureNumber.trim()) return;
    
    const targetHash = 'sha256_' + Math.floor(100000 + Math.random() * 900000) + 'ab45ef6c';
    setErasureStage('s3');
    setErasureLogs(['[07:41:25] Erasure Worker: Initiating Subject Request for ' + erasureNumber, '[07:41:25] GDPR Router: Mapping phone number to organizational hash: ' + targetHash]);

    // Stage 1: Purging S3 Audio
    setTimeout(() => {
      setErasureStage('postgres');
      setErasureLogs(prev => [...prev, '[07:41:26] AWS S3: Located raw M4A calls containing hash.', '[07:41:27] AWS S3: HARD PURGE successful. Deleted 3 objects with SSE-KMS keys.']);
    }, 1500);

    // Stage 2: Postgres Database rows deletion
    setTimeout(() => {
      setErasureStage('crm');
      setErasureLogs(prev => [...prev, '[07:41:29] PostgreSQL: Purging transcript segments for calls linked to hash.', '[07:41:30] PostgreSQL: Purging call_facts metrics projections. 12 records deleted.', '[07:41:31] PostgreSQL: Cascade deletion completed on org tenant schema.']);
    }, 3500);

    // Stage 3: CRM Callback Sync Deletion
    setTimeout(() => {
      setErasureStage('audit');
      setErasureLogs(prev => [...prev, '[07:41:32] HubSpot CRM: Dispatching API webhook DELETE request for contact deal link.', '[07:41:33] HubSpot CRM: Deletion acknowledged by external API. Link removed.']);
    }, 5500);

    // Stage 4: Writing Immutable Security Audit & Receipt
    setTimeout(() => {
      setErasureStage('complete');
      setErasureLogs(prev => [...prev, '[07:41:35] Compliance Auditor: Generated immutable deletion certificate.', '[07:41:35] Subject Request marked terminal: FULLY_ERASED.']);

      // Append Deletion action to Audit trail
      const auditItem: AuditLog = {
        id: `aud-${Math.floor(100 + Math.random() * 900)}`,
        actor: 'mas20042005@gmail.com',
        role: 'Platform Admin',
        action: 'Subject Erasure Completed',
        target: `Hash: ${targetHash}`,
        ipAddress: '103.44.152.88',
        timestamp: new Date().toISOString(),
        status: 'Success'
      };

      setAuditLogs(prev => [auditItem, ...prev]);

      // Create downloadable Receipt object
      setErasureReceipt({
        status: 'COMPLETED_SUCCESSFULLY',
        regulation: 'EU_GDPR_ARTICLE_17_AND_INDIA_DPDP_SEC_12',
        requester_identifier_mask: `+91 ******${erasureNumber.substring(erasureNumber.length - 4)}`,
        requester_hash: targetHash,
        deletion_timestamp_utc: new Date().toISOString(),
        assets_purged: [
          'AWS_S3_M4A_AUDIO_OBJECTS',
          'POSTGRES_TRANSCRIPT_ROWS',
          'POSTGRES_CALL_FACTS_ROWS',
          'HUBSPOT_CRM_SYNC_COPIES'
        ],
        cryptographic_signature: '0x9924abf445021e0ef8883fffaee129038ba9ccdd21'
      });
    }, 7500);
  };

  const handleCopyReceipt = () => {
    if (!erasureReceipt) return;
    navigator.clipboard.writeText(JSON.stringify(erasureReceipt, null, 2));
  };

  return (
    <div id="compliance-tab" className="space-y-6">
      
      {/* Upper Grid: Policy Editor vs GDPR Deletion Tool */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        
        {/* Consent & General Retention Policies */}
        <div className="bg-white p-5 rounded-none border-2 border-black shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] flex flex-col justify-between">
          <div className="space-y-4">
            <div>
              <h4 className="text-lg font-display font-black text-black uppercase tracking-tight">PLATFORM CONSENT & RETENTION POLICIES</h4>
              <p className="text-xs text-neutral-400 font-sans font-medium mt-0.5">Configure regional legal guardrails for automated voice capture</p>
            </div>

            <div className="space-y-4 pt-2 text-xs font-sans">
              {/* Consent Mode */}
              <div className="space-y-1.5">
                <label className="text-black font-bold uppercase font-mono tracking-tight block">Mandatory Call Consent Regime</label>
                <select
                  className="w-full p-2.5 border-2 border-black bg-neutral-50 rounded-none text-xs text-black font-bold uppercase focus:ring-0 focus:outline-none"
                  value={consentRegime}
                  onChange={(e) => setConsentRegime(e.target.value)}
                >
                  <option value="tone">Tone Beep (Plays local warning tone at call connected)</option>
                  <option value="tts">TTS Verbal Notice ("This call is captured for audit guidelines")</option>
                  <option value="none">Bypass Consent (Explicitly allowed in jurisdictions)</option>
                  <option value="prohibited">Disable Recording Entirely (Complete fleet lockout)</option>
                </select>
              </div>

              {/* On Fail behavior */}
              <div className="space-y-1.5">
                <label className="text-black font-bold uppercase font-mono tracking-tight block">On Consent Hardware Failure Action</label>
                <select
                  className="w-full p-2.5 border-2 border-black bg-neutral-50 rounded-none text-xs text-black font-bold uppercase focus:ring-0 focus:outline-none"
                  value={onConsentFail}
                  onChange={(e) => setOnConsentFail(e.target.value)}
                >
                  <option value="block">Block Ingest (Discard recording chunk, never save)</option>
                  <option value="flag">Upload & Flag (Mark "Consent Failed" in dashboards)</option>
                </select>
              </div>

              {/* Automated Reaper Scheduler */}
              <div className="space-y-1.5">
                <label className="text-black font-bold uppercase font-mono tracking-tight block">Durable Call Retention Scheduler</label>
                <select
                  className="w-full p-2.5 border-2 border-black bg-neutral-50 rounded-none text-xs text-black font-bold uppercase focus:ring-0 focus:outline-none"
                  value={retentionDays}
                  onChange={(e) => setRetentionDays(e.target.value)}
                >
                  <option value="30">30 Days (Standard retention, auto-reaps S3 & Postgres)</option>
                  <option value="90">90 Days (Enterprise average, India DPDP recommended)</option>
                  <option value="365">1 Year (Regulatory compliance window)</option>
                  <option value="never">Never auto-delete (Requires manual request)</option>
                </select>
              </div>
            </div>
          </div>

          <div className="pt-5 flex flex-wrap justify-between items-center gap-3 relative border-t-2 border-black mt-5">
            <span className="text-[9px] text-neutral-400 font-mono font-bold uppercase">Changes apply to all enrolled handsets instantly.</span>
            <button
              onClick={handleSavePolicy}
              className="bg-black text-white hover:bg-neutral-800 font-display font-bold uppercase tracking-wider px-4 py-2.5 rounded-none border-2 border-black transition-all cursor-pointer shadow-[2px_2px_0px_0px_rgba(0,0,0,1)]"
              id="btn-save-policy"
            >
              APPLY POLICIES
            </button>

            {/* Save Toast */}
            <AnimatePresence>
              {showSaveSuccess && (
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 10 }}
                  className="absolute bottom-14 right-0 bg-black text-white text-xs px-3.5 py-2.5 rounded-none flex items-center gap-2 border-2 border-white font-mono uppercase tracking-wider font-bold shadow-2xl z-25"
                >
                  <Check className="h-4 w-4 text-green-400" />
                  POLICIES APPLIED SUCCESSFULLY!
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>

        {/* GDPR/DPDP Subject Deletion Tool */}
        <div className="bg-white p-5 rounded-none border-2 border-black shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] flex flex-col justify-between">
          <div className="space-y-4">
            <div>
              <h4 className="text-lg font-display font-black text-black uppercase tracking-tight">GDPR & DPDP RIGHT TO BE FORGOTTEN (ERASURE)</h4>
              <p className="text-xs text-neutral-400 mt-0.5 font-sans font-medium">Wipe an individual's complete voice footprint with automated cascade deletions</p>
            </div>

            {erasureStage === 'idle' ? (
              <div className="space-y-4 pt-2 font-sans">
                <p className="text-[11px] text-neutral-600 leading-relaxed font-sans font-medium">
                  Enter the clear phone number of a customer requesting complete deletion. The system will automatically map it to their organizational hash and execute a destructive cascading sweep across AWS S3 objects, Postgres transcript lines, projection metrics, and HubSpot deals records.
                </p>

                <div className="space-y-1.5">
                  <label className="text-xs font-mono text-black uppercase tracking-wider font-bold block">Target Phone Number</label>
                  <input
                    type="text"
                    placeholder="e.g. +91 99330 11223"
                    className="w-full p-2.5 border-2 border-black rounded-none text-sm font-mono text-black focus:ring-0 focus:outline-none bg-neutral-50"
                    value={erasureNumber}
                    onChange={(e) => setErasureNumber(e.target.value)}
                  />
                </div>

                <button
                  onClick={handleRunErasure}
                  disabled={!erasureNumber.trim()}
                  className="w-full flex items-center justify-center gap-2 bg-red-500 hover:bg-red-600 disabled:bg-neutral-200 disabled:text-neutral-400 border-2 border-black text-white font-display font-bold uppercase tracking-wider py-2.5 rounded-none transition-all cursor-pointer shadow-[2px_2px_0px_0px_rgba(0,0,0,1)]"
                  id="btn-initiate-erasure"
                >
                  <UserX className="h-4.5 w-4.5" />
                  TRIGGER CASCADING PURGE
                </button>
              </div>
            ) : (
              <div className="space-y-4 pt-2">
                {/* Progress bar */}
                <div className="space-y-1.5 text-xs font-sans">
                  <div className="flex justify-between font-bold text-black uppercase font-mono">
                    <span>
                      {erasureStage === 's3' && 'Step 1/4: Purging Raw Audio from S3...'}
                      {erasureStage === 'postgres' && 'Step 2/4: Deleting Transcripts from Postgres...'}
                      {erasureStage === 'crm' && 'Step 3/4: Removing HubSpot Deals...'}
                      {erasureStage === 'audit' && 'Step 4/4: Writing Compliance certificate...'}
                      {erasureStage === 'complete' && '🎉 Deletion Sequence Completed!'}
                    </span>
                    <span>
                      {erasureStage === 's3' && '25%'}
                      {erasureStage === 'postgres' && '50%'}
                      {erasureStage === 'crm' && '75%'}
                      {erasureStage === 'audit' && '90%'}
                      {erasureStage === 'complete' && '100%'}
                    </span>
                  </div>
                  <div className="w-full bg-neutral-100 h-4 border-2 border-black rounded-none overflow-hidden">
                    <div 
                      className="h-full rounded-none transition-all duration-300 bg-red-600"
                      style={{ 
                        width: 
                          erasureStage === 's3' ? '25%' :
                          erasureStage === 'postgres' ? '50%' :
                          erasureStage === 'crm' ? '75%' :
                          erasureStage === 'audit' ? '90%' : '100%'
                      }}
                    />
                  </div>
                </div>

                {/* Live Output */}
                <div className="bg-black text-red-400 rounded-none p-3.5 h-32 font-mono text-[10px] overflow-y-auto space-y-1 border-2 border-black">
                  {erasureLogs.map((log, i) => (
                    <div key={i} className="leading-relaxed">{log}</div>
                  ))}
                  {erasureStage !== 'complete' && (
                    <div className="flex items-center gap-1.5 text-red-500 font-bold uppercase text-[10px]">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      <span>Shredding cryptographic sector keys...</span>
                    </div>
                  )}
                </div>

                {/* Receipt visual once complete */}
                {erasureStage === 'complete' && erasureReceipt && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-1">
                    {/* Raw certificate block */}
                    <div className="bg-black text-neutral-300 rounded-none p-3 text-[9px] font-mono overflow-y-auto h-32 border-2 border-black">
                      <span className="text-[8px] text-neutral-500 block mb-1 uppercase font-bold">DELETION RECEIPT CERTIFICATE</span>
                      <pre>{JSON.stringify(erasureReceipt, null, 2)}</pre>
                    </div>

                    <div className="flex flex-col justify-between p-1.5 font-sans">
                      <div className="space-y-1">
                        <span className="text-xs font-display font-black text-black flex items-center gap-1.5 uppercase">
                          <FileCheck2 className="h-4 w-4 text-black" />
                          Receipt Issued
                        </span>
                        <p className="text-[10px] text-neutral-600 leading-normal font-sans font-medium">
                          A signed, legally-verifiable erasure receipt is now logged in your audit log ledger under GDPR Article 17 requirements.
                        </p>
                      </div>

                      <div className="flex gap-2 mt-3 flex-wrap">
                        <button
                          onClick={handleCopyReceipt}
                          className="flex-1 flex items-center justify-center gap-1 bg-black text-white hover:bg-neutral-800 font-display font-bold text-[10px] py-2 border-2 border-black rounded-none cursor-pointer"
                        >
                          COPY RECEIPT
                        </button>
                        <button
                          onClick={() => {
                            setErasureStage('idle');
                            setErasureNumber('');
                            setErasureReceipt(null);
                          }}
                          className="flex-1 border-2 border-black bg-white hover:bg-neutral-50 text-black font-display font-bold text-[10px] py-2 rounded-none cursor-pointer"
                        >
                          RESET TOOL
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

      </div>

      {/* Security Audit Trail Ledger */}
      <div className="bg-white p-5 rounded-none border-2 border-black shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] space-y-4">
        
        {/* Audit Search Toolbar */}
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 pb-2">
          <div>
            <h4 className="text-lg font-display font-black text-black uppercase tracking-tight">SECURITY AUDIT LEDGER (IMMUTABLE)</h4>
            <p className="text-xs text-neutral-400 font-medium">Cryptographically sequenced logs of sensitive platform transactions</p>
          </div>

          <div className="flex flex-wrap items-center gap-3 w-full md:w-auto text-xs font-mono font-bold">
            {/* Search Input */}
            <div className="relative w-full md:w-60">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-black" />
              <input
                type="text"
                placeholder="Search audit trail..."
                className="w-full pl-8 pr-3 py-2 border-2 border-black rounded-none text-xs font-sans focus:ring-0 focus:outline-none text-black bg-neutral-50"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </div>

            {/* Action Filter */}
            <div className="flex items-center gap-1.5">
              <span className="text-neutral-500 uppercase">ACTION:</span>
              <select
                className="border-2 border-black rounded-none px-3 py-1.5 bg-white font-sans text-black font-bold uppercase focus:ring-0 focus:outline-none"
                value={selectedActionFilter}
                onChange={(e) => setSelectedActionFilter(e.target.value)}
              >
                <option value="All">All Actions</option>
                {uniqueActions.map((act, i) => (
                  <option key={i} value={act}>{act.toUpperCase()}</option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* Audit Table */}
        <div className="overflow-x-auto rounded-none border-2 border-black">
          <table className="w-full min-w-[700px] text-left border-collapse">
            <thead>
              <tr className="bg-black border-b-2 border-black font-mono text-[9px] text-white uppercase tracking-wider font-bold">
                <th className="py-3 px-4">Timestamp (UTC)</th>
                <th className="py-3 px-4">User Principal</th>
                <th className="py-3 px-4">Role Scope</th>
                <th className="py-3 px-4">Action</th>
                <th className="py-3 px-4">Target Resource</th>
                <th className="py-3 px-4">IP Address</th>
                <th className="py-3 px-4 text-right">Gate Status</th>
              </tr>
            </thead>
            <tbody className="divide-y-2 divide-black text-xs font-sans font-medium">
              {filteredLogs.map((log) => {
                const dateObj = new Date(log.timestamp);
                const formattedTime = dateObj.toLocaleDateString() + ' ' + dateObj.toLocaleTimeString([], { hour12: false });
                
                return (
                  <tr key={log.id} className="hover:bg-neutral-50 bg-white">
                    <td className="py-3.5 px-4 font-mono text-[11px] text-black font-bold">{formattedTime}</td>
                    <td className="py-3.5 px-4 font-bold text-black">{log.actor}</td>
                    <td className="py-3.5 px-4">
                      <span className="inline-flex items-center text-[10px] bg-black text-white px-2 py-0.5 rounded-none border border-black font-mono font-bold uppercase">
                        {log.role}
                      </span>
                    </td>
                    <td className="py-3.5 px-4 font-bold text-black uppercase">{log.action}</td>
                    <td className="py-3.5 px-4 font-mono text-[11px] text-neutral-600">{log.target}</td>
                    <td className="py-3.5 px-4 font-mono text-[11px] text-black font-bold">{log.ipAddress}</td>
                    <td className="py-3.5 px-4 text-right">
                      <span className="inline-flex items-center gap-1 font-bold text-black uppercase font-mono">
                        <Check className="h-3.5 w-3.5 text-black" />
                        PASS
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

      </div>

    </div>
  );
}
