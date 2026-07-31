import { Check } from 'lucide-react-native';
import { Pressable, Text, View } from 'react-native';

import { colors } from '@/shared/theme';
import type { Schedule } from '@/contracts';

import { scheduleColor, scheduleRange, scheduleTime } from '../presentation/scheduleFormat';
import { scheduleRowStyles as styles } from './scheduleRow.styles';

export function ScheduleRow({
  compact = false,
  item,
  onPress,
  onToggle,
  showConnector = true,
}: {
  compact?: boolean;
  item: Schedule;
  onPress?: () => void;
  onToggle?: () => void;
  showConnector?: boolean;
}) {
  const done = item.status === 'done';

  return (
    <Pressable
      accessibilityLabel={`${scheduleTime(item)} ${item.title}`}
      accessibilityRole="button"
      onPress={onPress}
      style={[
        styles.scheduleRow,
        compact && styles.scheduleRowCompact,
        done && styles.scheduleRowCompleted,
      ]}
    >
      <Text style={[styles.scheduleTime, compact && styles.scheduleTimeCompact]}>
        {scheduleTime(item)}
      </Text>
      <View style={[styles.scheduleRail, compact && styles.scheduleRailCompact]}>
        <Pressable
          accessibilityLabel={`${done ? '恢复' : '完成'} ${item.title}`}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: done, disabled: !onToggle }}
          disabled={!onToggle}
          hitSlop={8}
          onPress={(event) => {
            event?.stopPropagation?.();
            onToggle?.();
          }}
          style={[
            styles.scheduleDot,
            { backgroundColor: scheduleColor(item) },
            done && styles.scheduleDotCompleted,
          ]}
        >
          {done ? <Check color={colors.surface} size={7} strokeWidth={3} /> : null}
        </Pressable>
        {showConnector && <View style={styles.scheduleLine} />}
      </View>
      <View style={[styles.scheduleCopy, compact && styles.scheduleCopyCompact]}>
        <View style={styles.scheduleHeading}>
          <Text
            style={[
              styles.scheduleTitle,
              compact && styles.scheduleTitleCompact,
              done && styles.scheduleTitleCompleted,
            ]}
          >
            {item.title}
          </Text>
        </View>
        {(item.location_name || item.notes) && (
          <Text style={styles.scheduleMeta}>{item.location_name ?? item.notes}</Text>
        )}
        <Text style={[styles.scheduleRange, compact && styles.scheduleRangeCompact]}>
          {scheduleRange(item)}
        </Text>
      </View>
    </Pressable>
  );
}
