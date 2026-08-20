import { useEffect, useState } from 'react';
import { Dimensions, Keyboard, Platform, type KeyboardEvent } from 'react-native';

export type VisualViewportLike = {
  addEventListener: (type: string, listener: () => void) => void;
  height: number;
  offsetTop: number;
  removeEventListener: (type: string, listener: () => void) => void;
};

export function imeOverlapFromKeyboardFrame(windowHeight: number, keyboardScreenY: number): number {
  return Math.max(0, Math.round(windowHeight - keyboardScreenY));
}

function overlapFromEvent(event: KeyboardEvent): number {
  return imeOverlapFromKeyboardFrame(Dimensions.get('window').height, event.endCoordinates.screenY);
}

export function subscribeWebVisualViewport(
  onOverlap: (overlap: number) => void,
  viewport: VisualViewportLike | null = typeof window === 'undefined'
    ? null
    : window.visualViewport,
  layoutHeight: () => number = () => window.innerHeight,
): () => void {
  if (!viewport) {
    return () => {};
  }

  const update = () => {
    const overlap = Math.max(0, Math.round(layoutHeight() - viewport.height - viewport.offsetTop));
    onOverlap(overlap);
  };

  viewport.addEventListener('resize', update);
  viewport.addEventListener('scroll', update);
  update();
  return () => {
    viewport.removeEventListener('resize', update);
    viewport.removeEventListener('scroll', update);
  };
}

export function useImeOverlap(): number {
  const [overlap, setOverlap] = useState(0);

  useEffect(() => {
    if (Platform.OS === 'web') {
      return subscribeWebVisualViewport(setOverlap);
    }

    const onFrame = (event: KeyboardEvent) => {
      Keyboard.scheduleLayoutAnimation(event);
      setOverlap(overlapFromEvent(event));
    };

    const subscriptions =
      Platform.OS === 'ios'
        ? [Keyboard.addListener('keyboardWillChangeFrame', onFrame)]
        : [
            Keyboard.addListener('keyboardDidShow', onFrame),
            Keyboard.addListener('keyboardDidHide', onFrame),
            Keyboard.addListener('keyboardDidChangeFrame', onFrame),
          ];

    return () => {
      for (const subscription of subscriptions) {
        subscription.remove();
      }
    };
  }, []);

  return overlap;
}
