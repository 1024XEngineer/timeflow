import { describe, expect, it } from '@jest/globals';

import { resolveStrengthDeliveryPlan } from '../../../../../src/features/reminder/domain/strengthDelivery';

describe('resolveStrengthDeliveryPlan', () => {
  it('low: system notification only, native ring page gets a one-shot ping', () => {
    expect(resolveStrengthDeliveryPlan('low')).toEqual({
      useSystemNotification: true,
      usePopup: false,
      useVibration: false,
      useAudio: false,
      alarmSoundTier: 'ping',
    });
  });

  it('medium: popup + vibration, no JS audio, native ring page gets a one-shot ping', () => {
    expect(resolveStrengthDeliveryPlan('medium')).toEqual({
      useSystemNotification: false,
      usePopup: true,
      useVibration: true,
      useAudio: false,
      alarmSoundTier: 'ping',
    });
  });

  it('high: popup + vibration + audio, native ring page gets the full looping sound', () => {
    expect(resolveStrengthDeliveryPlan('high')).toEqual({
      useSystemNotification: false,
      usePopup: true,
      useVibration: true,
      useAudio: true,
      alarmSoundTier: 'full',
    });
  });
});
