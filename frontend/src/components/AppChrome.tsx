import type { ReactNode } from 'react';
import { UserRound } from 'lucide-react-native';
import { Pressable, Text, View } from 'react-native';

import { colors } from '../constants/theme';
import type { CalendarView } from '../types/home';
import { commonStyles as styles } from './AppChrome.styles';

export function Avatar({
  onPress,
  variant = 'dark',
}: {
  onPress?: () => void;
  variant?: 'dark' | 'light';
}) {
  const avatar = (
    <View style={[styles.avatar, variant === 'light' && styles.avatarLight]}>
      <UserRound
        color={variant === 'light' ? colors.deep : colors.lime}
        size={variant === 'light' ? 22 : 18}
        strokeWidth={2.2}
      />
    </View>
  );

  return onPress ? (
    <Pressable accessibilityLabel="打开我的" accessibilityRole="button" onPress={onPress}>
      {avatar}
    </Pressable>
  ) : (
    avatar
  );
}

export function ViewSwitch({
  value,
  onChange,
}: {
  value: CalendarView;
  onChange: (view: CalendarView) => void;
}) {
  return (
    <View style={styles.viewSwitch}>
      {(['day', 'week', 'month'] as CalendarView[]).map((item) => (
        <Pressable
          accessibilityLabel={`${item === 'day' ? '日' : item === 'week' ? '周' : '月'}视图`}
          accessibilityRole="tab"
          accessibilityState={{ selected: value === item }}
          key={item}
          onPress={() => onChange(item)}
          style={[styles.switchOption, value === item && styles.switchOptionActive]}
        >
          <Text style={[styles.switchText, value === item && styles.switchTextActive]}>
            {item === 'day' ? '日' : item === 'week' ? '周' : '月'}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

export function Header({
  eyebrow,
  title,
  action,
}: {
  eyebrow: string;
  title: string;
  action?: ReactNode;
}) {
  return (
    <View style={styles.header}>
      <View>
        <Text style={styles.eyebrow}>{eyebrow}</Text>
        <Text style={styles.pageTitle}>{title}</Text>
      </View>
      {action ?? <Avatar />}
    </View>
  );
}
