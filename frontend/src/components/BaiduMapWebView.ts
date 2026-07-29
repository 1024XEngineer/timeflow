import type { MapLocation } from './MapPicker.types';

export type BaiduMapBridgeMessage =
  | { type: 'map-ready' }
  | { message: string; type: 'map-error' }
  | { latitude: number; longitude: number; type: 'selecting' }
  | { location: MapLocation; type: 'selected' }
  | { message: string; type: 'location-error' }
  | { results: MapLocation[]; type: 'search-results' }
  | { type: 'search-error' };

export function buildBaiduMapDocument(ak: string, initialLocation: MapLocation | null) {
  const center = initialLocation ?? {
    address: '上海市 · 默认地图中心',
    latitude: 31.236305,
    longitude: 121.480237,
  };
  const initialJson = JSON.stringify(initialLocation);
  const centerJson = JSON.stringify(center);

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no" />
    <style>
      html, body, #map { width: 100%; height: 100%; margin: 0; overflow: hidden; }
      body { background: #dce3dc; }
    </style>
    <script src="https://api.map.baidu.com/api?v=4.0&ak=${encodeURIComponent(ak)}"></script>
  </head>
  <body>
    <div id="map"></div>
    <script>
      (function () {
        var bridge = window.ReactNativeWebView;
        var center = ${centerJson};
        var initialLocation = ${initialJson};

        function emit(payload) {
          if (bridge) bridge.postMessage(JSON.stringify(payload));
        }

        function fallbackAddress(point) {
          return '百度地图选点 · ' + point.lat.toFixed(5) + ', ' + point.lng.toFixed(5);
        }

        try {
          if (!window.BMap) throw new Error('Baidu JSAPI did not load');

          window.BMap.coordType = 'bd09ll';
          var centerPoint = new BMap.Point(center.longitude, center.latitude);
          var map = new BMap.Map('map', {
            center: centerPoint,
            enablePinchZoom: true,
            enableWheelZoom: true,
            fixCenterWhenResize: true,
            zoom: initialLocation ? 17 : 14
          });
          var marker = null;
          var markerSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28"><circle cx="14" cy="14" r="11" fill="#D9F65A" stroke="#142821" stroke-width="4"/></svg>';
          var markerIcon = new BMap.Icon(
            'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(markerSvg),
            new BMap.Size(28, 28),
            { anchor: new BMap.Size(14, 14) }
          );
          var geocoder = new BMap.Geocoder({ language: 'zh-CN' });

          function placeMarker(point) {
            if (marker) {
              marker.setPosition(point);
            } else {
              marker = new BMap.Marker(point, { icon: markerIcon });
              map.addOverlay(marker);
            }
          }

          function selectPoint(point) {
            var finished = false;
            placeMarker(point);
            emit({ type: 'selecting', latitude: point.lat, longitude: point.lng });

            var timeout = setTimeout(function () {
              if (finished) return;
              finished = true;
              emit({
                type: 'selected',
                location: {
                  address: fallbackAddress(point),
                  latitude: point.lat,
                  longitude: point.lng
                }
              });
            }, 6000);

            geocoder.getLocation(point, function (result) {
              if (finished) return;
              finished = true;
              clearTimeout(timeout);
              emit({
                type: 'selected',
                location: {
                  address: result && result.address ? result.address : fallbackAddress(point),
                  latitude: point.lat,
                  longitude: point.lng
                }
              });
            });
          }

          map.addEventListener('click', function (event) {
            selectPoint(event.point);
          });

          if (initialLocation) {
            placeMarker(new BMap.Point(initialLocation.longitude, initialLocation.latitude));
          }

          var localSearch = new BMap.LocalSearch(map, {
            pageCapacity: 5,
            renderOptions: { autoViewport: false },
            onSearchComplete: function (rawResults) {
              var result = Array.isArray(rawResults) ? rawResults[0] : rawResults;
              var locations = [];
              if (result) {
                var count = Math.min(result.getCurrentNumPois(), 5);
                for (var index = 0; index < count; index += 1) {
                  var poi = result.getPoi(index);
                  if (!poi || !poi.point) continue;
                  locations.push({
                    address: poi.address ? poi.title + ' · ' + poi.address : poi.title,
                    latitude: poi.point.lat,
                    longitude: poi.point.lng
                  });
                }
              }
              emit({ type: 'search-results', results: locations });
            }
          });

          window.__timeflowSearch = function (query) {
            try {
              localSearch.search(query);
            } catch (error) {
              emit({ type: 'search-error' });
            }
          };

          window.__timeflowLocate = function () {
            try {
              var geolocation = new BMap.Geolocation();
              geolocation.getCurrentPosition(function (result) {
                if (geolocation.getStatus() !== 0 || !result || !result.point) {
                  emit({ type: 'location-error', message: '无法获取当前位置，请允许定位权限后重试。' });
                  return;
                }
                map.setCenter(result.point, { noAnimation: false });
                map.setZoom(17, { noAnimation: false });
                selectPoint(result.point);
              }, { enableHighAccuracy: true });
            } catch (error) {
              emit({ type: 'location-error', message: '无法获取当前位置，请允许定位权限后重试。' });
            }
          };

          window.__timeflowSelect = function (longitude, latitude) {
            var point = new BMap.Point(longitude, latitude);
            placeMarker(point);
            map.setCenter(point, { noAnimation: false });
            map.setZoom(17, { noAnimation: false });
          };

          emit({ type: 'map-ready' });
        } catch (error) {
          emit({ type: 'map-error', message: '地图加载失败，请检查网络或百度地图密钥配置。' });
        }
      })();
    </script>
  </body>
</html>`;
}
