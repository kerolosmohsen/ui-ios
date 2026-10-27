# ui-ios build report

## Completed

- Built the `ui-ios` CLI for initializing a React Native project, starting and managing a remote iOS Simulator session, and checking local/GitHub readiness.
- Added the responsive browser controller and its secure WebSocket runtime, macOS runner workflow template, filtered project snapshot handling, and simulator selection helpers.
- Recorded the Phase 0 feasibility measurements and screenshots in [PHASE0_REPORT.md](../PHASE0_REPORT.md) and `evidence/phase0/`.
- Created and pushed the public `kerolosmohsen/ui-ios` repository. The static controller is published at <https://kerolosmohsen.github.io/ui-ios/>.

## Verification

- `npm run build`, `npm run typecheck`, and `npm run lint` pass.
- `npm test` passes all 12 tests.
- `npm pack --dry-run` includes the compiled CLI, runtime templates, workflow template, and static browser UI.
- `node bin/ui-ios.js --help` and `node bin/ui-ios.js doctor` run successfully.
- GitHub Pages returned HTTP 200 and the expected simulator UI markers.
- The Phase 0 macOS proof built and launched a React Native app, streamed simulator frames, and accepted taps. The server-side latency numbers are documented with their scope and limitations.
- Added a config-driven iPhone 15 / iPhone 17 / iPhone 18 Pro catalog, runtime UIKit/IDB display probing, exact screenshot pixel checks, and browser mapping from the screen aperture to IDB point coordinates. See [DEVICE_SPECS.md](DEVICE_SPECS.md).
- Added a macOS Phase 0 workflow that captures one pixel-checked screenshot and profile per catalog simulator. Its first real run captured iPhone 17; Phase 0 is rerunning after adding creation of the exact iPhone 15 device type exposed by Xcode.
- Verified iPhone 17 on the current `macos-latest` image: 402 × 874 pt, 1206 × 2622 px, @3x, safe area 62/34 pt. The runtime status bar measured 20 pt (the supplied reference is 54 pt), so the runtime value is used with a warning. The aggregate Phase 0 run fails because Xcode 26.6 does not expose exact iPhone 15 or iPhone 18 Pro simulators.
- Apple bezel extraction stopped at an embedded artwork license prompt and was not accepted automatically. No guessed device frame or Dynamic Island geometry is used; the exact manual steps and current frame limitation are documented.

## Pending end-to-end session

The first real `ui-ios start` session creates the private `ui-ios-sessions` repository, uploads a temporary app snapshot, and starts a macOS Actions job. The task requires user confirmation before that private repository is created. No private session repository was created and no new Actions run was started.
