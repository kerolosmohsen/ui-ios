'use strict';
const chalk = require('chalk');
const logger = {
    info: (message) => console.log(chalk.blue('ℹ'), message),
    success: (message) => console.log(chalk.green('✓'), message),
    warning: (message) => console.log(chalk.yellow('⚠'), message),
    error: (message) => console.error(chalk.red('✗'), message),
    step: (number, total, message) => console.log(chalk.cyan(`[${number}/${total}]`), message),
    divider: () => console.log(chalk.gray('─'.repeat(56))),
};
module.exports = logger;
//# sourceMappingURL=logger.js.map