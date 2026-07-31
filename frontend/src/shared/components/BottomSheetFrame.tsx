import type { ReactNode } from 'react';
import { X } from 'lucide-react-native';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { colors } from '@/shared/theme';

import { bottomSheetFrameStyles as styles } from './BottomSheetFrame.styles';

type BottomSheetFrameProps = {
  visible: boolean;
  onClose: () => void;
  closeAccessibilityLabel: string;
  children: ReactNode;
  /** 标准 eyebrow + title 头；与 header 二选一。 */
  eyebrow?: string;
  title?: string;
  /** 自定义头部左侧内容（覆盖 eyebrow/title）。 */
  header?: ReactNode;
  showClose?: boolean;
  showHandle?: boolean;
  sheetStyle?: StyleProp<ViewStyle>;
  headerStyle?: StyleProp<ViewStyle>;
  keyboardAvoiding?: boolean;
  animationType?: 'slide' | 'fade' | 'none';
};

/**
 * 底部 Sheet 共用外壳：Modal → backdrop → dismiss → sheet → handle → header → content。
 */
export function BottomSheetFrame({
  visible,
  onClose,
  closeAccessibilityLabel,
  children,
  eyebrow,
  title,
  header,
  showClose = true,
  showHandle = true,
  sheetStyle,
  headerStyle,
  keyboardAvoiding = false,
  animationType = 'slide',
}: BottomSheetFrameProps) {
  const hasHeader = Boolean(header || title || eyebrow);
  const headerLeft = header ?? (
    <View>
      {eyebrow ? <Text style={styles.eyebrow}>{eyebrow}</Text> : null}
      {title ? <Text style={styles.title}>{title}</Text> : null}
    </View>
  );

  const body = (
    <View style={styles.backdrop}>
      <Pressable
        accessibilityLabel={closeAccessibilityLabel}
        accessibilityRole="button"
        onPress={onClose}
        style={styles.dismiss}
      />
      <View style={[styles.sheet, sheetStyle]}>
        {showHandle ? <View style={styles.handle} /> : null}
        {hasHeader ? (
          <View style={[styles.header, headerStyle]}>
            {headerLeft}
            {showClose ? (
              <Pressable
                accessibilityLabel={closeAccessibilityLabel}
                accessibilityRole="button"
                onPress={onClose}
                style={styles.close}
              >
                <X color={colors.sub} size={18} strokeWidth={2.2} />
              </Pressable>
            ) : null}
          </View>
        ) : null}
        {children}
      </View>
    </View>
  );

  return (
    <Modal animationType={animationType} onRequestClose={onClose} transparent visible={visible}>
      {keyboardAvoiding ? (
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.keyboardAvoider}
        >
          {body}
        </KeyboardAvoidingView>
      ) : (
        body
      )}
    </Modal>
  );
}
