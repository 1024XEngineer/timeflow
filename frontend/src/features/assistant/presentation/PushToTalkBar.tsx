import { useEffect, useState } from 'react';
import { Animated, Easing, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { FLOATING_VOICE_BAR_HEIGHT } from '../../../shared/ui/floatingVoiceBarLayout';
import { colors, spacing } from '../../../shared/ui/theme';

const WAVE_BAR_HEIGHTS = [10, 16, 22, 16, 10] as const;
const MIN_BAR_SCALE = 0.4;
const LEVEL_ANIMATION_MS = 120;

interface PushToTalkBarProps {
  isRecording: boolean;
  disabled: boolean;
  /** 麦克风音量，dBFS（-160~0，越接近 0 越响）；不在录音时传 null。 */
  soundLevel: number | null;
  onPressIn: () => void;
  onPressOut: () => void;
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
}: PushToTalkBarProps) {
  const [waveValues] = useState(() =>
    WAVE_BAR_HEIGHTS.map(() => new Animated.Value(MIN_BAR_SCALE)),
  );

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
      disabled={disabled}
      onPressIn={onPressIn}
      onPressOut={onPressOut}
      style={({ pressed }) => [
        styles.bar,
        isRecording && styles.barActive,
        disabled && styles.barDisabled,
        pressed && styles.barPressed,
      ]}
    >
      {isRecording ? (
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
