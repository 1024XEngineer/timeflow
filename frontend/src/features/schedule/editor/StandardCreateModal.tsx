import { KeyboardAvoidingView, Modal, Platform, Pressable, View } from 'react-native';

import type { ScheduleUpsertPayload as ScheduleDraft } from '@/contracts';

import type { SavedLocation } from '../location';
import { createSheetStyles as styles } from './createSheet.styles';
import { StandardCreateSheet } from './StandardCreateSheet';

export function StandardCreateModal({
  initialDraft,
  onClose,
  onSave,
  onUpsertLocation,
  savedLocations,
  visible,
}: {
  initialDraft: ScheduleDraft | null;
  onClose: () => void;
  onSave: (draft: ScheduleDraft) => void | Promise<void>;
  onUpsertLocation: (location: SavedLocation) => void;
  savedLocations: SavedLocation[];
  visible: boolean;
}) {
  return (
    <Modal
      visible={visible}
      animationType={initialDraft ? 'fade' : 'slide'}
      onRequestClose={onClose}
      statusBarTranslucent
      transparent
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.modalKeyboardAvoider}
      >
        <View style={initialDraft ? styles.editModalBackdrop : styles.modalBackdrop}>
          <Pressable
            style={initialDraft ? styles.editModalDismiss : styles.modalDismiss}
            onPress={onClose}
          />
          <StandardCreateSheet
            key={initialDraft?.schedule_id ?? 'new-schedule'}
            initialDraft={initialDraft}
            onClose={onClose}
            onSave={onSave}
            onUpsertLocation={onUpsertLocation}
            savedLocations={savedLocations}
          />
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
