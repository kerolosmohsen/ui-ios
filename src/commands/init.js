'use strict';

const path = require('path');
const fs = require('fs-extra');
const { spawnSync } = require('child_process');
const inquirer = require('inquirer');
const ora = require('ora');
const chalk = require('chalk');

const logger = require('../utils/logger');
const {
  detectDetoxDependency,
  detectExistingFiles,
  detectReactNativeProject,
} = require('../utils/detector');
const { generateDetoxConfig } = require('../templates/detoxrc');

const TEMPLATE_FILES = [
  {
    target: '.detoxrc.js',
    template: null,
    description: 'Detox configuration',
  },
  {
    target: 'e2e/jest.config.js',
    template: '../templates/e2e/jest.config.js',
    description: 'Jest configuration',
  },
  {
    target: 'e2e/starter.test.js',
    template: '../templates/e2e/starter.test.js',
    description: 'example UI test',
  },
  {
    target: '.github/workflows/ios-ui-tests.yml',
    template: '../templates/github/workflows/ios-ui-tests.yml',
    description: 'GitHub Actions workflow',
  },
];

function readTemplate(templatePath) {
  const relativeTemplate = templatePath.replace(/^\.\.\/templates\//, '');
  const candidates = [
    path.resolve(__dirname, '..', 'templates', relativeTemplate),
    path.resolve(__dirname, '..', '..', 'src', 'templates', relativeTemplate),
  ];
  const sourcePath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!sourcePath) throw new Error(`Could not locate the bundled template ${relativeTemplate}.`);
  return fs.readFileSync(sourcePath, 'utf8');
}

function packageInstallCommand(packageManager) {
  if (packageManager === 'yarn') return ['yarn', ['add', '--dev', 'detox', 'jest']];
  if (packageManager === 'pnpm') return ['pnpm', ['add', '--save-dev', 'detox', 'jest']];
  return ['npm', ['install', '--save-dev', 'detox', 'jest', '--legacy-peer-deps']];
}

function runPackageInstall(packageManager, cwd) {
  const [command, args] = packageInstallCommand(packageManager);
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  if (result.error) throw new Error(`Could not start ${command}: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`${command} dependency installation failed (exit code ${result.status}).`);
  }
}

function updateGitignore(cwd, dryRun) {
  const filePath = path.join(cwd, '.gitignore');
  if (!fs.existsSync(filePath)) return false;

  const original = fs.readFileSync(filePath, 'utf8');
  const existing = new Set(original.split(/\r?\n/).map((line) => line.trim()));
  const additions = ['artifacts/', 'ios/build/'].filter((line) => !existing.has(line));
  if (additions.length === 0) return false;
  if (!dryRun) {
    const separator = original.length > 0 && !original.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(filePath, `${separator}\n# Detox\n${additions.join('\n')}\n`, 'utf8');
  }
  return true;
}

async function shouldOverwrite(existingFiles, options) {
  if (existingFiles.length === 0) return true;
  if (options.force) return true;
  if (options.dryRun || options.yes || !process.stdin.isTTY) return false;

  const answer = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'overwrite',
      default: false,
      message: `Overwrite existing generated files? (${existingFiles.join(', ')})`,
    },
  ]);
  return answer.overwrite;
}

async function runInit(options = {}) {
  const cwd = process.cwd();
  const isDryRun = Boolean(options.dryRun);
  const projectInfo = detectReactNativeProject(cwd);

  logger.divider();
  logger.step(1, 5, 'Checking the current project...');
  if (!projectInfo.valid) {
    logger.error(projectInfo.reason);
    logger.info('Run `ui-ios init` from the root of a React Native project.');
    process.exitCode = 1;
    return;
  }

  logger.success(`Found ${chalk.cyan(projectInfo.appName)} (React Native ${projectInfo.rnVersion}).`);
  logger.success(`iOS scheme/project: ${chalk.cyan(projectInfo.projectName)}.`);
  if (!projectInfo.hasIosDir || !projectInfo.buildProjectFile) {
    logger.warning('No iOS workspace or Xcode project was found. The generated iOS build will need a native iOS project.');
  }
  if (projectInfo.isExpo && !projectInfo.hasIosDir) {
    logger.warning('This Expo project has no ios/ directory; generate native iOS files before using this workflow.');
  }

  logger.step(2, 5, 'Checking existing configuration...');
  const foundFiles = detectExistingFiles(cwd);
  const shouldReplaceFiles = await shouldOverwrite(foundFiles, options);
  const alternateDetoxConfigs = foundFiles.filter((file) =>
    ['.detoxrc.json', 'detox.config.js'].includes(file)
  );
  const filesToWrite = TEMPLATE_FILES.filter((file) => {
    if (file.target === '.detoxrc.js' && alternateDetoxConfigs.length > 0) return false;
    const exists = fs.existsSync(path.join(cwd, file.target));
    if (!exists) return true;
    return shouldReplaceFiles;
  });
  const skippedFiles = TEMPLATE_FILES.filter((file) => !filesToWrite.includes(file));
  if (skippedFiles.length) {
    logger.info(`Leaving existing files unchanged: ${skippedFiles.map((file) => file.target).join(', ')}`);
  }
  if (alternateDetoxConfigs.length > 0) {
    logger.warning(`Found ${alternateDetoxConfigs.join(' and ')}. Rename or remove the existing Detox config before generating .detoxrc.js.`);
  }

  logger.step(3, 5, 'Preparing Detox and Jest...');
  const hasDetox = detectDetoxDependency(cwd);
  const shouldInstall = !options.skipInstall && (!hasDetox || !fs.existsSync(path.join(cwd, 'node_modules', 'jest')));
  if (shouldInstall && isDryRun) {
    const [command, args] = packageInstallCommand(projectInfo.packageManager);
    logger.info(`[DRY RUN] Would run ${command} ${args.join(' ')}.`);
  } else if (shouldInstall) {
    const spinner = ora(`Installing Detox and Jest with ${projectInfo.packageManager}...`).start();
    try {
      runPackageInstall(projectInfo.packageManager, cwd);
      spinner.succeed('Detox and Jest are installed.');
    } catch (error) {
      spinner.fail('Could not install UI testing dependencies.');
      throw error;
    }
  } else if (options.skipInstall) {
    logger.info('Dependency installation skipped.');
  } else {
    logger.success('Detox and Jest are already installed.');
  }

  logger.step(4, 5, isDryRun ? 'Reviewing planned files...' : 'Writing configuration files...');
  for (const file of filesToWrite) {
    const targetPath = path.join(cwd, file.target);
    const content = file.target === '.detoxrc.js'
      ? generateDetoxConfig(projectInfo, options.simulator || 'iPhone 16')
      : readTemplate(file.template);

    if (isDryRun) {
      logger.info(`[DRY RUN] Would create ${file.target} (${file.description}).`);
      continue;
    }

    fs.ensureDirSync(path.dirname(targetPath));
    fs.writeFileSync(targetPath, content, 'utf8');
    logger.success(`Created ${chalk.cyan(file.target)}.`);
  }

  const gitignoreChanged = updateGitignore(cwd, isDryRun);
  if (gitignoreChanged) {
    logger.info(isDryRun ? '[DRY RUN] Would add Detox build paths to .gitignore.' : 'Updated .gitignore.');
  }

  logger.step(5, 5, 'Setup complete.');
  if (isDryRun) {
    logger.warning('Dry run only; no files were written and no packages were installed.');
    return;
  }

  console.log('\nNext steps:');
  console.log('  1. Review the generated .detoxrc.js and example test.');
  console.log('  2. Commit and push the changes to GitHub.');
  console.log('  3. Open the Actions tab to see the iOS simulator workflow.');
  console.log('\nDetox iOS builds run on macOS. GitHub Actions provides the simulator runner; no local iPhone is required.');
}

module.exports = { readTemplate, runInit, updateGitignore };
