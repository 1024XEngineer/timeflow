const path = require('path');

module.exports = {
  dependencies: {
    'timeflow-alarm': {
      root: path.join(__dirname, 'modules/timeflow-alarm'),
    },
    'timeflow-baidu-location': {
      root: path.join(__dirname, 'modules/timeflow-baidu-location'),
    },
  },
};
