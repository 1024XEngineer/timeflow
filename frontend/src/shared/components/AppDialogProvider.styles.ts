import { StyleSheet } from 'react-native';

import { colors } from '@/shared/theme';

export const appDialogStyles = StyleSheet.create({
  backdrop: {
    alignItems: 'center',
    backgroundColor: 'rgba(14, 23, 19, 0.46)',
    flex: 1,
    justifyContent: 'center',
    padding: 24,
  },
  dismiss: {
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  dialog: {
    backgroundColor: colors.surface,
    borderColor: colors.line,
    borderRadius: 8,
    borderWidth: 1,
    padding: 18,
    width: '100%',
    maxWidth: 360,
  },
  icon: {
    alignItems: 'center',
    backgroundColor: colors.limeSoft,
    borderRadius: 8,
    height: 36,
    justifyContent: 'center',
    marginBottom: 13,
    width: 36,
  },
  iconDanger: {
    backgroundColor: colors.peach,
  },
  title: {
    color: colors.ink,
    fontSize: 20,
    fontWeight: '800',
    lineHeight: 26,
  },
  message: {
    color: colors.sub,
    fontSize: 14,
    lineHeight: 21,
    marginTop: 9,
  },
  actions: {
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'flex-end',
    marginTop: 22,
  },
  action: {
    alignItems: 'center',
    borderRadius: 8,
    minHeight: 42,
    minWidth: 84,
    justifyContent: 'center',
    paddingHorizontal: 15,
  },
  cancelAction: {
    backgroundColor: colors.surfaceTint,
  },
  primaryAction: {
    backgroundColor: colors.deep,
  },
  dangerAction: {
    backgroundColor: colors.coral,
  },
  cancelText: {
    color: colors.ink,
    fontSize: 14,
    fontWeight: '800',
  },
  primaryText: {
    color: colors.surface,
    fontSize: 14,
    fontWeight: '800',
  },
});
