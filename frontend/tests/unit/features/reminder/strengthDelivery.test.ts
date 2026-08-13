import { describe, expect, it } from '@jest/globals';

import { resolveStrengthDeliveryPlan } from '../../../../src/features/reminder/domain/strengthDelivery';

describe('resolveStrengthDeliveryPlan', () => {
  it('uses system notification only for low strength', () => {
    expect(resolveStrengthDeliveryPlan('low')).toEqual({
      useSystemNotification: true,
      usePopup: false,
      useVibration: false,
      useAudio: false,
    });
  });

  it('uses popup and vibration for medium strength', () => {
    expect(resolveStrengthDeliveryPlan('medium')).toEqual({
      useSystemNotification: false,
      usePopup: true,
      useVibration: true,
      useAudio: false,
    });
  });

  it('uses popup, vibration and audio for high strength', () => {
    expect(resolveStrengthDeliveryPlan('high')).toEqual({
      useSystemNotification: false,
      usePopup: true,
      useVibration: true,
      useAudio: true,
    });
  });
});
