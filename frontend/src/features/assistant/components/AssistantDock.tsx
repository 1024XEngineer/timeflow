import { View } from 'react-native';

import { assistantDockStyles as styles } from './AssistantDock.styles';
import { VoiceHoldButton } from './VoiceHoldButton';

/** 日程页底部语音入口；助手弹层打开时隐藏，改由弹层内的按钮说话。 */
export function AssistantDock({
  hidden = false,
  onOpen,
  onVoiceCancel,
  onVoiceEnd,
  onVoiceStart,
}: {
  hidden?: boolean;
  onOpen: () => void;
  onVoiceCancel?: () => void;
  onVoiceEnd: () => void;
  onVoiceStart?: () => void;
}) {
  if (hidden) return null;

  return (
    <View style={[styles.dock, { pointerEvents: 'box-none' }]}>
      <VoiceHoldButton
        onPress={onOpen}
        onVoiceCancel={onVoiceCancel}
        onVoiceEnd={onVoiceEnd}
        onVoiceStart={onVoiceStart}
      />
    </View>
  );
}
