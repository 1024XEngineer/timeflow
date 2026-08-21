import { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  Vibration,
  View,
} from 'react-native';
import type { GestureResponderEvent } from 'react-native';

import { FLOATING_VOICE_BAR_HEIGHT } from '../../../shared/ui/floatingVoiceBarLayout';
import { colors, spacing } from '../../../shared/ui/theme';

const WAVE_BAR_HEIGHTS = [10, 16, 22, 16, 10] as const;
const MIN_BAR_SCALE = 0.4;
const LEVEL_ANIMATION_MS = 120;
const HOLD_FEEDBACK_DURATION_MS = 10;
const CANCEL_DISTANCE_DP = 76;

interface PushToTalkBarProps {
  isRecording: boolean;
  disabled: boolean;
  /** 麦克风音量，dBFS（-160~0，越接近 0 越响）；不在录音时传 null。 */
  soundLevel: number | null;
  onPressIn: () => void;
  onPressOut: () => void;
  /** 上滑到取消区域后松手触发；未提供时回退到 onPressOut，保持组件兼容。 */
  onCancel?: () => void;
}

/**
 * 长条状按住说话入口，跟左边的电话按钮并排放在同一条底部长条里。录音时条内
 * 冒出波形，音量由真实麦克风电平驱动。免提通话进行中时整条置灰不可按——
 * 两条编排路径不能同时抢麦克风。
 */
export function PushToTalkBar({
  isRecording,
  disabled,
  soundLevel,
  onPressIn,
  onPressOut,
  onCancel,
}: PushToTalkBarProps) {
  const [waveValues] = useState(() =>
    WAVE_BAR_HEIGHTS.map(() => new Animated.Value(MIN_BAR_SCALE)),
  );
  const [isHolding, setIsHolding] = useState(false);
  const [isCanceling, setIsCanceling] = useState(false);
  const pressStartY = useRef<number | null>(null);
  const cancelingRef = useRef(false);
  const cancelHapticTriggered = useRef(false);
  const isActive = isHolding || isRecording;

  function handlePressIn(event?: GestureResponderEvent) {
    if (disabled) return;
    pressStartY.current = pageYFrom(event);
    cancelingRef.current = false;
    cancelHapticTriggered.current = false;
    setIsCanceling(false);
    setIsHolding(true);
    if (Platform.OS !== 'web') {
      Vibration.vibrate(HOLD_FEEDBACK_DURATION_MS);
    }
    onPressIn();
  }

  function handlePressMove(event?: GestureResponderEvent) {
    if (!isHolding || pressStartY.current === null) return;
    const currentY = pageYFrom(event);
    if (currentY === null) return;
    const distance = Math.max(0, pressStartY.current - currentY);
    const nextIsCanceling = distance >= CANCEL_DISTANCE_DP;
    cancelingRef.current = nextIsCanceling;
    setIsCanceling(nextIsCanceling);
    if (nextIsCanceling && !cancelHapticTriggered.current) {
      cancelHapticTriggered.current = true;
      if (Platform.OS !== 'web') {
        Vibration.vibrate(HOLD_FEEDBACK_DURATION_MS);
      }
    }
  }

  function handlePressOut() {
    const shouldCancel = cancelingRef.current;
    setIsHolding(false);
    setIsCanceling(false);
    pressStartY.current = null;
    cancelingRef.current = false;
    cancelHapticTriggered.current = false;
    if (shouldCancel && onCancel !== undefined) {
      onCancel();
      return;
    }
    onPressOut();
  }

  useEffect(() => {
    if (!isRecording) {
      waveValues.forEach((value) => {
        value.stopAnimation();
        value.setValue(MIN_BAR_SCALE);
      });
      return;
    }
    const target = MIN_BAR_SCALE + (1 - MIN_BAR_SCALE) * normalizeLevel(soundLevel);
    Animated.parallel(
      waveValues.map((value) =>
        Animated.timing(value, {
          duration: LEVEL_ANIMATION_MS,
          easing: Easing.out(Easing.ease),
          toValue: target,
          useNativeDriver: Platform.OS !== 'web',
        }),
      ),
    ).start();
  }, [isRecording, soundLevel, waveValues]);

  return (
    <Pressable
      accessibilityLabel="按住说话"
      accessibilityRole="button"
      accessibilityHint={
        isCanceling ? '已到取消区域，松开取消' : '按住说话，滑到上方取消位置后松开可取消'
      }
      disabled={disabled}
      onPressIn={handlePressIn}
      onPressMove={handlePressMove}
      onPressOut={handlePressOut}
      pressRetentionOffset={{ bottom: 128, left: 32, right: 32, top: 128 }}
      style={({ pressed }) => [
        styles.bar,
        isActive && styles.barActive,
        disabled && styles.barDisabled,
        pressed && styles.barPressed,
      ]}
    >
      {isHolding ? (
        <View
          pointerEvents="none"
          style={styles.cancelTargetPosition}
          testID="push-to-talk-cancel-target"
        >
          <View style={[styles.cancelTarget, isCanceling && styles.cancelTargetActive]}>
            <Text style={[styles.cancelTargetText, isCanceling && styles.cancelTargetTextActive]}>
              {isCanceling ? '已到取消位置' : '滑到这里取消'}
            </Text>
          </View>
        </View>
      ) : null}
      {isCanceling ? (
        <View style={styles.holdContent}>
          <Text style={styles.holdLabel}>松开取消</Text>
        </View>
      ) : isHolding ? (
        <View style={styles.holdContent}>
          <Text style={styles.holdLabel}>松开结束</Text>
        </View>
      ) : isRecording ? (
        <View style={styles.wave}>
          {waveValues.map((value, index) => (
            <Animated.View
              key={`wave-${WAVE_BAR_HEIGHTS[index]}-${index}`}
              style={[
                styles.waveBar,
                {
                  height: WAVE_BAR_HEIGHTS[index],
                  opacity: value,
                  transform: [{ scaleY: value }],
                },
              ]}
            />
          ))}
        </View>
      ) : (
        <Text style={[styles.label, disabled && styles.labelDisabled]}>按住说话</Text>
      )}
    </Pressable>
  );
}

function pageYFrom(event?: GestureResponderEvent): number | null {
  if (event === undefined) return null;
  const { pageY, locationY } = event.nativeEvent;
  return typeof pageY === 'number' ? pageY : typeof locationY === 'number' ? locationY : null;
}

function normalizeLevel(dbfs: number | null): number {
  if (dbfs === null) {
    return 0;
  }
  const clamped = Math.max(-50, Math.min(0, dbfs));
  return (clamped + 50) / 50;
}

const styles = StyleSheet.create({
  bar: {
    alignItems: 'center',
    backgroundColor: colors.text,
    borderRadius: 999,
    flex: 1,
    height: FLOATING_VOICE_BAR_HEIGHT,
    justifyContent: 'center',
  },
  barActive: {
    backgroundColor: colors.error,
  },
  barDisabled: {
    opacity: 0.4,
  },
  barPressed: {
    opacity: 0.86,
  },
  cancelTargetPosition: {
    alignItems: 'center',
    bottom: CANCEL_DISTANCE_DP + 12,
    left: 0,
    position: 'absolute',
    right: 0,
    zIndex: 1,
  },
  cancelTarget: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 8,
    borderWidth: 1,
    height: 32,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
  },
  cancelTargetActive: {
    backgroundColor: colors.error,
    borderColor: colors.error,
  },
  cancelTargetText: {
    color: colors.text,
    fontSize: 12,
    fontWeight: '600',
  },
  cancelTargetTextActive: {
    color: colors.onPrimary,
  },
  holdLabel: {
    color: colors.onPrimary,
    fontSize: 14,
    fontWeight: '700',
  },
  holdContent: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    color: colors.onPrimary,
    fontSize: 14,
    fontWeight: '600',
  },
  labelDisabled: {
    color: colors.onPrimary,
  },
  wave: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xs,
    height: 24,
  },
  waveBar: {
    backgroundColor: colors.onPrimary,
    borderRadius: 999,
    width: 3.5,
  },
});
