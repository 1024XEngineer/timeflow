import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, renderHook } from '@testing-library/react-native';

import { useCurrentDate } from '@/shared/hooks/useCurrentDate';

describe('useCurrentDate', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(2026, 6, 31, 12, 0, 0));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('starts at the current time and ticks every minute', () => {
    const { result } = renderHook(() => useCurrentDate());
    expect(result.current.getTime()).toBe(new Date(2026, 6, 31, 12, 0, 0).getTime());

    act(() => {
      jest.advanceTimersByTime(60_000);
    });
    expect(result.current.getTime()).toBe(new Date(2026, 6, 31, 12, 1, 0).getTime());
  });

  it('clears the interval on unmount', () => {
    const clearSpy = jest.spyOn(global, 'clearInterval');
    const { unmount } = renderHook(() => useCurrentDate());
    unmount();
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });
});
