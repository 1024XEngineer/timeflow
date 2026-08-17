import { Platform, Vibration } from 'react-native';

import type { VibrationPort } from '../../features/reminder/application/interfaces';

/** 震动 / 间隔，确认或 teardown 前循环。 */
const REPEAT_PATTERN = [0, 700, 350, 700];

/** React Native Vibration 适配器：提醒展示期间持续震动。 */
export class ReactNativeVibration implements VibrationPort {
  private iosTimer: ReturnType<typeof setInterval> | null = null;

  async vibrate(): Promise<void> {
    this.clearIosTimer();
    Vibration.cancel();

    if (Platform.OS === 'android') {
      // 第二个参数 true = 按 pattern 循环，直到 cancel。
      Vibration.vibrate(REPEAT_PATTERN, true);
      return;
    }

    Vibration.vibrate(REPEAT_PATTERN);
    this.iosTimer = setInterval(() => {
      Vibration.vibrate(REPEAT_PATTERN);
    }, 2_000);
  }

  async stop(): Promise<void> {
    this.clearIosTimer();
    Vibration.cancel();
  }

  private clearIosTimer(): void {
    if (this.iosTimer == null) return;
    clearInterval(this.iosTimer);
    this.iosTimer = null;
  }
}
