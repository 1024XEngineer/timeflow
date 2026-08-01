import { StyleSheet } from 'react-native';

import { colors } from '@/shared/theme';

export const assistantDockStyles = StyleSheet.create({
  dock: {
    alignItems: 'center',
    backgroundColor: 'rgba(244,245,241,0.97)',
    borderTopColor: colors.line,
    borderTopWidth: 1,
    bottom: 0,
    justifyContent: 'flex-end',
    left: 0,
    paddingBottom: 10,
    paddingTop: 6,
    position: 'absolute',
    right: 0,
    zIndex: 20,
  },
});
