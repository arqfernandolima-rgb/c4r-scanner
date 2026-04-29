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
  phase_0_cursor              text,
  phase_1_cursor              text,
  phase_2_cursors             jsonb,
  phase_3_cursor              text,
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
  triggered_by                text default 'manual',
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
  min_revit_version           text,
  priority_score              int default 0,
  last_file_activity          timestamptz,
  scan_status                 text default 'pending',
    -- pending | scanning | completed | error | skipped
  scan_error                  text,
  upgrade_status              text default 'not_needed',
    -- not_needed | pending | in_progress | completed | skipped
  has_composite_files         boolean default false,
  composite_file_count        int default 0,
  scanned_at                  timestamptz,
  created_at                  timestamptz default now()
);

create index idx_projects_scan_job on projects(scan_job_id);
create index idx_projects_at_risk on projects(scan_job_id, at_risk_file_count desc);

-- Revit files — one row per .rvt file found
create table revit_files (
  id                          uuid primary key default gen_random_uuid(),
  project_id                  uuid references projects(id) on delete cascade,
  item_id                     text not null,
  version_urn                 text,
  file_name                   text not null,
  folder_path                 text,
  revit_version               text,
  detection_method            text,
    -- dm_extension | manifest | binary_header | design_automation | unknown
  is_workshared               boolean,
  is_central                  boolean,
  is_cloud_model              boolean,
  is_composite                boolean default false,
  composite_parent_file       text,
  has_linked_files            boolean default false,
  linked_file_count           int default 0,
  needs_upgrade               boolean,
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
  target_version              text,
  assigned_to                 text,
  acc_upgrade_url             text,
  notes                       text,
  pre_upgrade_version         text,
  post_upgrade_version        text,
  verified_at                 timestamptz,
  completed_at                timestamptz,
  created_at                  timestamptz default now(),
  updated_at                  timestamptz default now()
);

-- DA upgrade jobs (Module 3 — automated upgrade via Design Automation)
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

-- Enable Realtime on scan_jobs so frontend gets live progress updates
alter publication supabase_realtime add table scan_jobs;

-- Basic RLS policies (single-tenant — allow all, documented as intentional)
alter table hub_settings enable row level security;
alter table scan_jobs enable row level security;
alter table projects enable row level security;
alter table revit_files enable row level security;
alter table upgrade_tasks enable row level security;
alter table da_upgrade_jobs enable row level security;

create policy "allow_all" on hub_settings for all using (true);
create policy "allow_all" on scan_jobs for all using (true);
create policy "allow_all" on projects for all using (true);
create policy "allow_all" on revit_files for all using (true);
create policy "allow_all" on upgrade_tasks for all using (true);
create policy "allow_all" on da_upgrade_jobs for all using (true);

-- pg_cron extension for scheduled scans (enable in Supabase dashboard first)
-- create extension if not exists pg_cron;
-- select cron.schedule('weekly-scan-reminder', '0 9 * * 1', $$
--   select net.http_post(
--     url := current_setting('app.edge_function_url') || '/scheduled-scan',
--     headers := jsonb_build_object('Authorization', 'Bearer ' || current_setting('app.service_role_key'))
--   )
-- $$);
