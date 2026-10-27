'use strict';

module.exports = {
  ...require('./commands/init'),
  ...require('./utils/detector'),
  ...require('./templates/detoxrc'),
};
