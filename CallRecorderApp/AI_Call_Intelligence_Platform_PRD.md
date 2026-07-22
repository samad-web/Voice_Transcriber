# Product Requirements Document (PRD)

## AI Call Intelligence Platform (Android APK + Multi-Tenant Web Platform)

### 1. Product Vision

Build a multi-tenant AI-powered Call Intelligence Platform consisting of
an Android APK that automatically records PSTN and VoIP calls, securely
uploads audio, and synchronizes with a cloud workspace, plus a Web
Platform that acts as a multi-tenant SaaS portal for managing
organizations, users, devices, AI agents, API keys, transcription, lead
extraction, CRM integrations, analytics, billing, and usage limits. The
platform must be fully dynamic with no customer-specific logic
hardcoded.

### 2. High-Level Architecture

``` text
Android APK
    │
Record Calls
    │
Encrypt & Upload
    │
Backend API
    ├── Tenant Service
    ├── Device Service
    ├── AI Runtime
    ├── ASR Service
    ├── Agent Engine
    ├── CRM Service
    ├── Billing
    ├── Analytics
    └── Notifications
```

### 3. Multi-Tenant Hierarchy

-   Platform
    -   Organization
        -   Workspace
            -   AI Instances
            -   Android Devices
            -   Users
            -   API Keys
            -   CRM Integrations
            -   Call History

### 4. Android APK

#### Existing Features

-   Automatic PSTN call recording
-   Incoming & outgoing call recording
-   VoIP recording
-   Dual-channel audio
-   Background uploads

#### New Features

-   Instance registration using Instance ID
-   Device authentication
-   Remote configuration sync
-   Background synchronization
-   Device health dashboard
-   End-to-end encryption
-   JWT authentication
-   Remote logout and wipe

### 5. Web Platform

#### Super Admin

-   Manage organizations
-   Billing & plans
-   Global analytics
-   AI model management

#### Organization Admin

-   Users
-   Workspaces
-   AI Instances
-   AI Agents
-   API Keys
-   CRM integrations
-   Usage monitoring

#### Users

-   View calls
-   Search transcripts
-   Listen to recordings
-   CRM updates
-   Dashboards

### 6. AI Instances

Each instance contains: - Instance ID - Secret - Devices - Monthly
limits - AI configuration - Active model - Language settings

### 7. Device Management

-   Register/remove devices
-   Rename devices
-   Force sync
-   Remote logout
-   Health monitoring

### 8. Subscription Limits

-   Devices
-   AI Agents
-   Calls/month
-   Minutes/month
-   Storage
-   API requests
-   Team members
-   CRM integrations

### 9. AI Agent Builder

Dynamic agent configuration: - System prompt - Extraction fields -
Classification labels - Lead scoring - Sentiment analysis - CRM
mapping - Validation rules

### 10. Dynamic Schema

Admins define custom extraction fields without backend code changes.

### 11. API Key Management

Support encrypted API profiles for OpenAI, Gemini, Claude, and future
providers.

### 12. AI Processing Pipeline

Audio → ASR → Language Detection → Load Instance → Load Agent → Prompt
Generation → LLM → JSON Validation → CRM → Storage

### 13. CRM Integrations

-   Salesforce
-   HubSpot
-   Zoho
-   Dynamics
-   REST/Webhooks

### 14. Analytics

-   Calls
-   Lead conversion
-   Recording success
-   Sentiment
-   AI cost
-   Device health
-   Model usage

### 15. Search & Playback

-   Transcript search
-   Audio playback
-   Timestamp navigation
-   Notes
-   Filters

### 16. Notifications

-   Hot leads
-   Upload failures
-   Device offline
-   API failures
-   CRM failures

### 17. Billing

Track: - Calls - Minutes - AI tokens - Storage - Devices - Users

### 18. Database Entities

Organizations, Workspaces, Users, Roles, Devices, AI Instances, AI
Agents, Calls, Recordings, Transcripts, AI Outputs, CRM Mappings,
Notifications, Billing, Usage Metrics.

### 19. API Endpoints

-   POST /devices/register
-   POST /devices/authenticate
-   GET /instances/{id}/config
-   POST /calls/upload
-   POST /calls/process
-   POST /agents
-   POST /instances
-   POST /apikeys
-   POST /crm/webhook

### 20. Non-Functional Requirements

-   Multi-tenancy
-   RBAC
-   Queue-based processing
-   Horizontal scalability
-   Audit logs
-   Encryption
-   Observability

### 21. Technical Stack

-   Backend: NestJS/FastAPI
-   PostgreSQL
-   Redis
-   RabbitMQ/Kafka/SQS
-   S3-compatible storage
-   Whisper/OpenAI/Gemini ASR
-   OpenAI/Gemini/Claude abstraction layer
-   Elasticsearch/OpenSearch
-   Prometheus + Grafana

### Recommendation

Implement a Model Provider Layer to centrally manage AI providers,
routing, failover, and cost optimization while optionally supporting
customer-managed API keys.
