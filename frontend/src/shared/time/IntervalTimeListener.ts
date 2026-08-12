import type {
  LocalTimeTick,
  TimeListenerHandle,
  TimeListenerOptions,
  TimeListenerPort,
} from '../../features/reminder/application/interfaces';

const DEFAULT_INTERVAL_MS = 30_000;

/** 进程内周期时间观测，驱动 handleTime。 */
export class IntervalTimeListener implements TimeListenerPort {
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>();
  private sequence = 0;

  constructor(private readonly intervalMs: number = DEFAULT_INTERVAL_MS) {}

  async start(
    listener: (tick: LocalTimeTick) => void,
    _options?: TimeListenerOptions,
  ): Promise<TimeListenerHandle> {
    const listenerId = `interval-time-listener-${++this.sequence}`;
    const emit = () => {
      listener({ observed_at: new Date().toISOString() });
    };
    // 不在 start 同步打首 tick，交给调用方完成 rebuild 后再自然周期触发。
    const timer = setInterval(emit, this.intervalMs);
    this.timers.set(listenerId, timer);
    return { listener_id: listenerId };
  }

  async stop(listenerId: string): Promise<void> {
    const timer = this.timers.get(listenerId);
    if (timer != null) {
      clearInterval(timer);
      this.timers.delete(listenerId);
    }
  }
}
