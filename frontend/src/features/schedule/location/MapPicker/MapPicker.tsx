import { useCallback, useEffect, useRef, useState } from 'react';
import { load as loadBaiduMap } from '@baidumap/jsapi-loader';
import { View } from 'react-native';

import {
  BAIDU_MAP_AK,
  createCoordinateLocation,
  createReverseGeocodeGate,
  readablePoiAddress,
  SHANGHAI_CENTER,
} from './baidu';
import { MapPickerOverlay } from './Overlay';
import { mapPickerStyles as styles } from './styles';
import type { MapLocation, MapPickerProps } from './types';

const MAP_REQUEST_TIMEOUT_MS = 6000;
const MAP_LOAD_TIMEOUT_MS = 5000;
const MARKER_SVG = encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28"><circle cx="14" cy="14" r="11" fill="#D9F65A" stroke="#142821" stroke-width="4"/></svg>',
);

export function MapPicker({ initialLocation, onCancel, onConfirm }: MapPickerProps) {
  const mapHostRef = useRef<View>(null);
  const bmapRef = useRef<typeof BMap | null>(null);
  const mapRef = useRef<BMap.Map | null>(null);
  const markerRef = useRef<BMap.Marker | null>(null);
  const requestRef = useRef(0);
  const reverseGeocodeGateRef = useRef(createReverseGeocodeGate());
  const [selection, setSelection] = useState<MapLocation | null>(initialLocation);
  const [locating, setLocating] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [mapError, setMapError] = useState<string | null>(
    BAIDU_MAP_AK ? null : '缺少百度地图浏览器端密钥，请完成地图服务配置。',
  );

  const moveMarker = useCallback((location: MapLocation) => {
    const BMapApi = bmapRef.current;
    const map = mapRef.current;
    if (!BMapApi || !map) return;

    const point = new BMapApi.Point(location.longitude, location.latitude);
    if (markerRef.current) {
      markerRef.current.setPosition(point);
      return;
    }

    const icon = new BMapApi.Icon(
      `data:image/svg+xml;charset=utf-8,${MARKER_SVG}`,
      new BMapApi.Size(28, 28),
      { anchor: new BMapApi.Size(14, 14) },
    );
    markerRef.current = new BMapApi.Marker(point, { icon });
    map.addOverlay(markerRef.current);
  }, []);

  const selectCoordinates = useCallback(
    (latitude: number, longitude: number) => {
      const BMapApi = bmapRef.current;
      if (!BMapApi) return;

      const requestId = requestRef.current + 1;
      requestRef.current = requestId;
      const pendingLocation = createCoordinateLocation(latitude, longitude);

      setLocationError(null);
      setSelection(pendingLocation);
      moveMarker(pendingLocation);
      setLocating(true);

      reverseGeocodeGateRef.current.schedule({ latitude, longitude, requestId }, (job) => {
        if (requestRef.current !== job.requestId) return;

        return new Promise<void>((resolve) => {
          let completed = false;
          const finish = (address?: string) => {
            if (completed) {
              resolve();
              return;
            }
            completed = true;
            window.clearTimeout(timeout);
            if (requestRef.current === job.requestId) {
              if (address?.trim()) {
                setSelection({
                  ...createCoordinateLocation(job.latitude, job.longitude),
                  address: address.trim(),
                });
              }
              setLocating(false);
            }
            resolve();
          };

          const timeout = window.setTimeout(() => finish(), MAP_REQUEST_TIMEOUT_MS);
          const geocoder = new BMapApi.Geocoder({ language: 'zh-CN' });
          geocoder.getLocation(
            new BMapApi.Point(job.longitude, job.latitude),
            (result: BMap.GeocoderResult | null) => finish(result?.address),
          );
        });
      });
    },
    [moveMarker],
  );

  const locateCurrentPosition = useCallback(() => {
    const BMapApi = bmapRef.current;
    const map = mapRef.current;
    if (!BMapApi || !map) return;

    setLocationError(null);
    setLocating(true);
    const geolocation = new BMapApi.Geolocation();
    geolocation.getCurrentPosition(
      (result) => {
        if (geolocation.getStatus() !== 0 || !result?.point) {
          setLocating(false);
          setLocationError('无法获取当前位置，请允许定位权限后重试。');
          return;
        }

        map.setCenter(result.point, { noAnimation: false });
        map.setZoom(17, { noAnimation: false });
        selectCoordinates(result.point.lat, result.point.lng);
      },
      { enableHighAccuracy: true },
    );
  }, [selectCoordinates]);

  useEffect(() => {
    const host = mapHostRef.current as unknown as HTMLElement | null;
    if (!host) return;

    if (!BAIDU_MAP_AK) return;

    const reverseGeocodeGate = reverseGeocodeGateRef.current;
    let disposed = false;
    const loadTimeout = window.setTimeout(() => {
      if (!disposed) {
        setMapError('请在百度地图控制台为此 Key 开通 JavaScript API 服务后重试。');
      }
    }, MAP_LOAD_TIMEOUT_MS);

    void loadBaiduMap({
      ak: BAIDU_MAP_AK,
      globalConfig: { coordType: 'bd09ll' },
      timeout: 10000,
      version: '4.0',
    })
      .then((namespace: typeof BMap) => {
        if (disposed) return;
        window.clearTimeout(loadTimeout);

        const center = initialLocation ?? SHANGHAI_CENTER;
        const point = new namespace.Point(center.longitude, center.latitude);
        const map = new namespace.Map(host, {
          center: point,
          enablePinchZoom: true,
          enableWheelZoom: true,
          fixCenterWhenResize: true,
          zoom: initialLocation ? 17 : 14,
        });

        bmapRef.current = namespace;
        mapRef.current = map;
        if (initialLocation) moveMarker(initialLocation);
        map.addEventListener('click', (event) => {
          selectCoordinates(event.point.lat, event.point.lng);
        });
        setMapError(null);
        setMapReady(true);
        if (!initialLocation) locateCurrentPosition();
      })
      .catch(() => {
        if (!disposed) {
          window.clearTimeout(loadTimeout);
          setMapError('地图加载失败，请检查网络或百度地图密钥配置。');
        }
      });

    return () => {
      disposed = true;
      window.clearTimeout(loadTimeout);
      reverseGeocodeGate.clear();
      requestRef.current += 1;
      markerRef.current = null;
      const map = mapRef.current;
      if (map) {
        try {
          const destroy = (map as unknown as { destroy?: () => void }).destroy;
          if (typeof destroy === 'function') {
            destroy.call(map);
          } else {
            (map as unknown as { clearOverlays?: () => void }).clearOverlays?.();
          }
        } catch {
          // Baidu may have already torn down the map while the overlay closes.
        }
      }
      mapRef.current = null;
      bmapRef.current = null;
    };
  }, [initialLocation, locateCurrentPosition, moveMarker, selectCoordinates]);

  const searchLocations = useCallback((query: string) => {
    return new Promise<MapLocation[]>((resolve, reject) => {
      const BMapApi = bmapRef.current;
      const map = mapRef.current;
      if (!BMapApi || !map) {
        reject(new Error('Baidu map is not ready'));
        return;
      }

      let completed = false;
      const finish = (locations?: MapLocation[]) => {
        if (completed) return;
        completed = true;
        window.clearTimeout(timeout);
        if (locations) resolve(locations);
        else reject(new Error('Baidu place search failed'));
      };
      const timeout = window.setTimeout(() => finish(), MAP_REQUEST_TIMEOUT_MS);
      const localSearch = new BMapApi.LocalSearch(map, {
        onSearchComplete: (rawResults) => {
          const result = Array.isArray(rawResults) ? rawResults[0] : rawResults;
          if (!result) {
            finish([]);
            return;
          }

          const locations: MapLocation[] = [];
          const count = Math.min(result.getCurrentNumPois(), 5);
          for (let index = 0; index < count; index += 1) {
            const poi = result.getPoi(index);
            if (!poi?.point) continue;
            locations.push({
              address: readablePoiAddress(poi.title, poi.address),
              latitude: poi.point.lat,
              longitude: poi.point.lng,
            });
          }
          finish(locations);
        },
        pageCapacity: 5,
        renderOptions: { autoViewport: false },
      });
      localSearch.search(query);
    });
  }, []);

  const selectSearchResult = (location: MapLocation) => {
    const BMapApi = bmapRef.current;
    const map = mapRef.current;
    if (!BMapApi || !map) return;

    setLocationError(null);
    reverseGeocodeGateRef.current.clear();
    requestRef.current += 1;
    setLocating(false);
    setSelection(location);
    moveMarker(location);
    map.setCenter(new BMapApi.Point(location.longitude, location.latitude), { noAnimation: false });
    map.setZoom(17, { noAnimation: false });
  };

  return (
    <View style={styles.screen}>
      <View ref={mapHostRef} style={styles.mapCanvas} />
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
