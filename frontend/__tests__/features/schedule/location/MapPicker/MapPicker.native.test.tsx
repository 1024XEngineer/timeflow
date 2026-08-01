import { describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render, screen } from '@testing-library/react-native';

jest.mock('@/features/schedule/location/MapPicker/baidu', () => ({
  BAIDU_MAP_AK: 'test-ak',
  createCoordinateLocation: (latitude: number, longitude: number) => ({
    address: `坐标 ${latitude},${longitude}`,
    latitude,
    longitude,
  }),
  buildBaiduMapDocument: () => '<html></html>',
}));

jest.mock('@/features/schedule/location/MapPicker/Overlay', () => ({
  MapPickerOverlay: ({
    onCancel,
    onConfirm,
    onLocate,
    onSearch,
    mapReady,
    selection,
  }: {
    onCancel: () => void;
    onConfirm: () => void;
    onLocate: () => void;
    onSearch: (query: string) => Promise<unknown>;
    mapReady: boolean;
    selection: { address: string } | null;
  }) => {
    const { Pressable, Text } = require('react-native');
    return (
      <>
        <Text>{mapReady ? 'ready' : 'loading'}</Text>
        <Text>{selection?.address ?? 'no-selection'}</Text>
        <Pressable accessibilityLabel="mock-cancel" onPress={onCancel}>
          <Text>cancel</Text>
        </Pressable>
        <Pressable accessibilityLabel="mock-confirm" onPress={onConfirm}>
          <Text>confirm</Text>
        </Pressable>
        <Pressable accessibilityLabel="mock-locate" onPress={onLocate}>
          <Text>locate</Text>
        </Pressable>
        <Pressable
          accessibilityLabel="mock-search"
          onPress={() => {
            void onSearch('外滩');
          }}
        >
          <Text>search</Text>
        </Pressable>
      </>
    );
  },
}));

import { MapPicker } from '@/features/schedule/location/MapPicker/MapPicker.native';

describe('MapPicker.native', () => {
  it('handles bridge messages and confirms the selection', async () => {
    const onConfirm = jest.fn();
    const onCancel = jest.fn();
    const { UNSAFE_getByType } = render(
      <MapPicker initialLocation={null} onCancel={onCancel} onConfirm={onConfirm} />,
    );

    const WebView = require('react-native-webview').WebView;
    const webview = UNSAFE_getByType(WebView);

    await act(async () => {
      webview.props.onMessage({
        nativeEvent: { data: JSON.stringify({ type: 'map-ready' }) },
      });
    });
    expect(screen.getByText('ready')).toBeTruthy();

    await act(async () => {
      webview.props.onMessage({
        nativeEvent: {
          data: JSON.stringify({ type: 'selecting', latitude: 31.2, longitude: 121.5 }),
        },
      });
    });
    expect(screen.getByText('坐标 31.2,121.5')).toBeTruthy();

    await act(async () => {
      webview.props.onMessage({
        nativeEvent: {
          data: JSON.stringify({
            type: 'selected',
            location: { address: '外滩', latitude: 31.2, longitude: 121.5 },
          }),
        },
      });
    });
    expect(screen.getByText('外滩')).toBeTruthy();

    fireEvent.press(screen.getByLabelText('mock-confirm'));
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ address: '外滩' }));
    fireEvent.press(screen.getByLabelText('mock-cancel'));
    expect(onCancel).toHaveBeenCalled();
  });

  it('surfaces map errors from the bridge', async () => {
    const { UNSAFE_getByType } = render(
      <MapPicker initialLocation={null} onCancel={jest.fn()} onConfirm={jest.fn()} />,
    );
    const WebView = require('react-native-webview').WebView;
    const webview = UNSAFE_getByType(WebView);
    await act(async () => {
      webview.props.onMessage({
        nativeEvent: { data: JSON.stringify({ type: 'map-error', message: '坏了' }) },
      });
    });
    expect(screen.getByText('loading')).toBeTruthy();
  });

  it('handles location errors from the bridge', async () => {
    const { UNSAFE_getByType } = render(
      <MapPicker
        initialLocation={{ address: '初始', latitude: 31, longitude: 121 }}
        onCancel={jest.fn()}
        onConfirm={jest.fn()}
      />,
    );
    const WebView = require('react-native-webview').WebView;
    const webview = UNSAFE_getByType(WebView);

    await act(async () => {
      webview.props.onMessage({
        nativeEvent: { data: JSON.stringify({ type: 'map-ready' }) },
      });
    });

    await act(async () => {
      webview.props.onMessage({
        nativeEvent: {
          data: JSON.stringify({ type: 'location-error', message: '无定位' }),
        },
      });
    });

    fireEvent.press(screen.getByLabelText('mock-locate'));

    await act(async () => {
      webview.props.onMessage({ nativeEvent: { data: 'not-json' } });
    });
  });
});
