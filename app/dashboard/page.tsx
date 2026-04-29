'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
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
  completed_at: string | null;
  total_projects: number;
  total_rvt_files: number;
  at_risk_count: number;
  versions_detected: number;
}

interface TrendPoint { label: string; atRisk: number; cleared: number; }

const DEPRECATED_BELOW = parseInt(process.env.NEXT_PUBLIC_DEPRECATED_BELOW_VERSION ?? '2022');
const DEADLINE = process.env.NEXT_PUBLIC_DEADLINE_DATE ?? '2026-05-07';

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
          // Stale scan warning
          if (jobData.completed_at) {
            const daysSince = (Date.now() - new Date(jobData.completed_at).getTime()) / 86400000;
            if (daysSince > 7) setStaleWarning(true);
          }
        }
      })
      .finally(() => setLoading(false));

    // Load historical trend from multiple completed scan jobs
    loadTrendData(hub.id);
  }, []);

  const loadTrendData = (hubId: string) => {
    // Fetch last 8 completed scan jobs to build trend
    fetch(`/api/scan/history?hubId=${hubId}`)
      .then(r => r.ok ? r.json() : { jobs: [] })
      .then(data => setTrendData(data.trendData ?? []));
  };

  const atRiskProjects = projects.filter(p => p.at_risk_file_count > 0);
  const totalFiles = job?.total_rvt_files ?? projects.reduce((s, p) => s + p.rvt_file_count, 0);
  const atRiskFiles = job?.at_risk_count ?? projects.reduce((s, p) => s + p.at_risk_file_count, 0);
  const membersImpacted = atRiskProjects.reduce((s, p) => s + p.member_count, 0);
  const daysLeft = daysUntil(DEADLINE);

  // Version distribution
  const versionCounts: Record<string, number> = {};
  projects.forEach(p => {
    if (p.min_revit_version) {
      versionCounts[p.min_revit_version] = (versionCounts[p.min_revit_version] ?? 0) + p.at_risk_file_count;
    }
  });
  const versionData = Object.entries(versionCounts)
    .sort(([a], [b]) => parseInt(a) - parseInt(b))
    .map(([version, count]) => ({ version, count }));

  // Filter
  const filtered = projects.filter(p => {
    if (filterRisk !== 'all' && riskLevel(p).toLowerCase() !== filterRisk) return false;
    if (filterType !== 'all' && p.project_type?.toLowerCase() !== filterType) return false;
    return true;
  });

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
                      {projects.length === 0 ? 'No scan data. Run a scan to see results.' : 'No projects match filters.'}
                    </TableCell>
                  </TableRow>
                )}
                {filtered.map(p => {
                  const risk = riskLevel(p);
                  return (
                    <TableRow
                      key={p.id}
                      className="cursor-pointer"
                      onClick={() => router.push(`/dashboard/${p.id}`)}
                    >
                      <TableCell className="font-medium text-sm">
                        <div className="flex items-center gap-2">
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
                        <RiskBadge risk={risk} />
                      </TableCell>
                      <TableCell>
                        <div className="text-sm font-medium">{p.priority_score}</div>
                        <div className="mt-1 h-1 w-16 rounded-full bg-border overflow-hidden">
                          <div
                            className={`h-full rounded-full ${risk === 'High' ? 'bg-destructive' : risk === 'Medium' ? 'bg-amber-500' : 'bg-border'}`}
                            style={{ width: `${p.priority_score}%` }}
                          />
                        </div>
                      </TableCell>
                      <TableCell className="text-sm">{p.member_count}</TableCell>
                      <TableCell className={`text-sm font-medium ${p.at_risk_file_count > 0 ? 'text-destructive' : 'text-muted-foreground'}`}>
                        {p.at_risk_file_count}
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
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 text-xs"
                          onClick={(e) => { e.stopPropagation(); router.push('/upgrade'); }}
                        >
                          Assign →
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </div>
      </div>
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
