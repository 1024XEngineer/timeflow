import { describe, expect, it, jest } from '@jest/globals';
import { act, renderHook } from '@testing-library/react-native';
import type { LayoutChangeEvent, ScrollView } from 'react-native';

import {
  contentFitsViewport,
  usePinnedTranscriptScroll,
} from '../../../../../src/features/assistant/presentation/usePinnedTranscriptScroll';

function layoutEvent(height: number): LayoutChangeEvent {
  return {
    nativeEvent: {
      layout: { height, width: 390, x: 0, y: 0 },
    },
  } as LayoutChangeEvent;
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
    const scrollToEnd = jest.fn();
    result.current.transcriptRef.current = { scrollToEnd } as unknown as ScrollView;

    act(() => {
      result.current.onLayout(layoutEvent(400));
      result.current.onContentSizeChange(390, 2000);
    });

    expect(result.current.fitsViewport).toBe(false);
    expect(scrollToEnd).toHaveBeenCalledWith({ animated: true });
  });
});
