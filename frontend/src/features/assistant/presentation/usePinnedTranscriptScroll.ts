import { useRef, useState } from 'react';
import type { LayoutChangeEvent, ScrollView } from 'react-native';

export function contentFitsViewport(contentHeight: number, viewportHeight: number): boolean {
  if (viewportHeight <= 0) {
    return true;
  }
  return contentHeight <= viewportHeight + 1;
}

export function usePinnedTranscriptScroll() {
  const transcriptRef = useRef<ScrollView>(null);
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

  const onContentSizeChange = (_width: number, height: number) => {
    contentHeightRef.current = height;
    syncFits();
    transcriptRef.current?.scrollToEnd({ animated: true });
  };

  return {
    fitsViewport,
    onContentSizeChange,
    onLayout,
    transcriptRef,
  };
}
