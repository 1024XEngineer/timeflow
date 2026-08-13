import { useEffect, useState } from 'react';
import { Animated, Easing, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, spacing } from '../../../shared/ui/theme';

import { TempoAssistantIcon } from './TempoAssistantIcon';

const WAVE_BAR_HEIGHTS = [11, 18, 24, 16, 12] as const;
const MIN_BAR_SCALE = 0.4;
const LEVEL_ANIMATION_MS = 120;

interface VoiceTalkButtonProps {
  isRecording: boolean;
  /** 麦克风音量，dBFS（-160~0，越接近 0 越响）；不在录音时传 null。 */
  soundLevel: number | null;
  onPressIn: () => void;
  onPressOut: () => void;
}

/**
 * 语音入口按钮：空闲态是个圆形图标按钮，录音时按钮上方冒出波形——状态提示画
 * 在按钮上方而不是按钮里面，手指按住按钮本身不会挡住看不见。波形柱子高度由
 * 真实麦克风音量（soundLevel）驱动，不是纯装饰动画。
 */
export function VoiceTalkButton({
  isRecording,
  soundLevel,
  onPressIn,
  onPressOut,
}: VoiceTalkButtonProps) {
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
    <View style={styles.wrap}>
      <View style={styles.hintSlot}>
        {isRecording ? <Text style={styles.hint}>录音中…</Text> : null}
      </View>
      <Pressable
        accessibilityLabel="按住说话"
        accessibilityRole="button"
        onPressIn={onPressIn}
        onPressOut={onPressOut}
        style={({ pressed }) => [
          styles.button,
          isRecording && styles.buttonActive,
          pressed && styles.buttonPressed,
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
          <TempoAssistantIcon color={colors.onPrimary} size={24} />
        )}
      </Pressable>
    </View>
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
  button: {
    alignItems: 'center',
    backgroundColor: colors.text,
    borderRadius: 999,
    height: 64,
    justifyContent: 'center',
    width: 64,
  },
  buttonActive: {
    backgroundColor: colors.error,
  },
  buttonPressed: {
    opacity: 0.86,
  },
  hint: {
    color: colors.mutedText,
    fontSize: 12,
    fontWeight: '600',
  },
  hintSlot: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 18,
  },
  wave: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 4,
    height: 24,
  },
  waveBar: {
    backgroundColor: colors.onPrimary,
    borderRadius: 999,
    width: 3.5,
  },
  wrap: {
    alignItems: 'center',
    gap: spacing.xs,
  },
});
