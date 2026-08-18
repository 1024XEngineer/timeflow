import { useEffect, useRef, useState } from 'react';
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
 * 免提通话的沉浸式全屏层：上方状态文字、居中一个跟着状态呼吸/跳动的圆圈、
 * 下方"结束对话"（真正挂断）。左上角收起不挂断，回到底部长条状入口，连接
 * 和麦克风都还开着。圆圈本身可点：点一下暂停/恢复麦克风推流。
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
  const historyRef = useRef<ScrollView>(null);

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

      {turns.length > 0 ? (
        <ScrollView
          ref={historyRef}
          contentContainerStyle={styles.historyContent}
          onContentSizeChange={() => historyRef.current?.scrollToEnd({ animated: true })}
          style={styles.history}
        >
          {turns.map((turn) => (
            <View key={turn.id} style={styles.historyTurn}>
              <Text style={styles.historyTranscript}>{turn.transcript}</Text>
              {turn.replyText !== null ? (
                <Text style={styles.historyReply}>{turn.replyText}</Text>
              ) : null}
            </View>
          ))}
        </ScrollView>
      ) : null}

      <View style={styles.body}>
        <Text style={styles.title}>{title}</Text>
        <Pressable
          accessibilityLabel={status === 'paused' ? '继续' : '暂停'}
          accessibilityRole="button"
          onPress={onTogglePause}
        >
          <Animated.View
            style={[
              styles.circle,
              status === 'interrupted' && styles.circleInterrupted,
              status === 'paused' && styles.circlePaused,
              { transform: [{ scale }] },
            ]}
          />
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
    flex: 1,
    gap: spacing.xxl,
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
  },
  buttonPressed: {
    opacity: 0.8,
  },
  circle: {
    backgroundColor: colors.focus,
    borderRadius: 999,
    height: 180,
    width: 180,
  },
  circleInterrupted: {
    backgroundColor: colors.error,
  },
  circlePaused: {
    backgroundColor: colors.mutedText,
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
    maxHeight: '38%',
    paddingTop: spacing.xl * 2,
  },
  historyContent: {
    gap: spacing.md,
    paddingHorizontal: spacing.xl,
  },
  historyReply: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 14,
    marginTop: spacing.xs,
  },
  historyTranscript: {
    color: colors.onPrimary,
    fontSize: 14,
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
  title: {
    color: colors.onPrimary,
    fontSize: 17,
    fontWeight: '600',
    textAlign: 'center',
  },
});
