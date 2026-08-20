import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { act, renderHook } from '@testing-library/react-native';
import { Dimensions, Keyboard, Platform, type KeyboardEvent } from 'react-native';

import {
  imeOverlapFromKeyboardFrame,
  subscribeWebVisualViewport,
  useImeOverlap,
  type VisualViewportLike,
} from '../../../../src/shared/ui/useImeOverlap';

const originalOs = Platform.OS;

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

function mockKeyboardListeners() {
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
  return listeners;
}

describe('imeOverlapFromKeyboardFrame', () => {
  it('returns the window height covered by the IME', () => {
    expect(imeOverlapFromKeyboardFrame(800, 480)).toBe(320);
    expect(imeOverlapFromKeyboardFrame(800, 800)).toBe(0);
    expect(imeOverlapFromKeyboardFrame(800, 860)).toBe(0);
  });
});

describe('subscribeWebVisualViewport', () => {
  it('does nothing when the visual viewport is missing', () => {
    const onOverlap = jest.fn<(overlap: number) => void>();
    const unsubscribe = subscribeWebVisualViewport(onOverlap, null, () => 800);
    unsubscribe();
    expect(onOverlap).not.toHaveBeenCalled();
  });

  it('reports coverage and unsubscribes viewport listeners', () => {
    const onOverlap = jest.fn<(overlap: number) => void>();
    const listeners = new Map<string, () => void>();
    let height = 520;
    const viewport: VisualViewportLike = {
      addEventListener: (type, listener) => {
        listeners.set(type, listener);
      },
      get height() {
        return height;
      },
      offsetTop: 12,
      removeEventListener: (type) => {
        listeners.delete(type);
      },
    };

    const unsubscribe = subscribeWebVisualViewport(onOverlap, viewport, () => 800);
    expect(onOverlap).toHaveBeenCalledWith(268);

    act(() => {
      height = 400;
      listeners.get('resize')?.();
    });
    expect(onOverlap).toHaveBeenLastCalledWith(388);

    act(() => {
      height = 400;
      listeners.get('scroll')?.();
    });
    expect(onOverlap).toHaveBeenLastCalledWith(388);

    unsubscribe();
    expect(listeners.size).toBe(0);
  });
});

describe('useImeOverlap', () => {
  afterEach(() => {
    Platform.OS = originalOs;
    jest.restoreAllMocks();
  });

  it('lifts by the covered window area when the IME frame changes on iOS', () => {
    Platform.OS = 'ios';
    const listeners = mockKeyboardListeners();

    const { result, unmount } = renderHook(() => useImeOverlap());
    expect(result.current).toBe(0);

    const onFrame = listeners.get('keyboardWillChangeFrame');
    expect(onFrame).toBeDefined();
    expect(listeners.has('keyboardDidShow')).toBe(false);

    const windowHeight = Dimensions.get('window').height;
    act(() => {
      onFrame?.(keyboardEvent(windowHeight - 336, 336));
    });
    expect(result.current).toBe(336);

    unmount();
    expect(listeners.size).toBe(0);
  });

  it('tracks show, hide, and frame changes on Android', () => {
    Platform.OS = 'android';
    const listeners = mockKeyboardListeners();

    const { result, unmount } = renderHook(() => useImeOverlap());
    expect(listeners.has('keyboardDidShow')).toBe(true);
    expect(listeners.has('keyboardDidHide')).toBe(true);
    expect(listeners.has('keyboardDidChangeFrame')).toBe(true);

    const windowHeight = Dimensions.get('window').height;
    act(() => {
      listeners.get('keyboardDidShow')?.(keyboardEvent(windowHeight - 280, 280));
    });
    expect(result.current).toBe(280);

    act(() => {
      listeners.get('keyboardDidChangeFrame')?.(keyboardEvent(windowHeight - 340, 340));
    });
    expect(result.current).toBe(340);

    act(() => {
      listeners.get('keyboardDidHide')?.(keyboardEvent(windowHeight, 0));
    });
    expect(result.current).toBe(0);

    unmount();
    expect(listeners.size).toBe(0);
  });

  it('tracks visualViewport coverage on web', () => {
    Platform.OS = 'web';
    const listeners = new Map<string, () => void>();
    let height = 640;
    const viewport: VisualViewportLike = {
      addEventListener: (type, listener) => {
        listeners.set(type, listener);
      },
      get height() {
        return height;
      },
      offsetTop: 0,
      removeEventListener: (type) => {
        listeners.delete(type);
      },
    };
    const previousViewport = Object.getOwnPropertyDescriptor(window, 'visualViewport');
    const previousInnerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight');
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });

    try {
      const { result, unmount } = renderHook(() => useImeOverlap());
      expect(result.current).toBe(160);

      act(() => {
        height = 480;
        listeners.get('resize')?.();
      });
      expect(result.current).toBe(320);

      unmount();
      expect(listeners.size).toBe(0);
    } finally {
      if (previousViewport) {
        Object.defineProperty(window, 'visualViewport', previousViewport);
      }
      if (previousInnerHeight) {
        Object.defineProperty(window, 'innerHeight', previousInnerHeight);
      }
    }
  });
});
