import { StyleSheet } from 'react-native';

import { colors } from '@/shared/theme';

export const assistantDraftCardStyles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.line,
    borderRadius: 16,
    borderWidth: 1,
    overflow: 'hidden',
  },
  cardResolved: {
    backgroundColor: '#FBFCFA',
  },
  head: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 11,
    paddingHorizontal: 13,
    paddingTop: 13,
  },
  icon: {
    alignItems: 'center',
    backgroundColor: colors.limeSoft,
    borderRadius: 10,
    height: 34,
    justifyContent: 'center',
    width: 34,
  },
  iconResolved: {
    backgroundColor: '#E7EDE8',
  },
  copy: {
    flex: 1,
    minWidth: 0,
  },
  titleRow: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'space-between',
  },
  title: {
    color: colors.ink,
    flex: 1,
    fontSize: 15,
    fontWeight: '800',
    lineHeight: 20,
  },
  when: {
    color: colors.ink,
    fontSize: 12,
    fontWeight: '600',
    lineHeight: 17,
    marginTop: 5,
  },
  meta: {
    color: colors.sub,
    fontSize: 11,
    lineHeight: 16,
    marginTop: 3,
  },
  clarification: {
    color: '#A16142',
    fontSize: 11,
    lineHeight: 16,
    marginTop: 6,
  },
  chip: {
    alignItems: 'center',
    backgroundColor: colors.limeSoft,
    borderRadius: 8,
    flexDirection: 'row',
    gap: 3,
    paddingHorizontal: 7,
    paddingVertical: 4,
  },
  chipAdded: {
    backgroundColor: '#E4EEE6',
  },
  chipDismissed: {
    backgroundColor: '#EEF0ED',
  },
  chipText: {
    color: '#5C7045',
    fontSize: 9,
    fontWeight: '800',
  },
  chipTextAdded: {
    color: '#63866E',
  },
  chipTextDismissed: {
    color: colors.muted,
  },
  actions: {
    borderTopColor: colors.line,
    borderTopWidth: 1,
    flexDirection: 'row',
    gap: 8,
    marginTop: 13,
    paddingHorizontal: 13,
    paddingVertical: 11,
  },
  action: {
    alignItems: 'center',
    borderRadius: 11,
    flexDirection: 'row',
    gap: 5,
    height: 40,
    justifyContent: 'center',
  },
  actionDismiss: {
    backgroundColor: '#E9ECE8',
    flex: 1,
  },
  actionDismissText: {
    color: colors.ink,
    fontSize: 12,
    fontWeight: '700',
  },
  actionConfirm: {
    backgroundColor: colors.lime,
    flex: 1.4,
  },
  actionConfirmText: {
    color: colors.deep,
    fontSize: 12,
    fontWeight: '800',
  },
  bottomPad: {
    height: 13,
  },
});
