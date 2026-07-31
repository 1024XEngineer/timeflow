import { useState } from 'react';
import { MapPin, Plus } from 'lucide-react-native';
import { Pressable, ScrollView, Text, View } from 'react-native';

import { BottomSheetFrame } from '@/shared/components/BottomSheetFrame';
import { colors } from '@/shared/theme';

import { AddressEditorSheet } from './AddressEditorSheet';
import { locationPickerStyles as styles } from './LocationPickerSheet.styles';
import type { SavedLocation } from './types';
import { createSavedLocation } from './utils';

type LocationPickerSheetProps = {
  locations: SavedLocation[];
  onClose: () => void;
  onSelect: (location: SavedLocation) => void;
  onUpsertLocation: (location: SavedLocation) => void;
  selectedId?: string | null;
  visible: boolean;
};

export function LocationPickerSheet({
  locations,
  onClose,
  onSelect,
  onUpsertLocation,
  selectedId = null,
  visible,
}: LocationPickerSheetProps) {
  const [editorOpen, setEditorOpen] = useState(false);

  const handleClose = () => {
    setEditorOpen(false);
    onClose();
  };

  return (
    <>
      <BottomSheetFrame
        closeAccessibilityLabel="关闭地点选择"
        eyebrow="LOCATIONS"
        onClose={handleClose}
        sheetStyle={styles.sheet}
        title="选择地点"
        visible={visible && !editorOpen}
      >
        <ScrollView
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          style={styles.list}
        >
          {locations.length === 0 ? (
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>还没有常用地点</Text>
              <Text style={styles.emptyHint}>先添加一个地点，再用于日程提醒</Text>
            </View>
          ) : (
            locations.map((location) => {
              const selected = location.id === selectedId;
              return (
                <Pressable
                  accessibilityLabel={`选择地点 ${location.name ?? location.address}`}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  key={location.id}
                  onPress={() => {
                    onSelect(location);
                    handleClose();
                  }}
                  style={[styles.item, selected && styles.itemSelected]}
                >
                  <View style={styles.itemIcon}>
                    <MapPin color={colors.deep} size={16} strokeWidth={2} />
                  </View>
                  <View style={styles.itemCopy}>
                    <Text style={styles.itemName}>{location.name ?? '未命名地点'}</Text>
                    <Text numberOfLines={2} style={styles.itemAddress}>
                      {location.address}
                    </Text>
                  </View>
                </Pressable>
              );
            })
          )}
        </ScrollView>

        <Pressable
          accessibilityLabel="添加地点"
          accessibilityRole="button"
          onPress={() => setEditorOpen(true)}
          style={styles.addButton}
        >
          <Plus color={colors.surface} size={16} strokeWidth={2.4} />
          <Text style={styles.addButtonText}>添加地点</Text>
        </Pressable>
      </BottomSheetFrame>

      <AddressEditorSheet
        onClose={() => setEditorOpen(false)}
        onSave={(location) => {
          const saved = createSavedLocation(location);
          onUpsertLocation(saved);
          onSelect(saved);
          setEditorOpen(false);
          onClose();
        }}
        title="添加地点"
        visible={visible && editorOpen}
      />
    </>
  );
}
