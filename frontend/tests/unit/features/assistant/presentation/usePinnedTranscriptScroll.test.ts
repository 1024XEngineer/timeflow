import { describe, expect, it, jest } from '@jest/globals';
import { act, renderHook } from '@testing-library/react-native';
import type { LayoutChangeEvent, ScrollView } from 'react-native';

import {
  PINNED_TO_BOTTOM_THRESHOLD,
  isPinnedToBottom,
  topSpacerHeight,
  usePinnedTranscriptScroll,
} from '../../../../../src/features/assistant/presentation/usePinnedTranscriptScroll';

function layoutEvent(height: number): LayoutChangeEvent {
  return {
    nativeEvent: {
      layout: { height, width: 390, x: 0, y: 0 },
    },
  } as LayoutChangeEvent;
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
});
