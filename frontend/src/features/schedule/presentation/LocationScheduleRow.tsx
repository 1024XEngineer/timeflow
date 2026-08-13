import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { LocationScheduleView } from '../application';
import { colors, spacing } from '../../../shared/ui/theme';

export function LocationScheduleRow({
  item,
  onPress,
}: {
  item: LocationScheduleView;
  onPress?: () => void;
}) {
  const locationLabel = item.locationName ?? '地点触发';
  return (
    <Pressable
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={`${locationLabel} ${item.title}`}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <Text style={styles.pin}>📍</Text>
      <View style={styles.copy}>
        <Text style={styles.title} numberOfLines={2}>
          {item.title}
        </Text>
        <Text style={styles.location}>{locationLabel}</Text>
        {item.reminderType || item.reminderStrength ? (
          <Text style={styles.meta}>
            {[item.reminderType, item.reminderStrength].filter(Boolean).join(' · ')}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  copy: { flex: 1, gap: 4 },
  location: { color: colors.mutedText, fontSize: 13, fontWeight: '600' },
  meta: { color: colors.mutedText, fontSize: 13 },
  pin: { fontSize: 16, marginTop: 1 },
  pressed: { opacity: 0.7 },
  row: {
    alignItems: 'flex-start',
    backgroundColor: colors.surface,
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  title: { color: colors.text, fontSize: 16, fontWeight: '700' },
});
