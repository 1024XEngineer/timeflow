import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { act, renderHook } from '@testing-library/react-native';
import { Dimensions, Keyboard, Platform, type KeyboardEvent } from 'react-native';

import {
  imeOverlapFromKeyboardFrame,
  useImeOverlap,
} from '../../../../src/shared/ui/useImeOverlap';

function keyboardEvent(screenY: number, height = 320): KeyboardEvent {
  return {
    duration: 0,
    easing: 'keyboard',
    endCoordinates: {
      height,
      screenX: 0,
      screenY,
      width: 400,
    },
  };
}

describe('imeOverlapFromKeyboardFrame', () => {
  it('returns the window height covered by the IME', () => {
    expect(imeOverlapFromKeyboardFrame(800, 480)).toBe(320);
    expect(imeOverlapFromKeyboardFrame(800, 800)).toBe(0);
    expect(imeOverlapFromKeyboardFrame(800, 860)).toBe(0);
  });
});

describe('useImeOverlap', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('lifts by the covered window area when the IME frame changes', () => {
    const listeners = new Map<string, (event: KeyboardEvent) => void>();
    jest.spyOn(Keyboard, 'addListener').mockImplementation((event, listener) => {
      listeners.set(event, listener as (event: KeyboardEvent) => void);
      return {
        remove() {
          listeners.delete(event);
        },
      } as ReturnType<typeof Keyboard.addListener>;
    });
    jest.spyOn(Keyboard, 'scheduleLayoutAnimation').mockImplementation(() => {});

    const { result, unmount } = renderHook(() => useImeOverlap());
    expect(result.current).toBe(0);

    const onFrame =
      Platform.OS === 'ios'
        ? listeners.get('keyboardWillChangeFrame')
        : listeners.get('keyboardDidShow');
    expect(onFrame).toBeDefined();

    const windowHeight = Dimensions.get('window').height;
    act(() => {
      onFrame?.(keyboardEvent(windowHeight - 336, 336));
    });
    expect(result.current).toBe(336);

    unmount();
  });
});
