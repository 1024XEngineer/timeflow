export { MockLocationMonitor, MOCK_LOCATION_SAMPLE } from './MockLocationMonitor';
export { NativeLocationMonitor } from './NativeLocationMonitor';
export type { LocationProvider } from './LocationProvider';
export {
  isBaiduLocationAvailable,
  baiduInit,
  baiduSetAgreePrivacy,
  baiduStartUpdating,
  baiduStopUpdating,
  persistBaiduPrivacyConsent,
  readBaiduPrivacyConsent,
  subscribeBaiduLocation,
} from './native/BaiduLocationBridge';
