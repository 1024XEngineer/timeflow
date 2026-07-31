import { StyleSheet } from 'react-native';

import { colors } from '@/shared/theme';

export const scheduleRowStyles = StyleSheet.create({
  scheduleRow: { alignItems: 'flex-start', flexDirection: 'row', minHeight: 84 },
  scheduleRowCompact: { minHeight: 72 },
  scheduleRowCompleted: { opacity: 0.82 },
  scheduleTime: {
    color: '#7D8983',
    fontSize: 11,
    lineHeight: 14,
    paddingTop: 7,
    width: 58,
  },
  scheduleTimeCompact: { paddingTop: 6, width: 52 },
  scheduleRail: { alignItems: 'center', alignSelf: 'stretch', paddingTop: 6, width: 17 },
  scheduleRailCompact: { paddingTop: 8, width: 12 },
  scheduleDot: { borderRadius: 6, height: 11, width: 11, zIndex: 1 },
  scheduleDotCompleted: {
    alignItems: 'center',
    backgroundColor: '#7CA38A',
    justifyContent: 'center',
  },
  scheduleLine: {
    backgroundColor: '#D7DCD7',
    bottom: 0,
    position: 'absolute',
    top: 19,
    width: 1,
  },
  scheduleCopy: {
    borderBottomColor: colors.line,
    borderBottomWidth: 1,
    flex: 1,
    minWidth: 0,
    paddingBottom: 15,
    paddingTop: 3,
  },
  scheduleCopyCompact: { marginBottom: 4, paddingBottom: 14, paddingTop: 4 },
  scheduleHeading: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  scheduleTitleCompact: { fontSize: 13, lineHeight: 22 },
  scheduleTitle: {
    color: colors.ink,
    flex: 1,
    fontSize: 14,
    fontWeight: '700',
    lineHeight: 19,
  },
  scheduleTitleCompleted: { color: '#7F8882', textDecorationLine: 'line-through' },
  scheduleMeta: {
    alignSelf: 'flex-start',
    backgroundColor: '#ECF2D7',
    borderRadius: 8,
    color: '#70814F',
    fontSize: 8,
    marginTop: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  scheduleRange: { color: '#818B85', fontSize: 10, lineHeight: 14, marginTop: 7 },
  scheduleRangeCompact: { color: '#747C77', fontSize: 11, lineHeight: 16, marginTop: 4 },
});
