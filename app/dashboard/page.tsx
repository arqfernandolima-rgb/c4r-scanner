'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { Button } from '@/components/ui/button';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Cell,
} from 'recharts';

interface Project {
  id: string;
  name: string;
  project_type: string;
  at_risk_file_count: number;
  rvt_file_count: number;
  member_count: number;
  min_revit_version: string | null;
  priority_score: number;
  last_file_activity: string | null;
  upgrade_status: string;
  scan_status: string;
  scan_error: string | null;
  has_composite_files: boolean;
}

interface ScanJob {
  id: string;
  status: string;
  phase: string;
  current_action: string | null;
  overall_pct: number;
  completed_at: string | null;
  total_projects: number;
  scanned_projects: number;
  total_rvt_files: number;
  at_risk_count: number;
  versions_detected: number;
  rate_limit_hits: number;
  eta_seconds: number | null;
}

interface TrendPoint { label: string; atRisk: number; cleared: number; }

const DEPRECATED_BELOW = parseInt(process.env.NEXT_PUBLIC_DEPRECATED_BELOW_VERSION ?? '2022');
const DEADLINE = process.env.NEXT_PUBLIC_DEADLINE_DATE ?? '2026-05-07';
const SCAN_PHASES = ['bootstrap', 'projects', 'files', 'versions', 'done'];
const PHASE_LABELS: Record<string, string> = {
  bootstrap: 'Bootstrap', projects: 'Projects', files: 'Files', versions: 'Versions', done: 'Done',
};

function daysUntil(dateStr: string) {
  return Math.max(0, Math.ceil((new Date(dateStr).getTime() - Date.now()) / 86400000));
}

function riskLevel(p: Project): 'High' | 'Medium' | 'Low' {
  if (p.priority_score >= 70) return 'High';
  if (p.priority_score >= 40) return 'Medium';
  return 'Low';
}

function relativeTime(dateStr: string | null): string {
  if (!dateStr) return '—';
  const days = Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
  if (days === 0) return 'today';
  if (days === 1) return '1d ago';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

export default function DashboardPage() {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [job, setJob] = useState<ScanJob | null>(null);
  const [trendData, setTrendData] = useState<TrendPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterRisk, setFilterRisk] = useState('all');
  const [filterType, setFilterType] = useState('all');
  const [staleWarning, setStaleWarning] = useState(false);
  const [scanDetailOpen, setScanDetailOpen] = useState(false);

  useEffect(() => {
    const hubRaw = localStorage.getItem('selected_hub');
    if (!hubRaw) { router.replace('/'); return; }
    const hub = JSON.parse(hubRaw);

    fetch(`/api/projects?hubId=${hub.id}`)
      .then(r => r.json())
      .then(data => {
        setProjects(data.projects ?? []);
        if (data.jobId) {
          return fetch(`/api/scan/${data.jobId}`).then(r => r.json());
        }
        return null;
      })
      .then(jobData => {
        if (jobData) {
          setJob(jobData);
          if (jobData.completed_at) {
            const daysSince = (Date.now() - new Date(jobData.completed_at).getTime()) / 86400000;
            if (daysSince > 7) setStaleWarning(true);
          }
        }
      })
      .finally(() => setLoading(false));

    fetch(`/api/scan/history?hubId=${hub.id}`)
      .then(r => r.ok ? r.json() : { jobs: [] })
      .then(data => setTrendData(data.trendData ?? []));
  }, []);

  // Realtime: update job progress and project list while a scan is running
  useEffect(() => {
    if (!job?.id || job.status === 'completed' || job.status === 'failed') return;

    const jobChannel = supabase
      .channel('dashboard-job')
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'scan_jobs', filter: `id=eq.${job.id}` },
        (payload) => {
          setJob(prev => prev ? { ...prev, ...(payload.new as Partial<ScanJob>) } : prev);
        }
      )
      .subscribe();

    const projectsChannel = supabase
      .channel('dashboard-projects')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'projects', filter: `scan_job_id=eq.${job.id}` },
        (payload) => {
          setProjects(prev => [...prev, payload.new as Project]);
        }
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'projects', filter: `scan_job_id=eq.${job.id}` },
        (payload) => {
          setProjects(prev =>
            prev.map(p => p.id === (payload.new as Project).id ? { ...p, ...(payload.new as Project) } : p)
          );
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(jobChannel);
      supabase.removeChannel(projectsChannel);
    };
  }, [job?.id, job?.status]);

  const isScanning = !!job && job.status !== 'completed' && job.status !== 'failed' && !job.completed_at;

  const atRiskProjects = projects.filter(p => p.at_risk_file_count > 0);
  const totalFiles = job?.total_rvt_files ?? projects.reduce((s, p) => s + p.rvt_file_count, 0);
  const atRiskFiles = job?.at_risk_count ?? projects.reduce((s, p) => s + p.at_risk_file_count, 0);
  const membersImpacted = atRiskProjects.reduce((s, p) => s + p.member_count, 0);
  const daysLeft = daysUntil(DEADLINE);

  const versionCounts: Record<string, number> = {};
  projects.forEach(p => {
    if (p.min_revit_version) {
      versionCounts[p.min_revit_version] = (versionCounts[p.min_revit_version] ?? 0) + p.at_risk_file_count;
    }
  });
  const versionData = Object.entries(versionCounts)
    .sort(([a], [b]) => parseInt(a) - parseInt(b))
    .map(([version, count]) => ({ version, count }));

  const filtered = projects
    .filter(p => {
      if (filterRisk !== 'all' && riskLevel(p).toLowerCase() !== filterRisk) return false;
      if (filterType !== 'all' && p.project_type?.toLowerCase() !== filterType) return false;
      return true;
    })
    .sort((a, b) => b.priority_score - a.priority_score);

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center"><p className="text-sm text-muted-foreground">Loading dashboard…</p></div>;
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-7xl mx-auto px-6 py-6 space-y-6">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold">Revit C4R Scanner</h1>
            {job?.completed_at && (
              <p className="text-xs text-muted-foreground mt-0.5">
                Last scan: {new Date(job.completed_at).toLocaleDateString()}
              </p>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" asChild>
              <a href={`/api/pdf?jobId=${job?.id}`} download>Export PDF</a>
            </Button>
            <Button size="sm" onClick={() => router.push('/scan')}>Run scan</Button>
            <Button variant="ghost" size="sm" asChild>
              <a href="/api/auth/logout">Sign out</a>
            </Button>
          </div>
        </div>

        {/* Active scan banner */}
        {isScanning && (
          <button
            onClick={() => setScanDetailOpen(true)}
            className="w-full text-left rounded-lg border border-primary/20 bg-primary/5 px-4 py-3 hover:bg-primary/10 transition-colors"
          >
            <div className="flex items-center gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-primary" />
                  </span>
                  <span className="text-xs font-medium text-primary uppercase tracking-wide">
                    Scan running
                  </span>
                  <span className="text-xs text-muted-foreground">·</span>
                  <span className="text-xs text-muted-foreground capitalize">{job?.phase} phase</span>
                  {job?.eta_seconds != null && (
                    <>
                      <span className="text-xs text-muted-foreground">·</span>
                      <span className="text-xs text-muted-foreground">
                        ~{Math.ceil(job.eta_seconds / 60)} min remaining
                      </span>
                    </>
                  )}
                </div>
                <div className="h-1.5 w-full rounded-full bg-primary/20 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-primary transition-all duration-700"
                    style={{ width: `${job?.overall_pct ?? 0}%` }}
                  />
                </div>
                <p className="text-xs text-muted-foreground mt-1.5 truncate">
                  {job?.current_action ?? 'Initializing…'}
                </p>
              </div>
              <div className="shrink-0 flex items-center gap-3">
                <div className="text-right hidden sm:block">
                  <div className="text-lg font-semibold tabular-nums">{job?.overall_pct ?? 0}%</div>
                  <div className="text-xs text-muted-foreground">
                    {job?.scanned_projects ?? 0}/{job?.total_projects ?? 0} projects
                  </div>
                </div>
                <span className="text-xs text-primary font-medium">Details →</span>
              </div>
            </div>
          </button>
        )}

        {/* Stale scan warning */}
        {staleWarning && (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            Your last scan was over 7 days ago. Run a new scan to get up-to-date results.
          </div>
        )}

        {/* KPI row */}
        <div className="grid grid-cols-4 gap-3">
          <KpiCard
            label="Projects at risk"
            value={atRiskProjects.length}
            sub={`of ${projects.length} total · ${projects.length > 0 ? Math.round(atRiskProjects.length / projects.length * 100) : 0}%`}
            variant={atRiskProjects.length > 0 ? 'danger' : 'default'}
          />
          <KpiCard
            label="Files needing upgrade"
            value={atRiskFiles}
            sub={`of ${totalFiles.toLocaleString()} .rvt · ${totalFiles > 0 ? (atRiskFiles / totalFiles * 100).toFixed(1) : 0}%`}
            variant={atRiskFiles > 0 ? 'warning' : 'default'}
          />
          <KpiCard
            label="Members impacted"
            value={membersImpacted}
            sub="across at-risk projects"
            variant="info"
          />
          <KpiCard
            label="Days to deadline"
            value={daysLeft}
            sub={`${DEADLINE} cutoff`}
            variant={daysLeft < 14 ? 'danger' : daysLeft < 30 ? 'warning' : 'default'}
          />
        </div>

        {/* Charts row */}
        <div className="grid grid-cols-3 gap-4">
          <div className="col-span-2 rounded-lg border bg-card p-4">
            <div className="text-sm font-medium">Files at risk over time</div>
            <div className="text-xs text-muted-foreground mb-3">Weekly scan snapshots</div>
            {trendData.length > 1 ? (
              <ResponsiveContainer width="100%" height={160}>
                <LineChart data={trendData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="label" tick={{ fontSize: 10 }} stroke="hsl(var(--border))" />
                  <YAxis tick={{ fontSize: 10 }} stroke="hsl(var(--border))" />
                  <Tooltip contentStyle={{ fontSize: 12 }} />
                  <Line type="monotone" dataKey="atRisk" stroke="#E24B4A" strokeWidth={2} name="At risk" dot={{ r: 3 }} />
                  <Line type="monotone" dataKey="cleared" stroke="#639922" strokeWidth={2} strokeDasharray="4 3" name="Cleared" dot={{ r: 3 }} />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-40 flex items-center justify-center text-sm text-muted-foreground">
                Run multiple scans to see trend data.
              </div>
            )}
          </div>

          <div className="rounded-lg border bg-card p-4">
            <div className="text-sm font-medium">Version distribution</div>
            <div className="text-xs text-muted-foreground mb-3">.rvt files by min version (at-risk projects)</div>
            {versionData.length > 0 ? (
              <ResponsiveContainer width="100%" height={160}>
                <BarChart data={versionData} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 10 }} stroke="hsl(var(--border))" />
                  <YAxis dataKey="version" type="category" tick={{ fontSize: 11, fontFamily: 'monospace' }} stroke="hsl(var(--border))" width={36} />
                  <Tooltip contentStyle={{ fontSize: 12 }} />
                  <Bar dataKey="count" radius={[0, 3, 3, 0]}>
                    {versionData.map((entry) => (
                      <Cell
                        key={entry.version}
                        fill={parseInt(entry.version) < DEPRECATED_BELOW ? '#E24B4A' : '#378ADD'}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-40 flex items-center justify-center text-sm text-muted-foreground">
                No data yet.
              </div>
            )}
          </div>
        </div>

        {/* Filters + table */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs uppercase tracking-wide text-muted-foreground font-medium">
              Priority project list — sorted by risk score
              {isScanning && (
                <span className="ml-2 normal-case font-normal text-primary">
                  · updating live
                </span>
              )}
            </p>
            <div className="flex gap-2">
              <Select value={filterRisk} onValueChange={v => setFilterRisk(v ?? 'all')}>
                <SelectTrigger className="h-7 text-xs w-28">
                  <SelectValue placeholder="Risk" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All risk</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="low">Low</SelectItem>
                </SelectContent>
              </Select>
              <Select value={filterType} onValueChange={v => setFilterType(v ?? 'all')}>
                <SelectTrigger className="h-7 text-xs w-28">
                  <SelectValue placeholder="Type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All types</SelectItem>
                  <SelectItem value="acc">ACC</SelectItem>
                  <SelectItem value="bim360">BIM 360</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="rounded-lg border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/30 hover:bg-muted/30">
                  <TableHead className="w-[28%]">Project</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Risk</TableHead>
                  <TableHead>Priority</TableHead>
                  <TableHead>Members</TableHead>
                  <TableHead>.rvt at risk</TableHead>
                  <TableHead>Min version</TableHead>
                  <TableHead>Last active</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={9} className="text-center text-sm text-muted-foreground py-12">
                      {projects.length === 0
                        ? isScanning
                          ? 'Scan in progress — projects will appear here as they are discovered.'
                          : 'No scan data. Run a scan to see results.'
                        : 'No projects match filters.'}
                    </TableCell>
                  </TableRow>
                )}
                {filtered.map(p => {
                  const risk = riskLevel(p);
                  const isPending = p.scan_status === 'pending';
                  return (
                    <TableRow
                      key={p.id}
                      className={`cursor-pointer ${isPending ? 'opacity-50' : ''}`}
                      onClick={() => !isPending && router.push(`/dashboard/${p.id}`)}
                    >
                      <TableCell className="font-medium text-sm">
                        <div className="flex items-center gap-2">
                          {isPending && (
                            <span className="inline-block w-1.5 h-1.5 rounded-full bg-muted-foreground/40 shrink-0" />
                          )}
                          {p.name}
                          {p.has_composite_files && (
                            <span title="Contains linked models" className="text-amber-500 text-xs">⚠</span>
                          )}
                        </div>
                        {p.scan_status === 'error' && (
                          <div className="text-xs text-destructive">{p.scan_error}</div>
                        )}
                      </TableCell>
                      <TableCell>
                        <span className="text-xs text-muted-foreground">{p.project_type}</span>
                      </TableCell>
                      <TableCell>
                        {isPending
                          ? <span className="text-xs text-muted-foreground">—</span>
                          : <RiskBadge risk={risk} />}
                      </TableCell>
                      <TableCell>
                        <div className="text-sm font-medium">{isPending ? '—' : p.priority_score}</div>
                        {!isPending && (
                          <div className="mt-1 h-1 w-16 rounded-full bg-border overflow-hidden">
                            <div
                              className={`h-full rounded-full ${risk === 'High' ? 'bg-destructive' : risk === 'Medium' ? 'bg-amber-500' : 'bg-border'}`}
                              style={{ width: `${p.priority_score}%` }}
                            />
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-sm">{p.member_count || '—'}</TableCell>
                      <TableCell className={`text-sm font-medium ${p.at_risk_file_count > 0 ? 'text-destructive' : 'text-muted-foreground'}`}>
                        {isPending ? '—' : p.at_risk_file_count}
                      </TableCell>
                      <TableCell>
                        {p.min_revit_version ? (
                          <span className={`inline-block font-mono text-xs px-1.5 py-0.5 rounded ${
                            parseInt(p.min_revit_version) < DEPRECATED_BELOW
                              ? 'bg-destructive/10 text-destructive'
                              : 'bg-green-100 text-green-700'
                          }`}>
                            {p.min_revit_version}
                          </span>
                        ) : <span className="text-muted-foreground text-xs">—</span>}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {relativeTime(p.last_file_activity)}
                      </TableCell>
                      <TableCell>
                        {!isPending && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-6 text-xs"
                            onClick={(e) => { e.stopPropagation(); router.push('/upgrade'); }}
                          >
                            Assign →
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </div>
      </div>

      {/* Scan detail dialog */}
      <Dialog open={scanDetailOpen} onOpenChange={setScanDetailOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Scan progress</DialogTitle>
          </DialogHeader>

          {job && <ScanDetail job={job} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ScanDetail({ job }: { job: ScanJob }) {
  const currentPhaseIndex = SCAN_PHASES.indexOf(job.phase ?? 'bootstrap');
  const circumference = 2 * Math.PI * 44;

  return (
    <div className="space-y-5">
      {/* Progress circle + current action */}
      <div className="flex items-center gap-4">
        <div className="relative w-20 h-20 shrink-0">
          <svg className="w-20 h-20 -rotate-90" viewBox="0 0 100 100">
            <circle cx="50" cy="50" r="44" fill="none" stroke="hsl(var(--border))" strokeWidth="6" />
            <circle
              cx="50" cy="50" r="44" fill="none"
              stroke="hsl(var(--primary))" strokeWidth="6"
              strokeDasharray={circumference}
              strokeDashoffset={circumference * (1 - (job.overall_pct ?? 0) / 100)}
              strokeLinecap="round"
              className="transition-all duration-500"
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-xl font-semibold">{job.overall_pct ?? 0}%</span>
          </div>
        </div>
        <div className="min-w-0">
          <p className="text-sm font-medium capitalize">{job.phase} phase</p>
          <p className="text-xs text-muted-foreground mt-1 leading-snug">
            {job.current_action ?? 'Initializing…'}
          </p>
          {job.eta_seconds != null && (
            <p className="text-xs text-primary mt-1.5 font-medium">
              ~{Math.ceil(job.eta_seconds / 60)} min remaining
            </p>
          )}
        </div>
      </div>

      {/* Phase stepper */}
      <div className="flex items-center gap-0.5">
        {SCAN_PHASES.filter(p => p !== 'done').map((phase, i) => (
          <div key={phase} className="flex items-center flex-1">
            <div className={`h-1 flex-1 rounded-full transition-colors ${
              i < currentPhaseIndex ? 'bg-primary'
              : i === currentPhaseIndex ? 'bg-primary/50'
              : 'bg-border'
            }`} />
            <span className={`text-[10px] px-0.5 whitespace-nowrap ${
              i === currentPhaseIndex ? 'text-primary font-medium' : 'text-muted-foreground'
            }`}>
              {PHASE_LABELS[phase]}
            </span>
          </div>
        ))}
      </div>

      {/* Counters */}
      <div className="grid grid-cols-2 gap-2">
        {[
          { label: 'Projects scanned', value: `${job.scanned_projects ?? 0} / ${job.total_projects ?? 0}` },
          { label: '.rvt files found', value: (job.total_rvt_files ?? 0).toLocaleString() },
          { label: 'Versions detected', value: (job.versions_detected ?? 0).toLocaleString() },
          { label: 'Rate limit hits', value: job.rate_limit_hits ?? 0 },
        ].map(({ label, value }) => (
          <div key={label} className="rounded-md border px-3 py-2">
            <div className="text-[10px] text-muted-foreground">{label}</div>
            <div className="text-base font-semibold tabular-nums mt-0.5">{value}</div>
          </div>
        ))}
      </div>

      {job.status === 'failed' && (
        <p className="text-xs text-destructive rounded border border-destructive/20 bg-destructive/5 px-3 py-2">
          Scan failed. Try running a new scan.
        </p>
      )}
    </div>
  );
}

function KpiCard({ label, value, sub, variant }: {
  label: string;
  value: number;
  sub: string;
  variant: 'default' | 'danger' | 'warning' | 'info';
}) {
  const valueClass = variant === 'danger' ? 'text-destructive'
    : variant === 'warning' ? 'text-amber-600'
    : variant === 'info' ? 'text-blue-600'
    : 'text-foreground';

  return (
    <div className="rounded-lg border bg-card px-4 py-3">
      <div className="text-xs text-muted-foreground font-medium uppercase tracking-wide">{label}</div>
      <div className={`text-3xl font-medium mt-1 ${valueClass}`}>{value.toLocaleString()}</div>
      <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>
    </div>
  );
}

function RiskBadge({ risk }: { risk: 'High' | 'Medium' | 'Low' }) {
  return (
    <span className={`inline-block text-[10px] font-medium px-2 py-0.5 rounded-full ${
      risk === 'High' ? 'bg-destructive/10 text-destructive'
      : risk === 'Medium' ? 'bg-amber-100 text-amber-700'
      : 'bg-muted text-muted-foreground border'
    }`}>
      {risk}
    </span>
  );
}
