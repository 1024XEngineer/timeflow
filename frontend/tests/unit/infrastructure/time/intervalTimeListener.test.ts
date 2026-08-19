import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { IntervalTimeListener } from '../../../../src/infrastructure/time/IntervalTimeListener';

describe('IntervalTimeListener', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('resolves start() with a handle carrying a listener_id, without firing synchronously', async () => {
    const listener = jest.fn();
    const time = new IntervalTimeListener();
    const handle = await time.start(listener);
    expect(handle.listener_id).toEqual(expect.any(String));
    expect(listener).not.toHaveBeenCalled();
  });

  it('fires the listener with an observed_at timestamp on every interval tick', async () => {
    const listener = jest.fn();
    const time = new IntervalTimeListener(1_000);
    await time.start(listener);

    jest.advanceTimersByTime(1_000);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ observed_at: expect.any(String) });

    jest.advanceTimersByTime(2_000);
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('hands out a distinct listener_id per start() call and ticks them independently', async () => {
    const first = jest.fn();
    const second = jest.fn();
    const time = new IntervalTimeListener(1_000);
    const firstHandle = await time.start(first);
    const secondHandle = await time.start(second);
    expect(firstHandle.listener_id).not.toBe(secondHandle.listener_id);

    jest.advanceTimersByTime(1_000);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('stop() clears the interval so the listener stops receiving ticks', async () => {
    const listener = jest.fn();
    const time = new IntervalTimeListener(1_000);
    const handle = await time.start(listener);

    jest.advanceTimersByTime(1_000);
    expect(listener).toHaveBeenCalledTimes(1);

    await time.stop(handle.listener_id);
    jest.advanceTimersByTime(5_000);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('stop() resolves without needing a matching start()', async () => {
    const time = new IntervalTimeListener();
    await expect(time.stop('unknown-listener')).resolves.toBeUndefined();
  });

  it('uses the default 30s interval when none is supplied', async () => {
    const listener = jest.fn();
    const time = new IntervalTimeListener();
    await time.start(listener);

    jest.advanceTimersByTime(29_999);
    expect(listener).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
