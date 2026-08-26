import { useRef, useState } from 'react';
import type {
  LayoutChangeEvent,
  NativeScrollEvent,
  NativeSyntheticEvent,
  ScrollView,
} from 'react-native';

export const PINNED_TO_BOTTOM_THRESHOLD = 80;

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
  const viewportHeightRef = useRef(0);
  const turnsHeightRef = useRef(0);
  const [topSpacer, setTopSpacer] = useState(0);

  const syncSpacer = () => {
    const next = topSpacerHeight(viewportHeightRef.current, turnsHeightRef.current);
    setTopSpacer((current) => (current === next ? current : next));
  };

  const followLatestIfPinned = () => {
    if (viewportHeightRef.current <= 0 || turnsHeightRef.current <= viewportHeightRef.current) {
      return;
    }
    if (pinnedRef.current) {
      transcriptRef.current?.scrollToEnd({ animated: true });
    }
  };

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

  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    viewportHeightRef.current = layoutMeasurement.height;
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
    onScroll,
    onTurnsLayout,
    topSpacer,
    transcriptRef,
  };
}
