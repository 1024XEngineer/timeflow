import { StyleSheet } from 'react-native';

import { colors, spacing } from '../constants/theme';

export const commonStyles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.background },
  appFrame: { flex: 1, backgroundColor: colors.background },
  screen: { flex: 1, paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: spacing.md,
  },
  eyebrow: { color: colors.sub, fontSize: 9, marginBottom: 5 },
  pageTitle: { color: colors.ink, fontSize: 25, fontWeight: '800', letterSpacing: 0 },
  headerActions: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  addButton: {
    alignItems: 'center',
    backgroundColor: '#EAE7DF',
    borderRadius: 13,
    height: 37,
    justifyContent: 'center',
    width: 37,
  },
  addButtonText: { color: colors.deep, fontSize: 20, lineHeight: 23 },
  avatar: {
    alignItems: 'center',
    backgroundColor: colors.deep,
    borderColor: colors.lime,
    borderRadius: 15,
    borderWidth: 2,
    height: 37,
    justifyContent: 'center',
    width: 37,
  },
  avatarLight: { backgroundColor: colors.lime, borderColor: colors.lime, height: 53, width: 53 },
  viewSwitch: { backgroundColor: '#EBE8E1', borderRadius: 13, flexDirection: 'row', padding: 4 },
  switchOption: {
    alignItems: 'center',
    borderRadius: 10,
    flex: 1,
    height: 32,
    justifyContent: 'center',
  },
  switchOptionActive: { backgroundColor: colors.surface, elevation: 2 },
  switchText: { color: colors.sub, fontSize: 10 },
  switchTextActive: { color: colors.ink, fontWeight: '800' },
});
