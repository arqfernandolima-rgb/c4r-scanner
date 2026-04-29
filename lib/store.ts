import { create } from 'zustand';

export interface ScanJob {
  id: string;
  status: string;
  phase: string;
  overall_pct: number;
  current_action: string | null;
  total_projects: number;
  scanned_projects: number;
  total_rvt_files: number;
  versions_detected: number;
  at_risk_count: number;
  rate_limit_hits: number;
  error_count: number;
  eta_seconds: number | null;
  error_message: string | null;
}

interface ScanStore {
  job: ScanJob | null;
  setJob: (job: ScanJob) => void;
  updateJob: (partial: Partial<ScanJob>) => void;
  clearJob: () => void;
}

export const useScanStore = create<ScanStore>((set) => ({
  job: null,
  setJob: (job) => set({ job }),
  updateJob: (partial) =>
    set((state) => ({ job: state.job ? { ...state.job, ...partial } : null })),
  clearJob: () => set({ job: null }),
}));
