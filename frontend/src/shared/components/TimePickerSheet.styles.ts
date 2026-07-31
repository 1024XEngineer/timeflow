import { StyleSheet } from 'react-native';

import { colors } from '@/shared/theme';

export const timePickerSheetStyles = StyleSheet.create({
  preview: {
    color: colors.ink,
    fontSize: 28,
    fontWeight: '800',
    marginBottom: 12,
    marginTop: 4,
    textAlign: 'center',
  },
  columns: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 4,
  },
  column: { flex: 1 },
  columnLabel: {
    color: colors.sub,
    fontSize: 12,
    fontWeight: '800',
    marginBottom: 8,
    textAlign: 'center',
  },
  list: {
    backgroundColor: '#F8FAF7',
    borderColor: colors.line,
    borderRadius: 14,
    borderWidth: 1,
    maxHeight: 220,
  },
  item: {
    alignItems: 'center',
    height: 44,
    justifyContent: 'center',
  },
  itemSelected: {
    backgroundColor: colors.limeSoft,
  },
  itemText: {
    color: colors.ink,
    fontSize: 16,
    fontWeight: '600',
  },
  itemTextSelected: {
    color: colors.deep,
    fontWeight: '800',
  },
  confirm: {
    alignItems: 'center',
    backgroundColor: colors.deep,
    borderRadius: 13,
    height: 48,
    justifyContent: 'center',
    marginHorizontal: 4,
    marginTop: 14,
  },
  confirmText: {
    color: colors.surface,
    fontSize: 13,
    fontWeight: '800',
  },
});
