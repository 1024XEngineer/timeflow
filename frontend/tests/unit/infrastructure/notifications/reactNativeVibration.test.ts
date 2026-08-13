import { describe, expect, it, jest } from '@jest/globals';
import { Vibration } from 'react-native';

import { ReactNativeVibration } from '../../../../src/infrastructure/notifications/ReactNativeVibration';

describe('ReactNativeVibration', () => {
  it('starts the default pattern and can cancel it', async () => {
    const vibrate = jest.spyOn(Vibration, 'vibrate').mockImplementation(() => undefined);
    const cancel = jest.spyOn(Vibration, 'cancel').mockImplementation(() => undefined);
    const vibration = new ReactNativeVibration();

    await vibration.vibrate();
    expect(vibrate).toHaveBeenCalledWith([0, 500, 200, 500]);
    await vibration.stop();
    expect(cancel).toHaveBeenCalledTimes(1);

    vibrate.mockRestore();
    cancel.mockRestore();
  });
});
