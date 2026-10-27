#!/usr/bin/env node

'use strict';

try {
  require('../dist/cli.js');
} catch (error) {
  if (error && error.code === 'MODULE_NOT_FOUND') {
    console.error('ui-ios has not been built. Run `npm run build` or install it from its GitHub repository.');
  } else {
    console.error(error.message);
  }
  process.exitCode = 1;
}
