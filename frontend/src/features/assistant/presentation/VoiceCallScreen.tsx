import { useEffect, useState } from 'react';
import {
  Animated,
  Easing,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { colors, spacing } from '../../../shared/ui/theme';
import type { ConversationTurnRecord } from '../domain/ConversationTurn';

import type { CallStatus } from './AssistantVoiceOverlay';
import { PhoneCallIcon } from './PhoneCallIcon';
import { usePinnedTranscriptScroll } from './usePinnedTranscriptScroll';

interface VoiceCallScreenProps {
  status: CallStatus;
  title: string;
  turns?: readonly ConversationTurnRecord[];
  onCollapse: () => void;
  onEnd: () => void;
  onTogglePause: () => void;
}

const BREATH_SCALE = { duration: 1600, from: 1, to: 1.06 };
const TALK_SCALE = { duration: 650, from: 1, to: 1.14 };

/**
 * 免提通话的沉浸式全屏层：主体是一份可回看的完整问答记录（每轮一条用户话
 * +对应回复），下方是一个跟着状态变化的小状态点+文字，只报通用状态（聆听中
 * /回答中/已打断……），具体说了什么、回复了什么都在上面的记录里，标题不
 * 重复展示。底部只保留“结束对话”（真正挂断）。左上角收起不挂断，回到底部长
 * 条状入口，连接和麦克风都还开着。状态点这一整行可点：点一下暂停/恢复麦克风
 * 推流，是“用户点击暂停”的唯一入口。
 */
export function VoiceCallScreen({
  status,
  title,
  turns = [],
  onCollapse,
  onEnd,
  onTogglePause,
}: VoiceCallScreenProps) {
  const [scale] = useState(() => new Animated.Value(1));
  const { fitsViewport, onContentSizeChange, onLayout, onScroll, transcriptRef } =
    usePinnedTranscriptScroll();

  useEffect(() => {
    scale.stopAnimation();
    if (status === 'listening' || status === 'speaking') {
      const { duration, from, to } = status === 'speaking' ? TALK_SCALE : BREATH_SCALE;
      scale.setValue(from);
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(scale, {
            duration,
            easing: Easing.inOut(Easing.ease),
            toValue: to,
            useNativeDriver: Platform.OS !== 'web',
          }),
          Animated.timing(scale, {
            duration,
            easing: Easing.inOut(Easing.ease),
            toValue: from,
            useNativeDriver: Platform.OS !== 'web',
          }),
        ]),
      );
      loop.start();
      return () => loop.stop();
    }
    scale.setValue(1);
    return undefined;
  }, [status, scale]);

  return (
    <View style={styles.screen}>
      <Pressable
        accessibilityLabel="收起通话"
        accessibilityRole="button"
        onPress={onCollapse}
        style={({ pressed }) => [styles.collapseButton, pressed && styles.buttonPressed]}
      >
        <PhoneCallIcon color={colors.onPrimary} size={18} />
      </Pressable>

      <ScrollView
        ref={transcriptRef}
        contentContainerStyle={[
          styles.historyContent,
          turns.length === 0 && styles.historyContentEmpty,
          turns.length > 0 && !fitsViewport && styles.historyContentOverflow,
        ]}
        onContentSizeChange={onContentSizeChange}
        onLayout={onLayout}
        onScroll={onScroll}
        scrollEventThrottle={16}
        style={styles.history}
        testID="voice-call-history"
      >
        {turns.length > 0 ? (
          turns.map((turn) => (
            <View key={turn.id} style={styles.historyTurn}>
              <Text style={styles.historyTranscript}>{turn.transcript}</Text>
              {turn.replyText !== null ? (
                <Text style={styles.historyReply}>{turn.replyText}</Text>
              ) : null}
            </View>
          ))
        ) : (
          <Text style={styles.historyEmptyText}>对话开始后，这里会显示完整记录</Text>
        )}
      </ScrollView>

      <View style={styles.body}>
        <Pressable
          accessibilityLabel={status === 'paused' ? '继续' : '暂停'}
          accessibilityRole="button"
          hitSlop={spacing.md}
          onPress={onTogglePause}
          style={styles.statusPill}
        >
          <Animated.View
            style={[
              styles.statusDot,
              status === 'speaking' && styles.statusDotSpeaking,
              status === 'interrupted' && styles.statusDotInterrupted,
              status === 'paused' && styles.statusDotPaused,
              { transform: [{ scale }] },
            ]}
          />
          <Text style={styles.title}>{title}</Text>
        </Pressable>
      </View>

      <View style={styles.actions}>
        <Pressable
          accessibilityLabel="结束对话"
          accessibilityRole="button"
          onPress={onEnd}
          style={({ pressed }) => [
            styles.actionButton,
            styles.endButton,
            pressed && styles.buttonPressed,
          ]}
        >
          <Text style={[styles.actionText, styles.endText]}>结束对话</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  actionButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderRadius: 999,
    flex: 1,
    paddingVertical: spacing.md,
  },
  actionText: {
    color: colors.onPrimary,
    fontSize: 15,
    fontWeight: '600',
  },
  actions: {
    flexDirection: 'row',
    gap: spacing.md,
    paddingBottom: spacing.xl,
    paddingHorizontal: spacing.xl,
  },
  body: {
    alignItems: 'center',
    flexShrink: 0,
    paddingBottom: spacing.md,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.sm,
  },
  buttonPressed: {
    opacity: 0.8,
  },
  collapseButton: {
    alignItems: 'center',
    height: 40,
    justifyContent: 'center',
    left: spacing.lg,
    position: 'absolute',
    top: spacing.xl,
    width: 40,
  },
  endButton: {
    backgroundColor: colors.error,
  },
  endText: {
    color: colors.onPrimary,
  },
  history: {
    flex: 1,
    paddingTop: spacing.xl * 2,
  },
  historyContent: {
    gap: spacing.md,
    paddingBottom: spacing.md,
    paddingHorizontal: spacing.xl,
  },
  historyContentEmpty: {
    alignItems: 'center',
    flexGrow: 1,
    justifyContent: 'center',
  },
  historyContentOverflow: {
    flexGrow: 0,
    justifyContent: 'flex-start',
  },
  historyEmptyText: {
    color: 'rgba(255,255,255,0.4)',
    fontSize: 13,
    textAlign: 'center',
  },
  historyReply: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 15,
    marginTop: spacing.xs,
  },
  historyTranscript: {
    color: colors.onPrimary,
    fontSize: 15,
    fontWeight: '600',
  },
  historyTurn: {
    gap: 2,
  },
  screen: {
    backgroundColor: colors.text,
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  statusDot: {
    backgroundColor: colors.focus,
    borderRadius: 999,
    height: 8,
    width: 8,
  },
  statusDotInterrupted: {
    backgroundColor: colors.error,
  },
  statusDotPaused: {
    backgroundColor: colors.mutedText,
  },
  statusDotSpeaking: {
    backgroundColor: colors.onPrimary,
  },
  statusPill: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
  },
  title: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.2,
  },
});
