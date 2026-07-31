import { StyleSheet } from 'react-native';

import { colors } from '@/shared/theme';

export const providerStyles = StyleSheet.create({
  desktopCanvas: {
    alignItems: 'center',
    backgroundColor: '#DDE2DF',
    flex: 1,
    justifyContent: 'center',
    padding: 24,
  },
  compactCanvas: { padding: 0 },
  webAppFrame: {
    backgroundColor: colors.background,
    borderColor: '#C9CFCC',
    borderRadius: 24,
    borderWidth: 1,
    boxShadow: '0 20px 60px rgba(20, 40, 33, 0.18)',
    flex: 1,
    maxHeight: 900,
    maxWidth: 430,
    overflow: 'hidden',
    width: '100%',
  },
  compactFrame: {
    borderRadius: 0,
    borderWidth: 0,
    maxHeight: '100%',
  },
});
