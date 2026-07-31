import { Pressable, Text } from 'react-native';

import { createSheetStyles as styles } from './createSheet.styles';

export function ClearFieldButton({
  accessibilityLabel,
  onPress,
}: {
  accessibilityLabel: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      hitSlop={8}
      onPress={onPress}
      style={styles.locationClear}
    >
      <Text style={styles.locationClearText}>清除</Text>
    </Pressable>
  );
}
