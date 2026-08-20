import { describe, expect, it, jest } from '@jest/globals';
import { act, renderHook } from '@testing-library/react-native';
import type {
  LayoutChangeEvent,
  NativeScrollEvent,
  NativeSyntheticEvent,
  ScrollView,
} from 'react-native';

import {
  PINNED_TO_BOTTOM_THRESHOLD,
  contentFitsViewport,
  isPinnedToBottom,
  usePinnedTranscriptScroll,
} from '../../../../../src/features/assistant/presentation/usePinnedTranscriptScroll';

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

describe('contentFitsViewport', () => {
  it('treats an unmeasured viewport as fitting', () => {
    expect(contentFitsViewport(800, 0)).toBe(true);
    expect(contentFitsViewport(800, -10)).toBe(true);
  });

  it('fits when content is within one pixel of the viewport', () => {
    expect(contentFitsViewport(400, 400)).toBe(true);
    expect(contentFitsViewport(401, 400)).toBe(true);
    expect(contentFitsViewport(402, 400)).toBe(false);
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
  it('keeps short content pinned to the dock and does not overflow', () => {
    const { result } = renderHook(() => usePinnedTranscriptScroll());
    const scrollToEnd = jest.fn();
    result.current.transcriptRef.current = { scrollToEnd } as unknown as ScrollView;

    act(() => {
      result.current.onLayout(layoutEvent(400));
      result.current.onContentSizeChange(390, 240);
    });

    expect(result.current.fitsViewport).toBe(true);
    expect(scrollToEnd).toHaveBeenCalledWith({ animated: true });
  });

  it('lets a tall transcript overflow so the user can scroll up', () => {
    const { result } = renderHook(() => usePinnedTranscriptScroll());

    act(() => {
      result.current.onLayout(layoutEvent(400));
      result.current.onContentSizeChange(390, 2000);
    });

    expect(result.current.fitsViewport).toBe(false);
  });

  it('does not yank the user back while they are reading earlier turns', () => {
    const { result } = renderHook(() => usePinnedTranscriptScroll());
    const scrollToEnd = jest.fn();
    result.current.transcriptRef.current = { scrollToEnd } as unknown as ScrollView;

    act(() => {
      result.current.onLayout(layoutEvent(400));
      result.current.onScroll(
        scrollEvent({ contentHeight: 2000, offsetY: 0, viewportHeight: 400 }),
      );
    });
    scrollToEnd.mockClear();

    act(() => {
      result.current.onContentSizeChange(390, 2200);
    });

    expect(scrollToEnd).not.toHaveBeenCalled();
    expect(result.current.fitsViewport).toBe(false);
  });

  it('resumes sticking to the latest turn after the user returns to the bottom', () => {
    const { result } = renderHook(() => usePinnedTranscriptScroll());
    const scrollToEnd = jest.fn();
    result.current.transcriptRef.current = { scrollToEnd } as unknown as ScrollView;

    act(() => {
      result.current.onScroll(
        scrollEvent({ contentHeight: 2000, offsetY: 0, viewportHeight: 400 }),
      );
      result.current.onContentSizeChange(390, 2000);
    });
    expect(scrollToEnd).not.toHaveBeenCalled();

    act(() => {
      result.current.onScroll(
        scrollEvent({ contentHeight: 2000, offsetY: 1600, viewportHeight: 400 }),
      );
      result.current.onContentSizeChange(390, 2100);
    });

    expect(scrollToEnd).toHaveBeenCalledWith({ animated: true });
  });
});
