# Revit C4R Scanner

Identify Revit files on deprecated Collaboration for Revit (C4R) versions across your ACC/BIM 360 hub, prioritize which projects need upgrading, and track remediation progress.

**Context:** Autodesk dropped cloud model access for Revit 2021 and older on May 7, 2026 (30 days after the Revit 2027 release). Each subsequent annual Revit release drops the oldest supported version. This tool handles that rolling deprecation cycle via the `NEXT_PUBLIC_DEPRECATED_BELOW_VERSION` env var.

---

## Prerequisites

- Autodesk Platform Services account — free at [aps.autodesk.com](https://aps.autodesk.com)
- Supabase account — free tier works for most hubs
- Vercel account — free tier works, Pro recommended for hubs with >500 projects (300s function timeout)
- ACC Account Admin access on your hub

---

## Setup (~15 minutes)

### 1. Create APS application

1. Go to [aps.autodesk.com/myapps](https://aps.autodesk.com/myapps) → **Create App**
2. Select APIs: **Data Management**, **Model Derivative**, **Construction Cloud Admin**
3. Set **Callback URL**: `https://your-domain.vercel.app/api/auth/callback`
4. Save **Client ID** and **Client Secret**

### 2. Create Supabase project

1. New project at [supabase.com](https://supabase.com)
2. **SQL Editor** → paste `supabase/migrations/001_initial.sql` → Run
3. Save **Project URL** and **anon key** (Settings → API)
4. Save **service_role key** (Settings → API → keep this secret)
5. Enable **Realtime** on `scan_jobs` table (Database → Replication)

### 3. Deploy to Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/your-org/revit-c4r-scanner)

Set these environment variables in Vercel:

| Variable | Value |
|---|---|
| `APS_CLIENT_ID` | From step 1 |
| `APS_CLIENT_SECRET` | From step 1 |
| `APS_CALLBACK_URL` | `https://your-domain.vercel.app/api/auth/callback` |
| `NEXT_PUBLIC_SUPABASE_URL` | From step 2 |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | From step 2 |
| `SUPABASE_SERVICE_ROLE_KEY` | From step 2 |
| `NEXT_PUBLIC_DEPRECATED_BELOW_VERSION` | `2022` (update each year) |
| `NEXT_PUBLIC_DEADLINE_DATE` | `2026-05-07` |

### 4. Provision app in ACC

1. Log into ACC as **Account Admin**
2. **Account Admin → Apps & Integrations → Add Custom Integration**
3. Enter your APS **Client ID**
4. Grant access to your hub

### 5. Run your first scan

1. Open your deployed app
2. Sign in with your Autodesk account (must be Account Admin)
3. Select your hub
4. Click **Run scan**

---

## Scheduled weekly scans (optional)

1. Enable `pg_cron` and `pg_net` extensions in Supabase Dashboard → Database → Extensions
2. Deploy the Edge Function: `supabase functions deploy scheduled-scan`
3. Set Edge Function env vars: `APP_URL`, `APP_SERVICE_KEY`
4. Run `supabase/migrations/002_pg_cron.sql` (uncomment and fill in your project ref)

---

## Rolling deprecation — annual update

Each year when Autodesk releases a new Revit version:

1. Update `NEXT_PUBLIC_DEPRECATED_BELOW_VERSION` in Vercel to the new threshold (e.g., `2023`)
2. Update `NEXT_PUBLIC_DEADLINE_DATE` to the new cutoff date
3. Run a new scan — `needs_upgrade` is recomputed from current settings on every scan

---

## Tech stack

| | |
|---|---|
| Framework | Next.js 14 App Router |
| Styling | Tailwind CSS v3 + shadcn/ui |
| Database | Supabase (Postgres 15, Auth, Realtime) |
| APS SDK | @aps_sdk/authentication, data-management, construction-account-admin |
| Charts | Recharts |
| PDF | @react-pdf/renderer |
| State | Zustand |
| Rate limiting | p-limit + p-retry |
| Deployment | Vercel |

---

## Privacy & security

- Your Autodesk credentials are **never stored** in the database
- OAuth tokens are kept only in **secure, httpOnly browser cookies** (session only, ~1 hour)
- All project data is stored in **your own Supabase instance**
- No data is shared with any third party
- `SUPABASE_SERVICE_ROLE_KEY` is **never** exposed to client-side code

---

## Version detection methods

| Method | Coverage | Cost |
|---|---|---|
| `dm_extension` | C4R cloud models (most files) | Free — inline with folder traversal |
| `manifest` | Files translated after Nov 2021 | ~200ms per file, no download |
| `binary_header` | Pre-2024 local/uploaded files | 4KB range download |
| `unknown` | Files that exhaust all methods | Treated conservatively as at-risk |

> **Note:** Binary header parsing is unreliable for Revit 2024+ due to internal file format changes. Files detected as `unknown` are flagged for manual review in the dashboard.
