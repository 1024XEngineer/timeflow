import { StyleSheet } from 'react-native';

import { colors } from '@/shared/theme';

export const datePickerSheetStyles = StyleSheet.create({
  calendar: {
    borderRadius: 14,
    overflow: 'hidden',
  },
  todayButton: {
    alignItems: 'center',
    backgroundColor: colors.limeSoft,
    borderColor: '#D7E6B2',
    borderRadius: 13,
    borderWidth: 1,
    height: 48,
    justifyContent: 'center',
    marginHorizontal: 4,
    marginTop: 12,
  },
  todayButtonText: { color: colors.deep, fontSize: 13, fontWeight: '800' },
});
