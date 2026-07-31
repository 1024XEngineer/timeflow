module.exports = {
  dependency: {
    platforms: {
      android: {
        sourceDir: './android',
        packageImportPath: 'import com.timeflow.alarm.AlarmPackage;',
        packageInstance: 'new AlarmPackage()',
      },
      ios: null,
    },
  },
};
