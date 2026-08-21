import { renderHook } from '@testing-library/react-native';
import { describe, expect, it, jest } from '@jest/globals';

import type {
  AlertDialogPort,
  AlertDialogRequest,
  DevicePermission,
  ReminderApplicationPort,
  ReminderPermissionBlockedEvent,
} from '../../../../../src/features/reminder/application/interfaces';
import { useReminderPermissionNudge } from '../../../../../src/features/reminder/presentation/useReminderPermissionNudge';

function createReminder(): ReminderApplicationPort & {
  fire: (event: ReminderPermissionBlockedEvent) => void;
} {
  let listener: ((event: ReminderPermissionBlockedEvent) => void) | null = null;
  const unsubscribe = jest.fn();
  return {
    onPermissionBlocked: jest.fn((l: (event: ReminderPermissionBlockedEvent) => void) => {
      listener = l;
      return unsubscribe;
    }),
    fire: (event: ReminderPermissionBlockedEvent) => listener?.(event),
  } as unknown as ReminderApplicationPort & {
    fire: (event: ReminderPermissionBlockedEvent) => void;
  };
}

function createDialog(): AlertDialogPort & { lastRequest: () => AlertDialogRequest | undefined } {
  const show = jest.fn<(request: AlertDialogRequest) => Promise<void>>(async () => {});
  return {
    show,
    lastRequest: () => show.mock.calls.at(-1)?.[0],
  };
}

describe('useReminderPermissionNudge', () => {
  it('subscribes to onPermissionBlocked on mount', () => {
    const reminder = createReminder();
    const dialog = createDialog();
    renderHook(() => useReminderPermissionNudge(reminder, dialog, jest.fn()));

    expect(reminder.onPermissionBlocked).toHaveBeenCalledTimes(1);
  });

  it('shows a combined dialog naming every missing permission', () => {
    const reminder = createReminder();
    const dialog = createDialog();
    renderHook(() => useReminderPermissionNudge(reminder, dialog, jest.fn()));

    reminder.fire({ schedule_id: 's1', missing: ['exact_alarm', 'overlay'] });

    expect(dialog.show).toHaveBeenCalledTimes(1);
    expect(dialog.lastRequest()?.message).toContain('精确闹钟');
    expect(dialog.lastRequest()?.message).toContain('显示在其他应用上层');
  });

  it('requests the first missing permission when the user confirms', () => {
    const reminder = createReminder();
    const dialog = createDialog();
    const onRequestPermission = jest.fn<(permission?: DevicePermission) => void>();
    renderHook(() => useReminderPermissionNudge(reminder, dialog, onRequestPermission));

    reminder.fire({ schedule_id: 's1', missing: ['exact_alarm', 'overlay'] });
    const confirmButton = dialog.lastRequest()?.buttons.find((button) => button.text === '去开启');
    confirmButton?.onPress?.();

    expect(onRequestPermission).toHaveBeenCalledWith('exact_alarm');
  });

  it('does not request a permission when the user dismisses', () => {
    const reminder = createReminder();
    const dialog = createDialog();
    const onRequestPermission = jest.fn<(permission?: DevicePermission) => void>();
    renderHook(() => useReminderPermissionNudge(reminder, dialog, onRequestPermission));

    reminder.fire({ schedule_id: 's1', missing: ['exact_alarm'] });
    const cancelButton = dialog.lastRequest()?.buttons.find((button) => button.text === '暂不');
    cancelButton?.onPress?.();

    expect(onRequestPermission).not.toHaveBeenCalled();
  });

  it('ignores an event with no missing permissions', () => {
    const reminder = createReminder();
    const dialog = createDialog();
    renderHook(() => useReminderPermissionNudge(reminder, dialog, jest.fn()));

    reminder.fire({ schedule_id: 's1', missing: [] });

    expect(dialog.show).not.toHaveBeenCalled();
  });

  it('unsubscribes on unmount', () => {
    const reminder = createReminder();
    const unsubscribe = jest.fn();
    reminder.onPermissionBlocked = jest.fn(() => unsubscribe);
    const dialog = createDialog();
    const { unmount } = renderHook(() => useReminderPermissionNudge(reminder, dialog, jest.fn()));

    unmount();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
