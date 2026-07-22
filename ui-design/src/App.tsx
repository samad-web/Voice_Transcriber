/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Activity, 
  Phone, 
  Sparkles, 
  Smartphone, 
  ShieldCheck, 
  Lock, 
  User, 
  Compass,
  Menu,
  X
} from 'lucide-react';

import { 
  INITIAL_CALLS, 
  INITIAL_DEVICES, 
  INITIAL_AGENTS, 
  INITIAL_AUDIT_LOGS,
  Call,
  Device,
  Agent,
  AuditLog
} from './types';

// Tab components
import DashboardTab from './components/DashboardTab';
import CallExplorerTab from './components/CallExplorerTab';
import AgentBuilderTab from './components/AgentBuilderTab';
import DevicesTab from './components/DevicesTab';
import ComplianceTab from './components/ComplianceTab';

type Tab = 'dashboard' | 'calls' | 'agents' | 'devices' | 'compliance';

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>('dashboard');
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  // Core global state matrices
  const [calls, setCalls] = useState<Call[]>(INITIAL_CALLS);
  const [devices, setDevices] = useState<Device[]>(INITIAL_DEVICES);
  const [agents, setAgents] = useState<Agent[]>(INITIAL_AGENTS);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>(INITIAL_AUDIT_LOGS);

  // Time stamp helper (static display as of user login context)
  const currentLocalTime = '2026-07-19 07:36 UTC';

  const navItems = [
    { id: 'dashboard', label: 'Platform Hub', icon: Activity },
    { id: 'calls', label: 'Call Log Explorer', icon: Phone },
    { id: 'agents', label: 'AI Agent Studio', icon: Sparkles },
    { id: 'devices', label: 'Fleet & MDM', icon: Smartphone },
    { id: 'compliance', label: 'Compliance & Audit', icon: ShieldCheck },
  ];

  return (
    <div className="min-h-screen bg-[#F9F9F9] text-[#1A1A1A] font-sans flex flex-col md:flex-row antialiased">
      
      {/* Sidebar: Desktop Navigation */}
      <aside className="hidden md:flex flex-col w-64 bg-white border-r-2 border-black p-5 shrink-0 justify-between">
        <div className="space-y-8">
          
          {/* Logo Brand Brand */}
          <div className="flex items-center gap-3 px-1.5" id="brand-logo">
            <div className="w-10 h-10 bg-black text-white flex items-center justify-center font-bold font-display text-xl select-none">
              A
            </div>
            <div>
              <h1 className="text-sm font-display font-black text-black tracking-tight leading-none uppercase">Aura Platform</h1>
              <span className="text-[9px] font-mono font-bold text-neutral-400 block tracking-[0.2em] uppercase mt-1">Call Intelligence</span>
            </div>
          </div>

          {/* Navigation Links */}
          <nav className="space-y-1" id="desktop-nav">
            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => setActiveTab(item.id as Tab)}
                  className={`w-full flex items-center gap-3 px-4 py-3 rounded-none text-xs font-display font-bold uppercase tracking-wider transition-all ${
                    isActive 
                      ? 'bg-black text-white border-l-4 border-black' 
                      : 'text-neutral-500 hover:text-black hover:bg-neutral-50 border-l-4 border-transparent'
                  }`}
                  id={`nav-item-${item.id}`}
                >
                  <Icon className="h-4 w-4" />
                  {item.label}
                </button>
              );
            })}
          </nav>
        </div>

        {/* Desktop Sidebar Footer */}
        <div className="space-y-4 border-t-2 border-black pt-4 px-1">
          <div className="flex items-center gap-2.5">
            <div className="p-2 bg-black text-white rounded-none">
              <User className="h-4 w-4" />
            </div>
            <div className="overflow-hidden">
              <span className="text-[11px] font-sans font-bold text-black block truncate">mas20042005@gmail.com</span>
              <span className="text-[9px] font-mono text-neutral-400 block uppercase font-bold tracking-wider">Platform Owner</span>
            </div>
          </div>

          <div className="text-[10px] text-neutral-500 font-mono flex items-center gap-1.5 pt-1 border-t border-neutral-100">
            <Lock className="h-3.5 w-3.5 text-black" />
            <span className="uppercase tracking-wider font-bold text-[9px]">Secure Session</span>
          </div>
        </div>
      </aside>

      {/* Mobile Top Header */}
      <header className="md:hidden bg-white border-b-2 border-black px-5 py-3.5 flex justify-between items-center z-30 shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 bg-black text-white flex items-center justify-center font-bold font-display text-sm">
            A
          </div>
          <span className="font-display font-black text-black text-sm uppercase tracking-tight">Aura Platform</span>
        </div>
        
        <button
          onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
          className="p-1.5 hover:bg-neutral-100 border border-black rounded-none text-black transition-colors"
        >
          {isMobileMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </header>

      {/* Mobile Menu Slide-down Overlay */}
      <AnimatePresence>
        {isMobileMenuOpen && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="md:hidden bg-white border-b-2 border-black px-5 py-4 space-y-4 z-20 absolute top-[49px] left-0 right-0 overflow-hidden shadow-lg"
            id="mobile-nav"
          >
            <nav className="space-y-1">
              {navItems.map((item) => {
                const Icon = item.icon;
                const isActive = activeTab === item.id;
                return (
                  <button
                    key={item.id}
                    onClick={() => {
                      setActiveTab(item.id as Tab);
                      setIsMobileMenuOpen(false);
                    }}
                    className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-none text-xs font-display font-bold uppercase tracking-wider transition-all ${
                      isActive 
                        ? 'bg-black text-white' 
                        : 'text-neutral-500 hover:bg-neutral-50'
                    }`}
                  >
                    <Icon className="h-4.5 w-4.5" />
                    {item.label}
                  </button>
                );
              })}
            </nav>

            <div className="pt-3 border-t-2 border-black flex items-center justify-between text-[11px] text-neutral-500">
              <span className="truncate font-bold text-black">mas20042005@gmail.com</span>
              <span className="font-mono text-[9px] uppercase tracking-wider bg-black text-white px-2 py-0.5 rounded-none font-bold">Owner</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Core Panel Content viewport */}
      <main className="flex-1 flex flex-col min-h-0 overflow-y-auto p-5 md:p-8 space-y-6">
        
        {/* Workspace Top Bar Header */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 border-b-2 border-neutral-200 pb-5">
          <div>
            <div className="text-[10px] font-mono text-neutral-400 uppercase tracking-[0.25em] font-bold flex items-center gap-1.5">
              <span>Tenant Node: Mumbai Workspace</span>
              <span className="w-1.5 h-1.5 bg-black rounded-full animate-ping" />
            </div>
            <h2 className="text-3xl sm:text-5xl font-display font-black text-black mt-2 leading-none uppercase tracking-tighter">
              {activeTab === 'dashboard' && 'Platform Hub'}
              {activeTab === 'calls' && 'Call Log Explorer'}
              {activeTab === 'agents' && 'AI Agent Studio'}
              {activeTab === 'devices' && 'Mobile Fleet'}
              {activeTab === 'compliance' && 'Compliance & Audit'}
            </h2>
          </div>

          <div className="text-right text-[10px] font-mono text-black space-y-1 bg-white py-2 px-4 rounded-none border-2 border-black shadow-xs self-stretch sm:self-auto">
            <span className="block font-bold text-neutral-400 uppercase tracking-[0.2em] text-[9px]">SYSTEM LOCAL TIME</span>
            <span className="block font-black text-black text-xs font-mono">{currentLocalTime}</span>
          </div>
        </div>

        {/* Tab Switch Viewport Panel Container */}
        <div className="flex-1 min-h-0">
          <AnimatePresence mode="wait">
            <motion.div
              key={activeTab}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.2 }}
              className="h-full"
            >
              {activeTab === 'dashboard' && <DashboardTab calls={calls} devices={devices} />}
              {activeTab === 'calls' && <CallExplorerTab calls={calls} setCalls={setCalls} devices={devices} />}
              {activeTab === 'agents' && <AgentBuilderTab agents={agents} setAgents={setAgents} />}
              {activeTab === 'devices' && <DevicesTab devices={devices} setDevices={setDevices} />}
              {activeTab === 'compliance' && <ComplianceTab auditLogs={auditLogs} setAuditLogs={setAuditLogs} />}
            </motion.div>
          </AnimatePresence>
        </div>

      </main>

    </div>
  );
}

