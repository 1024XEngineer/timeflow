import { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Platform,
  Pressable,
  Text,
  Vibration,
  View,
  type GestureResponderEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { colors } from '@/shared/theme';

import { TempoAssistantIcon } from './TempoAssistantIcon';
import { voiceHoldButtonStyles as styles } from './VoiceHoldButton.styles';

const WAVE_BAR_HEIGHTS = [11, 18, 24, 16, 12] as const;
const CANCEL_DISTANCE = 72;
const HOLD_DELAY_MS = 320;
const HAPTIC_DURATION_MS = 35;

/** 轻点打开助手；按住说话、松开发送、上滑取消。 */
export function VoiceHoldButton({
  iconSize = 22,
  onPress,
  onVoiceCancel,
  onVoiceEnd,
  onVoiceStart,
  style,
}: {
  iconSize?: number;
  onPress?: () => void;
  onVoiceCancel?: () => void;
  onVoiceEnd: () => void;
  onVoiceStart?: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  const [isListening, setIsListening] = useState(false);
  const [willCancel, setWillCancel] = useState(false);
  const [waveValues] = useState(() => WAVE_BAR_HEIGHTS.map(() => new Animated.Value(0.55)));
  const recordingStartedRef = useRef(false);
  const longPressTriggeredRef = useRef(false);
  const cancelHapticFiredRef = useRef(false);
  const willCancelRef = useRef(false);
  const startYRef = useRef(0);

  const handlePressIn = (event: GestureResponderEvent) => {
    startYRef.current = event.nativeEvent.pageY;
    recordingStartedRef.current = false;
    longPressTriggeredRef.current = false;
    cancelHapticFiredRef.current = false;
    willCancelRef.current = false;
    setWillCancel(false);
  };

  const handleLongPress = () => {
    longPressTriggeredRef.current = true;
    recordingStartedRef.current = true;
    setIsListening(true);
    Vibration.vibrate(HAPTIC_DURATION_MS);
    onVoiceStart?.();
  };

  const handleTouchMove = (event: GestureResponderEvent) => {
    if (!recordingStartedRef.current) return;
    const shouldCancel = event.nativeEvent.pageY - startYRef.current < -CANCEL_DISTANCE;
    if (shouldCancel && !cancelHapticFiredRef.current) {
      cancelHapticFiredRef.current = true;
      Vibration.vibrate(HAPTIC_DURATION_MS);
    }
    willCancelRef.current = shouldCancel;
    setWillCancel(shouldCancel);
  };

  const handlePressOut = () => {
    if (!recordingStartedRef.current) return;
    const cancelled = willCancelRef.current;
    recordingStartedRef.current = false;
    willCancelRef.current = false;
    setIsListening(false);
    setWillCancel(false);
    if (cancelled) onVoiceCancel?.();
    else onVoiceEnd();
  };

  useEffect(() => {
    if (!isListening) {
      waveValues.forEach((value) => {
        value.stopAnimation();
        value.setValue(0.55);
      });
      return;
    }

    const animation = Animated.loop(
      Animated.stagger(
        60,
        waveValues.map((value) =>
          Animated.sequence([
            Animated.timing(value, {
              duration: 170,
              easing: Easing.inOut(Easing.ease),
              toValue: 1,
              useNativeDriver: Platform.OS !== 'web',
            }),
            Animated.timing(value, {
              duration: 170,
              easing: Easing.inOut(Easing.ease),
              toValue: 0.5,
              useNativeDriver: Platform.OS !== 'web',
            }),
          ]),
        ),
      ),
    );

    animation.start();
    return () => {
      animation.stop();
      waveValues.forEach((value) => value.setValue(0.55));
    };
  }, [isListening, waveValues]);

  const hint = willCancel ? '松开手指取消发送' : isListening ? '松开发送 · 上滑取消' : '';

  return (
    <View style={[styles.wrap, style]}>
      {hint ? (
        <View style={styles.hintSlot}>
          <Text style={[styles.hint, willCancel && styles.hintCancel]}>{hint}</Text>
        </View>
      ) : null}
      <Pressable
        accessibilityLabel={
          onPress ? '轻点打开语音助手，按住说话，上滑取消' : '按住说话，松开发送，上滑取消'
        }
        accessibilityRole="button"
        delayLongPress={HOLD_DELAY_MS}
        onLongPress={handleLongPress}
        onPress={() => {
          if (!longPressTriggeredRef.current) onPress?.();
        }}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        onTouchMove={handleTouchMove}
        style={[
          styles.button,
          isListening && !willCancel && styles.buttonListening,
          willCancel && styles.buttonCancel,
        ]}
      >
        {isListening && !willCancel ? (
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
          <TempoAssistantIcon color={willCancel ? colors.coral : colors.lime} size={iconSize} />
        )}
      </Pressable>
    </View>
  );
}
