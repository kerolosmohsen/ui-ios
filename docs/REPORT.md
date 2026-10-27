# ui-ios build report

## Completed

- Built the `ui-ios` CLI for initializing a React Native project, starting and managing a remote iOS Simulator session, and checking local/GitHub readiness.
- Added the responsive browser controller and its secure WebSocket runtime, macOS runner workflow template, filtered project snapshot handling, and simulator selection helpers.
- Recorded the Phase 0 feasibility measurements and screenshots in [PHASE0_REPORT.md](../PHASE0_REPORT.md) and `evidence/phase0/`.
- Created and pushed the public `kerolosmohsen/ui-ios` repository. The static controller is published at <https://kerolosmohsen.github.io/ui-ios/>.
- Added a config-driven iPhone 15 / iPhone 17 / iPhone 18 Pro catalog, runtime UIKit/IDB display probing, exact screenshot pixel checks, and browser mapping from the screen aperture to IDB point coordinates. See [DEVICE_SPECS.md](DEVICE_SPECS.md).
- Added runner selection from the device catalog: iPhone 15 and iPhone 17 use `macos-latest`; iPhone 18 Pro uses the `xcode-27` image that exposes its exact simulator model.

## Verification

- `npm run build`, `npm run typecheck`, `npm run lint`, and `git diff --check` pass.
- `npm test` passes all 13 tests.
- `npm pack --dry-run` includes the compiled CLI, runtime templates, workflow template, and static browser UI.
- `node bin/ui-ios.js --help` and `node bin/ui-ios.js doctor` run successfully.
- GitHub Pages returned HTTP 200 and the expected simulator UI markers.
- The Phase 0 macOS proof built and launched a React Native app, streamed simulator frames, and accepted taps. The server-side latency numbers are documented with their scope and limitations.
- On `macos-latest` with Xcode 26.6 / iOS 26.5, the iPhone 15 and iPhone 17 screenshots passed exact pixel checks at 1179 × 2556 and 1206 × 2622 px. Runtime status bar measured 20 pt; the 54 pt reference is logged as a warning and the runtime value is used.
- On `xcode-27` / iOS 27.0, iPhone 17 passed at 402 × 874 pt, 1206 × 2622 px, @3×, safe area 62/34 pt, and runtime status bar 54 pt. The image also exposes the exact iPhone 18 Pro device type.
- The first `xcode-27` all-device run hit the initial 120-second timeout while resolving the iPhone 15 SDK and compiling for iPhone 18 Pro. The probe timeout is now ten minutes and Phase 0 is rerunning.
- Apple bezel extraction stopped at an embedded artwork license prompt and was not accepted automatically. Current `simctl` screenshots do not include the outer phone bezel or a contrasting Dynamic Island; the frame requirement remains pending. No guessed device frame or Dynamic Island geometry is used.

## Pending end-to-end session

The first real `ui-ios start` session creates the private `ui-ios-sessions` repository, uploads a temporary app snapshot, and starts a GitHub Actions job. The task requires user confirmation before that private repository is created. No private session repository was created and no new Actions run was started.
