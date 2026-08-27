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

  // scrollToLatest 用双重 requestAnimationFrame 延后两帧，测试里把这两帧走完。
  function flushFrames() {
    act(() => {
      jest.advanceTimersByTime(40);
    });
  }

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
    jest.useFakeTimers();
    const { result } = renderHook(() => usePinnedTranscriptScroll());
    const scrollToEnd = jest.fn();
    result.current.transcriptRef.current = { scrollToEnd } as unknown as ScrollView;

    act(() => {
      result.current.onLayout(layoutEvent(400));
      result.current.onTurnsLayout(layoutEvent(2000));
    });
    flushFrames();

    expect(result.current.topSpacer).toBe(0);
    expect(scrollToEnd).toHaveBeenCalledWith({ animated: false });
  });

  it('does not follow the latest turn after the user scrolls up and stops away from the bottom', () => {
    jest.useFakeTimers();
    const { result } = renderHook(() => usePinnedTranscriptScroll());
    const scrollToEnd = jest.fn();
    result.current.transcriptRef.current = { scrollToEnd } as unknown as ScrollView;

    act(() => {
      result.current.onLayout(layoutEvent(400));
      result.current.onTurnsLayout(layoutEvent(2000));
    });
    flushFrames();
    expect(scrollToEnd).toHaveBeenCalledTimes(1);

    // 用户上滑到顶部附近放手：贴底标记必须在手势结束时按真实位置重新判定，
    // 之后新内容不能再把列表拽回底部。
    act(() => {
      result.current.onScrollBeginDrag();
      result.current.onScrollEndDrag(
        scrollEvent({ contentHeight: 2000, offsetY: 0, viewportHeight: 400 }),
      );
      jest.advanceTimersByTime(TRANSCRIPT_IDLE_MS);
    });
    expect(scrollToEnd).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.onTurnsLayout(layoutEvent(2200));
      result.current.onContentSizeChange(390, 2200);
    });
    flushFrames();

    expect(scrollToEnd).toHaveBeenCalledTimes(1);
  });

  it('keeps following while the user is mid-drag even if content grows', () => {
    jest.useFakeTimers();
    const { result } = renderHook(() => usePinnedTranscriptScroll());
    const scrollToEnd = jest.fn();
    result.current.transcriptRef.current = { scrollToEnd } as unknown as ScrollView;

    act(() => {
      result.current.onLayout(layoutEvent(400));
      result.current.onTurnsLayout(layoutEvent(2000));
    });
    flushFrames();
    expect(scrollToEnd).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.onScrollBeginDrag();
      result.current.onTurnsLayout(layoutEvent(2200));
      result.current.onContentSizeChange(390, 2200);
    });
    flushFrames();

    // 拖动中不抢滚动：不自动跳底。
    expect(scrollToEnd).toHaveBeenCalledTimes(1);
  });

  it('cancels a queued scroll-to-bottom if the user starts dragging before it fires', () => {
    // 改前回归：onContentSizeChange 排队的 scrollToEnd() 隔着两帧才执行，
    // 执行前不会复查 interactingRef——如果用户在这两帧之内按下手指开始拖动，
    // 排队的那次跳底照样会在拖动中途把内容摁回最下面。流式出字期间
    // onContentSizeChange 触发得很密集，这个窗口几乎连续重开，体感就是
    // "流式输出时完全无法上拉"。
    jest.useFakeTimers();
    const { result } = renderHook(() => usePinnedTranscriptScroll());
    const scrollToEnd = jest.fn();
    result.current.transcriptRef.current = { scrollToEnd } as unknown as ScrollView;

    act(() => {
      result.current.onLayout(layoutEvent(400));
      result.current.onTurnsLayout(layoutEvent(2000));
    });
    flushFrames();
    expect(scrollToEnd).toHaveBeenCalledTimes(1);
    scrollToEnd.mockClear();

    act(() => {
      // 流式吐字触发一次内容增长：排队一次跳底（两帧后才执行）。
      result.current.onTurnsLayout(layoutEvent(2200));
      result.current.onContentSizeChange(390, 2200);
      // 排队好的跳底还没执行，用户已经按下手指开始上拉。
      result.current.onScrollBeginDrag();
    });
    flushFrames();

    expect(scrollToEnd).not.toHaveBeenCalled();
  });

  it('follows the latest turn on content size change while still pinned', () => {
    jest.useFakeTimers();
    const { result } = renderHook(() => usePinnedTranscriptScroll());
    const scrollToEnd = jest.fn();
    result.current.transcriptRef.current = { scrollToEnd } as unknown as ScrollView;

    act(() => {
      result.current.onLayout(layoutEvent(400));
      result.current.onTurnsLayout(layoutEvent(2000));
    });
    flushFrames();
    scrollToEnd.mockClear();

    act(() => {
      result.current.onContentSizeChange(390, 2100);
    });
    flushFrames();

    expect(scrollToEnd).toHaveBeenCalledWith({ animated: false });
  });

  it.each(['ios', 'android'] as const)(
    'does not steal an upward drag on %s before the first onScroll',
    (os) => {
      Platform.OS = os;
      jest.useFakeTimers();
      const { result } = renderHook(() => usePinnedTranscriptScroll());
      const scrollToEnd = jest.fn();
      result.current.transcriptRef.current = { scrollToEnd } as unknown as ScrollView;

      act(() => {
        result.current.onLayout(layoutEvent(400));
        result.current.onTurnsLayout(layoutEvent(2000));
      });
      flushFrames();
      expect(scrollToEnd).toHaveBeenCalledTimes(1);

      act(() => {
        result.current.onScrollBeginDrag();
        result.current.onMomentumScrollBegin();
        result.current.onTurnsLayout(layoutEvent(2200));
        result.current.onContentSizeChange(390, 2200);
      });
      flushFrames();

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
      });
      flushFrames();
      expect(scrollToEnd).toHaveBeenCalledTimes(1);
      scrollToEnd.mockClear();

      act(() => {
        result.current.onScrollBeginDrag();
        result.current.onTurnsLayout(layoutEvent(2100));
      });
      flushFrames();
      // 拖动期间内容继续长高也不抢滚动。
      expect(scrollToEnd).not.toHaveBeenCalled();

      act(() => {
        result.current.onMomentumScrollEnd(
          scrollEvent({ contentHeight: 2100, offsetY: 1700, viewportHeight: 400 }),
        );
      });
      flushFrames();
      // 惯性滚动停在底部附近：贴底，恢复跟随并补跳到底部。
      expect(scrollToEnd).toHaveBeenCalledTimes(1);
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
    });
    flushFrames();
    expect(scrollToEnd).toHaveBeenCalledTimes(1);
    scrollToEnd.mockClear();

    act(() => {
      result.current.onScrollBeginDrag();
      result.current.onScrollEndDrag(
        scrollEvent({ contentHeight: 2000, offsetY: 1600, viewportHeight: 400 }),
      );
      result.current.onTurnsLayout(layoutEvent(2100));
    });
    flushFrames();
    expect(scrollToEnd).not.toHaveBeenCalled();

    // 放手 180ms 后兜底恢复跟随：idle 计时器 + 双重 rAF 都要走完。
    act(() => {
      jest.advanceTimersByTime(TRANSCRIPT_IDLE_MS);
    });
    flushFrames();
    expect(scrollToEnd).toHaveBeenCalledTimes(1);
  });

  it('does not unpin itself: programmatic content growth keeps following while pinned', () => {
    // 改前回归：程序化 scrollToEnd 产生的 onScroll 事件被当成"用户滑走"，
    // pinnedRef 被置 false，之后新内容再也不自动跟随。现在贴底只在真实手势
    // 结束时判定，程序化增长不会改变贴底状态。
    jest.useFakeTimers();
    const { result } = renderHook(() => usePinnedTranscriptScroll());
    const scrollToEnd = jest.fn();
    result.current.transcriptRef.current = { scrollToEnd } as unknown as ScrollView;

    act(() => {
      result.current.onLayout(layoutEvent(400));
      result.current.onTurnsLayout(layoutEvent(2000));
    });
    flushFrames();
    expect(scrollToEnd).toHaveBeenCalledTimes(1);
    scrollToEnd.mockClear();

    act(() => {
      result.current.onTurnsLayout(layoutEvent(2200));
      result.current.onContentSizeChange(390, 2200);
    });
    flushFrames();
    // 贴底状态没有被程序化增长改掉：内容一变高就继续跳底。
    expect(scrollToEnd).toHaveBeenCalledTimes(2);
    scrollToEnd.mockClear();

    act(() => {
      result.current.onTurnsLayout(layoutEvent(2400));
      result.current.onContentSizeChange(390, 2400);
    });
    flushFrames();
    expect(scrollToEnd).toHaveBeenCalledTimes(2);
  });
});
