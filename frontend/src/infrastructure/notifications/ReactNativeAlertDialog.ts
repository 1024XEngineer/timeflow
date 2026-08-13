import { Alert } from 'react-native';

import type {
  AlertDialogPort,
  AlertDialogRequest,
} from '../../features/reminder/application/interfaces';

/** 系统 Alert 对话框适配器；presentation 通过 AlertDialogPort 使用，不直接依赖 RN。 */
export class ReactNativeAlertDialog implements AlertDialogPort {
  async show(request: AlertDialogRequest): Promise<void> {
    Alert.alert(
      request.title,
      request.message,
      request.buttons.map((button) => ({
        text: button.text,
        style: button.style,
        onPress: button.onPress,
      })),
    );
  }
}
