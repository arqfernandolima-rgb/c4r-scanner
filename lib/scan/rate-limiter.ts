import pLimit from 'p-limit';
import pRetry from 'p-retry';

export const limits = {
  phase0: pLimit(3),
  phase1: pLimit(15),
  phase2: pLimit(25),
  phase3: pLimit(10),
};

export async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  return pRetry(fn, {
    retries: 5,
    factor: 2,
    minTimeout: 100,
    maxTimeout: 30000,
    onFailedAttempt: async (err) => {
      const anyErr = err as unknown as { response?: { status: number; headers: { get: (k: string) => string | null } } };
      const status = anyErr.response?.status;
      if (status === 403) throw err;
      if (status === 429) {
        const retryAfter = anyErr.response?.headers.get('retry-after');
        if (retryAfter) {
          await new Promise(r => setTimeout(r, parseInt(retryAfter) * 1000));
        }
      }
    },
  });
}
