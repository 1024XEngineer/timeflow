import { useState } from 'react';
import { MapPin } from 'lucide-react-native';
import { Modal, Pressable, Text, TextInput, View } from 'react-native';

import { BottomSheetFrame } from '@/shared/components/BottomSheetFrame';
import { colors } from '@/shared/theme';

import { addressEditorStyles as styles } from './AddressEditorSheet.styles';
import { MapPicker, type MapLocation } from './MapPicker';

type AddressEditorSheetProps = {
  initialLocation?: MapLocation | null;
  onClose: () => void;
  onSave: (location: MapLocation) => void;
  title: string;
  visible: boolean;
};

export function AddressEditorSheet({
  initialLocation = null,
  onClose,
  onSave,
  title,
  visible,
}: AddressEditorSheetProps) {
  const [mapOpen, setMapOpen] = useState(false);
  const [pendingLocation, setPendingLocation] = useState<MapLocation | null>(initialLocation);
  const [locationName, setLocationName] = useState(initialLocation?.name ?? '');
  const [formError, setFormError] = useState('');
  const [syncedVisible, setSyncedVisible] = useState(visible);
  const [syncedInitial, setSyncedInitial] = useState(initialLocation);

  if (visible !== syncedVisible || initialLocation !== syncedInitial) {
    setSyncedVisible(visible);
    setSyncedInitial(initialLocation);
    if (visible) {
      setPendingLocation(initialLocation);
      setLocationName(initialLocation?.name ?? '');
      setFormError('');
      setMapOpen(false);
    }
  }

  const handleClose = () => {
    setMapOpen(false);
    setFormError('');
    onClose();
  };

  const handleSave = () => {
    if (!pendingLocation) {
      setFormError('请选择一个地图位置');
      return;
    }
    const nextName = locationName.trim();
    onSave({ ...pendingLocation, name: nextName || undefined });
  };

  return (
    <>
      <BottomSheetFrame
        closeAccessibilityLabel="关闭地址编辑"
        eyebrow="ADDRESS"
        keyboardAvoiding
        onClose={handleClose}
        sheetStyle={styles.sheet}
        title={title}
        visible={visible && !mapOpen}
      >
        <Text style={styles.fieldLabel}>地点名称</Text>
        <TextInput
          accessibilityLabel="地点名称"
          autoFocus
          onChangeText={setLocationName}
          placeholder="例如：家、公司、学校"
          placeholderTextColor="#9AA39D"
          returnKeyType="next"
          style={styles.input}
          value={locationName}
        />
        <Text style={styles.fieldLabel}>地图位置</Text>
        <Pressable
          accessibilityLabel="选择地图位置"
          accessibilityRole="button"
          onPress={() => {
            setFormError('');
            setMapOpen(true);
          }}
          style={styles.mapField}
        >
          <View style={styles.mapIcon}>
            <MapPin color={colors.deep} size={17} strokeWidth={2} />
          </View>
          <View style={styles.mapCopy}>
            <Text numberOfLines={2} style={styles.mapTitle}>
              {pendingLocation?.address ?? '请选择地点'}
            </Text>
            <Text style={styles.mapHint}>{pendingLocation ? '点击重新选择' : '点击打开地图'}</Text>
          </View>
        </Pressable>
        {formError ? <Text style={styles.error}>{formError}</Text> : null}
        <Pressable
          accessibilityLabel="保存地点"
          accessibilityRole="button"
          onPress={handleSave}
          style={styles.primary}
        >
          <Text style={styles.primaryText}>保存地址</Text>
        </Pressable>
      </BottomSheetFrame>

      <Modal
        animationType="slide"
        onRequestClose={() => setMapOpen(false)}
        visible={visible && mapOpen}
      >
        <MapPicker
          initialLocation={pendingLocation ?? initialLocation}
          onCancel={() => setMapOpen(false)}
          onConfirm={(location) => {
            setMapOpen(false);
            setPendingLocation(location);
            setFormError('');
          }}
        />
      </Modal>
    </>
  );
}
