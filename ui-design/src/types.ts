export interface TranscriptSegment {
  speaker: 'Agent' | 'Customer';
  text: string;
  time: string;
}

export interface Call {
  id: string;
  direction: 'Incoming' | 'Outgoing';
  remoteNumber: string;
  remoteName: string;
  startedAt: string;
  duration: number; // in seconds
  audioSource: 'VOICE_CALL' | 'MIC' | 'VOICE_RECOGNITION' | 'UNKNOWN';
  status: 'Awaiting Audio' | 'Transcoding' | 'Transcribing' | 'Analyzing' | 'Syncing' | 'Complete' | 'Failed';
  consentStatus: 'Verified (Played)' | 'Failed' | 'Bypassed (None)' | 'Required (Pending)';
  agentId: string;
  agentName: string;
  deviceId: string;
  deviceLabel: string;
  deviceModel: string;
  leadScore: number;
  leadIntent: 'Hot' | 'Warm' | 'Cold' | 'Unclassified';
  budget: string;
  followUpDate: string;
  objections: string[];
  summary: string;
  transcript: TranscriptSegment[];
  crmSyncStatus: 'Synced' | 'Pending' | 'Failed';
  crmExternalId: string;
  crmAttempts: number;
  crmError?: string;
  audioUrl?: string;
}

export interface Device {
  id: string;
  label: string;
  model: string;
  osVersion: string;
  appVersion: string;
  status: 'Active' | 'Logged Out' | 'Wiped' | 'Lost';
  captureCapability: 'Full Duplex (Certified)' | 'Near End Only (Forced Speaker)' | 'Unsupported (Silent)';
  accessibilityEnabled: boolean;
  batteryLevel: number;
  storageFreeMB: number;
  lastSeen: string;
  pendingUploads: number;
  lastUploadAt: string;
}

export interface ExtractionField {
  id: string;
  key: string;
  type: 'string' | 'number' | 'enum' | 'boolean';
  description: string;
  required: boolean;
  enumValues?: string[];
}

export interface Agent {
  id: string;
  name: string;
  version: number;
  systemPrompt: string;
  scoringWeights: {
    budgetSet: number;
    intentHot: number;
    objectionsResolved: number;
    followUpScheduled: number;
  };
  fields: ExtractionField[];
  isActive: boolean;
  updatedAt: string;
}

export interface AuditLog {
  id: string;
  actor: string;
  role: string;
  action: string;
  target: string;
  ipAddress: string;
  timestamp: string;
  status: 'Success' | 'Failed';
}

// Initial rich mock data to populate our platform prototype immediately
export const INITIAL_DEVICES: Device[] = [
  {
    id: 'dev-1',
    label: 'Mumbai Sales Desk #1',
    model: 'Google Pixel 7 Pro',
    osVersion: 'Android 14 (API 34)',
    appVersion: 'v2.1.4',
    status: 'Active',
    captureCapability: 'Full Duplex (Certified)',
    accessibilityEnabled: true,
    batteryLevel: 88,
    storageFreeMB: 45200,
    lastSeen: 'Just Now',
    pendingUploads: 0,
    lastUploadAt: '10 mins ago',
  },
  {
    id: 'dev-2',
    label: 'Delhi Enterprise Lead',
    model: 'Samsung Galaxy S23 Ultra',
    osVersion: 'Android 14 (API 34)',
    appVersion: 'v2.1.4',
    status: 'Active',
    captureCapability: 'Full Duplex (Certified)',
    accessibilityEnabled: true,
    batteryLevel: 94,
    storageFreeMB: 120500,
    lastSeen: '2 mins ago',
    pendingUploads: 1,
    lastUploadAt: '1 hour ago',
  },
  {
    id: 'dev-3',
    label: 'Bangalore Field Rep #4',
    model: 'OnePlus 11 5G',
    osVersion: 'Android 13 (API 33)',
    appVersion: 'v2.1.3',
    status: 'Active',
    captureCapability: 'Near End Only (Forced Speaker)',
    accessibilityEnabled: true,
    batteryLevel: 42,
    storageFreeMB: 8400,
    lastSeen: '15 mins ago',
    pendingUploads: 0,
    lastUploadAt: '4 hours ago',
  },
  {
    id: 'dev-4',
    label: 'Chennai Support Specialist',
    model: 'Xiaomi Redmi Note 12',
    osVersion: 'Android 12 (API 31)',
    appVersion: 'v2.1.0',
    status: 'Active',
    captureCapability: 'Unsupported (Silent)',
    accessibilityEnabled: false,
    batteryLevel: 15,
    storageFreeMB: 1200,
    lastSeen: '2 hours ago',
    pendingUploads: 4,
    lastUploadAt: 'Yesterday',
  },
  {
    id: 'dev-5',
    label: 'Kolkata Account Exec',
    model: 'Google Pixel 6a',
    osVersion: 'Android 14 (API 34)',
    appVersion: 'v2.1.4',
    status: 'Wiped',
    captureCapability: 'Full Duplex (Certified)',
    accessibilityEnabled: false,
    batteryLevel: 0,
    storageFreeMB: 0,
    lastSeen: '3 days ago',
    pendingUploads: 0,
    lastUploadAt: '3 days ago',
  }
];

export const INITIAL_AGENTS: Agent[] = [
  {
    id: 'agent-sales',
    name: 'B2B Enterprise Lead Qualifier',
    version: 4,
    systemPrompt: `You are an expert enterprise sales qualifier. Analyze the transcript to determine if the customer has a real purchase intent, what their specific budget range is, any key objections raised (pricing, timeline, competitors), and if a follow-up action was scheduled. Format output exactly as requested.`,
    scoringWeights: {
      budgetSet: 30,
      intentHot: 35,
      objectionsResolved: 15,
      followUpScheduled: 20
    },
    isActive: true,
    updatedAt: '2026-07-18T14:30:00Z',
    fields: [
      { id: 'f1', key: 'budget', type: 'number', description: 'Stated annual software budget in USD', required: true },
      { id: 'f2', key: 'intent', type: 'enum', description: 'Buyer intent rating', required: true, enumValues: ['Hot', 'Warm', 'Cold'] },
      { id: 'f3', key: 'follow_up_scheduled', type: 'boolean', description: 'Was a concrete follow-up meeting scheduled?', required: true },
      { id: 'f4', key: 'competitors_mentioned', type: 'string', description: 'Competitor names mentioned during the call', required: false }
    ]
  },
  {
    id: 'agent-support',
    name: 'Customer Support Escalation Triage',
    version: 2,
    systemPrompt: `Analyze incoming support calls to extract the main issue category, the severity of the customer's complaint, and if they threatened churn or legal action. Assign an escalation score to prioritize follow-up by senior staff.`,
    scoringWeights: {
      budgetSet: 10,
      intentHot: 20,
      objectionsResolved: 40,
      followUpScheduled: 30
    },
    isActive: false,
    updatedAt: '2026-07-15T09:15:00Z',
    fields: [
      { id: 'f5', key: 'issue_severity', type: 'enum', description: 'Urgency tier of client problem', required: true, enumValues: ['High', 'Medium', 'Low'] },
      { id: 'f6', key: 'escalation_requested', type: 'boolean', description: 'Did the customer explicitly ask for a manager or escalation?', required: true },
      { id: 'f7', key: 'product_bug', type: 'boolean', description: 'Does this refer to a confirmed software bug or defect?', required: false }
    ]
  }
];

export const INITIAL_CALLS: Call[] = [
  {
    id: 'call-101',
    direction: 'Outgoing',
    remoteNumber: '+91 98765 43210',
    remoteName: 'Rajesh Nair (CTO, Infolabs)',
    startedAt: '2026-07-19T10:15:00Z',
    duration: 214,
    audioSource: 'VOICE_CALL',
    status: 'Complete',
    consentStatus: 'Verified (Played)',
    agentId: 'agent-sales',
    agentName: 'B2B Enterprise Lead Qualifier',
    deviceId: 'dev-1',
    deviceLabel: 'Mumbai Sales Desk #1',
    deviceModel: 'Google Pixel 7 Pro',
    leadScore: 85,
    leadIntent: 'Hot',
    budget: '$45,000 / year',
    followUpDate: '2026-07-22 (Demo booked)',
    objections: ['Timeline is tight (needs deployment within 3 weeks)', 'Integration with legacy Active Directory'],
    summary: 'Rajesh is highly interested in migrating to our cloud platform. They have an active budget of $45k and want to see a customized demo on legacy AD integration next Tuesday at 2 PM. High probability opportunity.',
    crmSyncStatus: 'Synced',
    crmExternalId: 'hs-deal-908213',
    crmAttempts: 1,
    transcript: [
      { speaker: 'Agent', text: 'Hello, Rajesh! This is Amit from CloudTech. Just to let you know, our call is recorded for quality and security compliance. Hope that is alright with you?', time: '0:02' },
      { speaker: 'Customer', text: 'Yes, Amit, that is perfectly fine. Thanks for calling back so quickly.', time: '0:09' },
      { speaker: 'Agent', text: 'Excellent. I understand you are reviewing scaling options for your Mumbai databases. What does your current footprint look like?', time: '0:14' },
      { speaker: 'Customer', text: 'Right now we run 15 Postgres instances on-prem. It is getting very heavy to maintain. We have about $45,000 allocated for this fiscal year to move this to a managed cloud service.', time: '0:25' },
      { speaker: 'Agent', text: 'That budget perfectly aligns with our enterprise tier, which handles the administration, automated multi-region backups, and encryption at rest. How soon are you hoping to execute this migration?', time: '0:38' },
      { speaker: 'Customer', text: 'Well, our hardware lease expires in exactly one month, so we need to be fully operational on the cloud within three weeks. That is my biggest worry. Is that feasible?', time: '0:48' },
      { speaker: 'Agent', text: 'Three weeks is tight but absolutely standard for our migration team. We provide a dedicated solutions engineer to assist. Does your team use Active Directory for identity?', time: '1:02' },
      { speaker: 'Customer', text: 'Yes, we use a legacy Active Directory setup. We must have single sign-on working on day one. If we can verify that works, we are ready to sign.', time: '1:14' },
      { speaker: 'Agent', text: 'Understood. Let\'s do this: I can schedule a technical demo with our lead engineer next Tuesday at 2 PM IST to show you exactly how our AD wrapper functions. Would that work?', time: '1:32' },
      { speaker: 'Customer', text: 'Perfect. Let\'s book Tuesday at 2 PM. Send me the invite.', time: '1:45' },
      { speaker: 'Agent', text: 'Wonderful, Rajesh. I\'m sending the calendar invite now. Have a great day!', time: '1:58' },
      { speaker: 'Customer', text: 'Thanks, Amit. Talk to you on Tuesday.', time: '2:10' }
    ]
  },
  {
    id: 'call-102',
    direction: 'Incoming',
    remoteNumber: '+91 99330 11223',
    remoteName: 'Priya Sharma (HR Director, TechVanguard)',
    startedAt: '2026-07-19T09:40:00Z',
    duration: 156,
    audioSource: 'VOICE_CALL',
    status: 'Complete',
    consentStatus: 'Verified (Played)',
    agentId: 'agent-sales',
    agentName: 'B2B Enterprise Lead Qualifier',
    deviceId: 'dev-2',
    deviceLabel: 'Delhi Enterprise Lead',
    deviceModel: 'Samsung Galaxy S23 Ultra',
    leadScore: 60,
    leadIntent: 'Warm',
    budget: 'Under discussion ($15k-20k)',
    followUpDate: '2026-07-25 (Email brochure)',
    objections: ['Pricing seems higher than local cloud hosters', 'Unsure about data residency laws in India'],
    summary: 'Priya inquired about employee monitoring and call logging compliance for their 80-seat recruitment team. Concerned about Indian DPDP compliance and pricing compared to cheaper regional competitors. Sent product security whitepaper.',
    crmSyncStatus: 'Synced',
    crmExternalId: 'hs-deal-908214',
    crmAttempts: 1,
    transcript: [
      { speaker: 'Agent', text: 'Thank you for calling CloudTech sales. Standard notice: this call is recorded to fulfill regulatory audit guidelines.', time: '0:03' },
      { speaker: 'Customer', text: 'Yes, standard practice. Understood. I am calling from TechVanguard. We need a compliant solution to record recruiter outbound calls.', time: '0:12' },
      { speaker: 'Agent', text: 'Excellent, we specialize in high-integrity field-sales call capture. How large is your outbound recruitment fleet?', time: '0:22' },
      { speaker: 'Customer', text: 'We have about 80 active recruiters using Android corporate devices. My main concern is the new DPDP data protection act in India. Where are the call recordings stored?', time: '0:34' },
      { speaker: 'Agent', text: 'All audio is strictly anchored in our Mumbai AWS region, encrypted at rest using AES-256 with keys fully controlled by you. We are fully aligned with DPDP guidelines, including deep erasure utilities.', time: '0:48' },
      { speaker: 'Customer', text: 'That is reassuring. What is your pricing for 80 seats?', time: '1:02' },
      { speaker: 'Agent', text: 'Our Enterprise plan is $18 per seat per month. It includes direct CRM sync and deep transcription insights.', time: '1:12' },
      { speaker: 'Customer', text: 'Oh, that is substantially more than the local hoster we spoke with, who quoted $8 a seat. We need to see if we can justify that premium. We have a budget limit around $15,000 annually for this project.', time: '1:25' },
      { speaker: 'Agent', text: 'Our platform provides automated AI quality scoring and CRM logging, which saves your reps 30 minutes a day of manual data entry. That usually pays back the $10 difference in the first week. Let me email you our ROI calculator and compliance summary.', time: '1:44' },
      { speaker: 'Customer', text: 'Alright, send that over. I\'ll review it with our financial controller and let you know.', time: '2:15' },
      { speaker: 'Agent', text: 'Sending now, Priya. Thanks for your time!', time: '2:25' }
    ]
  },
  {
    id: 'call-103',
    direction: 'Outgoing',
    remoteNumber: '+91 88812 77665',
    remoteName: 'Vikram Grover (Operations, Star Logistics)',
    startedAt: '2026-07-19T08:12:00Z',
    duration: 89,
    audioSource: 'MIC',
    status: 'Complete',
    consentStatus: 'Bypassed (None)',
    agentId: 'agent-sales',
    agentName: 'B2B Enterprise Lead Qualifier',
    deviceId: 'dev-3',
    deviceLabel: 'Bangalore Field Rep #4',
    deviceModel: 'OnePlus 11 5G',
    leadScore: 25,
    leadIntent: 'Cold',
    budget: 'No budget allocated ($0)',
    followUpDate: 'None',
    objections: ['No active interest', 'Already using standard phone recording apps'],
    summary: 'Cold outreach call. Vikram has no interest. They are currently content with a simple local call recorder app on their phone for personal reference and have zero enterprise requirements or budget.',
    crmSyncStatus: 'Synced',
    crmExternalId: 'hs-deal-908215',
    crmAttempts: 1,
    transcript: [
      { speaker: 'Agent', text: 'Hi Vikram, this is Rohan from CloudTech. I was hoping to chat about automated CRM logging for Star Logistics.', time: '0:02' },
      { speaker: 'Customer', text: 'Rohan, I am in the middle of dispatching 40 trucks. We don\'t use a CRM, we use WhatsApp and spreadsheets.', time: '0:14' },
      { speaker: 'Agent', text: 'Ah, I understand. Our system actually captures WhatsApp call logs and syncs field updates automatically.', time: '0:22' },
      { speaker: 'Customer', text: 'Look, we are a small operation, we have no budget for corporate software. If I want to record a call, I just use a free app from the store. I don\'t need anything else.', time: '0:35' },
      { speaker: 'Agent', text: 'No problem at all, Vikram. Thank you for your time and good luck with the truck dispatch!', time: '0:45' },
      { speaker: 'Customer', text: 'Yeah, thanks. Bye.', time: '1:20' }
    ]
  },
  {
    id: 'call-104',
    direction: 'Incoming',
    remoteNumber: '+91 91223 88440',
    remoteName: 'Ananya Roy (Procurement, Zenith Corp)',
    startedAt: '2026-07-18T16:50:00Z',
    duration: 145,
    audioSource: 'VOICE_CALL',
    status: 'Failed',
    consentStatus: 'Failed',
    agentId: 'agent-sales',
    agentName: 'B2B Enterprise Lead Qualifier',
    deviceId: 'dev-4',
    deviceLabel: 'Chennai Support Specialist',
    deviceModel: 'Xiaomi Redmi Note 12',
    leadScore: 0,
    leadIntent: 'Unclassified',
    budget: 'N/A',
    followUpDate: 'N/A',
    objections: ['Audio capture failed due to OS mic lock'],
    summary: 'Call audio is silent due to dual-app mic locking on this Xiaomi device. Ingestion failed during transcription pipeline (ASR received 0 bytes). Accessibility log captured the call metadata, but no analytics are extractable.',
    crmSyncStatus: 'Failed',
    crmExternalId: 'N/A',
    crmAttempts: 3,
    crmError: 'ASR_PIPELINE_ERROR: Digital silence detected in captured channel. Verify device capture capability.',
    transcript: [
      { speaker: 'Agent', text: '[System Diagnostic: Call recorded with Xiaomi Redmi Note 12. Audio stream capture resulted in digital silence. Accessibility tracker successfully registered callee Ananya Roy, duration 145s, direction Incoming.]', time: '0:00' }
    ]
  }
];

export const INITIAL_AUDIT_LOGS: AuditLog[] = [
  {
    id: 'aud-1',
    actor: 'mas20042005@gmail.com',
    role: 'Platform Admin',
    action: 'Access Recording Audio',
    target: 'Call #101 (Rajesh Nair)',
    ipAddress: '103.44.152.88',
    timestamp: '2026-07-19T10:45:12Z',
    status: 'Success'
  },
  {
    id: 'aud-2',
    actor: 'mas20042005@gmail.com',
    role: 'Platform Admin',
    action: 'Modify Prompt Schema',
    target: 'Agent: B2B Enterprise Lead Qualifier (v4)',
    ipAddress: '103.44.152.88',
    timestamp: '2026-07-18T14:30:00Z',
    status: 'Success'
  },
  {
    id: 'aud-3',
    actor: 'mas20042005@gmail.com',
    role: 'Platform Admin',
    action: 'Subject Erasure Requested',
    target: 'Phone Hash: +91 ******4550',
    ipAddress: '103.44.152.88',
    timestamp: '2026-07-17T11:15:33Z',
    status: 'Success'
  },
  {
    id: 'aud-4',
    actor: 'system_worker_01',
    role: 'System Worker',
    action: 'HubSpot CRM Push',
    target: 'Call #102 (Priya Sharma)',
    ipAddress: '10.0.4.12',
    timestamp: '2026-07-19T09:44:11Z',
    status: 'Success'
  },
  {
    id: 'aud-5',
    actor: 'system_worker_02',
    role: 'System Worker',
    action: 'Device Wipe Sent',
    target: 'Device: Kolkata Account Exec (dev-5)',
    ipAddress: '10.0.4.13',
    timestamp: '2026-07-16T18:22:00Z',
    status: 'Success'
  }
];
