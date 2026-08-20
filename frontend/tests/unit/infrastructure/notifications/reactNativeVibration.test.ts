import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Platform, Vibration } from 'react-native';

import { ReactNativeVibration } from '../../../../src/infrastructure/notifications/ReactNativeVibration';

const REPEAT_PATTERN = [0, 700, 350, 700];

describe('ReactNativeVibration', () => {
  let vibrateSpy: jest.SpiedFunction<typeof Vibration.vibrate>;
  let cancelSpy: jest.SpiedFunction<typeof Vibration.cancel>;

  beforeEach(() => {
    jest.useFakeTimers();
    vibrateSpy = jest.spyOn(Vibration, 'vibrate').mockImplementation(() => undefined);
    cancelSpy = jest.spyOn(Vibration, 'cancel').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    Platform.OS = 'android';
  });

  it('vibrates in a looping pattern on Android without an interval timer', async () => {
    Platform.OS = 'android';
    const vibration = new ReactNativeVibration();
    await vibration.vibrate();

    expect(cancelSpy).toHaveBeenCalledTimes(1);
    expect(vibrateSpy).toHaveBeenCalledTimes(1);
    expect(vibrateSpy).toHaveBeenCalledWith(REPEAT_PATTERN, true);

    vibrateSpy.mockClear();
    jest.advanceTimersByTime(10_000);
    expect(vibrateSpy).not.toHaveBeenCalled();
  });

  it('vibrates once and re-triggers on a 2s interval on iOS', async () => {
    Platform.OS = 'ios';
    const vibration = new ReactNativeVibration();
    await vibration.vibrate();

    expect(vibrateSpy).toHaveBeenCalledTimes(1);
    expect(vibrateSpy).toHaveBeenCalledWith(REPEAT_PATTERN);

    jest.advanceTimersByTime(2_000);
    expect(vibrateSpy).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(2_000);
    expect(vibrateSpy).toHaveBeenCalledTimes(3);
  });

  it('cancels the previous iOS interval timer when vibrate is called again', async () => {
    Platform.OS = 'ios';
    const vibration = new ReactNativeVibration();
    await vibration.vibrate();
    vibrateSpy.mockClear();
    await vibration.vibrate();

    jest.advanceTimersByTime(2_000);
    // 只应该有新那个定时器的一次触发，不是新旧两个定时器叠加成两次。
    expect(vibrateSpy).toHaveBeenCalledTimes(2);
  });

  it('stop cancels vibration and clears the iOS interval timer', async () => {
    Platform.OS = 'ios';
    const vibration = new ReactNativeVibration();
    await vibration.vibrate();
    vibrateSpy.mockClear();
    cancelSpy.mockClear();

    await vibration.stop();
    expect(cancelSpy).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(10_000);
    expect(vibrateSpy).not.toHaveBeenCalled();
  });

  it('stop is safe to call without a prior vibrate (no timer to clear)', async () => {
    const vibration = new ReactNativeVibration();
    cancelSpy.mockClear();
    await expect(vibration.stop()).resolves.toBeUndefined();
    expect(cancelSpy).toHaveBeenCalledTimes(1);
  });
});
