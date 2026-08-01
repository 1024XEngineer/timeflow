import { StyleSheet } from 'react-native';

/** 底部 Sheet 共用外壳：backdrop / dismiss / handle / close。 */
export const sheetChromeStyles = StyleSheet.create({
  backdrop: {
    backgroundColor: 'rgba(14, 23, 19, 0.46)',
    flex: 1,
    justifyContent: 'flex-end',
  },
  dismiss: { bottom: 0, left: 0, position: 'absolute', right: 0, top: 0 },
  handle: {
    alignSelf: 'center',
    backgroundColor: '#D7D4CD',
    borderRadius: 3,
    height: 4,
    marginBottom: 16,
    width: 35,
  },
  close: {
    alignItems: 'center',
    backgroundColor: '#ECE9E2',
    borderRadius: 10,
    height: 30,
    justifyContent: 'center',
    width: 30,
  },
});
