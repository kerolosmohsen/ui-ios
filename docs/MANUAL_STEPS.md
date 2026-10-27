# Manual steps

## Optional Apple bezel package license

The Apple Design Resources iPhone 15 disk image downloaded successfully, but `hdiutil attach` stopped at the embedded App Store Marketing Artwork License and reported `attach canceled`. I did not accept the license on the user's behalf. If an authorized account representative wants the source package assets used, review and accept Apple's displayed artwork license through the Apple Design Resources flow, then rerun:

```powershell
& 'C:\Program Files\GitHub CLI\gh.exe' workflow run extract-apple-bezels.yml --repo kerolosmohsen/ui-ios --ref main
```

If the artwork license is not accepted, the fallback requires a full Simulator window screenshot and documented measurements. Current `simctl` screenshots contain screen pixels only and do not satisfy the bezel requirement by themselves.

## iPhone 18 Pro simulator runner

GitHub's `xcode-27` hosted runner image includes the exact iPhone 18 Pro simulator and is selected for that catalog entry. It is currently a preview image; session runs for iPhone 15 and iPhone 17 continue on `macos-latest`.
