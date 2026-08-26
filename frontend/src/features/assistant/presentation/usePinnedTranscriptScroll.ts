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

export function usePinnedTranscriptScroll() {
  const transcriptRef = useRef<ScrollView>(null);
  const pinnedRef = useRef(true);
  const interactingRef = useRef(false);
  const ignoreProgrammaticScrollRef = useRef(false);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ignoreTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  const clearIgnoreTimer = () => {
    if (ignoreTimerRef.current === null) {
      return;
    }
    clearTimeout(ignoreTimerRef.current);
    ignoreTimerRef.current = null;
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
    ignoreProgrammaticScrollRef.current = true;
    transcriptRef.current?.scrollToEnd({ animated: true });
    clearIgnoreTimer();
    ignoreTimerRef.current = setTimeout(() => {
      ignoreProgrammaticScrollRef.current = false;
      ignoreTimerRef.current = null;
    }, TRANSCRIPT_IDLE_MS);
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
      clearIgnoreTimer();
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

  const onScrollBeginDrag = () => {
    markInteracting();
  };

  const onScrollEndDrag = () => {
    clearIdleTimer();
    idleTimerRef.current = setTimeout(markIdle, TRANSCRIPT_IDLE_MS);
  };

  const onMomentumScrollBegin = () => {
    markInteracting();
  };

  const onMomentumScrollEnd = () => {
    clearIdleTimer();
    markIdle();
  };

  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    viewportHeightRef.current = layoutMeasurement.height;
    if (ignoreProgrammaticScrollRef.current) {
      return;
    }
    pinnedRef.current = isPinnedToBottom({
      contentHeight: contentSize.height,
      offsetY: contentOffset.y,
      viewportHeight: layoutMeasurement.height,
    });
  };

  const onContentSizeChange = (_width: number, _height: number) => {
    followLatestIfPinned();
  };

  return {
    onContentSizeChange,
    onLayout,
    onMomentumScrollBegin,
    onMomentumScrollEnd,
    onScroll,
    onScrollBeginDrag,
    onScrollEndDrag,
    onTurnsLayout,
    topSpacer,
    transcriptRef,
  };
}
