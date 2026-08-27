import { useEffect, useRef, useState } from 'react';
import type {
  LayoutChangeEvent,
  NativeScrollEvent,
  NativeSyntheticEvent,
  ScrollView,
} from 'react-native';

export const PINNED_TO_BOTTOM_THRESHOLD = 80;
export const TRANSCRIPT_IDLE_MS = 180;

export function topSpacerHeight(viewportHeight: number, turnsHeight: number): number {
  // ScrollView 的 justifyContent:'flex-end' 在内容超出视口时会把子节点上下排反，
  // 短对白改用顶部空白把气泡顶到声纹球上方。
  if (viewportHeight <= 0) {
    return 0;
  }
  return Math.max(0, viewportHeight - turnsHeight);
}

export function isPinnedToBottom({
  contentHeight,
  offsetY,
  viewportHeight,
  threshold = PINNED_TO_BOTTOM_THRESHOLD,
}: {
  contentHeight: number;
  offsetY: number;
  viewportHeight: number;
  threshold?: number;
}): boolean {
  const distanceFromBottom = contentHeight - viewportHeight - offsetY;
  return distanceFromBottom <= threshold;
}

/**
 * 对白列表的贴底滚动：
 * - 短对白靠顶部空白（topSpacer）贴在声纹球上方，不滚动；
 * - 超出一屏后，只要用户还贴在底部附近，新内容一到就跳到底部；
 * - "是否贴底"只在真实手势结束时重新判定（onScrollEndDrag /
 *   onMomentumScrollEnd），绝不从 onScroll 里判——程序化 scrollToEnd 也会
 *   触发 onScroll，从那儿判会把我们自己的滚动误认成用户滑走，列表从此不再
 *   自动跟随（改前实测：流式出字途中停摆，新句子被压到屏幕外）。
 * - 拖动开始到手势结束期间（interacting）不抢滚动，放手后若还在底部再补跳；
 * - 跳底用 animated:false：流式出字很密集，动画滚动会跟下一次内容变化互相
 *   打断，看起来像卡住不动。
 */
export function usePinnedTranscriptScroll() {
  const transcriptRef = useRef<ScrollView>(null);
  const pinnedRef = useRef(true);
  const interactingRef = useRef(false);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const viewportHeightRef = useRef(0);
  const turnsHeightRef = useRef(0);
  const [topSpacer, setTopSpacer] = useState(0);

  const syncSpacer = () => {
    const next = topSpacerHeight(viewportHeightRef.current, turnsHeightRef.current);
    setTopSpacer((current) => (current === next ? current : next));
  };

  const clearIdleTimer = () => {
    if (idleTimerRef.current == null) {
      return;
    }
    clearTimeout(idleTimerRef.current);
    idleTimerRef.current = null;
  };

  const scrollToLatest = () => {
    // Android 上 onContentSizeChange 触发时原生 ScrollView 有时还没把新内容
    // 高度提交完，直接跳会落不到底；延后两帧再跳。用 animated:false 而不是
    // 动画滚动——流式出字很密集，动画会跟下一次内容变化互相打断，看起来
    // 像卡住不动。
    // 排队和执行隔着两帧，这两帧之间用户完全可能已经按下手指开始拖动——
    // followLatestIfPinned() 里的判断只在排队那一刻查过一次，执行前必须
    // 再查一遍，否则一次流式出字排的跳底会在用户已经在拖动时突然把内容
    // 摁回最下面（改前实测：流式输出期间完全无法上拉，看起来像强制贴底）。
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (interactingRef.current || !pinnedRef.current) {
          return;
        }
        transcriptRef.current?.scrollToEnd({ animated: false });
      });
    });
  };

  const followLatestIfPinned = () => {
    if (interactingRef.current) {
      return;
    }
    if (viewportHeightRef.current <= 0 || turnsHeightRef.current <= viewportHeightRef.current) {
      return;
    }
    if (!pinnedRef.current) {
      return;
    }
    scrollToLatest();
  };

  const markInteracting = () => {
    interactingRef.current = true;
    clearIdleTimer();
  };

  const markIdle = () => {
    interactingRef.current = false;
    followLatestIfPinned();
  };

  useEffect(() => {
    return () => {
      clearIdleTimer();
    };
  }, []);

  const onLayout = (event: LayoutChangeEvent) => {
    viewportHeightRef.current = event.nativeEvent.layout.height;
    syncSpacer();
    followLatestIfPinned();
  };

  const onTurnsLayout = (event: LayoutChangeEvent) => {
    turnsHeightRef.current = event.nativeEvent.layout.height;
    syncSpacer();
    followLatestIfPinned();
  };

  /** 只有真实手势的滚动事件才算数：拖动结束或惯性滚动结束时的位置决定贴不贴底。 */
  const settlePinFromEvent = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    pinnedRef.current = isPinnedToBottom({
      contentHeight: contentSize.height,
      offsetY: contentOffset.y,
      viewportHeight: layoutMeasurement.height,
    });
  };

  const onScrollBeginDrag = () => {
    markInteracting();
  };

  const onScrollEndDrag = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    settlePinFromEvent(event);
    clearIdleTimer();
    // Android 上放手不一定有惯性滚动（onMomentumScrollEnd 可能不来），用短延迟
    // 兜底恢复跟随；iOS 有惯性时 onMomentumScrollBegin 会先清掉这个计时器。
    idleTimerRef.current = setTimeout(markIdle, TRANSCRIPT_IDLE_MS);
  };

  const onMomentumScrollBegin = () => {
    markInteracting();
  };

  const onMomentumScrollEnd = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    settlePinFromEvent(event);
    clearIdleTimer();
    markIdle();
  };

  const onContentSizeChange = (_width: number, _height: number) => {
    followLatestIfPinned();
  };

  return {
    onContentSizeChange,
    onLayout,
    onMomentumScrollBegin,
    onMomentumScrollEnd,
    onScrollBeginDrag,
    onScrollEndDrag,
    onTurnsLayout,
    topSpacer,
    transcriptRef,
  };
}
