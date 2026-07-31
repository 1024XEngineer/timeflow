module.exports = {
  dependency: {
    platforms: {
      android: {
        sourceDir: './android',
        packageImportPath: 'import com.timeflow.voicerecorder.VoiceRecorderPackage;',
        packageInstance: 'new VoiceRecorderPackage()',
      },
      ios: null,
    },
  },
};
