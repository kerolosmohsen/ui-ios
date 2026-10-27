'use strict';
function shellQuote(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}
function generateDetoxConfig(projectInfo, simulatorType = 'iPhone 16') {
    const projectName = projectInfo.projectName;
    const projectFile = projectInfo.buildProjectFile || `${projectName}.xcworkspace`;
    const projectType = projectInfo.buildProjectType || 'workspace';
    const buildCommand = [
        'xcodebuild',
        `-${projectType}`,
        shellQuote(`ios/${projectFile}`),
        '-scheme',
        shellQuote(projectName),
        '-configuration',
        'Debug',
        '-sdk',
        'iphonesimulator',
        '-derivedDataPath',
        'ios/build',
        'COMPILER_INDEX_STORE_ENABLE=NO',
    ].join(' ');
    const config = {
        testRunner: {
            args: {
                $0: 'jest',
                config: 'e2e/jest.config.js',
            },
            jest: {
                setupTimeout: 120000,
            },
        },
        apps: {
            'ios.sim.debug': {
                type: 'ios.app',
                binaryPath: `ios/build/Build/Products/Debug-iphonesimulator/${projectName}.app`,
                build: buildCommand,
            },
        },
        devices: {
            simulator: {
                type: 'ios.simulator',
                device: {
                    type: simulatorType,
                },
            },
        },
        configurations: {
            'ios.sim.debug': {
                device: 'simulator',
                app: 'ios.sim.debug',
            },
        },
    };
    const serialized = JSON.stringify(config, null, 2).replace(`"type": ${JSON.stringify(simulatorType)}`, `"type": process.env.UI_IOS_SIMULATOR || ${JSON.stringify(simulatorType)}`);
    return `/** @type {Detox.DetoxConfig} */\nmodule.exports = ${serialized};\n`;
}
module.exports = { generateDetoxConfig };
//# sourceMappingURL=detoxrc.js.map