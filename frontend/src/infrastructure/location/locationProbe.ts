import { getNativeLastKnownLocationSample } from './NativeLocationFallback';

export function startLocationProbeOnStartup(): void {
  if (!__DEV__ || process.env.EXPO_PUBLIC_LOCATION_PROBE_ON_START !== '1') {
    return;
  }

  void getNativeLastKnownLocationSample().then((sample) => {
    if (sample === null) {
      console.warn('[location-probe] native cached location unavailable');
      return;
    }

    // eslint-disable-next-line no-console -- this opt-in development probe reports successful reads
    console.info('[location-probe] native cached location ready', {
      accuracy_meters: sample.accuracy_meters,
      latitude: sample.latitude,
      longitude: sample.longitude,
      observed_at: sample.observed_at,
    });
  });
}
