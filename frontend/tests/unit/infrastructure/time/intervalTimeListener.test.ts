import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { IntervalTimeListener } from '../../../../src/infrastructure/time/IntervalTimeListener';

describe('IntervalTimeListener', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('does not emit a tick on start and stops after stop()', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-13T08:00:00.000Z'));
    const listener = new IntervalTimeListener(1_000);
    const ticks: string[] = [];

    const handle = await listener.start((tick) => {
      ticks.push(tick.observed_at);
    });
    expect(ticks).toEqual([]);

    await jest.advanceTimersByTimeAsync(1_000);
    expect(ticks).toEqual(['2026-08-13T08:00:01.000Z']);

    await listener.stop(handle.listener_id);
    await jest.advanceTimersByTimeAsync(5_000);
    expect(ticks).toHaveLength(1);
  });

  it('ignores stop for an unknown listener id', async () => {
    const listener = new IntervalTimeListener(30_000);
    await expect(listener.stop('missing')).resolves.toBeUndefined();
  });

  it('assigns a unique listener id per start', async () => {
    jest.useFakeTimers();
    const listener = new IntervalTimeListener(60_000);
    const first = await listener.start(() => undefined);
    const second = await listener.start(() => undefined);
    expect(first.listener_id).not.toBe(second.listener_id);
    await listener.stop(first.listener_id);
    await listener.stop(second.listener_id);
  });
});
