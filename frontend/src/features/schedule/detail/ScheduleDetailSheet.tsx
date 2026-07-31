import {
  CalendarClock,
  CheckCircle2,
  Clock3,
  Pencil,
  RotateCcw,
  Trash2,
} from 'lucide-react-native';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';

import { BackButton } from '@/shared/components/BackButton';
import { useAppDialog } from '@/shared/components/AppDialogProvider';
import type { Schedule } from '@/contracts';
import { colors } from '@/shared/theme';
import { formatFullDate } from '@/shared/utils/date';

import {
  scheduleColor,
  scheduleDate,
  scheduleDuration,
  scheduleRange,
  scheduleSourceLabel,
  scheduleStatusLabel,
} from '../presentation/scheduleFormat';
import { detailStyles as styles } from './detail.styles';

export function ScheduleDetailSheet({
  onClose,
  onDelete,
  onEdit,
  onOpenDay,
  onToggle,
  schedule,
}: {
  onClose: () => void;
  onDelete?: () => void;
  onEdit?: () => void;
  onOpenDay: (date: Date) => void;
  onToggle?: () => void;
  schedule: Schedule | null;
}) {
  const { confirm } = useAppDialog();
  const editable = schedule != null && schedule.status !== 'deleted';
  const actionIsEdit = Boolean(onEdit && editable);
  const canDelete = Boolean(onDelete && editable);
  const canToggle = Boolean(onToggle && editable);
  const statusLabel = schedule ? scheduleStatusLabel(schedule) : '';
  const isDone = schedule?.status === 'done';
  const itemDate = schedule ? scheduleDate(schedule) : null;
  const displayDate = itemDate ?? new Date();
  const dateLabel = schedule?.start_time ? formatFullDate(displayDate) : '按地点触发';
  const rangeLabel = schedule ? scheduleRange(schedule) : '';

  const handleDelete = async () => {
    if (!canDelete) return;
    const confirmed = await confirm({
      title: '删除日程',
      message: '确定删除这个日程吗？相关提醒也会一并取消。',
      confirmLabel: '删除',
      cancelLabel: '取消',
      tone: 'danger',
    });
    if (!confirmed) return;
    onDelete?.();
    onClose();
  };

  return (
    <Modal animationType="fade" onRequestClose={onClose} transparent visible={schedule !== null}>
      <View style={styles.scheduleModalBackdrop}>
        <Pressable
          accessibilityLabel="关闭日程详情"
          accessibilityRole="button"
          onPress={onClose}
          style={styles.scheduleModalDismiss}
        />
        {schedule && (
          <View style={styles.scheduleModalSheet}>
            <View style={styles.scheduleModalReferenceHeader}>
              <BackButton accessibilityLabel="返回日程" onPress={onClose} />
              <View style={styles.scheduleModalHeaderCopy}>
                <Text style={styles.scheduleModalHeaderTitle}>安排详情</Text>
              </View>
              <View
                style={[styles.scheduleModalStatus, isDone && styles.scheduleModalStatusCompleted]}
              >
                {isDone && <CheckCircle2 color="#63866E" size={11} strokeWidth={2.2} />}
                <Text
                  style={[
                    styles.scheduleModalStatusText,
                    isDone && styles.scheduleModalStatusTextCompleted,
                  ]}
                >
                  {statusLabel}
                </Text>
              </View>
            </View>
            <ScrollView
              contentContainerStyle={styles.scheduleModalScrollContent}
              showsVerticalScrollIndicator={false}
              style={styles.scheduleModalScroll}
            >
              <View style={styles.scheduleModalTitleBlock}>
                <Text style={styles.scheduleModalSource}>{scheduleSourceLabel(schedule)}</Text>
                <Text style={styles.scheduleModalTitle}>{schedule.title}</Text>
                <Text style={styles.scheduleModalSubtitle}>
                  {isDone ? '已完成 · 可回顾这次安排' : '安排已加入你的时间轴'}
                </Text>
              </View>
              <View style={styles.scheduleModalTimeCard}>
                <View
                  style={[
                    styles.scheduleModalTimeIcon,
                    { backgroundColor: scheduleColor(schedule) },
                  ]}
                >
                  <CalendarClock color={colors.surface} size={18} strokeWidth={2.1} />
                </View>
                <View style={styles.scheduleModalTimeCopy}>
                  <Text style={styles.scheduleModalTimeEyebrow}>日期与时间</Text>
                  <Text style={styles.scheduleModalDate}>{dateLabel}</Text>
                  <Text style={styles.scheduleModalTime}>{rangeLabel}</Text>
                </View>
                <Text style={styles.scheduleModalDuration}>{scheduleDuration(schedule)}</Text>
              </View>
              <View style={styles.scheduleModalMeta}>
                <View style={styles.scheduleModalMetaRow}>
                  <View style={styles.scheduleModalMetaLabelGroup}>
                    <Clock3 color={colors.sub} size={13} strokeWidth={1.8} />
                    <Text style={styles.scheduleModalMetaLabel}>状态</Text>
                  </View>
                  <Text
                    style={[styles.scheduleModalMetaValue, isDone && styles.scheduleModalCompleted]}
                  >
                    {statusLabel}
                  </Text>
                </View>
              </View>
            </ScrollView>
            <View style={styles.scheduleModalActions}>
              <Pressable
                accessibilityLabel={isDone ? '恢复日程' : '完成日程'}
                accessibilityRole="button"
                disabled={!canToggle}
                onPress={onToggle}
                style={[
                  styles.scheduleModalSecondaryAction,
                  !canToggle && styles.scheduleModalDeleteDisabled,
                ]}
              >
                {isDone ? (
                  <RotateCcw color={colors.ink} size={14} strokeWidth={2.2} />
                ) : (
                  <CheckCircle2 color={colors.ink} size={14} strokeWidth={2.2} />
                )}
                <Text style={styles.scheduleModalSecondaryText}>{isDone ? '恢复' : '完成'}</Text>
              </Pressable>
              <Pressable
                accessibilityLabel="删除日程"
                accessibilityRole="button"
                disabled={!canDelete}
                onPress={() => void handleDelete()}
                style={[
                  styles.scheduleModalSecondaryAction,
                  canDelete && styles.scheduleModalDeleteAction,
                  !canDelete && styles.scheduleModalDeleteDisabled,
                ]}
              >
                {canDelete ? <Trash2 color={colors.coral} size={14} strokeWidth={2.2} /> : null}
                <Text
                  style={[
                    styles.scheduleModalSecondaryText,
                    canDelete && styles.scheduleModalDeleteText,
                  ]}
                >
                  删除
                </Text>
              </Pressable>
              <Pressable
                accessibilityLabel={actionIsEdit ? '编辑日程' : '查看当天日程'}
                accessibilityRole="button"
                onPress={() => {
                  onClose();
                  if (actionIsEdit) onEdit?.();
                  else onOpenDay(displayDate);
                }}
                style={styles.scheduleModalPrimaryAction}
              >
                {actionIsEdit && <Pencil color={colors.surface} size={14} strokeWidth={2.2} />}
                <Text style={styles.scheduleModalPrimaryText}>
                  {actionIsEdit ? '编辑日程' : '查看当天'}
                </Text>
              </Pressable>
            </View>
          </View>
        )}
      </View>
    </Modal>
  );
}
