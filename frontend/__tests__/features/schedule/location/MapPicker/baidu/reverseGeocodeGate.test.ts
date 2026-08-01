import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import {
  createReverseGeocodeGate,
  type ReverseGeocodeJob,
  type ReverseGeocodeRunner,
} from '@/features/schedule/location/MapPicker/baidu/reverseGeocodeGate';

describe('createReverseGeocodeGate', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('debounces rapid schedules and only runs the latest job', async () => {
    const gate = createReverseGeocodeGate({ debounceMs: 450, minIntervalMs: 0 });
    const run = jest.fn<ReverseGeocodeRunner>();

    gate.schedule({ latitude: 1, longitude: 1, requestId: 1 }, run);
    gate.schedule({ latitude: 2, longitude: 2, requestId: 2 }, run);
    gate.schedule({ latitude: 3, longitude: 3, requestId: 3 }, run);

    expect(run).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(450);

    expect(run).toHaveBeenCalledTimes(1);
    const firstCall = run.mock.calls[0]?.[0] as ReverseGeocodeJob | undefined;
    expect(firstCall).toEqual({
      latitude: 3,
      longitude: 3,
      requestId: 3,
    });
  });

  it('waits for the minimum interval before starting the next run', async () => {
    const gate = createReverseGeocodeGate({ debounceMs: 0, minIntervalMs: 350 });
    const run = jest.fn<ReverseGeocodeRunner>(async () => undefined);

    gate.schedule({ latitude: 1, longitude: 1, requestId: 1 }, run);
    await jest.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);

    gate.schedule({ latitude: 2, longitude: 2, requestId: 2 }, run);
    await jest.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(350);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('clear cancels pending timers and drops the queued job', async () => {
    const gate = createReverseGeocodeGate({ debounceMs: 450, minIntervalMs: 0 });
    const run = jest.fn<ReverseGeocodeRunner>();

    gate.schedule({ latitude: 1, longitude: 1, requestId: 1 }, run);
    gate.clear();
    await jest.advanceTimersByTimeAsync(450);
    expect(run).not.toHaveBeenCalled();
  });

  it('queues the next job until the in-flight request finishes', async () => {
    const gate = createReverseGeocodeGate({ debounceMs: 0, minIntervalMs: 0 });
    let resolveFirst: (() => void) | undefined;
    const first = jest.fn<ReverseGeocodeRunner>(
      () =>
        new Promise<void>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const second = jest.fn<ReverseGeocodeRunner>(async () => undefined);

    gate.schedule({ latitude: 1, longitude: 1, requestId: 1 }, first);
    await jest.advanceTimersByTimeAsync(0);
    expect(first).toHaveBeenCalledTimes(1);

    gate.schedule({ latitude: 2, longitude: 2, requestId: 2 }, second);
    await jest.advanceTimersByTimeAsync(0);
    expect(second).not.toHaveBeenCalled();

    resolveFirst?.();
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(0);

    expect(second).toHaveBeenCalledTimes(1);
    const secondCall = second.mock.calls[0]?.[0] as ReverseGeocodeJob | undefined;
    expect(secondCall?.requestId).toBe(2);
  });
});
