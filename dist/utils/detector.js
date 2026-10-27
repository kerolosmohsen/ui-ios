'use strict';
const fs = require('fs-extra');
const path = require('path');
function readPackageJson(cwd) {
    const packageJsonPath = path.join(cwd, 'package.json');
    if (!fs.existsSync(packageJsonPath)) {
        return { error: 'No package.json found in the current directory.' };
    }
    try {
        return { packageJson: fs.readJsonSync(packageJsonPath) };
    }
    catch (error) {
        return { error: `Could not read package.json: ${error.message}` };
    }
}
function detectReactNativeProject(cwd = process.cwd()) {
    const result = readPackageJson(cwd);
    if (result.error)
        return { valid: false, reason: result.error };
    const packageJson = result.packageJson;
    const dependencies = {
        ...packageJson.dependencies,
        ...packageJson.devDependencies,
        ...packageJson.peerDependencies,
    };
    if (!dependencies['react-native']) {
        return {
            valid: false,
            reason: 'react-native was not found in dependencies, devDependencies, or peerDependencies.',
        };
    }
    const iosDir = path.join(cwd, 'ios');
    const iosFiles = fs.existsSync(iosDir) ? fs.readdirSync(iosDir) : [];
    const workspace = iosFiles.find((file) => file.endsWith('.xcworkspace'));
    const project = iosFiles.find((file) => file.endsWith('.xcodeproj'));
    const hasPodfile = fs.existsSync(path.join(iosDir, 'Podfile'));
    const nativeProject = workspace || project;
    const projectName = nativeProject
        ? nativeProject.replace(/\.(xcworkspace|xcodeproj)$/, '')
        : (packageJson.name || 'MyApp').split('/').pop();
    const buildProjectFile = workspace || (hasPodfile ? `${projectName}.xcworkspace` : project);
    const buildProjectType = workspace || hasPodfile ? 'workspace' : project ? 'project' : null;
    const packageManagerField = packageJson.packageManager || '';
    let packageManager = packageManagerField.split('@')[0];
    if (!['npm', 'yarn', 'pnpm'].includes(packageManager)) {
        if (fs.existsSync(path.join(cwd, 'pnpm-lock.yaml')))
            packageManager = 'pnpm';
        else if (fs.existsSync(path.join(cwd, 'yarn.lock')))
            packageManager = 'yarn';
        else
            packageManager = 'npm';
    }
    return {
        valid: true,
        appName: packageJson.name || 'MyApp',
        projectName,
        hasIosDir: fs.existsSync(iosDir),
        iosDir,
        workspaceName: workspace || null,
        projectFile: project || null,
        buildProjectFile: buildProjectFile || null,
        buildProjectType,
        rnVersion: dependencies['react-native'],
        packageManager,
        hasPodfile,
        isExpo: Boolean(dependencies.expo),
    };
}
function detectExistingFiles(cwd = process.cwd()) {
    const candidates = [
        '.detoxrc.js',
        '.detoxrc.json',
        'detox.config.js',
        'e2e/jest.config.js',
        'e2e/starter.test.js',
        '.github/workflows/ios-ui-tests.yml',
    ];
    return candidates.filter((file) => fs.existsSync(path.join(cwd, file)));
}
function detectDetoxDependency(cwd = process.cwd()) {
    const result = readPackageJson(cwd);
    if (result.error)
        return false;
    const packageJson = result.packageJson;
    return Boolean(packageJson.dependencies?.detox ||
        packageJson.devDependencies?.detox ||
        packageJson.peerDependencies?.detox);
}
module.exports = {
    detectDetoxDependency,
    detectExistingFiles,
    detectReactNativeProject,
};
//# sourceMappingURL=detector.js.map