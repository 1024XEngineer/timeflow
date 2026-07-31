import { useState } from 'react';
import { ChevronDown, ChevronUp, MapPin } from 'lucide-react-native';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';

import { colors } from '@/shared/theme';
import type { ScheduleType, ScheduleUpsertPayload as ScheduleDraft } from '@/contracts';
import type { SavedLocation } from '../location';
import { createSavedLocation, matchSavedLocation, LocationPickerSheet } from '../location';

import {
  currentTimezone,
  dateAndTimeFromIso,
  defaultCreateDateAndTime,
  isoFromDateAndTime,
  optionalNumber,
} from './datetime';
import { createSheetStyles as styles } from './createSheet.styles';
import { ClearFieldButton } from './ClearFieldButton';
import { DateTimeField } from './DateTimeField';

export function StandardCreateSheet({
  initialDraft,
  onClose,
  onSave,
  onUpsertLocation,
  savedLocations,
}: {
  initialDraft?: ScheduleDraft | null;
  onClose: () => void;
  onSave: (draft: ScheduleDraft) => void | Promise<void>;
  onUpsertLocation: (location: SavedLocation) => void;
  savedLocations: SavedLocation[];
}) {
  const initialStart = initialDraft?.start_time
    ? dateAndTimeFromIso(initialDraft.start_time)
    : defaultCreateDateAndTime();
  const initialEnd = dateAndTimeFromIso(initialDraft?.end_time);
  const initialLocation =
    matchSavedLocation(savedLocations, {
      latitude: initialDraft?.latitude,
      longitude: initialDraft?.longitude,
      location_name: initialDraft?.location_name,
      location_address: initialDraft?.location_address,
    }) ??
    (initialDraft?.latitude != null && initialDraft?.longitude != null
      ? createSavedLocation({
          address: initialDraft.location_address ?? '',
          latitude: initialDraft.latitude,
          longitude: initialDraft.longitude,
          name: initialDraft.location_name ?? undefined,
        })
      : null);
  const [title, setTitle] = useState(initialDraft?.title ?? '');
  const [notes, setNotes] = useState(initialDraft?.notes ?? '');
  const [date, setDate] = useState(initialStart.date);
  const [start, setStart] = useState(initialStart.time);
  const [end, setEnd] = useState(initialEnd.time);
  const [selectedLocation, setSelectedLocation] = useState<SavedLocation | null>(initialLocation);
  const [geofenceRadius, setGeofenceRadius] = useState(
    String(initialDraft?.geofence_radius_meters ?? 100),
  );
  const [remindOffset, setRemindOffset] = useState(
    String(initialDraft?.time_remind_offset_minutes ?? 0),
  );
  const [moreOpen, setMoreOpen] = useState(() =>
    Boolean(
      initialDraft?.notes ||
      initialEnd.time ||
      (initialDraft?.geofence_radius_meters != null &&
        initialDraft.geofence_radius_meters !== 100) ||
      (initialDraft?.time_remind_offset_minutes != null &&
        initialDraft.time_remind_offset_minutes !== 0),
    ),
  );
  const [locationPickerOpen, setLocationPickerOpen] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const editing = Boolean(initialDraft?.schedule_id);
  const MoreIcon = moreOpen ? ChevronUp : ChevronDown;

  const applyLocation = (location: SavedLocation | null) => {
    setSelectedLocation(location);
  };

  const handleSave = async () => {
    const normalizedTitle = title.trim();
    const startTime = date && start ? isoFromDateAndTime(date, start) : null;
    const endTime = startTime && end ? isoFromDateAndTime(date, end) : null;
    const latitudeValue = selectedLocation?.latitude ?? null;
    const longitudeValue = selectedLocation?.longitude ?? null;
    const hasLocation = selectedLocation != null && latitudeValue != null && longitudeValue != null;
    const radiusValue = optionalNumber(geofenceRadius);
    const remindOffsetValue = optionalNumber(remindOffset);
    // 有时间 → time；仅地点 → location；时间和地点都有仍按 time。
    const resolvedType: ScheduleType = startTime ? 'time' : 'location';

    if (!normalizedTitle) {
      setError('请填写日程标题。');
      return;
    }
    if (!startTime && !hasLocation) {
      setError('请至少填写时间或地点。');
      return;
    }
    if (date && !start) {
      setError('已选日期时请一并选择开始时间。');
      return;
    }
    if (start && !date) {
      setError('已选时间时请一并选择日期。');
      return;
    }
    if (startTime && new Date(startTime).getTime() <= Date.now()) {
      setError('开始时间需晚于当前分钟，请选择下一分钟及以后。');
      return;
    }
    if (endTime && startTime && new Date(endTime) < new Date(startTime)) {
      setError('结束时间不能早于开始时间。');
      return;
    }
    if (
      hasLocation &&
      (radiusValue === null || !Number.isInteger(radiusValue) || radiusValue <= 0)
    ) {
      setError('地理围栏半径必须是大于 0 的整数。');
      return;
    }
    if (
      remindOffsetValue === null ||
      !Number.isInteger(remindOffsetValue) ||
      remindOffsetValue < 0
    ) {
      setError('提前提醒分钟数必须是非负整数。');
      return;
    }

    const nextDraft: ScheduleDraft = {
      end_time: endTime,
      geofence_armed: initialDraft?.geofence_armed ?? null,
      geofence_radius_meters: hasLocation
        ? radiusValue
        : (initialDraft?.geofence_radius_meters ?? 100),
      latitude: latitudeValue,
      location_address: selectedLocation?.address ?? null,
      location_name: selectedLocation?.name?.trim() || selectedLocation?.address || null,
      longitude: longitudeValue,
      notes: notes.trim() || null,
      schedule_id: initialDraft?.schedule_id ?? null,
      schedule_type: resolvedType,
      source_mode: initialDraft?.source_mode ?? 'manual',
      start_time: startTime,
      time_remind_offset_minutes: remindOffsetValue,
      timezone: startTime ? currentTimezone() : null,
      title: normalizedTitle,
    };
    setError('');
    setSaving(true);
    try {
      await onSave(nextDraft);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '保存失败，请稍后重试。');
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={[styles.standardSheet, editing && styles.standardDialog]}>
      <View style={styles.sheetHandle} />
      <ScrollView
        contentContainerStyle={styles.standardFormContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        style={styles.standardFormScroll}
      >
        <View style={styles.sheetHeader}>
          <View>
            <Text style={styles.sheetEyebrow}>
              {editing ? 'EDIT SCHEDULE' : 'STANDARD SCHEDULE'}
            </Text>
            <Text style={styles.sheetTitle}>{editing ? '编辑日程' : '添加日程'}</Text>
          </View>
          <Pressable style={styles.sheetClose} onPress={onClose} accessibilityLabel="关闭">
            <Text style={styles.sheetCloseText}>×</Text>
          </Pressable>
        </View>

        <Text style={styles.fieldLabel}>标题（必填）</Text>
        <TextInput
          accessibilityLabel="日程标题"
          onChangeText={setTitle}
          placeholder="请输入日程标题"
          placeholderTextColor={colors.muted}
          style={styles.formInputControl}
          value={title}
        />

        <Text style={styles.fieldLabel}>日期</Text>
        <View style={styles.fieldWithClear}>
          <View style={styles.fieldWithClearMain}>
            <DateTimeField
              accessibilityLabel="日期"
              mode="date"
              onChange={setDate}
              placeholder="选择日期"
              value={date}
            />
          </View>
          {date ? (
            <ClearFieldButton
              accessibilityLabel="清除日期"
              onPress={() => {
                setDate('');
                setStart('');
                setEnd('');
              }}
            />
          ) : null}
        </View>

        <Text style={styles.fieldLabel}>开始时间</Text>
        <View style={styles.fieldWithClear}>
          <View style={styles.fieldWithClearMain}>
            <DateTimeField
              accessibilityLabel="开始时间"
              mode="time"
              onChange={setStart}
              placeholder="选择时间"
              value={start}
            />
          </View>
          {start ? (
            <ClearFieldButton
              accessibilityLabel="清除开始时间"
              onPress={() => {
                setStart('');
                setEnd('');
              }}
            />
          ) : null}
        </View>

        <Text style={styles.fieldLabel}>地点</Text>
        <View style={styles.locationField}>
          <Pressable
            accessibilityLabel="选择地点"
            accessibilityRole="button"
            onPress={() => setLocationPickerOpen(true)}
            style={styles.locationFieldMain}
          >
            <View style={styles.locationFieldIcon}>
              <MapPin color={colors.deep} size={16} strokeWidth={2} />
            </View>
            <View style={styles.locationFieldCopy}>
              <Text
                numberOfLines={1}
                style={[
                  styles.locationFieldTitle,
                  !selectedLocation && styles.locationFieldPlaceholder,
                ]}
              >
                {selectedLocation
                  ? (selectedLocation.name ?? selectedLocation.address)
                  : '从常用地点中选择'}
              </Text>
              {selectedLocation ? (
                <Text numberOfLines={1} style={styles.locationFieldHint}>
                  {selectedLocation.address}
                </Text>
              ) : (
                <Text style={styles.locationFieldHint}>时间或地点至少填一项</Text>
              )}
            </View>
          </Pressable>
          {selectedLocation ? (
            <ClearFieldButton accessibilityLabel="清除地点" onPress={() => applyLocation(null)} />
          ) : null}
        </View>

        <Pressable
          accessibilityLabel={moreOpen ? '收起更多信息' : '展开更多信息'}
          accessibilityRole="button"
          accessibilityState={{ expanded: moreOpen }}
          onPress={() => setMoreOpen((open) => !open)}
          style={[styles.moreToggle, moreOpen && styles.moreToggleActive]}
        >
          <Text style={[styles.moreToggleText, moreOpen && styles.moreToggleTextActive]}>
            更多信息
          </Text>
          <MoreIcon color={moreOpen ? '#52745D' : '#7D8982'} size={15} strokeWidth={2.2} />
        </Pressable>

        {moreOpen ? (
          <View style={styles.moreSection}>
            <Text style={styles.fieldLabel}>备注（可选）</Text>
            <TextInput
              accessibilityLabel="日程备注"
              multiline
              onChangeText={setNotes}
              placeholder="补充日程信息"
              placeholderTextColor={colors.muted}
              style={[styles.formInputControl, styles.formInputMultiline]}
              value={notes}
            />
            <Text style={styles.fieldLabel}>结束时间（可选）</Text>
            <DateTimeField
              accessibilityLabel="结束时间"
              mode="time"
              onChange={setEnd}
              placeholder="选择时间"
              value={end}
            />
            <Text style={styles.fieldLabel}>提前提醒（分钟）</Text>
            <TextInput
              accessibilityLabel="提前提醒分钟数"
              keyboardType="number-pad"
              onChangeText={setRemindOffset}
              placeholder="15"
              placeholderTextColor={colors.muted}
              style={styles.formInputControl}
              value={remindOffset}
            />
            {selectedLocation ? (
              <>
                <Text style={styles.fieldLabel}>围栏半径（米）</Text>
                <TextInput
                  accessibilityLabel="地理围栏半径"
                  keyboardType="number-pad"
                  onChangeText={setGeofenceRadius}
                  placeholder="100"
                  placeholderTextColor={colors.muted}
                  style={styles.formInputControl}
                  value={geofenceRadius}
                />
              </>
            ) : null}
          </View>
        ) : null}

        {error ? <Text style={styles.formError}>{error}</Text> : null}
        <Pressable disabled={saving} style={styles.standardPrimary} onPress={handleSave}>
          <Text style={styles.standardPrimaryText}>
            {saving ? '正在保存…' : editing ? '保存修改' : '添加日程'}
          </Text>
        </Pressable>
      </ScrollView>

      <LocationPickerSheet
        locations={savedLocations}
        onClose={() => setLocationPickerOpen(false)}
        onSelect={applyLocation}
        onUpsertLocation={onUpsertLocation}
        selectedId={selectedLocation?.id ?? null}
        visible={locationPickerOpen}
      />
    </View>
  );
}
