import type { ReminderStrength } from './reminder';

/** 原生全屏响铃页的声音档位：none=不出声，ping=一次性短提示音，full=循环语音直到处理。 */
export type AlarmSoundTier = 'none' | 'ping' | 'full';

/** 提醒强度对应的客户端送达通道组合。 */
export type StrengthDeliveryPlan = {
  /** 只在原生全屏页不可用时的 JS 兜底路径里使用（iOS、或安卓侧原生模块拿不到）。 */
  useSystemNotification: boolean;
  usePopup: boolean;
  useVibration: boolean;
  /** JS 兜底路径专用的 TTS/本地音；跟 alarmSoundTier 是两回事，互不影响。 */
  useAudio: boolean;
  /** 原生全屏响铃页（presentNow / AlarmSoundService）用的声音档位。 */
  alarmSoundTier: AlarmSoundTier;
};

export function resolveStrengthDeliveryPlan(strength: ReminderStrength): StrengthDeliveryPlan {
  switch (strength) {
    case 'low':
      return {
        useSystemNotification: true,
        usePopup: false,
        useVibration: false,
        useAudio: false,
        alarmSoundTier: 'ping',
      };
    case 'medium':
      return {
        useSystemNotification: false,
        usePopup: true,
        useVibration: true,
        useAudio: false,
        alarmSoundTier: 'ping',
      };
    case 'high':
      return {
        useSystemNotification: false,
        usePopup: true,
        useVibration: true,
        useAudio: true,
        alarmSoundTier: 'full',
      };
  }
}
