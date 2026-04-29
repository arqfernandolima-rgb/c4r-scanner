'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';

interface ProjectTask {
  id: string;
  name: string;
  project_type: string;
  acc_project_id: string;
  member_count: number;
  at_risk_file_count: number;
  min_revit_version: string | null;
  has_composite_files: boolean;
  priority_score: number;
  upgrade_tasks: UpgradeTask[];
}

interface UpgradeTask {
  id: string;
  status: string;
  assigned_to: string | null;
  target_version: string | null;
  notes: string | null;
  acc_upgrade_url: string | null;
  completed_at: string | null;
}

const STATUS_LABELS: Record<string, string> = {
  not_needed: 'Not needed',
  pending: 'Pending',
  in_progress: 'In progress',
  completed: 'Completed',
  skipped: 'Skipped',
  blocked: 'Blocked',
};

const STATUS_COLORS: Record<string, string> = {
  pending: 'bg-muted text-muted-foreground border',
  in_progress: 'bg-blue-100 text-blue-700',
  completed: 'bg-green-100 text-green-700',
  skipped: 'bg-muted text-muted-foreground',
  blocked: 'bg-destructive/10 text-destructive',
  not_needed: 'bg-muted text-muted-foreground',
};

const REVIT_VERSIONS = ['2022', '2023', '2024', '2025', '2026', '2027'];

export default function UpgradePage() {
  const router = useRouter();
  const [tasks, setTasks] = useState<ProjectTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [assignModal, setAssignModal] = useState<{ project: ProjectTask } | null>(null);
  const [form, setForm] = useState({ assignedTo: '', targetVersion: '2025', notes: '' });
  const [saving, setSaving] = useState(false);

  const loadTasks = () => {
    const hubRaw = localStorage.getItem('selected_hub');
    if (!hubRaw) { router.replace('/'); return; }
    const hub = JSON.parse(hubRaw);

    fetch(`/api/upgrade?hubId=${hub.id}`)
      .then(r => r.json())
      .then(data => setTasks(data.tasks ?? []))
      .finally(() => setLoading(false));
  };

  useEffect(loadTasks, []);

  const currentTask = (p: ProjectTask) => p.upgrade_tasks?.[0];

  const handleAssign = async () => {
    if (!assignModal) return;
    setSaving(true);
    await fetch('/api/upgrade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: assignModal.project.id,
        status: 'in_progress',
        assignedTo: form.assignedTo,
        targetVersion: form.targetVersion,
        notes: form.notes,
      }),
    });
    setSaving(false);
    setAssignModal(null);
    loadTasks();
  };

  const handleMarkDone = async (projectId: string) => {
    await fetch('/api/upgrade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, status: 'completed' }),
    });
    loadTasks();
  };

  const completed = tasks.filter(p => currentTask(p)?.status === 'completed').length;

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center"><p className="text-sm text-muted-foreground">Loading…</p></div>;
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-6xl mx-auto px-6 py-6 space-y-6">

        {/* Header */}
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => router.push('/dashboard')}>← Dashboard</Button>
          <div>
            <h1 className="text-xl font-semibold">Upgrade tracker</h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              {completed} of {tasks.length} projects upgraded
            </p>
          </div>
        </div>

        {/* Summary bar */}
        <div className="rounded-lg border bg-card px-4 py-3">
          <div className="flex items-center gap-6 text-sm">
            <span><strong>{tasks.length}</strong> projects at risk</span>
            <span className="text-green-700"><strong>{completed}</strong> completed</span>
            <span className="text-blue-700">
              <strong>{tasks.filter(p => currentTask(p)?.status === 'in_progress').length}</strong> in progress
            </span>
            <span className="text-muted-foreground">
              <strong>{tasks.filter(p => !currentTask(p) || currentTask(p)?.status === 'pending').length}</strong> pending
            </span>
            {tasks.length > 0 && (
              <span className="ml-auto text-muted-foreground text-xs">
                {Math.round(completed / tasks.length * 100)}% complete
              </span>
            )}
          </div>
          {tasks.length > 0 && (
            <div className="mt-2 h-1.5 w-full rounded-full bg-border overflow-hidden">
              <div
                className="h-full bg-green-500 rounded-full transition-all"
                style={{ width: `${Math.round(completed / tasks.length * 100)}%` }}
              />
            </div>
          )}
        </div>

        {/* Table */}
        <div className="rounded-lg border overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/30 hover:bg-muted/30">
                <TableHead className="w-[30%]">Project</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Assigned to</TableHead>
                <TableHead>Target version</TableHead>
                <TableHead>.rvt at risk</TableHead>
                <TableHead>Min version</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tasks.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-sm text-muted-foreground py-12">
                    No at-risk projects found. Run a scan first.
                  </TableCell>
                </TableRow>
              )}
              {tasks.map(p => {
                const task = currentTask(p);
                const status = task?.status ?? 'pending';
                const accId = p.acc_project_id.replace(/^b\./, '');
                const upgradeUrl = task?.acc_upgrade_url
                  ?? `https://acc.autodesk.com/docs/files/projects/${accId}?upgrade=true`;

                return (
                  <TableRow key={p.id}>
                    <TableCell className="font-medium text-sm">
                      <div className="flex items-center gap-2">
                        {p.name}
                        {p.has_composite_files && (
                          <span title="Has linked models" className="text-amber-500 text-xs">⚠</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <span className="text-xs text-muted-foreground">{p.project_type}</span>
                    </TableCell>
                    <TableCell>
                      <span className={`inline-block text-[10px] font-medium px-2 py-0.5 rounded-full ${STATUS_COLORS[status] ?? ''}`}>
                        {STATUS_LABELS[status] ?? status}
                      </span>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {task?.assigned_to ?? '—'}
                    </TableCell>
                    <TableCell className="font-mono text-sm">
                      {task?.target_version ?? '—'}
                    </TableCell>
                    <TableCell className="text-sm text-destructive font-medium">
                      {p.at_risk_file_count}
                    </TableCell>
                    <TableCell>
                      {p.min_revit_version ? (
                        <span className="font-mono text-xs bg-destructive/10 text-destructive px-1.5 py-0.5 rounded">
                          {p.min_revit_version}
                        </span>
                      ) : '—'}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        <Button
                          size="sm" variant="outline" className="h-6 text-xs"
                          asChild
                        >
                          <a href={upgradeUrl} target="_blank" rel="noopener noreferrer">
                            Open in ACC →
                          </a>
                        </Button>
                        {status !== 'completed' && (
                          <>
                            <Button
                              size="sm" variant="outline" className="h-6 text-xs"
                              onClick={() => {
                                setForm({
                                  assignedTo: task?.assigned_to ?? '',
                                  targetVersion: task?.target_version ?? '2025',
                                  notes: task?.notes ?? '',
                                } as { assignedTo: string; targetVersion: string; notes: string });
                                setAssignModal({ project: p });
                              }}
                            >
                              Assign
                            </Button>
                            <Button
                              size="sm" variant="ghost" className="h-6 text-xs text-green-700"
                              onClick={() => handleMarkDone(p.id)}
                            >
                              Mark done
                            </Button>
                          </>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* Assign modal */}
      <Dialog open={!!assignModal} onOpenChange={() => setAssignModal(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Assign upgrade — {assignModal?.project.name}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {assignModal?.project.has_composite_files && (
              <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                ⚠ This project has linked models. Upgrade host and linked files together.
              </div>
            )}
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Assigned to</label>
              <input
                className="w-full border rounded-md px-3 py-2 text-sm"
                value={form.assignedTo}
                onChange={e => setForm(f => ({ ...f, assignedTo: e.target.value }))}
                placeholder="Name or email"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Target version</label>
              <Select value={form.targetVersion} onValueChange={v => setForm(f => ({ ...f, targetVersion: v ?? '2025' }))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {REVIT_VERSIONS.map(v => (
                    <SelectItem key={v} value={v}>Revit {v}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Notes</label>
              <textarea
                className="w-full border rounded-md px-3 py-2 text-sm resize-none"
                rows={3}
                value={form.notes}
                onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                placeholder="Optional notes…"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAssignModal(null)}>Cancel</Button>
            <Button onClick={handleAssign} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
