import type {
  LocalTimeTick,
  TimeListenerHandle,
  TimeListenerOptions,
  TimeListenerPort,
} from '../../features/reminder/application/interfaces';

/** 固定时间监听边界，替换前不会发出平台事件。 */
export class MockTimeListener implements TimeListenerPort {
  async start(
    _listener: (tick: LocalTimeTick) => void,
    _options?: TimeListenerOptions,
  ): Promise<TimeListenerHandle> {
    return { listener_id: 'mock-time-listener-001' };
  }

  async stop(_listenerId: string): Promise<void> {
    return Promise.resolve();
  }
}
