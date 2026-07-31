import { StyleSheet } from 'react-native';

import { colors } from '@/shared/theme';

export const addressEditorStyles = StyleSheet.create({
  sheet: {
    paddingHorizontal: 20,
  },
  fieldLabel: { color: colors.ink, fontSize: 12, fontWeight: '800', marginTop: 20 },
  input: {
    backgroundColor: '#FFFFFF',
    borderColor: '#C7D0C9',
    borderRadius: 14,
    borderWidth: 1,
    color: colors.ink,
    fontSize: 14,
    height: 52,
    marginTop: 8,
    outlineColor: 'transparent',
    outlineStyle: 'solid',
    outlineWidth: 0,
    paddingHorizontal: 13,
  },
  error: { color: '#A85F4E', fontSize: 11, marginTop: 6 },
  mapField: {
    alignItems: 'center',
    backgroundColor: '#F8FAF7',
    borderColor: colors.line,
    borderRadius: 14,
    borderWidth: 1,
    flexDirection: 'row',
    marginTop: 8,
    minHeight: 66,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  mapIcon: {
    alignItems: 'center',
    backgroundColor: colors.limeSoft,
    borderRadius: 10,
    height: 36,
    justifyContent: 'center',
    width: 36,
  },
  mapCopy: { flex: 1, marginLeft: 10 },
  mapTitle: { color: colors.ink, fontSize: 13, lineHeight: 18 },
  mapHint: { color: colors.sub, fontSize: 10, marginTop: 3 },
  primary: {
    alignItems: 'center',
    backgroundColor: colors.deep,
    borderRadius: 13,
    height: 50,
    justifyContent: 'center',
    marginTop: 17,
  },
  primaryText: { color: colors.surface, fontSize: 13, fontWeight: '800' },
});
