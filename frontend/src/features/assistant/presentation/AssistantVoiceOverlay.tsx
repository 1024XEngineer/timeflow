import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, spacing } from '../../../shared/ui/theme';
import type { AssistantApplicationPort } from '../application/AssistantApplication';

import { useAssistantConversation } from './useAssistantConversation';
import { VoiceTalkButton } from './VoiceTalkButton';

interface AssistantVoiceOverlayProps {
  application: AssistantApplicationPort;
}

/**
 * 叠在日历屏上的语音入口：底部居中按住说话按钮，说完话上方冒出流式文字气泡
 * （voice.dialogue.reply）。外层 pointerEvents="box-none" 让按钮和气泡之外的
 * 区域穿透给下面的日历，不挡滚动和点日期。
 *
 * 气泡出现时会多铺一层全屏蒙层（"box-none" 让位给它），点气泡本身不关闭
 * （包了一层自己的 Pressable 吃掉点击），点气泡以外的任何地方——包括蒙层本身
 * 覆盖的日历区域——都会关掉气泡并打断正在播放的 TTS。按钮渲染在蒙层之后，
 * 层级更高，蒙层出现时按钮仍能正常按。
 */
export function AssistantVoiceOverlay({ application }: AssistantVoiceOverlayProps) {
  const { dismissReply, endTurn, replyText, soundLevel, startTurn, state } =
    useAssistantConversation(application);
  const isRecording = state.phase === 'recording';

  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
      {/* 铺满全屏的蒙层：点气泡和按钮以外的任何地方（包括上面的日历区域）都会
          命中这层，因为它渲染在 overlay 内容之前、又是 box-none 容器唯一会
          拦截"空白处"点击的兜底。 */}
      {replyText ? (
        <Pressable
          accessibilityLabel="关闭回复"
          onPress={dismissReply}
          style={StyleSheet.absoluteFill}
        />
      ) : null}
      <View pointerEvents="box-none" style={styles.overlay}>
        {replyText ? (
          <Pressable onPress={() => {}} style={styles.bubble}>
            <Text style={styles.bubbleText}>{replyText}</Text>
          </Pressable>
        ) : null}
        <VoiceTalkButton
          isRecording={isRecording}
          onPressIn={startTurn}
          onPressOut={endTurn}
          soundLevel={soundLevel}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
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
  overlay: {
    alignItems: 'center',
    bottom: spacing.xl,
    left: 0,
    position: 'absolute',
    right: 0,
  },
});
