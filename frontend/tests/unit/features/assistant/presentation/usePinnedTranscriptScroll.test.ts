import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { act, renderHook } from '@testing-library/react-native';
import type {
  LayoutChangeEvent,
  NativeScrollEvent,
  NativeSyntheticEvent,
  ScrollView,
} from 'react-native';
import { Platform } from 'react-native';

import {
  PINNED_TO_BOTTOM_THRESHOLD,
  TRANSCRIPT_IDLE_MS,
  isPinnedToBottom,
  topSpacerHeight,
  usePinnedTranscriptScroll,
} from '../../../../../src/features/assistant/presentation/usePinnedTranscriptScroll';

const originalOs = Platform.OS;

function layoutEvent(height: number): LayoutChangeEvent {
  return {
    nativeEvent: {
      layout: { height, width: 390, x: 0, y: 0 },
    },
  } as LayoutChangeEvent;
}

function scrollEvent({
  contentHeight,
  offsetY,
  viewportHeight,
}: {
  contentHeight: number;
  offsetY: number;
  viewportHeight: number;
}): NativeSyntheticEvent<NativeScrollEvent> {
  return {
    nativeEvent: {
      contentOffset: { x: 0, y: offsetY },
      contentSize: { height: contentHeight, width: 390 },
      layoutMeasurement: { height: viewportHeight, width: 390 },
    },
  } as NativeSyntheticEvent<NativeScrollEvent>;
}

describe('topSpacerHeight', () => {
  it('waits for a measured viewport before inserting space', () => {
    expect(topSpacerHeight(0, 80)).toBe(0);
    expect(topSpacerHeight(-10, 80)).toBe(0);
  });

  it('fills leftover viewport so short turns sit above the dock', () => {
    expect(topSpacerHeight(400, 120)).toBe(280);
    expect(topSpacerHeight(400, 400)).toBe(0);
    expect(topSpacerHeight(400, 2000)).toBe(0);
  });
});

describe('isPinnedToBottom', () => {
  it('pins short content and the true bottom', () => {
    expect(isPinnedToBottom({ contentHeight: 200, offsetY: 0, viewportHeight: 400 })).toBe(true);
    expect(isPinnedToBottom({ contentHeight: 2000, offsetY: 1600, viewportHeight: 400 })).toBe(
      true,
    );
  });

  it('unpins once the user scrolls past the threshold', () => {
    const viewportHeight = 400;
    const contentHeight = 2000;
    const bottomOffset = contentHeight - viewportHeight;
    expect(
      isPinnedToBottom({
        contentHeight,
        offsetY: bottomOffset - PINNED_TO_BOTTOM_THRESHOLD,
        viewportHeight,
      }),
    ).toBe(true);
    expect(
      isPinnedToBottom({
        contentHeight,
        offsetY: bottomOffset - PINNED_TO_BOTTOM_THRESHOLD - 1,
        viewportHeight,
      }),
    ).toBe(false);
  });
});

describe('usePinnedTranscriptScroll', () => {
  afterEach(() => {
    Platform.OS = originalOs;
    jest.useRealTimers();
  });

  it('pads short turns instead of asking ScrollView to pack them with flex-end', () => {
    const { result } = renderHook(() => usePinnedTranscriptScroll());
    const scrollToEnd = jest.fn();
    result.current.transcriptRef.current = { scrollToEnd } as unknown as ScrollView;

    act(() => {
      result.current.onLayout(layoutEvent(400));
      result.current.onTurnsLayout(layoutEvent(240));
    });

    expect(result.current.topSpacer).toBe(160);
    expect(scrollToEnd).not.toHaveBeenCalled();

    act(() => {
      result.current.onLayout(layoutEvent(400));
      result.current.onTurnsLayout(layoutEvent(240));
    });
    expect(result.current.topSpacer).toBe(160);
  });

  it('drops the spacer once turns overflow so chronological order stays top to bottom', () => {
    const { result } = renderHook(() => usePinnedTranscriptScroll());
    const scrollToEnd = jest.fn();
    result.current.transcriptRef.current = { scrollToEnd } as unknown as ScrollView;

    act(() => {
      result.current.onLayout(layoutEvent(400));
      result.current.onTurnsLayout(layoutEvent(2000));
    });

    expect(result.current.topSpacer).toBe(0);
    expect(scrollToEnd).toHaveBeenCalledWith({ animated: true });
  });

  it('does not follow the latest turn after the user scrolls up', () => {
    jest.useFakeTimers();
    const { result } = renderHook(() => usePinnedTranscriptScroll());
    const scrollToEnd = jest.fn();
    result.current.transcriptRef.current = { scrollToEnd } as unknown as ScrollView;

    act(() => {
      result.current.onLayout(layoutEvent(400));
      result.current.onTurnsLayout(layoutEvent(2000));
    });
    expect(scrollToEnd).toHaveBeenCalledTimes(1);

    act(() => {
      jest.advanceTimersByTime(TRANSCRIPT_IDLE_MS);
    });

    act(() => {
      result.current.onScroll(
        scrollEvent({ contentHeight: 2000, offsetY: 0, viewportHeight: 400 }),
      );
      result.current.onContentSizeChange(390, 2200);
      result.current.onTurnsLayout(layoutEvent(2200));
    });

    expect(scrollToEnd).toHaveBeenCalledTimes(1);
  });

  it('follows the latest turn on content size change while still pinned', () => {
    const { result } = renderHook(() => usePinnedTranscriptScroll());
    const scrollToEnd = jest.fn();
    result.current.transcriptRef.current = { scrollToEnd } as unknown as ScrollView;

    act(() => {
      result.current.onLayout(layoutEvent(400));
      result.current.onTurnsLayout(layoutEvent(2000));
    });
    scrollToEnd.mockClear();

    act(() => {
      result.current.onContentSizeChange(390, 2100);
    });

    expect(scrollToEnd).toHaveBeenCalledWith({ animated: true });
  });

  it.each(['ios', 'android'] as const)(
    'does not steal an upward drag on %s before the first onScroll',
    (os) => {
      Platform.OS = os;
      const { result } = renderHook(() => usePinnedTranscriptScroll());
      const scrollToEnd = jest.fn();
      result.current.transcriptRef.current = { scrollToEnd } as unknown as ScrollView;

      act(() => {
        result.current.onLayout(layoutEvent(400));
        result.current.onTurnsLayout(layoutEvent(2000));
      });
      expect(scrollToEnd).toHaveBeenCalledTimes(1);

      act(() => {
        result.current.onScrollBeginDrag();
        result.current.onMomentumScrollBegin();
        result.current.onTurnsLayout(layoutEvent(2200));
        result.current.onContentSizeChange(390, 2200);
      });

      expect(scrollToEnd).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['ios', 'android'] as const)(
    'follows the latest turn on %s after the user stops at the bottom',
    (os) => {
      Platform.OS = os;
      jest.useFakeTimers();
      const { result } = renderHook(() => usePinnedTranscriptScroll());
      const scrollToEnd = jest.fn();
      result.current.transcriptRef.current = { scrollToEnd } as unknown as ScrollView;

      act(() => {
        result.current.onLayout(layoutEvent(400));
        result.current.onTurnsLayout(layoutEvent(2000));
        result.current.onScrollBeginDrag();
        result.current.onTurnsLayout(layoutEvent(2100));
      });
      expect(scrollToEnd).toHaveBeenCalledTimes(1);

      act(() => {
        result.current.onMomentumScrollEnd();
      });
      expect(scrollToEnd).toHaveBeenCalledTimes(2);
    },
  );

  it('uses the drag-end idle timer when momentum does not follow', () => {
    Platform.OS = 'ios';
    jest.useFakeTimers();
    const { result } = renderHook(() => usePinnedTranscriptScroll());
    const scrollToEnd = jest.fn();
    result.current.transcriptRef.current = { scrollToEnd } as unknown as ScrollView;

    act(() => {
      result.current.onLayout(layoutEvent(400));
      result.current.onTurnsLayout(layoutEvent(2000));
      result.current.onScrollBeginDrag();
      result.current.onScrollEndDrag();
      result.current.onTurnsLayout(layoutEvent(2100));
    });
    expect(scrollToEnd).toHaveBeenCalledTimes(1);

    act(() => {
      jest.advanceTimersByTime(TRANSCRIPT_IDLE_MS);
    });
    expect(scrollToEnd).toHaveBeenCalledTimes(2);
  });

  it('ignores programmatic scroll so follow-latest does not unpin itself', () => {
    Platform.OS = 'ios';
    jest.useFakeTimers();
    const { result } = renderHook(() => usePinnedTranscriptScroll());
    const scrollToEnd = jest.fn();
    result.current.transcriptRef.current = { scrollToEnd } as unknown as ScrollView;

    act(() => {
      result.current.onLayout(layoutEvent(400));
      result.current.onTurnsLayout(layoutEvent(2000));
    });
    expect(scrollToEnd).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.onScroll(
        scrollEvent({ contentHeight: 2000, offsetY: 0, viewportHeight: 400 }),
      );
      result.current.onTurnsLayout(layoutEvent(2100));
    });
    expect(scrollToEnd).toHaveBeenCalledTimes(2);
  });
});
