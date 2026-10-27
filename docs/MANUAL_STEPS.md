# Manual steps

## Optional Apple bezel package license

The Apple Design Resources iPhone 15 disk image downloaded successfully, but `hdiutil attach` stopped at the embedded App Store Marketing Artwork License and reported `attach canceled`. I did not accept the license on the user's behalf. If an authorized account representative wants the source package assets used, review and accept Apple's displayed artwork license through the Apple Design Resources flow, then rerun:

```powershell
& 'C:\Program Files\GitHub CLI\gh.exe' workflow run extract-apple-bezels.yml --repo kerolosmohsen/ui-ios --ref main
```

If the artwork license is not accepted, the fallback requires a full Simulator window screenshot and documented measurements. Current `simctl` screenshots contain screen pixels only and do not satisfy the bezel requirement by themselves.

The automated Device Hub fallback was also tried. Do not use the artifacts from runs `40449012896` or `40450325952` as device-frame references: the first run showed the iPhone 15 overview for its iPhone 17 and iPhone 18 Pro captures, and the second run failed to capture iPhone 15 and again showed the iPhone 15 overview for the other devices. To complete the frame requirement, an authorized person must either accept Apple's artwork license and rerun the extraction workflow, or provide one correct full-window Device Hub screenshot per model with the target model selected and its screen visible. Measurements must be taken from those verified source images before enabling any frame in the app.

## iPhone 18 Pro simulator runner

GitHub's `xcode-27` hosted runner image includes the exact iPhone 18 Pro simulator and is selected for that catalog entry. It is currently a preview image; session runs for iPhone 15 and iPhone 17 continue on `macos-latest`.
