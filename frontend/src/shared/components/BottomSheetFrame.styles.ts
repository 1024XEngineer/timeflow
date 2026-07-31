import { StyleSheet } from 'react-native';

import { colors } from '@/shared/theme';

import { sheetChromeStyles } from './sheetChrome.styles';

const localStyles = StyleSheet.create({
  keyboardAvoider: { flex: 1 },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 26,
    borderTopRightRadius: 26,
    paddingBottom: 28,
    paddingHorizontal: 16,
    paddingTop: 10,
  },
  header: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 8,
    paddingHorizontal: 4,
  },
  eyebrow: { color: colors.muted, fontSize: 10, fontWeight: '700' },
  title: { color: colors.ink, fontSize: 22, fontWeight: '800', marginTop: 5 },
});

export const bottomSheetFrameStyles = {
  backdrop: sheetChromeStyles.backdrop,
  dismiss: sheetChromeStyles.dismiss,
  handle: sheetChromeStyles.handle,
  close: sheetChromeStyles.close,
  ...localStyles,
};
