import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  FLOATING_VOICE_BAR_HEIGHT,
  floatingVoiceBarBottomOffset,
} from '../../../shared/ui/floatingVoiceBarLayout';
import { colors, spacing } from '../../../shared/ui/theme';
import type { AlertDialogPort, DevicePermission } from '../../reminder';
import type { AssistantApplicationPort } from '../application/AssistantApplication';
import type { ConversationTurnState } from '../domain/ConversationTurn';

import { PhoneCallIcon } from './PhoneCallIcon';
import { PushToTalkBar } from './PushToTalkBar';
import { useAssistantConversation } from './useAssistantConversation';
import { VoiceCallScreen } from './VoiceCallScreen';

export type CallStatus = 'off' | 'listening' | 'speaking' | 'interrupted' | 'paused' | 'busy';

/** AssistantConversationService/AssistantContinuousConversationService 请求被拒后设的原话。 */
const MICROPHONE_DENIED_MESSAGE = '没有麦克风权限';

interface AssistantVoiceOverlayProps {
  pushToTalkApplication: AssistantApplicationPort;
  continuousApplication: AssistantApplicationPort;
  alertDialog: AlertDialogPort;
  onRequestPermission: (permission?: DevicePermission) => void;
}

function callStatusFor(phase: ConversationTurnState['phase']): CallStatus {
  switch (phase) {
    case 'connecting':
      return 'busy';
    case 'listening':
      return 'listening';
    case 'speaking':
    case 'asking':
      return 'speaking';
    case 'interrupted':
      return 'interrupted';
    case 'paused':
      return 'paused';
    default:
      return 'off';
  }
}

const CALL_ACTIVE_PHASES: ReadonlySet<ConversationTurnState['phase']> = new Set([
  'connecting',
  'listening',
  'speaking',
  'asking',
  'interrupted',
  'paused',
]);

const PTT_BUSY_PHASES: ReadonlySet<ConversationTurnState['phase']> = new Set([
  'connecting',
  'recording',
  'awaiting_result',
]);

function statusLabelFor(state: ConversationTurnState): string {
  if (state.phase === 'error') return state.message;
  switch (state.phase) {
    case 'connecting':
      return '连接中…';
    case 'listening':
      return '正在听';
    case 'interrupted':
      return '已打断';
    case 'speaking':
    case 'asking':
      return '正在回复';
    case 'paused':
      return '已暂停，点击圆圈继续';
    default:
      return '';
  }
}

/**
 * 叠在日历屏上的语音入口：底部一条长条状控件，左边一个圆形电话按钮进入免提
 * 通话（沉浸式全屏层，对白与底部声纹球的布局参考 GPT Voice），右边一条长按说话的语音条——两条编排
 * 路径（AssistantConversationService/AssistantContinuousConversationService）
 * 各自独立连接（各自绑定不同 voiceMode 的 AuthenticatedVoiceTransport 实例，
 * 共用同一个 AuthenticatedWebSocketClient），不共享一个 application 实例，
 * 所以这里同时订阅两边的状态。没有模式切换的概念：用哪边完全看用户点了哪个
 * 控件，另一边在对方进行中时置灰，不能同时抢麦克风。
 *
 * 免提通话进行中会展开 VoiceCallScreen 铺满全屏；左上角收起只是把它降级回
 * 长条状入口，连接和麦克风不受影响，真正挂断走全屏层里的"结束对话"。
 */
export function AssistantVoiceOverlay({
  pushToTalkApplication,
  continuousApplication,
  alertDialog,
  onRequestPermission,
}: AssistantVoiceOverlayProps) {
  const insets = useSafeAreaInsets();
  const ptt = useAssistantConversation(pushToTalkApplication);
  const call = useAssistantConversation(continuousApplication);
  const [expanded, setExpanded] = useState(false);

  useMicrophoneDeniedNudge(ptt.state, alertDialog, onRequestPermission);
  useMicrophoneDeniedNudge(call.state, alertDialog, onRequestPermission);

  const isCallActive = CALL_ACTIVE_PHASES.has(call.state.phase);
  const isPttBusy = PTT_BUSY_PHASES.has(ptt.state.phase);

  // 通话挂断（回到 idle）之后全屏层跟着收起——渲染期间同步，不用 effect，
  // 避免多触发一轮 commit（跟 useAssistantConversation 里 trackedApplication
  // 的处理是同一个原因）。
  const [trackedCallPhase, setTrackedCallPhase] = useState(call.state.phase);
  if (trackedCallPhase !== call.state.phase) {
    setTrackedCallPhase(call.state.phase);
    if (call.state.phase === 'idle' && expanded) {
      setExpanded(false);
    }
  }

  if (expanded) {
    return (
      <VoiceCallScreen
        messages={call.messages}
        onCollapse={() => setExpanded(false)}
        onEnd={() => void call.endTurn()}
        onTogglePause={() => call.togglePause()}
        soundLevel={call.soundLevel}
        status={callStatusFor(call.state.phase)}
        title={statusLabelFor(call.state)}
      />
    );
  }

  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill} testID="assistant-voice-overlay">
      {ptt.replyText ? (
        <Pressable
          accessibilityLabel="关闭回复"
          onPress={ptt.dismissReply}
          style={StyleSheet.absoluteFill}
        />
      ) : null}
      <View
        pointerEvents="box-none"
        style={[styles.overlay, { bottom: floatingVoiceBarBottomOffset(insets.bottom) }]}
        testID="assistant-voice-controls"
      >
        {ptt.replyText ? (
          <Pressable onPress={ptt.dismissReply} style={styles.bubble}>
            <Text style={styles.bubbleText}>{ptt.replyText}</Text>
          </Pressable>
        ) : null}
        <View style={styles.bar}>
          <Pressable
            accessibilityLabel="进入免提通话"
            accessibilityRole="button"
            disabled={isPttBusy}
            onPress={() => {
              setExpanded(true);
              if (call.state.phase === 'idle' || call.state.phase === 'error') {
                void call.startTurn();
              }
            }}
            style={({ pressed }) => [
              styles.callButton,
              isPttBusy && styles.callButtonDisabled,
              pressed && styles.callButtonPressed,
            ]}
          >
            <PhoneCallIcon color={colors.onPrimary} size={20} />
          </Pressable>
          <PushToTalkBar
            disabled={isCallActive}
            isRecording={ptt.state.phase === 'recording'}
            onPressIn={ptt.startTurn}
            onPressOut={ptt.endTurn}
            soundLevel={ptt.soundLevel}
          />
        </View>
      </View>
    </View>
  );
}

/** 麦克风被拒时弹一次"去权限页开启"，用 phase+message 做依赖，状态没变就不重复弹。 */
function useMicrophoneDeniedNudge(
  state: ConversationTurnState,
  alertDialog: AlertDialogPort,
  onRequestPermission: (permission?: DevicePermission) => void,
): void {
  const message = state.phase === 'error' ? state.message : null;
  useEffect(() => {
    if (message !== MICROPHONE_DENIED_MESSAGE) return;
    void alertDialog.show({
      title: '需要麦克风权限',
      message: '拒绝了麦克风权限，没法使用语音功能。现在去开启吗？',
      cancelable: true,
      buttons: [
        { text: '暂不', style: 'cancel' },
        { text: '去开启', onPress: () => onRequestPermission('microphone') },
      ],
    });
  }, [message, alertDialog, onRequestPermission]);
}

const styles = StyleSheet.create({
  bar: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    width: '100%',
  },
  bubble: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 16,
    borderWidth: 1,
    marginBottom: spacing.md,
    maxWidth: 280,
    padding: spacing.md,
  },
  bubbleText: {
    color: colors.text,
    fontSize: 15,
  },
  callButton: {
    alignItems: 'center',
    backgroundColor: colors.text,
    borderRadius: 999,
    height: FLOATING_VOICE_BAR_HEIGHT,
    justifyContent: 'center',
    width: 52,
  },
  callButtonDisabled: {
    opacity: 0.4,
  },
  callButtonPressed: {
    opacity: 0.86,
  },
  overlay: {
    alignItems: 'center',
    left: 0,
    paddingHorizontal: spacing.lg,
    position: 'absolute',
    right: 0,
  },
});
