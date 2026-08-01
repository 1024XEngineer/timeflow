import { StyleSheet } from 'react-native';

import { colors } from '@/shared/theme';

export const voiceHoldButtonStyles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    alignSelf: 'center',
    gap: 7,
  },
  hintSlot: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 15,
  },
  hint: {
    color: colors.muted,
    fontSize: 11,
    fontWeight: '700',
  },
  hintCancel: {
    color: colors.coral,
  },
  button: {
    alignItems: 'center',
    backgroundColor: colors.deep,
    borderColor: 'transparent',
    borderRadius: 16,
    borderWidth: 1,
    height: 52,
    justifyContent: 'center',
    width: 52,
  },
  buttonListening: {
    borderColor: 'rgba(215,243,106,0.55)',
    width: 96,
  },
  buttonCancel: {
    backgroundColor: colors.peach,
    borderColor: '#F1C6B6',
    width: 76,
  },
  wave: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 4,
    height: 24,
  },
  waveBar: {
    backgroundColor: colors.lime,
    borderRadius: 999,
    width: 3.5,
  },
});
