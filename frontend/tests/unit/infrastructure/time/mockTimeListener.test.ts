import { describe, expect, it, jest } from '@jest/globals';

import { MockTimeListener } from '../../../../src/infrastructure/time/MockTimeListener';

describe('MockTimeListener', () => {
  it('resolves start() with a handle carrying a listener_id, never firing the listener', async () => {
    const listener = jest.fn();
    const time = new MockTimeListener();
    const handle = await time.start(listener);
    expect(handle.listener_id).toEqual(expect.any(String));
    expect(listener).not.toHaveBeenCalled();
  });

  it('hands out a distinct listener_id per start() call', async () => {
    const time = new MockTimeListener();
    const first = await time.start(() => {});
    const second = await time.start(() => {});
    expect(first.listener_id).not.toBe(second.listener_id);
  });

  it('stop() resolves without needing a matching start()', async () => {
    const time = new MockTimeListener();
    await expect(time.stop('unknown-listener')).resolves.toBeUndefined();
  });
});
