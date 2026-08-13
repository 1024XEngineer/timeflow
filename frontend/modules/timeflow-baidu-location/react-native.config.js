module.exports = {
  dependency: {
    platforms: {
      android: {
        sourceDir: './android',
        packageImportPath: 'import com.timeflow.baidulocation.BaiduLocationPackage;',
        packageInstance: 'new BaiduLocationPackage()',
      },
      ios: null,
    },
  },
};
