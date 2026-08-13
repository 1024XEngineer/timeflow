import type { ReminderStrength } from './reminder';

/** 提醒强度对应的客户端送达通道组合。 */
export type StrengthDeliveryPlan = {
  useSystemNotification: boolean;
  usePopup: boolean;
  useVibration: boolean;
  useAudio: boolean;
};

export function resolveStrengthDeliveryPlan(strength: ReminderStrength): StrengthDeliveryPlan {
  switch (strength) {
    case 'low':
      return {
        useSystemNotification: true,
        usePopup: false,
        useVibration: false,
        useAudio: false,
      };
    case 'medium':
      return {
        useSystemNotification: false,
        usePopup: true,
        useVibration: true,
        useAudio: false,
      };
    case 'high':
      return {
        useSystemNotification: false,
        usePopup: true,
        useVibration: true,
        useAudio: true,
      };
  }
}
