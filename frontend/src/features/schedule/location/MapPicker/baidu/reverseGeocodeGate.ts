/**
 * 逆地理编码调度：防抖 + 串行，避免连点/拖图触发超免费 QPS。
 * 同一时间只保留最新待解析坐标；上一请求结束后再发下一请求。
 */
export type ReverseGeocodeJob = {
  latitude: number;
  longitude: number;
  requestId: number;
};

export type ReverseGeocodeRunner = (job: ReverseGeocodeJob) => Promise<void> | void;

export type ReverseGeocodeGate = {
  schedule: (job: ReverseGeocodeJob, run: ReverseGeocodeRunner) => void;
  clear: () => void;
};

export function createReverseGeocodeGate(options?: {
  debounceMs?: number;
  minIntervalMs?: number;
}): ReverseGeocodeGate {
  const debounceMs = options?.debounceMs ?? 450;
  const minIntervalMs = options?.minIntervalMs ?? 350;

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let intervalTimer: ReturnType<typeof setTimeout> | null = null;
  let pending: { job: ReverseGeocodeJob; run: ReverseGeocodeRunner } | null = null;
  let inFlight = false;
  let lastStartedAt = 0;

  const clearTimers = () => {
    if (debounceTimer != null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (intervalTimer != null) {
      clearTimeout(intervalTimer);
      intervalTimer = null;
    }
  };

  const flush = async () => {
    if (inFlight || !pending) return;

    const elapsed = Date.now() - lastStartedAt;
    const wait = lastStartedAt === 0 ? 0 : Math.max(0, minIntervalMs - elapsed);
    if (wait > 0) {
      intervalTimer = setTimeout(() => {
        intervalTimer = null;
        void flush();
      }, wait);
      return;
    }

    const current = pending;
    pending = null;
    inFlight = true;
    lastStartedAt = Date.now();

    try {
      await current.run(current.job);
    } finally {
      inFlight = false;
      if (pending) void flush();
    }
  };

  return {
    schedule(job, run) {
      pending = { job, run };
      if (debounceTimer != null) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        void flush();
      }, debounceMs);
    },
    clear() {
      clearTimers();
      pending = null;
    },
  };
}
