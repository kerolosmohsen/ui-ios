# ui-ios

`ui-ios` opens a remote iPhone Simulator in your browser for a React Native app on Windows. The simulator runs on a temporary GitHub Actions macOS runner; the static controls are hosted on GitHub Pages, and the live JPEG stream travels through a Cloudflare Quick Tunnel.

This is a personal development and testing tool. GitHub Actions is a CI service, not a persistent remote desktop. The private runner job can consume macOS minutes at the 10× rate, may exceed your plan's included allowance, and stops after 5h30. GitHub's terms caution against using Actions as a serverless application or creating disproportionate load. The tool allows one viewer, stops after five minutes without a browser heartbeat, and stops after the configured idle timeout. Do not share a session link.

## Requirements

- Node.js 18 or newer and Git on Windows.
- GitHub CLI (`gh`) authenticated with repository and workflow access.
- A React Native app with `react-native` in `package.json`. Expo projects can omit `ios/`; the macOS runner generates it from the Expo config.
- An account that can create a private `ui-ios-sessions` repository and run GitHub Actions.

Expo projects without `ios/` are supported. The session runner runs `npx expo prebuild --platform ios --no-install` on macOS, so Windows does not need to generate or modify native iOS files locally.

## Quick start

The commands below work with npm 12: npm blocks Git dependencies by default, so `--allow-git=all` opts in for that command only. `--ignore-scripts` keeps install-time scripts disabled; the repository includes its compiled CLI files.

Run once inside each React Native project to add the project configuration and preserve the existing Detox setup:

```powershell
npx --ignore-scripts --allow-git=all github:kerolosmohsen/ui-ios init
```

Then start the simulator from that project:

```powershell
npx --ignore-scripts --allow-git=all github:kerolosmohsen/ui-ios start
```

On first start, the CLI explains Actions costs and asks before creating the private sessions repository. The app snapshot is uploaded to a temporary orphan branch in that repository. The CLI never uses or changes the app project's Git remote, branch, or commits.

Use one command globally instead, if preferred:

```powershell
npm install --global --ignore-scripts --allow-git=all github:kerolosmohsen/ui-ios
ui-ios init
ui-ios start
```

## Commands

```text
ui-ios init [--dry-run] [--skip-install] [--yes] [--force]
ui-ios start [--device iphone15|iphone17|iphone18pro] [--verbose] [--include-env]
ui-ios stop
ui-ios status
ui-ios logs
ui-ios doctor
```

`ui-ios init` leaves an existing `ui-ios.config.json` unchanged. `--force` replaces it. The device selector comes from `templates/runtime/device-catalog.json` and currently offers iPhone 15, iPhone 17, and iPhone 18 Pro. Each selection requires an exact simulator model match; the runner will not silently substitute a different iPhone. The catalog is config-driven, so adding another supported model requires one catalog entry plus its verified bezel asset.

`ui-ios stop` cancels the run and removes the temporary branch. Closing the terminal without stopping still leaves a five-minute heartbeat timeout. If the CLI process remains running, Ctrl+C also cancels the job and removes the branch.

## Project configuration

`ui-ios init` creates `ui-ios.config.json`:

```json
{
  "version": 1,
  "sessionRepository": "",
  "devices": ["iphone15", "iphone17", "iphone18pro"],
  "defaultDevice": "iphone15",
  "idleTimeoutMinutes": 30,
  "includeEnv": false,
  "excludeGlobs": [],
  "stream": "jpeg",
  "fps": 5,
  "warningAcknowledged": false
}
```

The simulator currently uses the Phase 0 verified MJPEG stream over WebSocket, up to 10 frames per second. `.env*` files are excluded by default. Set `includeEnv` or pass `--include-env` only when needed; the CLI asks again and warns that those files are uploaded to the private sessions repository. The entire upload is capped at 100 MB. Add large generated or local files to `excludeGlobs` when they are not needed to build the iOS app.

The snapshot always excludes `node_modules/`, `android/`, `ios/Pods/`, `ios/build/`, `.git/`, and `.ui-ios/`, and it also respects the project's `.gitignore` and `excludeGlobs`. If the snapshot is too large, the CLI lists its largest files.

## Browser controls

- Tap or swipe inside the simulator screen.
- Home, Lock, Rotate, Screenshot, Relaunch, and Shake.
- Dark/light appearance, app logs, and text input.
- Choose iPhone 15, iPhone 17, or iPhone 18 Pro. Changing the selection boots that exact simulator and reinstalls the app.
- The status panel reports the connection, actual device, frame rate, tap response, runtime point and pixel dimensions, status bar, safe area, and remaining time.
- Taps and swipes are mapped from the displayed screen rectangle into the simulator's runtime point coordinates; the bezel is excluded.

The macOS runner checks Xcode, Homebrew, Git, CocoaPods, and Bundler before building, and installs CocoaPods or Bundler on that temporary runner if either is missing. It installs JavaScript dependencies using the detected npm, Yarn, pnpm, or Bun package manager and lockfile, validates the iOS project, and generates Expo's native iOS project on macOS when `ios/` is absent. Expo config must enable iOS; otherwise the run stops with a direct fix before Xcode build time is spent. It then installs Pods, selects an available simulator, builds a Debug app with its JavaScript bundle embedded, and starts IDB plus a private tunnel. The default screen transport is IDB MJPEG; `simctl` screenshots converted to JPEG are the fallback. App logs and screenshots are uploaded as a seven-day Actions artifact when the job ends.

Each Actions runner is temporary, so this setup runs on every new session. No local Mac, Xcode, Watchman, or CocoaPods installation is needed on Windows. Before uploading a snapshot, `ui-ios start` checks the local Node.js and Git versions, React Native project structure, GitHub authentication, session repository permissions, and configuration. `.env` files stay excluded by default; when needed, `ui-ios start --include-env` asks for a second confirmation and uploads them to the private sessions repository.

## Limits

- The sessions repository is private. Private-repository macOS Actions minutes are billed at the account's current rate and may incur charges beyond the included quota.
- The run is capped at 5h30, and it stops after five minutes without heartbeat or after the configured idle period (30 minutes by default).
- Only one browser viewer can be connected at a time. A Quick Tunnel address changes for each session; the fixed Pages URL opens the current tunnel. Old links expire.
- The simulator has no real camera, push notification delivery, or other physical iPhone hardware. Modules that require those capabilities may not work.
- The first run may take several minutes for the macOS runner, package installation, CocoaPods, simulator boot, and app build.
- Large apps, unavailable native modules, Xcode build scripts, and unsupported React Native configurations can fail during runner setup. `ui-ios logs` shows the Actions log.

## Phase 0 evidence

The feasibility workflow built and launched `MyTestApp` on `macos-latest`, streamed the iPhone 17 simulator with IDB MJPEG, and accepted IDB taps. The measured server-side response from receiving the tap through the command and next frame was a median of 1.11 seconds; it does not include browser-to-runner network or image display time. See [PHASE0_REPORT.md](PHASE0_REPORT.md) and [the saved screenshots](evidence/phase0/).

The device table, unconfirmed safe-area values, runtime profile checks, and the Phase 0 pixel-size workflow are documented in [docs/DEVICE_SPECS.md](docs/DEVICE_SPECS.md). The manual Apple asset workflow extracts official bezel packages from [Apple Design Resources](https://developer.apple.com/design/resources/); frame metadata is added only after the source image and screen aperture are verified.

GitHub Pages requires a public repository on GitHub Free. The Pages UI is therefore served from this public tool repository; project snapshots and the runner workflow stay in the separate private sessions repository.
