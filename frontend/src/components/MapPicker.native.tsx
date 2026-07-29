import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import { WebView, WebViewMessageEvent } from 'react-native-webview';

import { BaiduMapBridgeMessage, buildBaiduMapDocument } from './BaiduMapWebView';
import { BAIDU_MAP_AK, createCoordinateLocation } from './MapPicker.services';
import { mapPickerStyles as styles } from './MapPicker.styles';
import { MapPickerOverlay } from './MapPickerOverlay';
import type { MapLocation, MapPickerProps } from './MapPicker.types';

const SEARCH_TIMEOUT_MS = 8000;

type PendingSearch = {
  reject: (error: Error) => void;
  resolve: (locations: MapLocation[]) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export function MapPicker({ initialLocation, onCancel, onConfirm }: MapPickerProps) {
  const webViewRef = useRef<WebView>(null);
  const pendingSearchRef = useRef<PendingSearch | null>(null);
  const [selection, setSelection] = useState<MapLocation | null>(initialLocation);
  const [locating, setLocating] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [mapError, setMapError] = useState<string | null>(
    BAIDU_MAP_AK ? null : '缺少百度地图浏览器端密钥，请完成地图服务配置。',
  );
  const document = useMemo(
    () => buildBaiduMapDocument(BAIDU_MAP_AK, initialLocation),
    [initialLocation],
  );

  useEffect(() => {
    return () => {
      if (pendingSearchRef.current) {
        clearTimeout(pendingSearchRef.current.timeout);
        pendingSearchRef.current = null;
      }
    };
  }, []);

  const failPendingSearch = useCallback((message: string) => {
    const pending = pendingSearchRef.current;
    if (!pending) return;
    clearTimeout(pending.timeout);
    pending.reject(new Error(message));
    pendingSearchRef.current = null;
  }, []);

  const handleMessage = useCallback(
    ({ nativeEvent }: WebViewMessageEvent) => {
      let message: BaiduMapBridgeMessage;
      try {
        message = JSON.parse(nativeEvent.data) as BaiduMapBridgeMessage;
      } catch {
        return;
      }

      if (message.type === 'map-ready') {
        setMapReady(true);
        setMapError(null);
        if (!initialLocation) {
          webViewRef.current?.injectJavaScript('window.__timeflowLocate(); true;');
        }
        return;
      }
      if (message.type === 'map-error') {
        setMapReady(false);
        setMapError(message.message);
        failPendingSearch(message.message);
        return;
      }
      if (message.type === 'selecting') {
        setLocationError(null);
        setSelection(createCoordinateLocation(message.latitude, message.longitude));
        setLocating(true);
        return;
      }
      if (message.type === 'selected') {
        setSelection(message.location);
        setLocating(false);
        setLocationError(null);
        return;
      }
      if (message.type === 'location-error') {
        setLocating(false);
        setLocationError(message.message);
        return;
      }
      if (message.type === 'search-results') {
        const pending = pendingSearchRef.current;
        if (!pending) return;
        clearTimeout(pending.timeout);
        pending.resolve(message.results);
        pendingSearchRef.current = null;
        return;
      }
      if (message.type === 'search-error') {
        failPendingSearch('Baidu place search failed');
      }
    },
    [failPendingSearch, initialLocation],
  );

  const searchLocations = useCallback(
    (query: string) => {
      return new Promise<MapLocation[]>((resolve, reject) => {
        if (!mapReady || !webViewRef.current) {
          reject(new Error('Baidu map is not ready'));
          return;
        }

        failPendingSearch('A newer search replaced this request');
        const timeout = setTimeout(() => {
          failPendingSearch('Baidu place search timed out');
        }, SEARCH_TIMEOUT_MS);
        pendingSearchRef.current = { reject, resolve, timeout };
        webViewRef.current.injectJavaScript(
          `window.__timeflowSearch(${JSON.stringify(query)}); true;`,
        );
      });
    },
    [failPendingSearch, mapReady],
  );

  const selectSearchResult = (location: MapLocation) => {
    setLocationError(null);
    setLocating(false);
    setSelection(location);
    webViewRef.current?.injectJavaScript(
      `window.__timeflowSelect(${location.longitude}, ${location.latitude}); true;`,
    );
  };

  const locateCurrentPosition = () => {
    setLocationError(null);
    setLocating(true);
    webViewRef.current?.injectJavaScript('window.__timeflowLocate(); true;');
  };

  return (
    <View style={styles.screen}>
      {BAIDU_MAP_AK ? (
        <WebView
          androidLayerType="hardware"
          domStorageEnabled
          geolocationEnabled
          javaScriptCanOpenWindowsAutomatically={false}
          javaScriptEnabled
          onError={() => {
            setMapReady(false);
            setMapError('地图加载失败，请检查网络或百度地图密钥配置。');
          }}
          onMessage={handleMessage}
          originWhitelist={['https://*']}
          ref={webViewRef}
          scrollEnabled={false}
          setSupportMultipleWindows={false}
          source={{ baseUrl: 'https://timeflow.local/', html: document }}
          style={styles.mapCanvas}
        />
      ) : (
        <View style={styles.mapCanvas} />
      )}
      <MapPickerOverlay
        locating={locating}
        locationError={locationError}
        mapError={mapError}
        mapReady={mapReady}
        onCancel={onCancel}
        onLocate={locateCurrentPosition}
        onConfirm={() => selection && onConfirm(selection)}
        onSearch={searchLocations}
        onSelectSearchResult={selectSearchResult}
        selection={selection}
      />
    </View>
  );
}
