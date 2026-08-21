import { useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';

import { floatingVoiceContentBottomInset } from '../../../shared/ui/floatingVoiceBarLayout';
import { colors, spacing } from '../../../shared/ui/theme';
import type { ScheduleCalendarReadService, ScheduleOccurrenceView } from '../application';
import { LocationScheduleDetailSheet } from './LocationScheduleDetailSheet';
import { LocationScheduleRow } from './LocationScheduleRow';
import { MonthCalendar } from './MonthCalendar';
import { ScheduleOccurrenceDetailSheet } from './ScheduleOccurrenceDetailSheet';
import { ScheduleOccurrenceRow } from './ScheduleOccurrenceRow';
import { emptyAgendaMessage, formatAgendaSectionTitle } from './scheduleDisplay';
import { useScheduleCalendar } from './useScheduleCalendar';
import type { CalendarFocusTarget } from './calendarFocus';

const SELECTED_DATE_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
  day: 'numeric',
  month: 'long',
  weekday: 'long',
});

interface ScheduleCalendarScreenProps {
  service: ScheduleCalendarReadService;
  accountId: string;
  timezone: string;
  username: string;
  onSignOut: () => void | Promise<void>;
  isSigningOut?: boolean;
  /** 打开权限列表页（不带具体权限，用户随时可以回去看全部状态）。 */
  onOpenPermissions: () => void;
  /** 外部触发刷新用（比如语音写完一条日程）；变化即重取，不用管具体数值。 */
  refreshSignal?: number;
  focusTarget?: CalendarFocusTarget | null;
}

export function ScheduleCalendarScreen({
  service,
  accountId,
  timezone,
  username,
  onSignOut,
  isSigningOut = false,
  onOpenPermissions,
  refreshSignal,
  focusTarget,
}: ScheduleCalendarScreenProps) {
  const insets = useSafeAreaInsets();
  const calendar = useScheduleCalendar(
    service,
    accountId,
    timezone,
    undefined,
    refreshSignal,
    focusTarget,
  );
  const [selectedOccurrenceKey, setSelectedOccurrenceKey] = useState<string | null>(null);
  const [selectedLocationId, setSelectedLocationId] = useState<string | null>(null);
  const selectedOccurrence =
    calendar.selectedOccurrences.find((item) => occurrenceKey(item) === selectedOccurrenceKey) ??
    null;
  const selectedLocation =
    calendar.locationSchedules.find((item) => item.scheduleId === selectedLocationId) ?? null;
  const topSafeAreaPadding = Platform.OS === 'android' ? insets.top : 0;
  const selectedLabel = SELECTED_DATE_FORMATTER.format(calendar.selectedDate);
  const agendaTitle = formatAgendaSectionTitle(calendar.selectedDate);
  const emptyAgenda = emptyAgendaMessage(calendar.selectedDate);
  const displayUsername = username.trim() || '用户';
  const avatarInitial = Array.from(displayUsername)[0]?.toLocaleUpperCase() ?? '用';

  return (
    <View style={styles.screen}>
      <ScrollView
        contentContainerStyle={[
          styles.scrollContent,
          {
            paddingBottom: floatingVoiceContentBottomInset(insets.bottom),
            paddingTop: topSafeAreaPadding,
          },
        ]}
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        testID="schedule-calendar-scroll"
      >
        <View style={styles.content}>
          <View style={styles.header}>
            <View style={styles.headerTop}>
              <Text numberOfLines={1} style={styles.title}>
                {selectedLabel}
              </Text>
              <View style={styles.accountActions} testID="schedule-account-actions">
                <Pressable
                  accessibilityLabel={`当前用户 ${displayUsername}，点击查看权限设置`}
                  accessibilityRole="button"
                  hitSlop={6}
                  onPress={onOpenPermissions}
                  style={({ pressed }) => [styles.userPill, pressed && styles.userPillPressed]}
                >
                  <View style={styles.avatar}>
                    <Text style={styles.avatarText}>{avatarInitial}</Text>
                  </View>
                  <Text
                    ellipsizeMode="tail"
                    numberOfLines={1}
                    style={styles.username}
                    testID="schedule-account-username"
                  >
                    {displayUsername}
                  </Text>
                </Pressable>
                <Pressable
                  accessibilityLabel="退出登录"
                  accessibilityRole="button"
                  accessibilityState={{ disabled: isSigningOut }}
                  disabled={isSigningOut}
                  hitSlop={6}
                  onPress={() => void onSignOut()}
                  style={({ pressed }) => [
                    styles.signOutButton,
                    pressed && !isSigningOut && styles.signOutButtonPressed,
                  ]}
                >
                  {isSigningOut ? (
                    <ActivityIndicator color={colors.text} size="small" />
                  ) : (
                    <LogoutIcon />
                  )}
                </Pressable>
              </View>
            </View>
          </View>

          <MonthCalendar
            month={calendar.visibleMonth}
            selectedDate={calendar.selectedDate}
            today={new Date()}
            occurrencesByDate={calendar.occurrencesByDate}
            onSelectDate={calendar.selectDate}
            onChangeMonth={calendar.changeMonth}
          />

          {calendar.loading ? (
            <View style={styles.center}>
              <ActivityIndicator color={colors.focus} />
              <Text style={styles.stateText}>正在加载日程</Text>
            </View>
          ) : null}

          {calendar.error ? (
            <View style={styles.center}>
              <Text style={styles.error}>{calendar.error}</Text>
              <Pressable accessibilityRole="button" onPress={calendar.retry} style={styles.retry}>
                <Text style={styles.retryText}>重试</Text>
              </Pressable>
            </View>
          ) : null}

          {!calendar.loading && !calendar.error ? (
            <View style={styles.agenda}>
              <View style={styles.sectionHeader}>
                <Text style={styles.sectionTitle}>{agendaTitle}</Text>
                <Text style={styles.sectionCount}>{calendar.selectedOccurrences.length} 项</Text>
              </View>

              {calendar.selectedOccurrences.length === 0 ? (
                <View style={styles.empty}>
                  <Text style={styles.emptyTitle}>{emptyAgenda.title}</Text>
                  {emptyAgenda.detail ? (
                    <Text style={styles.emptyCopy}>{emptyAgenda.detail}</Text>
                  ) : null}
                </View>
              ) : (
                calendar.selectedOccurrences.map((item, index) => (
                  <ScheduleOccurrenceRow
                    item={item}
                    isLast={index === calendar.selectedOccurrences.length - 1}
                    key={`${item.scheduleId}-${item.occurrenceStart}`}
                    onPress={() => setSelectedOccurrenceKey(occurrenceKey(item))}
                  />
                ))
              )}

              {calendar.locationSchedules.length > 0 ? (
                <View style={styles.locationSection}>
                  <View style={styles.sectionHeader}>
                    <Text style={styles.sectionTitle}>地点提醒</Text>
                    <Text style={styles.sectionCount}>{calendar.locationSchedules.length} 项</Text>
                  </View>
                  {calendar.locationSchedules.map((item) => (
                    <LocationScheduleRow
                      item={item}
                      key={item.scheduleId}
                      onPress={() => setSelectedLocationId(item.scheduleId)}
                    />
                  ))}
                </View>
              ) : null}
            </View>
          ) : null}
        </View>
      </ScrollView>

      <ScheduleOccurrenceDetailSheet
        occurrence={selectedOccurrence}
        onClose={() => setSelectedOccurrenceKey(null)}
      />
      <LocationScheduleDetailSheet
        schedule={selectedLocation}
        onClose={() => setSelectedLocationId(null)}
      />
    </View>
  );
}

function occurrenceKey(item: ScheduleOccurrenceView): string {
  return `${item.scheduleId}\u0000${item.occurrenceStart ?? ''}`;
}

function LogoutIcon() {
  return (
    <Svg fill="none" height={18} viewBox="0 0 24 24" width={18}>
      <Path
        d="M10 5H6.8A1.8 1.8 0 0 0 5 6.8v10.4A1.8 1.8 0 0 0 6.8 19H10M14.5 8l4 4-4 4M18 12H9"
        stroke={colors.text}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.8}
      />
    </Svg>
  );
}

const styles = StyleSheet.create({
  accountActions: {
    alignItems: 'center',
    flexDirection: 'row',
    flexShrink: 1,
    gap: spacing.sm,
    justifyContent: 'flex-end',
    marginLeft: 'auto',
    maxWidth: 240,
    minWidth: 0,
  },
  agenda: { paddingHorizontal: spacing.md, paddingTop: spacing.xl },
  avatar: {
    alignItems: 'center',
    backgroundColor: colors.accent,
    borderRadius: 999,
    height: 28,
    justifyContent: 'center',
    width: 28,
  },
  avatarText: { color: colors.text, fontSize: 12, fontWeight: '800' },
  center: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 16,
    borderWidth: 1,
    gap: spacing.md,
    justifyContent: 'center',
    marginHorizontal: spacing.md,
    marginTop: spacing.xl,
    minHeight: 180,
    padding: spacing.lg,
  },
  content: { alignSelf: 'center', maxWidth: 720, width: '100%' },
  empty: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 16,
    borderWidth: 1,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xl,
  },
  emptyCopy: {
    color: colors.mutedText,
    fontSize: 13,
    lineHeight: 19,
    marginTop: spacing.sm,
    textAlign: 'center',
  },
  emptyTitle: { color: colors.text, fontSize: 15, fontWeight: '700' },
  error: { color: colors.error, fontSize: 15, textAlign: 'center' },
  header: {
    paddingBottom: spacing.lg,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xl,
  },
  headerTop: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    minWidth: 0,
    width: '100%',
  },
  locationSection: {
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    marginTop: spacing.lg,
    paddingTop: spacing.lg,
  },
  retry: {
    backgroundColor: colors.text,
    borderRadius: 12,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  retryText: { color: colors.onPrimary, fontWeight: '700' },
  screen: { backgroundColor: colors.background, flex: 1 },
  scrollContent: { paddingBottom: spacing.lg },
  sectionCount: { color: colors.mutedText, fontSize: 12, fontWeight: '600' },
  sectionHeader: {
    alignItems: 'flex-end',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingBottom: 14,
  },
  sectionTitle: { color: colors.text, fontSize: 20, fontWeight: '800' },
  signOutButton: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 18,
    borderWidth: 1,
    flexShrink: 0,
    height: 36,
    justifyContent: 'center',
    width: 36,
  },
  signOutButtonPressed: { opacity: 0.62 },
  stateText: { color: colors.mutedText },
  title: {
    color: colors.text,
    flex: 1,
    fontSize: 28,
    fontWeight: '800',
    lineHeight: 34,
    minWidth: 0,
  },
  userPill: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 18,
    borderWidth: 1,
    flexDirection: 'row',
    flexShrink: 1,
    gap: spacing.sm,
    maxWidth: 196,
    minWidth: 0,
    paddingHorizontal: 4,
    paddingRight: 10,
    paddingVertical: 3,
  },
  userPillPressed: { opacity: 0.62 },
  username: { color: colors.text, flexShrink: 1, fontSize: 13, fontWeight: '700', minWidth: 0 },
});
