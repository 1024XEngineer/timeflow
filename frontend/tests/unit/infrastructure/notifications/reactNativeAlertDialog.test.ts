import { describe, expect, it, jest } from '@jest/globals';
import { Alert } from 'react-native';

import { ReactNativeAlertDialog } from '../../../../src/infrastructure/notifications/ReactNativeAlertDialog';

describe('ReactNativeAlertDialog', () => {
  it('forwards title, message and button handlers to Alert.alert', async () => {
    const onPress = jest.fn();
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    const dialog = new ReactNativeAlertDialog();

    await dialog.show({
      title: '需要精确闹钟权限',
      message: '允许后才能准时触发。',
      buttons: [
        { text: '暂不', style: 'cancel' },
        { text: '去授权', onPress },
      ],
    });

    expect(alert).toHaveBeenCalledWith('需要精确闹钟权限', '允许后才能准时触发。', [
      { text: '暂不', style: 'cancel', onPress: undefined },
      { text: '去授权', style: undefined, onPress },
    ]);
    alert.mockRestore();
  });
});
