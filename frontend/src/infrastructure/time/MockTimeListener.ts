import type {
  LocalTimeTick,
  TimeListenerHandle,
  TimeListenerOptions,
  TimeListenerPort,
} from '../../features/reminder/application/interfaces';

let nextListenerId = 0;

/** 不产生任何 tick 的固定实现——真实的周期计时器接入前占位用。 */
export class MockTimeListener implements TimeListenerPort {
  async start(
    _listener: (tick: LocalTimeTick) => void,
    _options?: TimeListenerOptions,
  ): Promise<TimeListenerHandle> {
    nextListenerId += 1;
    return { listener_id: `mock-time-listener-${nextListenerId}` };
  }

  async stop(_listenerId: string): Promise<void> {
    return Promise.resolve();
  }
}
