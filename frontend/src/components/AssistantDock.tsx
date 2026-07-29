import { Pressable, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { assistantStyles as styles } from '../screens/AssistantScreen.styles';

export function TempoAssistantIcon({
  color = '#D9F65A',
  size = 22,
}: {
  color?: string;
  size?: number;
}) {
  return (
    <Svg fill="none" height={size} viewBox="0 0 24 24" width={size}>
      <Path
        d="M12 3.5 13.8 9l5.2 1.7-5.2 1.7L12 18l-1.8-5.6L5 10.7 10.2 9 12 3.5Z"
        stroke={color}
        strokeLinejoin="round"
        strokeWidth={1.65}
      />
      <Path
        d="m18.3 15.6.65 1.95 1.95.65-1.95.65-.65 1.95-.65-1.95-1.95-.65 1.95-.65.65-1.95Z"
        fill={color}
      />
    </Svg>
  );
}

export function AssistantDock({ onPress }: { onPress: () => void }) {
  return (
    <View pointerEvents="box-none" style={styles.assistantDock}>
      <Pressable
        accessibilityLabel="打开智能助手"
        accessibilityRole="button"
        hitSlop={6}
        onPress={onPress}
        style={({ pressed }) => [
          styles.assistantDockButton,
          pressed && styles.assistantDockButtonPressed,
        ]}
      >
        <TempoAssistantIcon />
      </Pressable>
    </View>
  );
}
