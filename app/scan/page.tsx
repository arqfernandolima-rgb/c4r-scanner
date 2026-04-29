'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { useScanStore } from '@/lib/store';
import { Button } from '@/components/ui/button';

const PHASES = ['bootstrap', 'projects', 'files', 'versions', 'done'];
const PHASE_LABELS: Record<string, string> = {
  bootstrap: 'Bootstrap',
  projects: 'Projects',
  files: 'Files',
  versions: 'Versions',
  done: 'Done',
};

export default function ScanPage() {
  const router = useRouter();
  const { job, setJob, updateJob } = useScanStore();
  const [errors, setErrors] = useState<string[]>([]);
  const [paused, setPaused] = useState(false);
  const chunkRunning = useRef(false);
  const jobIdRef = useRef<string | null>(null);

  // Kick off scan on mount
  useEffect(() => {
    const hubRaw = localStorage.getItem('selected_hub');
    if (!hubRaw) { router.replace('/'); return; }
    const hub = JSON.parse(hubRaw);

    fetch('/api/scan/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hubId: hub.id, accountId: hub.id.replace('b.', '') }),
    })
      .then(r => r.json())
      .then(data => {
        if (data.error) { setErrors([data.error]); return; }
        jobIdRef.current = data.jobId;
        return fetch(`/api/scan/${data.jobId}`).then(r => r.json());
      })
      .then(jobData => {
        if (jobData) setJob(jobData);
      });
  }, []);

  // Supabase Realtime subscription
  useEffect(() => {
    if (!jobIdRef.current) return;
    const channel = supabase
      .channel('scan-progress')
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'scan_jobs', filter: `id=eq.${jobIdRef.current}` },
        (payload) => {
          updateJob(payload.new as Parameters<typeof updateJob>[0]);
          if ((payload.new as { status: string }).status === 'completed') {
            setTimeout(() => router.push('/dashboard'), 1500);
          }
        }
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [jobIdRef.current]);

  // Chunk pump — drives the scan forward
  useEffect(() => {
    if (!job || paused || job.status === 'completed' || job.status === 'failed') return;
    if (chunkRunning.current) return;

    const pump = async () => {
      if (paused || !jobIdRef.current) return;
      chunkRunning.current = true;
      try {
        const res = await fetch('/api/scan/chunk', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobId: jobIdRef.current }),
        });
        const data = await res.json();
        if (data.error) {
          setErrors(e => [...e, data.error]);
          return;
        }
        if (!data.done) setTimeout(pump, 200);
        else chunkRunning.current = false;
      } catch (err) {
        setErrors(e => [...e, String(err)]);
        chunkRunning.current = false;
      }
    };
    pump();
  }, [job?.phase, paused]);

  const handlePause = async () => {
    if (!jobIdRef.current) return;
    setPaused(true);
    chunkRunning.current = false;
    await fetch(`/api/scan/${jobIdRef.current}`, { method: 'PATCH' });
  };

  const currentPhaseIndex = PHASES.indexOf(job?.phase ?? 'bootstrap');

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-background p-8">
      <div className="w-full max-w-lg space-y-8">
        <div>
          <h1 className="text-xl font-semibold">Scanning hub</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {job?.current_action ?? 'Initializing…'}
          </p>
        </div>

        {/* Circular progress indicator */}
        <div className="flex items-center justify-center">
          <div className="relative w-40 h-40">
            <svg className="w-40 h-40 -rotate-90" viewBox="0 0 160 160">
              <circle cx="80" cy="80" r="68" fill="none" stroke="hsl(var(--border))" strokeWidth="8" />
              <circle
                cx="80" cy="80" r="68" fill="none"
                stroke="hsl(var(--primary))" strokeWidth="8"
                strokeDasharray={`${2 * Math.PI * 68}`}
                strokeDashoffset={`${2 * Math.PI * 68 * (1 - (job?.overall_pct ?? 0) / 100)}`}
                strokeLinecap="round"
                className="transition-all duration-500"
              />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <span className="text-3xl font-semibold">{job?.overall_pct ?? 0}%</span>
              <span className="text-xs text-muted-foreground capitalize">{job?.phase ?? 'starting'}</span>
            </div>
          </div>
        </div>

        {/* Phase stepper */}
        <div className="flex items-center gap-1">
          {PHASES.filter(p => p !== 'done').map((phase, i) => (
            <div key={phase} className="flex items-center flex-1">
              <div className={`flex-1 h-1 rounded-full transition-colors ${
                i < currentPhaseIndex ? 'bg-primary'
                : i === currentPhaseIndex ? 'bg-primary/50'
                : 'bg-border'
              }`} />
              <div className={`text-xs px-1 whitespace-nowrap ${
                i === currentPhaseIndex ? 'text-primary font-medium' : 'text-muted-foreground'
              }`}>
                {PHASE_LABELS[phase]}
              </div>
            </div>
          ))}
        </div>

        {/* Live counters */}
        <div className="grid grid-cols-2 gap-3">
          {[
            { label: 'Projects scanned', value: `${job?.scanned_projects ?? 0} / ${job?.total_projects ?? 0}` },
            { label: '.rvt files found', value: job?.total_rvt_files ?? 0 },
            { label: 'Versions detected', value: job?.versions_detected ?? 0 },
            { label: 'Rate limit hits', value: job?.rate_limit_hits ?? 0 },
          ].map(({ label, value }) => (
            <div key={label} className="rounded-md border px-4 py-3">
              <div className="text-xs text-muted-foreground">{label}</div>
              <div className="text-lg font-semibold mt-0.5">{value}</div>
            </div>
          ))}
        </div>

        {job?.eta_seconds != null && (
          <p className="text-sm text-muted-foreground text-center">
            Estimated time remaining: {Math.ceil(job.eta_seconds / 60)} min
          </p>
        )}

        {/* Errors */}
        {errors.length > 0 && (
          <details className="rounded-md border border-destructive/40 bg-destructive/5 p-3">
            <summary className="text-sm font-medium text-destructive cursor-pointer">
              {errors.length} error{errors.length > 1 ? 's' : ''}
            </summary>
            <ul className="mt-2 space-y-1">
              {errors.map((e, i) => (
                <li key={i} className="text-xs text-destructive/80 font-mono">{e}</li>
              ))}
            </ul>
          </details>
        )}

        <div className="flex gap-3">
          {!paused && job?.status !== 'completed' && (
            <Button variant="outline" onClick={handlePause}>Pause scan</Button>
          )}
          <Button variant="ghost" onClick={() => router.push('/dashboard')}>
            View dashboard
          </Button>
        </div>
      </div>
    </div>
  );
}
