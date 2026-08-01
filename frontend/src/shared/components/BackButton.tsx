import { ChevronLeft } from 'lucide-react-native';
import { Pressable, StyleSheet } from 'react-native';

import { colors } from '@/shared/theme';

type BackButtonProps = {
  accessibilityLabel?: string;
  onPress: () => void;
};

/** 统一页面层级返回入口的视觉和交互。 */
export function BackButton({ accessibilityLabel = '返回', onPress }: BackButtonProps) {
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      hitSlop={8}
      onPress={onPress}
      style={({ pressed }) => [styles.button, pressed && styles.pressed]}
    >
      <ChevronLeft color={colors.deep} size={20} strokeWidth={2.2} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.line,
    borderRadius: 12,
    borderWidth: 1,
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  pressed: {
    backgroundColor: colors.surfaceTint,
    transform: [{ scale: 0.94 }],
  },
});
