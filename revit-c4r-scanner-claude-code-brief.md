# Revit C4R Scanner — Claude Code Build Brief

## Project overview

Build a production-ready web application called **Revit C4R Scanner** that helps Autodesk Construction Cloud (ACC) and BIM 360 account admins identify Revit files using deprecated versions of Collaboration for Revit (C4R), prioritize which projects need upgrading, and track remediation progress.

**Context:** Autodesk dropped cloud model access for Revit 2021 and older on May 7, 2026 (30 days after the Revit 2027 release on April 7, 2026). Each subsequent annual Revit release drops the oldest supported version. This tool must handle that rolling deprecation cycle.

**Audience:** Autodesk customers (architects, BIM managers). Deployed as open source on GitHub — each customer self-hosts their own instance on Vercel + Supabase.

**Design reference:** Forma / Autodesk Construction Cloud visual language. Clean, light, flat UI. No gradients, no heavy styling.

---

## Tech stack — exact packages

```
Framework:        Next.js 14 (App Router, React Server Components)
Styling:          Tailwind CSS v3 + shadcn/ui components
Database:         Supabase (Postgres 15, Auth, Realtime, Edge Functions)
ORM:              None — raw Supabase client (@supabase/supabase-js)
APS SDK:          @aps_sdk/autodesk-sdkmanager @aps_sdk/authentication
                  @aps_sdk/data-management @aps_sdk/construction-account-admin
Rate limiting:    p-limit p-retry
PDF generation:   @react-pdf/renderer
Scheduling:       Supabase pg_cron (via Edge Function)
State:            Zustand (client scan progress state)
Charts:           Recharts
Deployment:       Vercel (Pro recommended, 300s function timeout)
CI:               GitHub Actions
```

---

## Environment variables

```bash
# APS Application (created at aps.autodesk.com)
APS_CLIENT_ID=
APS_CLIENT_SECRET=
APS_CALLBACK_URL=https://your-domain.vercel.app/api/auth/callback

# Supabase (created at supabase.com)
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=         # server-only, never exposed to client

# App config
NEXT_PUBLIC_DEPRECATED_BELOW_VERSION=2022   # files < this version are flagged
NEXT_PUBLIC_DEADLINE_DATE=2026-05-07        # shown in countdown KPI
```

No stored OAuth tokens. Users authenticate fresh for each scan session.

---

## Auth model

**3-legged OAuth (PKCE) — the user must be an ACC Account Admin.**

### Why 3-legged works for "all projects"
The Data Management API `GET /project/v1/hubs/:id/projects` only returns projects the authenticated user is a member of. The **ACC Admin API** `GET /construction/admin/v1/accounts/:accountId/projects` returns ALL projects in the hub — ACC and BIM 360. Same 3-legged token, just needs Account Admin role. This is the correct approach.

### OAuth scopes
```
data:read account:read
```

### PKCE flow (implemented in Next.js API routes)

```
GET  /api/auth/login       → redirect to Autodesk PKCE authorize URL
GET  /api/auth/callback    → exchange code for tokens, store in httpOnly cookie (session only, never DB)
GET  /api/auth/logout      → clear cookie
GET  /api/auth/me          → return { name, email, autodesk_id } from /userinfo
```

Token storage: httpOnly, Secure, SameSite=Strict cookie. No refresh token stored. Session expires with cookie (~1 hour). On expiry, user must re-login to run another scan.

### Pre-requisite for customers
Customer must provision the APS app in their ACC hub:
`ACC Account Admin → Apps & Integrations → Add Custom App → enter Client ID`

Document this clearly in README with screenshots.

---

## Database schema — run as Supabase migration

```sql
-- Enable UUID extension
create extension if not exists "pgcrypto";

-- Hub settings (one row per deployment — single tenant)
create table hub_settings (
  id                          uuid primary key default gen_random_uuid(),
  hub_id                      text unique not null,
  hub_name                    text,
  account_id                  text not null,
  deprecated_below_version    text not null default '2022',
  deadline_date               date,
  scan_reminder_days          int default 7,
  created_at                  timestamptz default now(),
  updated_at                  timestamptz default now()
);

-- Scan jobs — one row per scan run
create table scan_jobs (
  id                          uuid primary key default gen_random_uuid(),
  hub_id                      text not null,
  status                      text not null default 'pending',
    -- pending | running | completed | failed | paused
  phase                       text default 'bootstrap',
    -- bootstrap | projects | files | versions | done
  overall_pct                 int default 0,
  current_action              text,
  -- Phase cursors for resume
  phase_0_cursor              text,   -- last page offset (project enumeration)
  phase_1_cursor              text,   -- last project_id enriched
  phase_2_cursors             jsonb,  -- { projectId: lastFolderUrn }
  phase_3_cursor              text,   -- last file_id version-detected
  -- Counters
  total_projects              int default 0,
  scanned_projects            int default 0,
  total_rvt_files             int default 0,
  versions_detected           int default 0,
  at_risk_count               int default 0,
  rate_limit_hits             int default 0,
  error_count                 int default 0,
  eta_seconds                 int,
  -- Metadata
  triggered_by                text default 'manual', -- manual | scheduled
  error_message               text,
  started_at                  timestamptz,
  completed_at                timestamptz,
  created_at                  timestamptz default now(),
  updated_at                  timestamptz default now()
);

-- Projects — one row per ACC/BIM360 project per scan
create table projects (
  id                          uuid primary key default gen_random_uuid(),
  scan_job_id                 uuid references scan_jobs(id) on delete cascade,
  acc_project_id              text not null,
  hub_id                      text not null,
  name                        text,
  project_type                text,   -- ACC | BIM360
  status                      text,   -- active | inactive | archived
  member_count                int default 0,
  rvt_file_count              int default 0,
  at_risk_file_count          int default 0,
  min_revit_version           text,   -- oldest version found in this project
  priority_score              int default 0,
    -- formula: (recency_weight*3 + member_norm*2 + file_norm*1) / 6 * 100
  last_file_activity          timestamptz,  -- most recent .rvt modified date
  scan_status                 text default 'pending',
    -- pending | scanning | completed | error | skipped
  scan_error                  text,
  upgrade_status              text default 'not_needed',
    -- not_needed | pending | in_progress | completed | skipped
  scanned_at                  timestamptz,
  created_at                  timestamptz default now()
);

create index idx_projects_scan_job on projects(scan_job_id);
create index idx_projects_at_risk on projects(scan_job_id, at_risk_file_count desc);

-- Revit files — one row per .rvt file found
create table revit_files (
  id                          uuid primary key default gen_random_uuid(),
  project_id                  uuid references projects(id) on delete cascade,
  item_id                     text not null,    -- APS Data Management item ID
  version_urn                 text,             -- base64 encoded URN
  file_name                   text not null,
  folder_path                 text,
  revit_version               text,             -- '2019', '2020', '2021', null
  detection_method            text,
    -- manifest | binary_header | design_automation | unknown
  is_workshared               boolean,
  is_central                  boolean,
  is_cloud_model              boolean,
  needs_upgrade               boolean,          -- SET IN APPLICATION CODE, not as generated column
                                                  -- compute as: revit_version::int < hub_settings.deprecated_below_version::int
                                                  -- Do NOT use GENERATED ALWAYS AS — the threshold changes each year
  file_size_bytes             bigint,
  last_modified_at            timestamptz,
  created_at                  timestamptz default now()
);

create index idx_revit_files_project on revit_files(project_id);
create index idx_revit_files_needs_upgrade on revit_files(project_id, needs_upgrade);

-- Upgrade tasks — one row per project assigned for upgrade
create table upgrade_tasks (
  id                          uuid primary key default gen_random_uuid(),
  project_id                  uuid references projects(id) on delete cascade,
  status                      text default 'pending',
    -- pending | in_progress | completed | skipped | blocked
  target_version              text,             -- e.g. '2024'
  assigned_to                 text,             -- name or email
  acc_upgrade_url             text,             -- deep-link to ACC upgrade page
  notes                       text,
  pre_upgrade_version         text,
  post_upgrade_version        text,
  verified_at                 timestamptz,      -- set after post-upgrade scan confirms
  completed_at                timestamptz,
  created_at                  timestamptz default now(),
  updated_at                  timestamptz default now()
);

-- Enable Realtime on scan_jobs so frontend gets live updates
alter publication supabase_realtime add table scan_jobs;
```

---

## File structure

```
revit-c4r-scanner/
├── app/
│   ├── layout.tsx                    # Root layout, Tailwind, fonts
│   ├── page.tsx                      # Landing / hub selector (requires auth)
│   ├── dashboard/
│   │   ├── page.tsx                  # Main dashboard (KPIs, charts, project table)
│   │   └── [projectId]/page.tsx      # Project drill-down (files list)
│   ├── scan/
│   │   └── page.tsx                  # Scan progress view (real-time)
│   ├── upgrade/
│   │   └── page.tsx                  # Upgrade tracker (Module 3)
│   └── api/
│       ├── auth/
│       │   ├── login/route.ts        # PKCE authorize redirect
│       │   ├── callback/route.ts     # Token exchange → httpOnly cookie
│       │   ├── logout/route.ts       # Clear cookie
│       │   └── me/route.ts           # /userinfo proxy
│       ├── hubs/
│       │   └── route.ts              # GET hubs (DM API)
│       ├── scan/
│       │   ├── start/route.ts        # Create scan_job, begin Phase 0
│       │   ├── resume/route.ts       # Resume interrupted scan
│       │   ├── chunk/route.ts        # Process next batch (all phases)
│       │   └── [jobId]/route.ts      # GET scan job status
│       ├── projects/
│       │   └── route.ts              # GET projects for latest scan
│       └── pdf/
│           └── route.ts              # Generate PDF report
├── lib/
│   ├── aps/
│   │   ├── auth.ts                   # PKCE helpers, token from cookie
│   │   ├── admin.ts                  # ACC Admin API (list all projects)
│   │   ├── dm.ts                     # Data Management (folders, items, versions)
│   │   └── derivative.ts             # Model Derivative manifest
│   ├── scan/
│   │   ├── engine.ts                 # Orchestrator: phases 0-3
│   │   ├── phase0-bootstrap.ts       # Enumerate all projects → DB
│   │   ├── phase1-enrich.ts          # Member count, project type
│   │   ├── phase2-files.ts           # BFS folder traversal, find .rvt
│   │   ├── phase3-versions.ts        # Fallback chain: T1 → T2 → T3
│   │   └── rate-limiter.ts           # p-limit + exponential backoff
│   ├── detect/
│   │   ├── manifest.ts               # T1: Model Derivative RVTVersion
│   │   ├── binary-header.ts          # T2: 10KB range download + parse
│   │   └── design-automation.ts      # T3: BasicFileInfo workitem
│   ├── priority.ts                   # Priority score formula
│   ├── supabase.ts                   # Supabase client (server + browser)
│   └── pdf/
│       └── report.tsx                # React PDF report template
├── components/
│   ├── kpi-card.tsx
│   ├── trend-chart.tsx
│   ├── version-chart.tsx
│   ├── project-table.tsx
│   ├── scan-progress.tsx             # Real-time progress bar + log
│   ├── upgrade-board.tsx
│   └── hub-picker.tsx
├── supabase/
│   └── migrations/
│       └── 001_initial.sql           # Full schema above
├── .env.local.example
├── README.md
└── package.json
```

---

## Scan engine — detailed algorithm

### Rate limiter (lib/scan/rate-limiter.ts)

```typescript
import pLimit from 'p-limit';
import pRetry from 'p-retry';

// Global concurrency limits per phase
export const limits = {
  phase0: pLimit(3),   // pagination requests
  phase1: pLimit(15),  // project enrichment
  phase2: pLimit(25),  // folder traversal (5 projects × 5 folders)
  phase3: pLimit(10),  // version detection
};

export async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  return pRetry(fn, {
    retries: 5,
    factor: 2,
    minTimeout: 100,
    maxTimeout: 30000,
    jitter: 'full',
    onFailedAttempt: (err) => {
      if (err.response?.status === 429) {
        const retryAfter = err.response.headers['retry-after'];
        if (retryAfter) return new Promise(r => setTimeout(r, parseInt(retryAfter) * 1000));
        // After 3 consecutive 429s, halve concurrency for 60s
      }
      if (err.response?.status === 403) throw err; // Don't retry auth errors
    }
  });
}
```

### Phase 0 — bootstrap (lib/scan/phase0-bootstrap.ts)

```typescript
// 1. Call ACC Admin API: GET /construction/admin/v1/accounts/:accountId/projects
//    Paginated with limit=100, offset=0. Loop until no more results.
// 2. Write all project stubs to DB (acc_project_id, name, project_type, scan_status='pending')
// 3. Update scan_job: total_projects=N, phase='projects', phase_0_cursor='done'
// 4. Return total count to frontend immediately — progress bar initializes
```

### Phase 1 — enrich (lib/scan/phase1-enrich.ts)

```typescript
// For each project (15 concurrent via limits.phase1):
// 1. GET /construction/admin/v1/accounts/:accountId/projects/:projectId/users?limit=1
//    → pagination.totalResults = member_count
// 2. Determine if project has Revit enabled (check products list or just proceed)
// 3. Write: member_count, project_type confirmed, scan_status='pending'
// 4. Update phase_1_cursor to last processed project_id after each batch
// 5. Update scan_job: scanned_projects++, overall_pct = scanned/total*30 (phase1 = 0-30%)
```

### Phase 2 — file discovery (lib/scan/phase2-files.ts)

```typescript
// For each project (5 concurrent projects, 5 concurrent folders per project):
// 1. GET /project/v1/hubs/:hubId/projects/:projectId/topFolders
// 2. BFS: for each folder, GET /data/v1/projects/:projectId/folders/:folderId/contents
//    Filter items where attributes.displayName ends with '.rvt'
//    Recurse into subFolderItems concurrently
// 3. For each .rvt found: write revit_files stub (item_id, version_urn, file_name, folder_path)
// 4. Save phase_2_cursors[projectId] = lastProcessedFolderUrn after each folder batch
// 5. Update scan_job: total_rvt_files++, overall_pct = 30 + (filesPhase/total)*40 (30-70%)
//
// BIM360 note: topFolders returns 'Project Files' and 'Plans' — traverse both
// ACC note: same structure, same API endpoint
```

### Phase 3 — version detection (lib/scan/phase3-versions.ts)

**IMPORTANT: The detection chain was revised based on research. The original binary header (regex) approach
does not work for Revit 2024 and 2025 — the internal file scheme changed. Design Automation is the
reliable fallback for all versions. For C4R cloud models, the version is often directly available in
the DM API version extension data — read during Phase 2 at zero extra cost.**

```typescript
// For each revit_file (10 concurrent via limits.phase3):
// Try T0 → T1 → T2 → T3 in order, stop at first success

// T0: DM API version extension data — FREE, already fetched in Phase 2
// C4R cloud models expose revitProjectVersion directly in the item version attributes.
// Extension type: "versions:autodesk.bim360:C4RModel"
// This is the most reliable and cheapest method. Store during Phase 2 if available.
//
// Example response structure from GET /data/v1/projects/:id/items/:itemId/versions:
// attributes.extension.type === "versions:autodesk.bim360:C4RModel"
// attributes.extension.data.revitProjectVersion === 2025  ← exact year as int
// attributes.extension.data.isCompositeDesign             ← true if linked model
//
// During Phase 2 folder traversal, when writing a .rvt file stub to DB:
// - Check item version extension type
// - If C4RModel: write revit_version = extension.data.revitProjectVersion, detection_method='dm_extension', is_cloud_model=true
// - Mark file as version_detected, skip in Phase 3
// This means most cloud workshared models — the primary target — never need Phase 3 at all.

// T1: Model Derivative manifest RVTVersion
// Works for models translated after Nov 4 2021. Zero download. ~200ms per file.
async function detectFromManifest(urn: string, token: string): Promise<string | null> {
  const resp = await fetch(
    `https://developer.api.autodesk.com/derivativeservice/v2/manifest/${encodeURIComponent(urn)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!resp.ok) return null;
  const manifest = await resp.json();
  const derivative = manifest.derivatives?.find(
    (d: any) => d.outputType === 'svf' || d.outputType === 'svf2'
  );
  if (!derivative) return null;
  const docInfo = derivative.children?.find(
    (c: any) => c.role === 'Autodesk.CloudPlatform.DocumentInfo'
  );
  return docInfo?.properties?.['Document Information']?.RVTVersion?.toString() ?? null;
}

// T2: Design Automation BasicFileInfo — reliable for ALL Revit versions including 2024+
// The binary header regex approach is BROKEN for Revit 2024 and newer (scheme changed).
// Use DA instead: submit workitem with DA4R-RevitBasicFileInfoExtract AppBundle.
// Async — returns in 1–3 minutes. Only used for non-cloud, non-translated files.
// Reference implementation: https://github.com/yiskang/DA4R-RevitBasicFileInfoExtract
//
// Result JSON from BasicFileInfo includes:
// { "Format": "2023", "IsWorkshared": true, "IsCentral": false, "CentralPath": "..." }
//
// Store workitems in a separate da_jobs table. Poll for completion.
// Process DA results as they complete (event-driven, not blocking the main scan).

// T3: Binary header parse — LAST RESORT, unreliable for Revit 2024+
// Only attempt if T0/T1/T2 all failed and file is older (pre-2024 suspected).
// OLE2 signature bytes: D0 CF 11 E0 A1 B1 1A E1 (first 8 bytes of any .rvt)
// Version string for Revit ≤2023: search for "Autodesk Revit \d{4}" in first 512 bytes
// Version string for Revit 2019+: search for "Format: \d{4}" in BasicFileInfo stream
// DO NOT rely on this for 2024+ files — mark as unknown instead.
async function detectFromBinaryHeader(storageUrl: string, token: string): Promise<string | null> {
  const resp = await fetch(storageUrl, {
    headers: { Authorization: `Bearer ${token}`, Range: 'bytes=0-4096' }
  });
  if (!resp.ok) return null;
  const buffer = await resp.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  // Verify OLE2 signature
  const OLE2_SIG = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
  const isOLE2 = OLE2_SIG.every((b, i) => bytes[i] === b);
  if (!isOLE2) return null;
  const text = new TextDecoder('latin1').decode(buffer);
  // Works for Revit 2019–2023
  const formatMatch = text.match(/Format:\s*(\d{4})/);
  if (formatMatch) return formatMatch[1];
  // Older fallback (Revit 2018 and below)
  const buildMatch = text.match(/Autodesk Revit (\d{4})/);
  return buildMatch ? buildMatch[1] : null;
}

// After detection (any tier):
// 1. Write revit_version, detection_method, is_workshared, is_central, is_cloud_model
// 2. Compute needs_upgrade (revit_version < DEPRECATED_BELOW_VERSION)
// 3. Update project: at_risk_file_count++, min_revit_version (track oldest)
// 4. Recompute project priority_score
// 5. Update phase_3_cursor, scan_job counters
// 6. overall_pct = 70 + (detected/total)*30 (70–100%)
// Files that exhaust all tiers → detection_method='unknown', flag in dashboard
```

### Priority score formula (lib/priority.ts)

```typescript
export function computePriorityScore(project: {
  member_count: number;
  at_risk_file_count: number;
  last_file_activity: Date | null;
  max_members: number;      // hub-wide max for normalization
  max_at_risk: number;      // hub-wide max for normalization
}): number {
  const daysSinceActivity = project.last_file_activity
    ? (Date.now() - project.last_file_activity.getTime()) / 86400000
    : 999;
  
  const recencyWeight = daysSinceActivity < 14 ? 3
    : daysSinceActivity < 30 ? 2.5
    : daysSinceActivity < 90 ? 1.5
    : 1;
  
  const memberNorm = project.max_members > 0
    ? (project.member_count / project.max_members) * 3
    : 0;
  
  const fileNorm = project.max_at_risk > 0
    ? (project.at_risk_file_count / project.max_at_risk) * 3
    : 0;

  return Math.round(((recencyWeight * 3) + (memberNorm * 2) + (fileNorm * 1)) / 6 * 100);
}
```

---

## API routes

### POST /api/scan/start

```typescript
// 1. Verify auth cookie (must have valid APS token)
// 2. Check for existing running scan → if found and stale (updated_at < now-90s), auto-resume
// 3. Create scan_job row: status='running', started_at=now()
// 4. Begin Phase 0 synchronously (fast — just enumeration)
// 5. Return { jobId, status: 'started', total_projects }
// Client immediately begins polling /api/scan/chunk
```

### POST /api/scan/chunk

```typescript
// Body: { jobId: string, phase: string, cursor?: string }
// 1. Load scan_job from DB
// 2. Determine which phase to run based on job.phase
// 3. Process one batch (N items per call, fit within 25s)
// 4. Update scan_job with new cursor, counters, overall_pct
// 5. Return { done: boolean, next_cursor, phase, overall_pct, current_action, eta_seconds }
// Client immediately calls next chunk if done=false
// Supabase Realtime also broadcasts scan_job updates to dashboard
```

### GET /api/pdf

```typescript
// Query: ?jobId=...
// 1. Load scan_job + all at-risk projects sorted by priority_score desc
// 2. Load at-risk files per project (grouped)
// 3. Render React PDF report
// 4. Return as application/pdf with Content-Disposition: attachment
```

---

## Module 3 — Programmatic upgrade via Design Automation API

**Research update: programmatic upgrade IS possible.** An official APS blog post (Nov 2025) and
open-source reference implementation demonstrate exactly this workflow. Build it into Module 3 as
an advanced option alongside the manual tracker.

**Reference:** https://aps.autodesk.com/blog/revit-cloud-worksharing-migration-tool-automation-api
**Reference implementation:** https://github.com/autodesk-platform-services/aps-revit-rcw-migrate-automation

### How programmatic upgrade works

1. **Download** the RCW model from ACC/BIM 360 via signed URL (as a local .rvt file)
2. **Submit DA workitem** — AppBundle opens it as a detached model (worksets preserved automatically)
3. **Inside AppBundle:** call `Document.SaveAsCloudModel(accountId, projectId, folderId, fileName)` — republishes to ACC at the new Revit engine version
4. **Monitor** workitem → on completion, trigger mini re-scan to verify version changed

**Critical constraint:** Cannot open an RCW directly inside Revit Automation — download locally first, then SaveAsCloudModel re-publishes it as a new cloud model version.

**Engine = target version:** AppBundle running on `Autodesk.Revit+2025` saves the model as Revit 2025. Build one activity per supported target version (2022–2027).

### Additional DB table

```sql
create table da_upgrade_jobs (
  id                    uuid primary key default gen_random_uuid(),
  upgrade_task_id       uuid references upgrade_tasks(id) on delete cascade,
  project_id            uuid references projects(id),
  file_id               uuid references revit_files(id),
  da_workitem_id        text,
  status                text default 'queued',
  target_version        text not null,
  source_version        text,
  engine                text,
  error_message         text,
  submitted_at          timestamptz,
  completed_at          timestamptz,
  created_at            timestamptz default now()
);
```

### Upgrade page — two modes

**Mode A: Manual tracker** (always available — no extra setup)
Assign projects, track status, deep-link to ACC, verify via mini re-scan.

**Mode B: Automated upgrade** (requires one-time DA setup wizard)
Select projects + files + target version → submit DA workitems (10 concurrent max) → live progress per file → auto-verify on completion. Requires `data:write` scope — request this at login only if Mode B is enabled.

### DA setup wizard (one-time, /settings/da-setup page)
Create AppBundle + Activity per target Revit version. Store IDs in hub_settings. Reference the open-source AppBundle code from the APS reference implementation above.

### Caveats to surface in UI
- Linked models (`isCompositeDesign=true`): upgrading host does NOT auto-upgrade linked files — flag clearly
- Creates a new version in ACC, does not replace old one (version history preserved)
- Large files (>500MB) may take 5–15 min per workitem
- Default DA concurrency quota: 10 simultaneous workitems

---

## UI pages and components

### Dashboard page (app/dashboard/page.tsx)

Layout (top to bottom):
1. Header: hub name, last scan date, "Run scan" button, "Export PDF" button
2. KPI row (4 cards):
   - Projects at risk (count + % of total, red if >0)
   - Files needing upgrade (count + %, amber)
   - Members impacted (sum of member_count across at-risk projects, blue)
   - Days to deadline (countdown to DEADLINE_DATE, red when <14)
3. Charts row (2/3 + 1/3):
   - Left: "Files at risk over time" — Recharts LineChart, 2 series (at-risk / cleared), weekly scan data points
   - Right: "Version distribution" — Recharts BarChart horizontal, files by Revit version, red bars for deprecated
4. Project table (shadcn/ui Table):
   - Columns: Project name, Type (ACC/BIM360 badge), Risk (High/Medium/Low pill), Priority score (number + thin bar), Members, .rvt at risk, Min version, Last active, Action
   - Sorted by priority_score desc by default
   - Filterable by: risk level, project type, upgrade status
   - Clickable rows → project drill-down

### Scan progress page (app/scan/page.tsx)

- Large circular progress indicator (overall_pct)
- Phase indicator: Bootstrap → Projects → Files → Versions (stepper)
- Current action text (updates every ~2s via Supabase Realtime)
- Live counters: projects scanned, .rvt found, versions detected, rate limit hits
- ETA display
- Error log (expandable, per-project errors listed)
- "Pause scan" button
- Auto-redirect to dashboard when scan completes

Subscribe to Supabase Realtime:
```typescript
const channel = supabase
  .channel('scan-progress')
  .on('postgres_changes', {
    event: 'UPDATE', schema: 'public', table: 'scan_jobs',
    filter: `id=eq.${jobId}`
  }, (payload) => updateProgress(payload.new))
  .subscribe();
```

### PDF report structure (lib/pdf/report.tsx)

Pages:
1. Cover: Hub name, scan date, generated by app
2. Executive summary: 4 KPIs, brief explanation of deprecation policy
3. At-risk projects table: sorted by priority score, columns: project name, members, files at risk, min version, last active, priority score
4. Per-project breakdown (one section per high-priority project): project details + list of at-risk .rvt files with folder path and version
5. Appendix: version distribution table, methodology notes

Style: clean, black/white/gray, Autodesk-neutral. No logos (customers may add their own).

### Upgrade tracker page (app/upgrade/page.tsx)

- Table of projects with upgrade_tasks rows
- Status column: Pending / In progress / Completed / Skipped (color-coded pills)
- Per-row: "Open in ACC →" button (deep-links to `https://acc.autodesk.com/docs/projects/${projectId}/settings/model-upgrade`)
- "Assign" button: modal with target version picker + assignee name field
- "Mark done" → triggers mini re-scan of that project's .rvt files only
- Summary at top: X of Y projects upgraded, estimated % of at-risk files resolved

---

## Key behaviors and edge cases

**BIM 360 vs ACC projects:** Both returned by ACC Admin API. Differentiate via `project_type` field in Admin API response. Folder traversal and file access are identical (same DM API endpoints). Handle both gracefully.

**Projects with no .rvt files:** Mark as `scan_status='completed'`, `rvt_file_count=0`, `upgrade_status='not_needed'`. Never show in at-risk list.

**Projects with 403/access errors:** Mark as `scan_status='error'`, store `scan_error='Insufficient permissions'`. Surface in dashboard with explanation. Don't fail the entire scan.

**Version detection fallback chain — updated order T0→T1→T2→T3:**
- T0 happens inline during Phase 2 folder traversal at zero extra cost. For C4R cloud models, the DM API item version response includes `attributes.extension.data.revitProjectVersion` as an integer. If present, write it immediately and skip this file in Phase 3.
- T1 (Model Derivative manifest) is the first Phase 3 attempt. Requires the file to have been translated after Nov 2021.
- T2 (Design Automation BasicFileInfo) is the reliable fallback for all versions including 2024+. The old binary regex approach is BROKEN for Revit 2024/2025 — do not use it as the primary fallback.
- T3 (binary header parse, 4KB range download) is last resort only. Verify OLE2 signature (bytes: `D0 CF 11 E0 A1 B1 1A E1`), then search for `Format: YYYY` (Revit 2019+) or `Autodesk Revit YYYY` (≤2018). For files suspected to be 2024+, skip T3 and mark as unknown rather than returning a wrong result.
- Files exhausting all tiers → `detection_method='unknown'`, `revit_version=null`. Show in dashboard as "Version unknown — manual check required". Include in PDF report with a note. Do not exclude from at-risk list; treat conservatively (assume at-risk).

**Linked models (composite designs) — requires special handling throughout:**

During Phase 2 folder traversal, when reading item version extension data:
- If `attributes.extension.data.isCompositeDesign === true`: set `is_composite=true` on the revit_files row and store `composite_parent_file` (the parent filename from `extension.data.compositeParentFile` if present)
- A composite design means this file has linked Revit models — upgrading the host without upgrading linked files will break the model's references

In the dashboard project drill-down:
- Show a warning banner if any at-risk file in the project has `is_composite=true`: "⚠ This project contains linked model assemblies. Upgrading host files without upgrading linked files will break references. Review all linked files before proceeding."
- In the file table, show a "Linked" badge on composite files and list known linked file names if available

In the upgrade tracker (both modes):
- Mode A (manual): surface a "Has linked models" warning column. Deep-link to ACC still works but the user must handle linked files manually.
- Mode B (automated DA): block automated upgrade for composite files by default. Show a warning: "Linked model upgrade is not yet supported in automated mode — use manual upgrade in ACC for this file." Provide a checkbox override for advanced users who understand the risk.

Add these columns to `revit_files` table:
```sql
is_composite          boolean default false,
composite_parent_file text,   -- parent .rvt filename if this is a linked file
has_linked_files      boolean default false,  -- true if this file IS the host
linked_file_count     int default 0,  -- how many links this host has (from extension data if available)
```

Add to `projects` table:
```sql
has_composite_files   boolean default false,  -- true if any .rvt in this project is composite
composite_file_count  int default 0,
```

**Rolling deprecation cycle — important implementation note:**
`DEPRECATED_BELOW_VERSION` env var controls what version is flagged. The `needs_upgrade` computed column in the DB schema uses a hardcoded literal `< 2022` — this MUST be updated manually in a new migration when the threshold changes. To make this safer: store the threshold in `hub_settings.deprecated_below_version` (already in schema) and compute `needs_upgrade` in application code rather than as a Postgres generated column. Remove the `GENERATED ALWAYS AS` clause and compute it as:
```typescript
const needsUpgrade = revit_version !== null &&
  parseInt(revit_version) < parseInt(settings.deprecated_below_version);
```
Update this on every scan run based on current `hub_settings` value.

**Weekly scan reminder:** On each login, check `scan_jobs` for the most recent completed scan. If `completed_at < now() - 7 days`, show a banner: "Your last scan was X days ago. Run a new scan to get up-to-date results." No auto-scan — no refresh tokens are stored.

**ACC upgrade deep-link URL:** The URL pattern for the Revit Cloud Model Upgrade page in ACC is:
```
https://acc.autodesk.com/docs/files/projects/{projectId}?upgrade=true
```
where `projectId` is the ACC project ID **without** the `b.` prefix. If this URL pattern does not land on the correct page (it may vary by region or ACC version), fall back to the project's Docs root:
```
https://acc.autodesk.com/docs/files/projects/{projectId}
```
and add a tooltip explaining: "Navigate to Settings → Revit Cloud Model Upgrade inside this project." Verify the correct URL by testing with a real ACC project before shipping — this was not confirmed via API documentation and may need adjustment.

---

## Security checklist

- [ ] APS tokens only in httpOnly Secure cookies, never in localStorage or sent to client JS
- [ ] `SUPABASE_SERVICE_ROLE_KEY` never exposed to client (only used in server-side API routes)
- [ ] All API routes check for valid auth cookie before executing
- [ ] APS token never logged or stored in DB
- [ ] Supabase RLS: not needed for single-tenant, but enable basic policies anyway:
      `CREATE POLICY "allow_all" ON scan_jobs FOR ALL USING (true);` — document that this is single-tenant
- [ ] Rate limiter prevents runaway API calls
- [ ] PDF download route: no auth bypass — same cookie check as other routes
- [ ] CORS: restrict to own domain in Next.js config

---

## README structure (for GitHub)

```markdown
# Revit C4R Scanner

Identify Revit files on deprecated Collaboration for Revit versions across your 
ACC/BIM 360 hub and track upgrade progress.

## Prerequisites
- Autodesk Platform Services account (free at aps.autodesk.com)
- Supabase account (free tier works)
- Vercel account (free tier works for most hubs, Pro recommended for >500 projects)
- ACC Account Admin access

## Setup (~15 minutes)

### 1. Create APS application
1. Go to https://aps.autodesk.com/myapps → Create App
2. Select APIs: Data Management, Model Derivative, Construction Cloud Admin
3. Set callback URL: https://your-domain.vercel.app/api/auth/callback
4. Save Client ID and Client Secret

### 2. Create Supabase project
1. New project at supabase.com
2. Go to SQL Editor → paste contents of supabase/migrations/001_initial.sql → Run
3. Save Project URL and anon key (Settings → API)

### 3. Deploy to Vercel
[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=...)
Set environment variables from .env.local.example

### 4. Provision app in ACC
1. Log into ACC as Account Admin
2. Account Admin → Apps & Integrations → Add Custom Integration
3. Enter your APS Client ID
4. Grant access to your hub

### 5. Run your first scan
1. Open your deployed app
2. Log in with your Autodesk account (must be Account Admin)
3. Select your hub
4. Click "Run scan"

## Environment variables
See .env.local.example for all required variables.

## Privacy & security
- Your Autodesk credentials are never stored in the database
- OAuth tokens are kept only in secure, httpOnly browser cookies (session only)
- All project data is stored in your own Supabase instance
- No data is shared with any third party
```

---

## Build order recommendation

1. Auth flow (login → callback → cookie → /api/auth/me → hub picker)
2. Supabase schema + migrations
3. Phase 0 + 1 (project enumeration + enrichment) — gets the list working
4. Scan progress UI with Realtime subscription
5. Phase 2 (folder traversal + .rvt discovery)
6. Phase 3 version detection — T0 (inline in Phase 2 for C4R files) → T1 (Model Derivative) → T2 (Design Automation BasicFileInfo). Covers 95%+ of files. Do NOT rely on binary header regex for primary detection.
7. Dashboard KPIs + project table (data already in DB)
8. Charts (trend + distribution)
9. PDF report
10. Upgrade tracker (Module 3)
11. Phase 3 T3 (Design Automation — edge case, implement last)
12. README + GitHub setup

---

*Generated: April 2026 | Autodesk Platform Services versions current as of Revit 2027 release*
