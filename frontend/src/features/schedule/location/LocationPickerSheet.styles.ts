import { StyleSheet } from 'react-native';

import { colors } from '@/shared/theme';

export const locationPickerStyles = StyleSheet.create({
  sheet: {
    maxHeight: '78%',
    paddingHorizontal: 20,
  },
  list: { flexGrow: 0, flexShrink: 1 },
  listContent: { gap: 8, paddingBottom: 8 },
  empty: {
    alignItems: 'center',
    backgroundColor: colors.limeSoft,
    borderColor: '#D7E6B2',
    borderRadius: 14,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 22,
  },
  emptyTitle: { color: colors.deep, fontSize: 14, fontWeight: '800' },
  emptyHint: { color: colors.sub, fontSize: 11, marginTop: 6 },
  item: {
    alignItems: 'center',
    backgroundColor: '#F8FAF7',
    borderColor: colors.line,
    borderRadius: 14,
    borderWidth: 1,
    flexDirection: 'row',
    minHeight: 68,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  itemSelected: {
    backgroundColor: colors.limeSoft,
    borderColor: '#C7D69A',
  },
  itemIcon: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: 10,
    height: 36,
    justifyContent: 'center',
    width: 36,
  },
  itemCopy: { flex: 1, marginLeft: 10 },
  itemName: { color: colors.ink, fontSize: 14, fontWeight: '800' },
  itemAddress: { color: colors.sub, fontSize: 12, lineHeight: 17, marginTop: 3 },
  addButton: {
    alignItems: 'center',
    backgroundColor: colors.deep,
    borderRadius: 13,
    flexDirection: 'row',
    gap: 8,
    height: 50,
    justifyContent: 'center',
    marginTop: 12,
  },
  addButtonText: { color: colors.surface, fontSize: 13, fontWeight: '800' },
});
