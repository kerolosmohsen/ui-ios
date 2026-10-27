# iPhone simulator device specifications

The browser selector is built from `templates/runtime/device-catalog.json`. It currently offers exactly `iphone15`, `iphone17`, and `iphone18pro`. Standard iPhone 18 is intentionally absent. A later standard iPhone can be introduced by adding one catalog entry after its real simulator model and display profile are available.

## Fixed reference table

| Model | Screen points | Screenshot pixels | Scale | Diagonal | Density | Body (H × W × D) | Display details |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| iPhone 15 | 393 × 852 | 1179 × 2556 | 3× | 6.1 in | 460 ppi | 147.6 × 71.6 × 7.8 mm | Dynamic Island; status bar 54 pt; safe top/bottom 59/34 pt |
| iPhone 17 | 402 × 874 | 1206 × 2622 | 3× | 6.3 in | 460 ppi | 149.6 × 71.5 × 7.95 mm | Dynamic Island; status bar 54 pt; safe top 62 pt; bottom unconfirmed |
| iPhone 18 Pro | Derived as 402 × 874 from pixels ÷ 3; runtime confirmation required | 1206 × 2622 | 3× | 6.3 in | 460 ppi | 150.0 × 71.9 × 8.75 mm | Dynamic Island; status bar and both safe-area insets unconfirmed |

The catalog records unknown values as `null`. It does not substitute guessed values for the iPhone 17 bottom inset or iPhone 18 Pro status bar and insets.

## Runtime measurement and Phase 0

The `device-specs.yml` workflow boots each exact simulator model, runs a small UIKit probe, captures a `simctl` PNG screenshot, reads its pixel dimensions, and asks IDB for its logical screen dimensions. The profile records the simulator name, UDID, point and pixel dimensions, scale, status bar, and safe-area insets. Runtime values are used by the preview and a warning is logged if any known table entry differs.

Phase 0 fails when a screenshot's pixel dimensions do not equal its table entry. For iPhone 18 Pro it also fails unless the simulator confirms 402 × 874 points from the 1206 × 2622 pixel size at 3×. Uploaded workflow artifacts contain each screenshot and measured JSON profile. They are not committed to the repository.

## Touch mapping

IDB's coordinate UI accepts integer locations in screen points with origin at the upper left ([IDB UI documentation](https://fbidb.io/idb/ui/)). The browser reads pointer positions relative to the displayed screen rectangle, excluding the device bezel. It sends normalized positions; the runner multiplies them by the simulator's measured point width and height before calling `idb ui tap` or `idb ui swipe`.

## Device bezels

Product bezel downloads are provided by [Apple Design Resources](https://developer.apple.com/design/resources/). The page currently lists iPhone 18 and iPhone 17 product bezel packages; the iPhone 15 package is retained from Apple's historical CDN path. The iPhone 15 disk image opened an embedded Apple Marketing Artwork License prompt in the macOS runner, so it was not accepted automatically. The exact manual route is recorded in [MANUAL_STEPS.md](MANUAL_STEPS.md). Until then, the fallback must be measured from a real Simulator window screenshot, with the display aperture, Dynamic Island, and corner radius recorded in the catalog and report. The UI must not substitute guessed geometry.

## Verification status

The pixel-perfect profiles can only be confirmed on the macOS runner because Windows does not provide Xcode Simulator. Run the `Phase 0 iPhone device specifications` GitHub Actions workflow and inspect the `ui-ios-device-specs` artifact. No simulator measurements are recorded here until that run completes.
