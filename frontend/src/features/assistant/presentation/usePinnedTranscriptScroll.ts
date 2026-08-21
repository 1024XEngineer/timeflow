import { useRef, useState } from 'react';
import type {
  LayoutChangeEvent,
  NativeScrollEvent,
  NativeSyntheticEvent,
  ScrollView,
} from 'react-native';

export const PINNED_TO_BOTTOM_THRESHOLD = 80;

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
  const pinnedRef = useRef(true);
  const viewportHeightRef = useRef(0);
  const contentHeightRef = useRef(0);
  const [fitsViewport, setFitsViewport] = useState(true);

  const syncFits = () => {
    const fits = contentFitsViewport(contentHeightRef.current, viewportHeightRef.current);
    setFitsViewport((current) => (current === fits ? current : fits));
  };

  const onLayout = (event: LayoutChangeEvent) => {
    viewportHeightRef.current = event.nativeEvent.layout.height;
    syncFits();
  };

  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    viewportHeightRef.current = layoutMeasurement.height;
    contentHeightRef.current = contentSize.height;
    pinnedRef.current = isPinnedToBottom({
      contentHeight: contentSize.height,
      offsetY: contentOffset.y,
      viewportHeight: layoutMeasurement.height,
    });
  };

  const onContentSizeChange = (_width: number, height: number) => {
    contentHeightRef.current = height;
    syncFits();
    if (pinnedRef.current) {
      transcriptRef.current?.scrollToEnd({ animated: true });
    }
  };

  return {
    fitsViewport,
    onContentSizeChange,
    onLayout,
    onScroll,
    transcriptRef,
  };
}
