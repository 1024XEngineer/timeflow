import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';

import type { LocationScheduleView } from '../application';
import { colors } from '../../../shared/ui/theme';
import { scheduleCategoryLabel } from './scheduleDisplay';

export function LocationScheduleRow({
  item,
  onPress,
}: {
  item: LocationScheduleView;
  onPress?: () => void;
}) {
  const locationLabel = item.locationName ?? '地点触发';
  const categoryLabel = scheduleCategoryLabel(item.category);
  return (
    <Pressable
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={`${locationLabel} ${item.title}`}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <View style={styles.iconWrap}>
        <LocationPinIcon />
      </View>
      <View style={styles.copy}>
        <Text style={styles.title} numberOfLines={2}>
          {item.title}
        </Text>
        <Text numberOfLines={1} style={styles.location}>
          {locationLabel}
        </Text>
        {categoryLabel ? (
          <Text numberOfLines={1} style={styles.location}>
            {categoryLabel}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

function LocationPinIcon() {
  return (
    <Svg fill="none" height={20} viewBox="0 0 24 24" width={20}>
      <Path
        d="M20 10c0 5.25-8 11-8 11S4 15.25 4 10a8 8 0 1 1 16 0Z"
        stroke={colors.text}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.8}
      />
      <Circle cx={12} cy={10} fill={colors.text} r={2.25} />
    </Svg>
  );
}

const styles = StyleSheet.create({
  copy: { flex: 1, gap: 4, minWidth: 0 },
  iconWrap: {
    alignItems: 'center',
    backgroundColor: colors.accent,
    borderRadius: 12,
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  location: { color: colors.mutedText, fontSize: 13, fontWeight: '600' },
  pressed: { opacity: 0.72, transform: [{ scale: 0.995 }] },
  row: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 16,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 12,
    marginBottom: 10,
    padding: 14,
  },
  title: { color: colors.text, fontSize: 16, fontWeight: '700', lineHeight: 21 },
});
