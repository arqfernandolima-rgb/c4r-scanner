'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';

interface RevitFile {
  id: string;
  file_name: string;
  folder_path: string | null;
  revit_version: string | null;
  detection_method: string | null;
  is_workshared: boolean | null;
  is_central: boolean | null;
  is_cloud_model: boolean | null;
  is_composite: boolean;
  composite_parent_file: string | null;
  has_linked_files: boolean;
  linked_file_count: number;
  needs_upgrade: boolean | null;
  last_modified_at: string | null;
  file_size_bytes: number | null;
}

interface Project {
  id: string;
  name: string;
  project_type: string;
  acc_project_id: string;
  member_count: number;
  rvt_file_count: number;
  at_risk_file_count: number;
  min_revit_version: string | null;
  has_composite_files: boolean;
  composite_file_count: number;
  upgrade_status: string;
  last_file_activity: string | null;
}

const DEPRECATED_BELOW = parseInt(process.env.NEXT_PUBLIC_DEPRECATED_BELOW_VERSION ?? '2022');

function formatBytes(bytes: number | null): string {
  if (!bytes) return '—';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function ProjectDetailPage() {
  const router = useRouter();
  const params = useParams();
  const projectId = params.projectId as string;

  const [project, setProject] = useState<Project | null>(null);
  const [files, setFiles] = useState<RevitFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    fetch(`/api/projects/${projectId}`)
      .then(r => r.json())
      .then(data => {
        setProject(data.project);
        setFiles(data.files ?? []);
      })
      .finally(() => setLoading(false));
  }, [projectId]);

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center"><p className="text-sm text-muted-foreground">Loading…</p></div>;
  }
  if (!project) {
    return <div className="min-h-screen flex items-center justify-center"><p className="text-sm text-muted-foreground">Project not found.</p></div>;
  }

  const atRiskFiles = files.filter(f => f.needs_upgrade === true);
  const displayed = showAll ? files : atRiskFiles;

  const accProjectId = project.acc_project_id.replace(/^b\./, '');
  const upgradeUrl = `https://acc.autodesk.com/docs/files/projects/${accProjectId}?upgrade=true`;

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-6xl mx-auto px-6 py-6 space-y-6">

        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => router.back()}>← Back</Button>
          <div>
            <h1 className="text-xl font-semibold">{project.name}</h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              {project.project_type} · {project.member_count} members · {project.rvt_file_count} .rvt files
            </p>
          </div>
          <div className="ml-auto flex gap-2">
            <Button variant="outline" size="sm" asChild>
              <a href={upgradeUrl} target="_blank" rel="noopener noreferrer">
                Open in ACC →
              </a>
            </Button>
            <Button size="sm" onClick={() => router.push('/upgrade')}>
              Track upgrade
            </Button>
          </div>
        </div>

        {/* Composite warning */}
        {project.has_composite_files && (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            ⚠ This project contains linked model assemblies. Upgrading host files without upgrading linked files
            will break references. Review all linked files before proceeding.
            {project.composite_file_count > 0 && ` (${project.composite_file_count} linked file${project.composite_file_count > 1 ? 's' : ''} detected)`}
          </div>
        )}

        {/* Stats row */}
        <div className="grid grid-cols-4 gap-3">
          {[
            { label: 'Files at risk', value: project.at_risk_file_count, danger: project.at_risk_file_count > 0 },
            { label: 'Total .rvt', value: project.rvt_file_count, danger: false },
            { label: 'Min version', value: project.min_revit_version ?? '—', danger: project.min_revit_version ? parseInt(project.min_revit_version) < DEPRECATED_BELOW : false },
            { label: 'Members', value: project.member_count, danger: false },
          ].map(({ label, value, danger }) => (
            <div key={label} className="rounded-lg border bg-card px-4 py-3">
              <div className="text-xs text-muted-foreground font-medium uppercase tracking-wide">{label}</div>
              <div className={`text-2xl font-medium mt-1 ${danger ? 'text-destructive' : ''}`}>
                {typeof value === 'number' ? value.toLocaleString() : value}
              </div>
            </div>
          ))}
        </div>

        {/* File table */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-xs uppercase tracking-wide text-muted-foreground font-medium">
              {showAll ? `All .rvt files (${files.length})` : `At-risk files (${atRiskFiles.length})`}
            </p>
            <Button variant="ghost" size="sm" className="text-xs" onClick={() => setShowAll(v => !v)}>
              {showAll ? 'Show at-risk only' : 'Show all files'}
            </Button>
          </div>

          <div className="rounded-lg border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/30 hover:bg-muted/30">
                  <TableHead>File name</TableHead>
                  <TableHead>Folder</TableHead>
                  <TableHead>Version</TableHead>
                  <TableHead>Detection</TableHead>
                  <TableHead>Flags</TableHead>
                  <TableHead>Size</TableHead>
                  <TableHead>Modified</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {displayed.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center text-sm text-muted-foreground py-10">
                      No files to show.
                    </TableCell>
                  </TableRow>
                )}
                {displayed.map(f => (
                  <TableRow key={f.id}>
                    <TableCell className="font-medium text-sm font-mono">{f.file_name}</TableCell>
                    <TableCell className="text-xs text-muted-foreground max-w-[200px] truncate">{f.folder_path ?? '—'}</TableCell>
                    <TableCell>
                      {f.revit_version ? (
                        <span className={`inline-block font-mono text-xs px-1.5 py-0.5 rounded ${
                          f.needs_upgrade ? 'bg-destructive/10 text-destructive' : 'bg-green-100 text-green-700'
                        }`}>
                          {f.revit_version}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground italic">unknown</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <span className="text-xs text-muted-foreground font-mono">
                        {f.detection_method ?? '—'}
                      </span>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {f.is_cloud_model && <span className="text-[10px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded">Cloud</span>}
                        {f.is_workshared && <span className="text-[10px] bg-muted text-muted-foreground px-1.5 py-0.5 rounded border">WS</span>}
                        {f.is_composite && (
                          <span className="text-[10px] bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded" title={f.composite_parent_file ?? 'Linked model'}>
                            Linked
                          </span>
                        )}
                        {f.has_linked_files && (
                          <span className="text-[10px] bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded">
                            Host ({f.linked_file_count})
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{formatBytes(f.file_size_bytes)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {f.last_modified_at ? new Date(f.last_modified_at).toLocaleDateString() : '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      </div>
    </div>
  );
}
