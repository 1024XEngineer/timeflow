import { StyleSheet } from 'react-native';

import { colors } from '@/shared/theme';

export const scheduleScreenStyles = StyleSheet.create({
  screen: { flex: 1, paddingBottom: 76, paddingHorizontal: 20, paddingTop: 20 },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 14,
    minHeight: 50,
  },
  headerButton: { flex: 1, marginRight: 12 },
  headerEyebrow: {
    color: colors.muted,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0,
    marginBottom: 4,
  },
  headerTitleRow: { alignItems: 'center', flexDirection: 'row', gap: 4 },
  headerTitle: {
    color: colors.ink,
    fontSize: 28,
    fontWeight: '800',
    letterSpacing: 0,
    lineHeight: 29,
  },
  addButton: {
    alignItems: 'center',
    backgroundColor: colors.limeSoft,
    borderColor: '#D4E3B1',
    borderRadius: 13,
    borderWidth: 1,
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  addButtonDisabled: { opacity: 0.45 },
});
