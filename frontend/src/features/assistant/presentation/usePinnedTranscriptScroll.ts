import { useEffect, useRef, useState } from 'react';
import {
  Platform,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollView,
} from 'react-native';

export const PINNED_TO_BOTTOM_THRESHOLD = 80;
export const TRANSCRIPT_IDLE_MS = 180;

export function contentFitsViewport(contentHeight: number, viewportHeight: number): boolean {
  if (viewportHeight <= 0) {
    return true;
  }
  return contentHeight <= viewportHeight + 1;
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
  const interactingRef = useRef(false);
  const ignoreProgrammaticScrollRef = useRef(false);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ignoreTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const viewportHeightRef = useRef(0);
  const contentHeightRef = useRef(0);
  const [fitsViewport, setFitsViewport] = useState(true);

  const syncFits = () => {
    const fits = contentFitsViewport(contentHeightRef.current, viewportHeightRef.current);
    setFitsViewport((current) => (current === fits ? current : fits));
  };

  const clearIdleTimer = () => {
    if (idleTimerRef.current === null) {
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

  const followLatest = () => {
    if (interactingRef.current) {
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
    followLatest();
  };

  useEffect(() => {
    return () => {
      clearIdleTimer();
      clearIgnoreTimer();
    };
  }, []);

  const onLayout = (event: LayoutChangeEvent) => {
    viewportHeightRef.current = event.nativeEvent.layout.height;
    syncFits();
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
    const { contentSize, layoutMeasurement } = event.nativeEvent;
    viewportHeightRef.current = layoutMeasurement.height;
    contentHeightRef.current = contentSize.height;
    if (ignoreProgrammaticScrollRef.current) {
      return;
    }
    if (Platform.OS === 'web') {
      markInteracting();
      idleTimerRef.current = setTimeout(markIdle, TRANSCRIPT_IDLE_MS);
    }
  };

  const onContentSizeChange = (_width: number, height: number) => {
    contentHeightRef.current = height;
    syncFits();
    followLatest();
  };

  return {
    fitsViewport,
    onContentSizeChange,
    onLayout,
    onMomentumScrollBegin,
    onMomentumScrollEnd,
    onScroll,
    onScrollBeginDrag,
    onScrollEndDrag,
    transcriptRef,
  };
}
