import { useEffect, useRef, useState } from 'react';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
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
import { useSafeAreaInsets } from 'react-native-safe-area-context';

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
const STICK_TO_BOTTOM_THRESHOLD = 48;

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
  const insets = useSafeAreaInsets();
  const [scale] = useState(() => new Animated.Value(1));
  const [statusRowHeight, setStatusRowHeight] = useState(0);
  const historyRef = useRef<ScrollView>(null);
  // 回复是流式的（累计文字每收到一段就整段刷新一次），跟着一路自动滚会跟
  // 用户手动上滑打架——用户一滑走就不再强制拉回底部，直到他自己滑回底部
  // 附近才恢复跟随，不然会出现看似“滑不动”的情况。
  const stickToBottomRef = useRef(true);

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

  // 只在用户真的拖动结束时才重新判断是否贴底——不能用 onScroll，流式内容
  // 一直在长，我们自己触发的 scrollToEnd 也会产生 onScroll 事件，那时候
  // contentSize 可能已经比滚动目标又长了一截，会被误判成“用户滑走了”，
  // 之后就再也不会自动跟随，导致流式说完了还有一段没露出来。
  // onScrollEndDrag/onMomentumScrollEnd 只在手指真正划过之后才触发，不受
  // animated:false 的程序化跳转影响。
  function handleScrollSettled(event: NativeSyntheticEvent<NativeScrollEvent>) {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const distanceFromBottom = contentSize.height - contentOffset.y - layoutMeasurement.height;
    stickToBottomRef.current = distanceFromBottom <= STICK_TO_BOTTOM_THRESHOLD;
  }

  return (
    <View style={styles.screen}>
      <View
        style={[styles.navigation, { paddingTop: Math.max(spacing.md, insets.top) }]}
        testID="voice-call-navigation"
      >
        <Pressable
          accessibilityLabel="收起通话"
          accessibilityRole="button"
          onPress={onCollapse}
          style={({ pressed }) => [styles.collapseButton, pressed && styles.buttonPressed]}
        >
          <PhoneCallIcon color={colors.onPrimary} size={18} />
        </Pressable>
      </View>

      <ScrollView
        ref={historyRef}
        contentContainerStyle={[
          styles.historyContent,
          // 用实测的“聆听中”状态行高度兜底，不管这行到底多高、有没有跟
          // ScrollView 自身的 flex 计算对不上，最后一条记录都保证能完整
          // 露出来，不会被这一行挡住最后一点。
          { paddingBottom: spacing.xl + statusRowHeight },
          turns.length === 0 && styles.historyContentEmpty,
        ]}
        onContentSizeChange={() => {
          if (!stickToBottomRef.current) {
            return;
          }
          // 延后两帧再滚：Android 上 onContentSizeChange 触发时原生 ScrollView
          // 有时还没把新内容高度提交完，内容越高时越容易滚不到底。用
          // animated:false 直接跳到底，流式刷新很密集，动画会跟下一次
          // 内容变化互相打断、显得卡住不动。
          requestAnimationFrame(() =>
            requestAnimationFrame(() => historyRef.current?.scrollToEnd({ animated: false })),
          );
        }}
        onMomentumScrollEnd={handleScrollSettled}
        onScrollEndDrag={handleScrollSettled}
        style={styles.history}
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

      <View
        onLayout={(event) => setStatusRowHeight(event.nativeEvent.layout.height)}
        style={styles.body}
      >
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

      <View
        style={[
          styles.actions,
          { paddingBottom: Math.max(spacing.xl, insets.bottom + spacing.md) },
        ]}
        testID="voice-call-actions"
      >
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
    width: 40,
  },
  endButton: {
    backgroundColor: colors.error,
  },
  endText: {
    color: colors.onPrimary,
  },
  navigation: {
    paddingBottom: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  history: {
    flex: 1,
    paddingTop: spacing.xl * 2,
  },
  historyContent: {
    gap: spacing.md,
    paddingHorizontal: spacing.xl,
  },
  historyContentEmpty: {
    alignItems: 'center',
    flexGrow: 1,
    justifyContent: 'center',
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
