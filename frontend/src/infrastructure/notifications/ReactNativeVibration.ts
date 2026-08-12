import { Vibration } from 'react-native';

import type { VibrationPort } from '../../features/reminder/application/interfaces';

const DEFAULT_PATTERN = [0, 500, 200, 500];

/** React Native Vibration 适配器。 */
export class ReactNativeVibration implements VibrationPort {
  async vibrate(): Promise<void> {
    Vibration.vibrate(DEFAULT_PATTERN);
  }

  async stop(): Promise<void> {
    Vibration.cancel();
  }
}
