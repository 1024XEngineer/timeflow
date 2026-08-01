import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, renderHook } from '@testing-library/react-native';
import { AppState, Platform } from 'react-native';

const mockGetStatus = jest.fn();
const mockOpenSettings = jest.fn(async () => undefined);
const mockRequestNotifications = jest.fn(async () => true);
const mockIsSupported = jest.fn(() => true);
const mockConfirm = jest.fn(async () => false);

jest.mock('@/shared/components/AppDialogProvider', () => ({
  useAppDialog: () => ({ confirm: mockConfirm, showNotice: jest.fn() }),
}));

jest.mock('@/features/reminder/native/alarmScheduler', () => ({
  getAndroidAlarmPermissionStatus: () => mockGetStatus(),
  openAndroidAlarmPermissionSettings: (...args: unknown[]) =>
    (mockOpenSettings as (...a: unknown[]) => unknown)(...args),
  requestAndroidNotificationPermission: () => mockRequestNotifications(),
  isAndroidAlarmSupported: () => mockIsSupported(),
}));

import { useAlarmPermissionsOnLaunch } from '@/features/reminder';

describe('useAlarmPermissionsOnLaunch', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    (Platform as { OS: string }).OS = 'android';
    mockIsSupported.mockReturnValue(true);
    mockConfirm.mockResolvedValue(false);
    mockGetStatus.mockResolvedValue({
      exactAlarm: false,
      overlay: true,
      fullScreen: true,
      notifications: true,
      battery: true,
    } as never);
    jest.spyOn(AppState, 'addEventListener').mockReturnValue({ remove: jest.fn() } as never);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('does nothing on non-android platforms', () => {
    (Platform as { OS: string }).OS = 'ios';
    renderHook(() => useAlarmPermissionsOnLaunch());
    act(() => {
      jest.runOnlyPendingTimers();
    });
    expect(mockGetStatus).not.toHaveBeenCalled();
  });

  it('prompts for the next missing permission and can skip', async () => {
    renderHook(() => useAlarmPermissionsOnLaunch());
    await act(async () => {
      jest.advanceTimersByTime(600);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ title: '需要精确闹钟权限' }),
    );
    expect(mockGetStatus).toHaveBeenCalled();
  });

  it('requests notification permission first when missing', async () => {
    mockGetStatus.mockResolvedValue({
      exactAlarm: true,
      overlay: true,
      fullScreen: true,
      notifications: false,
      battery: true,
    } as never);
    renderHook(() => useAlarmPermissionsOnLaunch());
    await act(async () => {
      jest.advanceTimersByTime(600);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockRequestNotifications).toHaveBeenCalled();
  });
});
