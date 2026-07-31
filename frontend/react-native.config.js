const path = require('path');

module.exports = {
  dependencies: {
    'timeflow-alarm': {
      root: path.join(__dirname, 'modules/timeflow-alarm'),
    },
    'timeflow-voice-recorder': {
      root: path.join(__dirname, 'modules/timeflow-voice-recorder'),
    },
  },
};
