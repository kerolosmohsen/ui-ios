# Manual steps

## Optional Apple bezel package license

The Apple Design Resources iPhone 15 disk image downloaded successfully, but `hdiutil attach` stopped at the embedded App Store Marketing Artwork License and reported `attach canceled`. I did not accept the license on the user's behalf. If an authorized account representative wants the source package assets used, review and accept Apple's displayed artwork license through the Apple Design Resources flow, then rerun:

```powershell
& 'C:\Program Files\GitHub CLI\gh.exe' workflow run extract-apple-bezels.yml --repo kerolosmohsen/ui-ios --ref main
```

The device-spec work continues with the requested real Simulator screenshot measurement fallback. This manual step is not required if that fallback satisfies the frame requirement.

## Simulator models missing from the hosted image

The `macos-latest` run on 2026-10-27 used Xcode 26.6 and exposed pre-created simulators for iPhone 17, iPhone 17 Pro, iPhone 17 Pro Max, and iPhone Air. The iPhone 15 device type is present and the workflow now creates that exact model automatically. Xcode 26.6 does not list an iPhone 18 Pro device type. Do not let the workflow substitute another model. To finish the required three-device Phase 0 check, select or provide a macOS runner/Xcode installation that lists the exact iPhone 18 Pro simulator type and runtime, then rerun `device-specs.yml`. If obtaining that Xcode version requires Apple account login or download approval, complete that step as the account owner.
