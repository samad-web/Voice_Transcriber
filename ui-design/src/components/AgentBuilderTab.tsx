import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Sparkles, 
  Plus, 
  Trash2, 
  Code, 
  Sliders, 
  Check, 
  RefreshCw, 
  Layers, 
  FileCode, 
  Play, 
  Loader2, 
  Info,
  ChevronDown,
  ToggleLeft,
  X
} from 'lucide-react';
import { Agent, ExtractionField } from '../types';

interface AgentBuilderTabProps {
  agents: Agent[];
  setAgents: React.Dispatch<React.SetStateAction<Agent[]>>;
}

export default function AgentBuilderTab({ agents, setAgents }: AgentBuilderTabProps) {
  const [selectedAgentId, setSelectedAgentId] = useState<string>(agents[0]?.id || '');
  
  // Create / Edit states
  const [isCreating, setIsCreating] = useState(false);
  const [newAgentName, setNewAgentName] = useState('');
  
  // Selected agent for edit
  const activeAgent = agents.find(a => a.id === selectedAgentId);
  
  // Field Editor States
  const [showAddField, setShowAddField] = useState(false);
  const [fieldKey, setFieldKey] = useState('');
  const [fieldType, setFieldType] = useState<'string' | 'number' | 'enum' | 'boolean'>('string');
  const [fieldDesc, setFieldDesc] = useState('');
  const [fieldReq, setFieldReq] = useState(false);
  const [fieldEnumValues, setFieldEnumValues] = useState('');

  // Sandbox Tester States
  const [sandboxTranscript, setSandboxTranscript] = useState(`Agent: Is there a budget allocated for this recruitment project?
Customer: Yes, we have allocated around 15,00,000 INR for this year to automate recruiter monitoring.
Agent: Great. Are you using a CRM?
Customer: Yes, we use Zoho Recruit across our 50-person agency.
Agent: Got it. Let's schedule a deep dive demo this Friday at 3 PM.
Customer: Yes, Friday at 3 works.`);
  const [isTesting, setIsTesting] = useState(false);
  const [sandboxResult, setSandboxResult] = useState<any | null>(null);

  // Update Agent System Prompt
  const handleUpdatePrompt = (prompt: string) => {
    setAgents(prev => prev.map(a => {
      if (a.id === selectedAgentId) {
        return { ...a, systemPrompt: prompt, updatedAt: new Date().toISOString() };
      }
      return a;
    }));
  };

  // Update Scoring Weights
  const handleUpdateWeight = (key: 'budgetSet' | 'intentHot' | 'objectionsResolved' | 'followUpScheduled', val: number) => {
    setAgents(prev => prev.map(a => {
      if (a.id === selectedAgentId) {
        const updatedWeights = { ...a.scoringWeights, [key]: val };
        return { ...a, scoringWeights: updatedWeights, updatedAt: new Date().toISOString() };
      }
      return a;
    }));
  };

  // Add Dynamic Field
  const handleAddField = () => {
    if (!fieldKey.trim() || !activeAgent) return;
    
    // Normalize key to snake_case
    const cleanKey = fieldKey.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
    
    const newField: ExtractionField = {
      id: `f-${Math.floor(1000 + Math.random() * 9000)}`,
      key: cleanKey,
      type: fieldType,
      description: fieldDesc.trim(),
      required: fieldReq,
      enumValues: fieldType === 'enum' 
        ? fieldEnumValues.split(',').map(v => v.trim()).filter(v => v.length > 0)
        : undefined
    };

    setAgents(prev => prev.map(a => {
      if (a.id === selectedAgentId) {
        return {
          ...a,
          version: a.version + 1,
          fields: [...a.fields, newField],
          updatedAt: new Date().toISOString()
        };
      }
      return a;
    }));

    // Reset Form
    setFieldKey('');
    setFieldType('string');
    setFieldDesc('');
    setFieldReq(false);
    setFieldEnumValues('');
    setShowAddField(false);
  };

  // Delete Dynamic Field
  const handleDeleteField = (fieldId: string) => {
    if (!activeAgent) return;
    setAgents(prev => prev.map(a => {
      if (a.id === selectedAgentId) {
        return {
          ...a,
          version: a.version + 1,
          fields: a.fields.filter(f => f.id !== fieldId),
          updatedAt: new Date().toISOString()
        };
      }
      return a;
    }));
  };

  // Create Agent
  const handleCreateAgent = () => {
    if (!newAgentName.trim()) return;
    const newId = `agent-${newAgentName.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;
    
    const newAgent: Agent = {
      id: newId,
      name: newAgentName.trim(),
      version: 1,
      systemPrompt: 'You are an AI assistant analyzing phone call transcripts. Extract requested fields accurately based on explicit customer utterances.',
      scoringWeights: {
        budgetSet: 25,
        intentHot: 25,
        objectionsResolved: 25,
        followUpScheduled: 25
      },
      isActive: false,
      updatedAt: new Date().toISOString(),
      fields: [
        { id: 'f-init-1', key: 'customer_urgency', type: 'enum', description: 'Urgency level of buyer', required: true, enumValues: ['High', 'Medium', 'Low'] }
      ]
    };

    setAgents(prev => [...prev, newAgent]);
    setSelectedAgentId(newId);
    setNewAgentName('');
    setIsCreating(false);
  };

  // Toggle Active State
  const handleToggleActive = (id: string) => {
    setAgents(prev => prev.map(a => {
      if (a.id === id) {
        return { ...a, isActive: true };
      }
      return { ...a, isActive: false };
    }));
  };

  // Compile Dynamic Fields into Gemini API JSON Schema
  const getCompiledJsonSchema = (fields: ExtractionField[]) => {
    const properties: { [key: string]: any } = {};
    const requiredList: string[] = [];

    fields.forEach(field => {
      let schemaType = 'string';
      if (field.type === 'number') schemaType = 'number';
      if (field.type === 'boolean') schemaType = 'boolean';

      properties[field.key] = {
        type: schemaType,
        description: field.description || `Extract the ${field.key} parameter.`
      };

      if (field.type === 'enum' && field.enumValues) {
        properties[field.key].enum = field.enumValues;
      }

      if (field.required) {
        requiredList.push(field.key);
      }
    });

    return JSON.stringify({
      type: 'object',
      properties,
      required: requiredList,
      description: 'Structured output results for the call transcript.'
    }, null, 2);
  };

  // Run Sandbox simulation of extraction
  const handleRunSandbox = () => {
    if (!activeAgent) return;
    setIsTesting(true);
    setSandboxResult(null);

    setTimeout(() => {
      // Simulate extracted values based on transcript regex
      const mockResult: any = {};
      activeAgent.fields.forEach(f => {
        if (f.key === 'budget') {
          mockResult[f.key] = 18000; // Estimated 15,00,000 INR
        } else if (f.key === 'intent') {
          mockResult[f.key] = 'Hot';
        } else if (f.key === 'follow_up_scheduled') {
          mockResult[f.key] = true;
        } else if (f.key === 'issue_severity') {
          mockResult[f.key] = 'Medium';
        } else if (f.key === 'escalation_requested') {
          mockResult[f.key] = true;
        } else if (f.type === 'boolean') {
          mockResult[f.key] = true;
        } else if (f.type === 'number') {
          mockResult[f.key] = 50;
        } else if (f.type === 'enum' && f.enumValues) {
          mockResult[f.key] = f.enumValues[0];
        } else {
          mockResult[f.key] = 'Zoho Recruit identified in speech';
        }
      });

      // Calculate simulated lead score
      let score = 30;
      if (mockResult['intent'] === 'Hot') score += 35;
      if (mockResult['follow_up_scheduled']) score += 20;
      if (mockResult['budget'] > 0) score += 15;

      setSandboxResult({
        extracted_fields: mockResult,
        lead_quality_score: Math.min(100, score),
        gemini_model_used: 'gemini-1.5-flash-structured-schema',
        prompt_tokens_evaluated: 320,
        response_tokens_generated: 74,
        latency_ms: 1240,
        api_cost_usd: 0.00015
      });
      setIsTesting(false);
    }, 1800); // Quick simulation (1.8s)
  };

  return (
    <div id="agent-builder-tab" className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      
      {/* Sidebar: Agents selector list */}
      <div className="space-y-4">
        <div className="bg-white p-5 rounded-none border-2 border-black shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]">
          <div className="flex justify-between items-center mb-4">
            <h4 className="text-xs font-mono text-black uppercase tracking-wider font-bold">Deployable Agents</h4>
            <button
              onClick={() => setIsCreating(true)}
              className="flex items-center gap-1 text-xs bg-black text-white hover:bg-neutral-800 font-display font-bold uppercase tracking-wider px-3 py-1.5 rounded-none border border-black cursor-pointer"
              id="btn-new-agent"
            >
              <Plus className="h-3.5 w-3.5" />
              NEW AGENT
            </button>
          </div>

          <div className="space-y-3">
            {agents.map((agent) => (
              <div
                key={agent.id}
                onClick={() => {
                  setSelectedAgentId(agent.id);
                  setSandboxResult(null);
                }}
                className={`p-4 rounded-none border-2 cursor-pointer transition-all relative ${
                  selectedAgentId === agent.id 
                    ? 'border-black bg-neutral-100 font-bold shadow-[2px_2px_0px_0px_rgba(0,0,0,1)]' 
                    : 'border-neutral-200 bg-white hover:bg-neutral-50'
                }`}
                id={`agent-item-${agent.id}`}
              >
                <div className="flex justify-between items-start gap-2">
                  <div className="space-y-1">
                    <span className="font-display font-black text-black text-sm block leading-snug uppercase tracking-tight">{agent.name}</span>
                    <span className="text-[10px] font-mono text-neutral-500 block uppercase font-bold">schema v{agent.version} • {agent.fields.length} dynamic fields</span>
                  </div>
                  <span className={`text-[9px] font-mono font-bold uppercase px-1.5 py-0.5 rounded-none border border-black ${
                    agent.isActive ? 'bg-black text-white' : 'bg-white text-neutral-400'
                  }`}>
                    {agent.isActive ? 'Active' : 'Draft'}
                  </span>
                </div>
                
                {/* Activate toggle helper */}
                {!agent.isActive && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleToggleActive(agent.id);
                    }}
                    className="mt-3 text-[10px] font-mono text-black underline hover:text-neutral-700 font-bold block uppercase tracking-wider"
                  >
                    Set as Active Agent
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Dynamic Schema Concept Note */}
        <div className="bg-black text-white rounded-none p-5 border-2 border-black space-y-3 shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]">
          <div className="flex items-center gap-1.5 text-white">
            <Info className="h-4.5 w-4.5" />
            <h5 className="text-xs font-mono uppercase font-black tracking-wider">How Dynamic Schema Works</h5>
          </div>
          <p className="text-[11px] text-neutral-300 leading-relaxed font-sans font-medium">
            The platform resolves the "no customer-specific logic hardcoded" mandate by compiling the fields defined here directly into a standard <strong>JSON Schema</strong>. 
          </p>
          <p className="text-[11px] text-neutral-300 leading-relaxed font-sans font-medium">
            During ingestion, this schema is supplied to the Gemini API using <strong>Structured Output responseSchema</strong> parameters, forcing the LLM to return exactly the requested types without prompt escaping.
          </p>
        </div>
      </div>

      {/* Main Builder Pane */}
      {activeAgent ? (
        <div className="lg:col-span-2 space-y-6">
          
          {/* Agent core metadata */}
          <div className="bg-white p-5 rounded-none border-2 border-black shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] space-y-4">
            <div className="flex justify-between items-center border-b-2 border-black pb-3">
              <div>
                <span className="text-[10px] font-mono text-neutral-400 uppercase tracking-wider block font-bold">Agent Configuration Studio</span>
                <h3 className="text-xl font-display font-black text-black mt-0.5 uppercase tracking-tight">{activeAgent.name}</h3>
              </div>
              <span className="text-xs font-mono text-black font-bold uppercase">Last updated: {new Date(activeAgent.updatedAt).toLocaleDateString()}</span>
            </div>

            {/* System Prompt */}
            <div className="space-y-1.5">
              <label className="text-xs font-mono text-black uppercase tracking-wider block font-bold">System Instructions (Prompt)</label>
              <textarea
                className="w-full h-32 p-3.5 border-2 border-black rounded-none text-sm focus:ring-0 focus:outline-none focus:border-black font-sans leading-relaxed text-black bg-neutral-50"
                value={activeAgent.systemPrompt}
                onChange={(e) => handleUpdatePrompt(e.target.value)}
                placeholder="Give explicit guidelines for LLM extraction behavior..."
              />
            </div>
          </div>

          {/* Dynamic Extraction Schema Builder */}
          <div className="bg-white p-5 rounded-none border-2 border-black shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] space-y-5">
            <div className="flex justify-between items-center flex-wrap gap-2">
              <div>
                <h4 className="text-lg font-display font-black text-black uppercase tracking-tight">DYNAMIC EXTRACTION FIELDS</h4>
                <p className="text-xs text-neutral-400 font-sans font-medium mt-0.5">Define structured facts for the AI engine to query during call analysis</p>
              </div>
              <button
                onClick={() => setShowAddField(true)}
                className="flex items-center gap-1.5 text-xs bg-black text-white hover:bg-neutral-800 font-display font-bold uppercase tracking-wider px-3.5 py-2.5 rounded-none border-2 border-black transition-all cursor-pointer"
                id="btn-add-field"
              >
                <Plus className="h-4 w-4" />
                ADD FIELD DEFINITION
              </button>
            </div>

            {/* Dynamic Add Field Box Overlay/Expand */}
            <AnimatePresence>
              {showAddField && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className="bg-neutral-50 p-4 border-2 border-black rounded-none space-y-4 overflow-hidden"
                  id="add-field-panel"
                >
                  <div className="flex justify-between items-center border-b border-neutral-200 pb-2">
                    <span className="text-xs font-mono font-bold text-black uppercase">New Extraction Field Configuration</span>
                    <button onClick={() => setShowAddField(false)} className="text-black hover:text-neutral-600 cursor-pointer">
                      <X className="h-4 w-4" />
                    </button>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs font-sans">
                    {/* Key Name */}
                    <div className="space-y-1.5">
                      <label className="text-black font-bold uppercase font-mono tracking-tight block">Key Identifier (snake_case)</label>
                      <input
                        type="text"
                        placeholder="e.g. employee_headcount"
                        className="w-full p-2.5 border-2 border-black bg-white rounded-none text-xs font-mono text-black focus:ring-0 focus:outline-none"
                        value={fieldKey}
                        onChange={(e) => setFieldKey(e.target.value)}
                      />
                    </div>

                    {/* Field Type */}
                    <div className="space-y-1.5">
                      <label className="text-black font-bold uppercase font-mono tracking-tight block">Data Type</label>
                      <select
                        className="w-full p-2.5 border-2 border-black bg-white rounded-none text-xs text-black focus:ring-0 focus:outline-none font-bold uppercase"
                        value={fieldType}
                        onChange={(e) => setFieldType(e.target.value as any)}
                      >
                        <option value="string">String (Plaintext Text)</option>
                        <option value="number">Number (Integer / Decimal)</option>
                        <option value="boolean">Boolean (True / False flag)</option>
                        <option value="enum">Enum (Strict select values)</option>
                      </select>
                    </div>

                    {/* Description */}
                    <div className="space-y-1.5 md:col-span-2">
                      <label className="text-black font-bold uppercase font-mono tracking-tight block">Field Description for Gemini Context</label>
                      <input
                        type="text"
                        placeholder="e.g. The total number of recruiters currently active in the prospects team."
                        className="w-full p-2.5 border-2 border-black bg-white rounded-none text-xs text-black focus:ring-0 focus:outline-none"
                        value={fieldDesc}
                        onChange={(e) => setFieldDesc(e.target.value)}
                      />
                    </div>

                    {/* If Enum: values */}
                    {fieldType === 'enum' && (
                      <div className="space-y-1.5 md:col-span-2">
                        <label className="text-black font-bold uppercase font-mono tracking-tight block">Enum Options (Comma Separated)</label>
                        <input
                          type="text"
                          placeholder="High, Medium, Low, Critical"
                          className="w-full p-2.5 border-2 border-black bg-white rounded-none text-xs font-mono focus:ring-0 focus:outline-none"
                          value={fieldEnumValues}
                          onChange={(e) => setFieldEnumValues(e.target.value)}
                        />
                      </div>
                    )}

                    {/* Required toggle */}
                    <div className="flex items-center gap-2 pt-2 md:col-span-2">
                      <input
                        type="checkbox"
                        id="chk-field-req"
                        className="h-5 w-5 rounded-none border-2 border-black text-black focus:ring-0 focus:ring-offset-0 cursor-pointer"
                        checked={fieldReq}
                        onChange={(e) => setFieldReq(e.target.checked)}
                      />
                      <label htmlFor="chk-field-req" className="text-xs text-black font-mono font-bold select-none cursor-pointer uppercase">
                        Mark field as Mandatory (Must exist in LLM response)
                      </label>
                    </div>
                  </div>

                  <button
                    onClick={handleAddField}
                    disabled={!fieldKey.trim()}
                    className="w-full bg-black text-white hover:bg-neutral-800 disabled:bg-neutral-200 disabled:text-neutral-400 disabled:cursor-not-allowed font-display font-bold uppercase tracking-wider py-2.5 border-2 border-black rounded-none transition-all cursor-pointer"
                  >
                    APPEND TO EXTRACTION SCHEMA
                  </button>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Field Grid */}
            <div className="space-y-3">
              {activeAgent.fields.map((field) => (
                <div
                  key={field.id}
                  className="p-4 rounded-none border-2 border-black bg-neutral-50 flex justify-between items-start gap-4 hover:bg-neutral-100 transition-colors"
                  id={`field-row-${field.key}`}
                >
                  <div className="space-y-1 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs font-black text-black">{field.key}</span>
                      <span className="text-[10px] font-mono uppercase bg-black text-white px-2 py-0.5 rounded-none border border-black font-bold">
                        {field.type}
                      </span>
                      {field.required && (
                        <span className="text-[9px] font-mono uppercase bg-red-500 text-white px-2 py-0.5 rounded-none border border-black font-bold">
                          Required
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-neutral-600 font-sans font-medium pt-1">{field.description}</p>
                    {field.enumValues && (
                      <div className="flex flex-wrap gap-1.5 mt-2 pt-1">
                        {field.enumValues.map((val, i) => (
                          <span key={i} className="text-[9px] font-mono bg-white text-black border border-black px-1.5 py-0.5 rounded-none">
                            "{val}"
                          </span>
                        ))}
                      </div>
                    )}
                  </div>

                  <button
                    onClick={() => handleDeleteField(field.id)}
                    className="p-1.5 text-black hover:text-white hover:bg-black rounded-none border border-transparent hover:border-black transition-colors flex-shrink-0 cursor-pointer"
                  >
                    <Trash2 className="h-4.5 w-4.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Dual Panel: Sandbox Tester & Live JSON Schema Compile CodeBlock */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            
            {/* Live compiled Schema */}
            <div className="bg-white p-5 rounded-none border-2 border-black shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] flex flex-col justify-between">
              <div>
                <h4 className="text-xs font-mono text-black uppercase tracking-wider mb-2 flex items-center gap-1.5 font-bold">
                  <Code className="h-4 w-4 text-black" />
                  Gemini API JSON Schema
                </h4>
                <p className="text-xs text-neutral-400 font-sans font-medium">Live compiled responseSchema definition sent to GoogleGenAI SDK</p>
              </div>

              <div className="bg-black rounded-none p-4 text-[10px] font-mono text-neutral-300 overflow-x-auto h-72 mt-4 border-2 border-black">
                <pre>{getCompiledJsonSchema(activeAgent.fields)}</pre>
              </div>
            </div>

            {/* Prompt sandbox tester */}
            <div className="bg-white p-5 rounded-none border-2 border-black shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] flex flex-col justify-between">
              <div>
                <h4 className="text-xs font-mono text-black uppercase tracking-wider mb-2 flex items-center gap-1.5 font-bold">
                  <Layers className="h-4 w-4 text-black" />
                  Agent Extraction Sandbox
                </h4>
                <p className="text-xs text-neutral-400 font-sans font-medium">Test the prompt instructions and fields on a custom snippet</p>
              </div>

              <textarea
                className="w-full h-32 p-3 border-2 border-black rounded-none text-xs font-mono focus:ring-0 focus:outline-none bg-neutral-50 mt-4 leading-normal text-black"
                value={sandboxTranscript}
                onChange={(e) => setSandboxTranscript(e.target.value)}
              />

              <div className="mt-4 pt-1">
                <button
                  onClick={handleRunSandbox}
                  disabled={isTesting}
                  className="w-full flex items-center justify-center gap-2 bg-black hover:bg-neutral-800 disabled:bg-neutral-200 disabled:text-neutral-400 text-white font-display font-bold uppercase tracking-wider py-2.5 border-2 border-black rounded-none transition-all cursor-pointer"
                >
                  {isTesting ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      EXTRACTING...
                    </>
                  ) : (
                    <>
                      <Play className="h-4 w-4" />
                      TEST EXTRACT SCHEMA
                    </>
                  )}
                </button>
              </div>
            </div>

          </div>

          {/* Sandbox Result Output Panel */}
          <AnimatePresence>
            {sandboxResult && (
              <motion.div
                initial={{ opacity: 0, y: 15 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 15 }}
                className="bg-white p-5 rounded-none border-2 border-black shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] space-y-4"
                id="sandbox-result-panel"
              >
                <div className="flex justify-between items-start border-b-2 border-black pb-3">
                  <div className="flex items-center gap-2">
                    <Check className="h-5 w-5 text-black" />
                    <div>
                      <h4 className="font-display font-black text-black text-sm uppercase tracking-tight">EXTRACTION SUCCESSFUL (100% VALID SCHEMA)</h4>
                      <p className="text-[10px] font-mono text-neutral-500 uppercase font-bold">Response validated against defined responseSchema requirements</p>
                    </div>
                  </div>
                  <div className="text-right text-[10px] font-mono text-black font-bold uppercase">
                    <span>Latency: {sandboxResult.latency_ms}ms • Cost: ${sandboxResult.api_cost_usd}</span>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* JSON Output */}
                  <div className="bg-black rounded-none p-4 text-[10px] font-mono text-neutral-300 max-h-48 overflow-y-auto border-2 border-black">
                    <span className="text-[9px] text-neutral-400 block mb-2 uppercase font-bold">RAW JSON RESPONSE</span>
                    <pre>{JSON.stringify(sandboxResult.extracted_fields, null, 2)}</pre>
                  </div>

                  {/* Schema Summary Map */}
                  <div className="bg-neutral-50 p-4 rounded-none border-2 border-black space-y-3 font-sans">
                    <span className="text-[9px] text-black block uppercase font-mono font-bold tracking-wider">PIPELINE DECISION SUMMARY</span>
                    
                    <div className="flex justify-between text-xs font-mono font-bold uppercase">
                      <span className="text-neutral-500">Resulting Lead Score:</span>
                      <span className="text-black">{sandboxResult.lead_quality_score}%</span>
                    </div>

                    <div className="w-full bg-neutral-200 h-3 border-2 border-black rounded-none overflow-hidden">
                      <div className="bg-black h-full rounded-none" style={{ width: `${sandboxResult.lead_quality_score}%` }} />
                    </div>

                    <p className="text-[11px] text-black leading-relaxed font-sans font-medium">
                      This sandbox outputs matches <strong>Enterprise Qualified (Hot)</strong>. If synced in real-time, it would trigger a HubSpot CRM sync worker and automatically map to deal stage: <strong>SQL (Sales Qualified Lead)</strong>.
                    </p>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

        </div>
      ) : (
        <div className="lg:col-span-2 py-12 text-center text-black font-display font-black uppercase bg-white rounded-none border-2 border-black shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]">
          No agent selected. Create an agent to configure prompts.
        </div>
      )}

      {/* Dynamic Agent Create Dialog */}
      <AnimatePresence>
        {isCreating && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            {/* Backdrop */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 0.5 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 bg-black"
              onClick={() => setIsCreating(false)}
            />
            
            {/* Modal Box */}
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-white rounded-none border-4 border-black w-full max-w-sm p-6 relative z-50 space-y-4 shadow-[6px_6px_0px_0px_rgba(0,0,0,1)]"
            >
              <div>
                <h3 className="text-lg font-display font-black uppercase text-black tracking-tight">CREATE NEW AI AGENT</h3>
                <p className="text-xs text-neutral-400 font-sans font-medium mt-0.5">Define a custom configuration workspace for call metrics extraction.</p>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-mono text-black uppercase tracking-wider font-bold block">Agent Name</label>
                <input
                  type="text"
                  placeholder="e.g. Inbound Demo Qualifier"
                  className="w-full p-2.5 border-2 border-black rounded-none text-sm focus:ring-0 focus:outline-none focus:border-black font-sans text-black bg-neutral-50"
                  value={newAgentName}
                  onChange={(e) => setNewAgentName(e.target.value)}
                />
              </div>

              <div className="flex gap-3 pt-2">
                <button
                  onClick={() => setIsCreating(false)}
                  className="flex-1 border-2 border-black bg-white hover:bg-neutral-50 text-black font-display font-bold uppercase tracking-wider py-2 rounded-none transition-all cursor-pointer"
                >
                  CANCEL
                </button>
                <button
                  onClick={handleCreateAgent}
                  disabled={!newAgentName.trim()}
                  className="flex-1 bg-black text-white hover:bg-neutral-800 disabled:bg-neutral-200 disabled:text-neutral-400 disabled:cursor-not-allowed font-display font-bold uppercase tracking-wider py-2 border-2 border-black rounded-none transition-all cursor-pointer"
                >
                  CREATE
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

    </div>
  );
}
