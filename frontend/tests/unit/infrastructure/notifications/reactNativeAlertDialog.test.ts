import { describe, expect, it, jest } from '@jest/globals';
import { Alert } from 'react-native';

import { ReactNativeAlertDialog } from '../../../../src/infrastructure/notifications/ReactNativeAlertDialog';

describe('ReactNativeAlertDialog', () => {
  it('forwards title, message, buttons, and options to Alert.alert', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    const onPress = jest.fn();
    const onDismiss = jest.fn();

    const dialog = new ReactNativeAlertDialog();
    await dialog.show({
      title: '标题',
      message: '内容',
      buttons: [{ text: '确定', style: 'default', onPress }],
      cancelable: false,
      onDismiss,
    });

    expect(alertSpy).toHaveBeenCalledWith(
      '标题',
      '内容',
      [{ text: '确定', style: 'default', onPress }],
      { cancelable: false, onDismiss },
    );

    alertSpy.mockRestore();
  });

  it('defaults cancelable to true when not specified', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    const dialog = new ReactNativeAlertDialog();
    await dialog.show({ title: 't', message: 'm', buttons: [] });

    expect(alertSpy).toHaveBeenCalledWith('t', 'm', [], {
      cancelable: true,
      onDismiss: undefined,
    });

    alertSpy.mockRestore();
  });
});
