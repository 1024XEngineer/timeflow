import { describe, expect, it } from '@jest/globals';

import { MockDeviceCapability } from '../../../../src/infrastructure/notifications/MockDeviceCapability';

describe('MockDeviceCapability', () => {
  it('reports the fixed mock status', async () => {
    const device = new MockDeviceCapability();
    await expect(device.getStatus()).resolves.toEqual({
      platform: 'android',
      supported: true,
      permissions: {
        notifications: true,
        exact_alarm: true,
        overlay: false,
        full_screen: true,
        battery_optimization: false,
        location_foreground: true,
        location_background: false,
      },
      background_execution: false,
    });
  });

  it('resolves requestPermission with the fixed value for that permission', async () => {
    const device = new MockDeviceCapability();
    await expect(device.requestPermission('overlay')).resolves.toBe(false);
    await expect(device.requestPermission('notifications')).resolves.toBe(true);
  });

  it('resolves openSettings as successful', async () => {
    const device = new MockDeviceCapability();
    await expect(device.openSettings('overlay')).resolves.toBe(true);
  });

  it('onAppActive is a no-op that returns an unsubscribe function', () => {
    const device = new MockDeviceCapability();
    const unsubscribe = device.onAppActive(() => {
      throw new Error('should never be called');
    });
    expect(() => unsubscribe()).not.toThrow();
  });
});
