# iPhone simulator device specifications

The browser selector reads `templates/runtime/device-catalog.json`. It currently offers `iphone15`, `iphone17`, and `iphone18pro`; standard iPhone 18 is intentionally absent. The catalog holds each label, simulator identity, runner, expected profile, and optional frame data so a future model can be added as one entry.

## Reference values

| Model | Screen points | Screenshot pixels | Scale | Diagonal | Density | Body (H × W × D) | Display details |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| iPhone 15 | 393 × 852 | 1179 × 2556 | 3× | 6.1 in | 460 ppi | 147.6 × 71.6 × 7.8 mm | Dynamic Island; expected status bar 54 pt; safe top/bottom 59/34 pt |
| iPhone 17 | 402 × 874 | 1206 × 2622 | 3× | 6.3 in | 460 ppi | 149.6 × 71.5 × 7.95 mm | Dynamic Island; expected status bar 54 pt; safe top 62 pt; bottom unconfirmed |
| iPhone 18 Pro | Derived as 402 × 874 from pixels ÷ 3; simulator confirmation required | 1206 × 2622 | 3× | 6.3 in | 460 ppi | 150.0 × 71.9 × 8.75 mm | Dynamic Island; status bar and safe-area values unconfirmed |

Unknown values stay `null` in the catalog. In particular, the iPhone 17 bottom inset and all iPhone 18 Pro status/safe-area values come from the running simulator, never from guesses.

## Runtime checks and coordinate mapping

The Phase 0 workflow boots the exact model, reads logical dimensions from IDB, reads status-bar and safe-area values from UIKit, and captures a PNG with `simctl`. The checker reads the PNG header and fails if its pixel dimensions differ from the reference. It also strictly checks that iPhone 18 Pro reports 402 × 874 points derived from its 1206 × 2622 pixels at 3×. A known table value that differs from runtime is logged as a warning; the runtime value is used by the preview.

IDB's UI commands accept integer screen-point coordinates with a top-left origin ([IDB UI documentation](https://fbidb.io/idb/ui/)). The browser measures pointer positions relative to the displayed screen rectangle only. The server maps normalized positions to the measured simulator point width and height before sending a tap or swipe; bezel pixels are excluded.

## Runner selection

The Phase 0 profile check uses GitHub's `xcode-27` image because the current `macos-latest` image does not expose an iPhone 18 Pro simulator. Session jobs select the runner from the catalog: iPhone 15 and iPhone 17 use `macos-latest`, while iPhone 18 Pro uses `xcode-27`. GitHub currently documents `xcode-27` as a preview image without the normal Actions SLA; its image inventory lists iPhone 18 Pro and iPhone 17 on iOS 27.0 ([runner image inventory](https://github.com/actions/runner-images/blob/main/images/macos/xcode-27-arm64-Readme.md), [runner label documentation](https://github.com/actions/runner-images)).

## Phone frames

The app does not draw a guessed Dynamic Island, bezel, or corner radius. Apple Design Resources provides official product bezel assets ([Apple Design Resources](https://developer.apple.com/design/resources/)). The iPhone 15 package reached an embedded Apple Marketing Artwork License prompt on the hosted Mac; it was not accepted automatically. See [MANUAL_STEPS.md](MANUAL_STEPS.md) for the authorized route. The fallback is to capture the complete Simulator device window and measure its display aperture, island, and screen corner radius from that real screenshot. The current `simctl` PNGs show the screen only and are not enough to measure the physical bezel; no frame asset is active yet.

## Verified profiles

On `macos-latest` with macOS 26.6.2, Xcode 26.6 (build 17F113), and iOS 26.5, the iPhone 15 probe measured 393 × 852 pt, 1179 × 2556 px, @3×, safe area 59/34 pt, and status bar 20 pt. The iPhone 17 probe measured 402 × 874 pt, 1206 × 2622 px, @3×, safe area 62/34 pt, and status bar 20 pt. Both screenshots passed the exact pixel checks. The 20 pt status-bar reading is runtime data and produces a warning against the supplied 54 pt reference.

The first `xcode-27` run (iOS 27.0) confirmed the exact iPhone 18 Pro simulator exists and successfully checked iPhone 17 at 402 × 874 pt, 1206 × 2622 px, @3×, safe area 62/34 pt, and status bar 54 pt. iPhone 15's SDK-path query and iPhone 18 Pro's Swift compile exceeded the initial two-minute process timeout; that timeout is now ten minutes. The strict all-device run is being repeated to obtain the other two profiles.
