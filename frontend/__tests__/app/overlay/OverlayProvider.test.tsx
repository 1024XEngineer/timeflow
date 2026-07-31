import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { StrictMode } from 'react';
import { Pressable, Text, View } from 'react-native';

import { OverlayProvider, useOverlay, type OverlayKind } from '@/app/overlay/OverlayProvider';

function Harness({ onClose }: { onClose: () => void }) {
  const { pop, popKind, push, stack } = useOverlay();

  const add = (kind: OverlayKind) => {
    push({ kind, onClose });
  };

  return (
    <>
      <Text>{stack.map((entry) => entry.kind).join(',')}</Text>
      <View>
        <Pressable accessibilityLabel="push-standard" onPress={() => add('standardCreate')} />
        <Pressable accessibilityLabel="push-assistant" onPress={() => add('assistant')} />
        <Pressable accessibilityLabel="pop" onPress={pop} />
        <Pressable accessibilityLabel="pop-standard" onPress={() => popKind('standardCreate')} />
      </View>
    </>
  );
}

function renderHarness(onClose: () => void) {
  return render(
    <StrictMode>
      <OverlayProvider>
        <Harness onClose={onClose} />
      </OverlayProvider>
    </StrictMode>,
  );
}

describe('OverlayProvider', () => {
  it('invokes onClose once when the top overlay is popped', () => {
    const onClose = jest.fn();
    renderHarness(onClose);

    fireEvent.press(screen.getByLabelText('push-standard'));
    fireEvent.press(screen.getByLabelText('pop'));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('removes and closes only the latest matching overlay', () => {
    const onClose = jest.fn();
    renderHarness(onClose);

    fireEvent.press(screen.getByLabelText('push-standard'));
    fireEvent.press(screen.getByLabelText('push-assistant'));
    fireEvent.press(screen.getByLabelText('push-standard'));
    fireEvent.press(screen.getByLabelText('pop-standard'));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.getByText('standardCreate,assistant')).toBeTruthy();
  });
});
