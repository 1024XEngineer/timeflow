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
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Defs, Path, RadialGradient, Rect, Stop } from 'react-native-svg';

import { colors, spacing } from '../../../shared/ui/theme';
import type { VoiceChatMessage } from '../domain/ConversationTurn';

import type { CallStatus } from './AssistantVoiceOverlay';
import { PhoneCallIcon } from './PhoneCallIcon';
import { usePinnedTranscriptScroll } from './usePinnedTranscriptScroll';

interface VoiceCallScreenProps {
  status: CallStatus;
  title: string;
  messages: readonly VoiceChatMessage[];
  soundLevel?: number | null;
  onCollapse: () => void;
  onEnd: () => void;
  onTogglePause: () => void;
}

const BREATH_SCALE = { duration: 1600, from: 1, to: 1.06 };
const TALK_SCALE = { duration: 650, from: 1, to: 1.14 };
const VOICEPRINT_BAR_COUNT = 9;
const VOICEPRINT_TICK_MS = 80;
const BUBBLE_VOICEPRINT_BARS = 5;
const CALL_BACKGROUND = '#0E241F';
const CALL_GLOW = '#18443A';
const CALL_VIGNETTE = '#071310';
const END_BUTTON_SIZE = 72;

/**
 * 免提通话的沉浸式全屏层，布局贴近 GPT Voice：对白从声纹球上方长出来，
 * 球本身靠底部。左上角收起不挂断；点圆圈暂停/恢复麦克风；底部红色按钮才是
 * 真正挂断。
 */
export function VoiceCallScreen({
  status,
  title,
  messages,
  soundLevel = null,
  onCollapse,
  onEnd,
  onTogglePause,
}: VoiceCallScreenProps) {
  const insets = useSafeAreaInsets();
  const { fitsViewport, onContentSizeChange, onLayout, onScroll, transcriptRef } =
    usePinnedTranscriptScroll();
  const [scale] = useState(() => new Animated.Value(1));

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
    <View style={styles.screen} testID="voice-call-screen">
      <CallBackdrop />
      <Pressable
        accessibilityLabel="收起通话"
        accessibilityRole="button"
        onPress={onCollapse}
        style={({ pressed }) => [
          styles.collapseButton,
          { top: Math.max(spacing.md, insets.top) },
          pressed && styles.buttonPressed,
        ]}
      >
        <CollapseChevron color={colors.onPrimary} />
      </Pressable>

      <ScrollView
        ref={transcriptRef}
        contentContainerStyle={[
          styles.transcriptContent,
          !fitsViewport && styles.transcriptContentOverflow,
        ]}
        onContentSizeChange={onContentSizeChange}
        onLayout={onLayout}
        onScroll={onScroll}
        scrollEventThrottle={16}
        showsVerticalScrollIndicator={false}
        style={styles.transcript}
        testID="voice-call-transcript"
      >
        {messages.map((message, index) => (
          <View
            accessibilityLabel={`${message.role === 'user' ? '你' : '助手'}：${message.text}`}
            key={message.id}
            style={[
              styles.turn,
              message.role === 'user' ? styles.turnUser : styles.turnAssistant,
              index < messages.length - 1 && styles.turnPast,
            ]}
          >
            <View
              style={[
                styles.bubble,
                message.role === 'user' ? styles.bubbleUser : styles.bubbleAssistant,
              ]}
            >
              <Text
                style={[
                  styles.bubbleText,
                  message.role === 'user' ? styles.bubbleTextUser : styles.bubbleTextAssistant,
                ]}
              >
                {message.text}
              </Text>
              {message.pending ? (
                <Voiceprint
                  active
                  barCount={BUBBLE_VOICEPRINT_BARS}
                  barStyle={
                    message.role === 'user'
                      ? [styles.speakingWaveBar, styles.speakingWaveBarUser]
                      : [styles.speakingWaveBar, styles.speakingWaveBarAssistant]
                  }
                  containerStyle={styles.speakingWave}
                  maxHeight={12}
                  minHeight={2}
                  soundLevel={soundLevel}
                  testID={`voice-call-speaking-wave-${message.role}`}
                />
              ) : null}
            </View>
          </View>
        ))}
      </ScrollView>

      <View
        style={[styles.dock, { paddingBottom: Math.max(spacing.lg, insets.bottom + spacing.sm) }]}
      >
        {title ? <Text style={styles.title}>{title}</Text> : null}
        <Pressable
          accessibilityLabel={status === 'paused' ? '继续' : '暂停'}
          accessibilityRole="button"
          onPress={onTogglePause}
          style={styles.orbHit}
        >
          <View style={styles.orbWell}>
            <Animated.View
              pointerEvents="none"
              style={[styles.ring, styles.ringOuter, { transform: [{ scale }] }]}
            />
            <Animated.View
              pointerEvents="none"
              style={[styles.ring, styles.ringInner, { transform: [{ scale }] }]}
            />
            <Animated.View
              style={[
                styles.circle,
                status === 'interrupted' && styles.circleInterrupted,
                status === 'paused' && styles.circlePaused,
                status === 'busy' && styles.circleBusy,
                { transform: [{ scale }] },
              ]}
            >
              {status === 'listening' || status === 'speaking' ? (
                <Voiceprint
                  active
                  barCount={VOICEPRINT_BAR_COUNT}
                  barStyle={styles.orbWaveBar}
                  maxHeight={34}
                  minHeight={3}
                  soundLevel={soundLevel}
                  testID="voice-call-orb-wave"
                  testIDPrefix="voice-call-voiceprint-bar"
                />
              ) : null}
            </Animated.View>
          </View>
        </Pressable>
        <Pressable
          accessibilityLabel="结束对话"
          accessibilityRole="button"
          onPress={onEnd}
          style={({ pressed }) => [styles.endButton, pressed && styles.buttonPressed]}
        >
          <View style={styles.endIcon} testID="voice-call-end-icon">
            <PhoneCallIcon color={colors.onPrimary} size={26} />
          </View>
          <Text style={styles.endText}>结束对话</Text>
        </Pressable>
      </View>
    </View>
  );
}

function CallBackdrop() {
  return (
    <Svg
      height="100%"
      pointerEvents="none"
      style={StyleSheet.absoluteFill}
      testID="voice-call-backdrop"
      width="100%"
    >
      <Defs>
        <RadialGradient cx="50%" cy="58%" fx="50%" fy="58%" id="callGlow" rx="98%" ry="92%">
          <Stop offset="0%" stopColor={CALL_GLOW} />
          <Stop offset="82%" stopColor={CALL_BACKGROUND} />
          <Stop offset="100%" stopColor={CALL_VIGNETTE} />
        </RadialGradient>
      </Defs>
      <Rect fill="url(#callGlow)" height="100%" width="100%" />
    </Svg>
  );
}

function CollapseChevron({ color }: { color: string }) {
  return (
    <Svg fill="none" height={22} viewBox="0 0 24 24" width={22}>
      <Path
        d="M6 9l6 6 6-6"
        stroke={color}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.8}
      />
    </Svg>
  );
}

function normalizeLevel(dbfs: number | null): number {
  if (dbfs === null) {
    return 0;
  }
  const clamped = Math.max(-50, Math.min(0, dbfs));
  return (clamped + 50) / 50;
}

function equalizerSamples(count: number, energy: number, tick: number): number[] {
  if (count === 0) {
    return [];
  }
  if (energy <= 0) {
    return Array.from({ length: count }, () => 0);
  }
  const center = (count - 1) / 2;
  return Array.from({ length: count }, (_, index) => {
    const dist = center === 0 ? 0 : Math.abs(index - center) / center;
    const envelope = 1 - dist * 0.58;
    const phase = tick * (0.85 + index * 0.41) + index * 1.63;
    const wobble = 0.42 + 0.58 * Math.abs(Math.sin(phase));
    return energy * envelope * wobble;
  });
}

/**
 * 球里的均衡器声纹：柱子位置不动，高度跟麦克风音量上下跳。中间柱更敏感，
 * 两边稍弱，各自相位不同，所以看起来是声纹在跳，而不是一条波形在横着挪。
 */
function Voiceprint({
  active,
  barCount,
  barStyle,
  containerStyle,
  maxHeight,
  minHeight,
  soundLevel,
  testID,
  testIDPrefix,
}: {
  active: boolean;
  barCount: number;
  barStyle: StyleProp<ViewStyle>;
  containerStyle?: StyleProp<ViewStyle>;
  maxHeight: number;
  minHeight: number;
  soundLevel: number | null;
  testID: string;
  testIDPrefix?: string;
}) {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!active) {
      return undefined;
    }
    const timer = setInterval(() => {
      setTick((current) => current + 1);
    }, VOICEPRINT_TICK_MS);
    return () => {
      clearInterval(timer);
    };
  }, [active]);

  const energy = active ? normalizeLevel(soundLevel) : 0;
  const samples = equalizerSamples(barCount, energy, tick);

  return (
    <View style={[styles.orbWave, containerStyle]} testID={testID}>
      {samples.map((level, index) => (
        <View
          key={`voiceprint-${testID}-${index}`}
          style={[
            styles.voiceprintBar,
            barStyle,
            { height: minHeight + level * (maxHeight - minHeight) },
          ]}
          testID={testIDPrefix ? `${testIDPrefix}-${index}` : undefined}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  bubble: {
    borderRadius: 22,
    maxWidth: '100%',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  bubbleAssistant: {
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  bubbleText: {
    fontSize: 16,
    lineHeight: 24,
  },
  bubbleTextAssistant: {
    color: colors.onPrimary,
  },
  bubbleTextUser: {
    color: colors.text,
  },
  bubbleUser: {
    backgroundColor: colors.accent,
  },
  buttonPressed: {
    opacity: 0.8,
  },
  circle: {
    alignItems: 'center',
    backgroundColor: colors.focus,
    borderRadius: 999,
    height: 96,
    justifyContent: 'center',
    width: 96,
  },
  circleBusy: {
    backgroundColor: 'rgba(184,216,117,0.55)',
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
    left: spacing.md,
    position: 'absolute',
    width: 40,
    zIndex: 2,
  },
  dock: {
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.sm,
  },
  endButton: {
    alignItems: 'center',
    gap: spacing.xs,
    marginTop: spacing.xxl,
  },
  endIcon: {
    alignItems: 'center',
    backgroundColor: colors.error,
    borderRadius: 999,
    height: END_BUTTON_SIZE,
    justifyContent: 'center',
    transform: [{ rotate: '135deg' }],
    width: END_BUTTON_SIZE,
  },
  endText: {
    color: 'rgba(255,255,255,0.78)',
    fontSize: 14,
    fontWeight: '600',
  },
  orbHit: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  orbWave: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 3,
    height: 36,
    justifyContent: 'center',
  },
  orbWaveBar: {
    backgroundColor: colors.text,
    borderRadius: 999,
    width: 3.5,
  },
  speakingWave: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    height: 12,
    marginTop: 8,
  },
  speakingWaveBar: {
    borderRadius: 999,
    width: 2.5,
  },
  speakingWaveBarAssistant: {
    backgroundColor: 'rgba(255,255,255,0.78)',
  },
  speakingWaveBarUser: {
    backgroundColor: colors.text,
  },
  voiceprintBar: {
    alignSelf: 'center',
    borderRadius: 999,
  },
  orbWell: {
    alignItems: 'center',
    height: 168,
    justifyContent: 'center',
    width: 168,
  },
  ring: {
    borderRadius: 999,
    position: 'absolute',
  },
  ringInner: {
    backgroundColor: 'rgba(184,216,117,0.22)',
    height: 128,
    width: 128,
  },
  ringOuter: {
    backgroundColor: 'rgba(184,216,117,0.12)',
    height: 168,
    width: 168,
  },
  screen: {
    backgroundColor: CALL_BACKGROUND,
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  title: {
    color: 'rgba(255,255,255,0.78)',
    fontSize: 14,
    fontWeight: '600',
    letterSpacing: 0.4,
    textAlign: 'center',
  },
  transcript: {
    flex: 1,
    marginTop: 56,
  },
  transcriptContent: {
    flexGrow: 1,
    gap: spacing.md,
    justifyContent: 'flex-end',
    paddingBottom: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
  },
  transcriptContentOverflow: {
    flexGrow: 0,
    justifyContent: 'flex-start',
  },
  turn: {
    gap: 6,
    maxWidth: '86%',
  },
  turnAssistant: {
    alignItems: 'flex-start',
    alignSelf: 'flex-start',
  },
  turnPast: {
    opacity: 0.62,
  },
  turnUser: {
    alignItems: 'flex-end',
    alignSelf: 'flex-end',
  },
});
