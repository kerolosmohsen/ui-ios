# Manual steps

## Optional Apple bezel package license

The Apple Design Resources iPhone 15 disk image downloaded successfully, but `hdiutil attach` stopped at the embedded App Store Marketing Artwork License and reported `attach canceled`. I did not accept the license on the user's behalf. If an authorized account representative wants the source package assets used, review and accept Apple's displayed artwork license through the Apple Design Resources flow, then rerun:

```powershell
& 'C:\Program Files\GitHub CLI\gh.exe' workflow run extract-apple-bezels.yml --repo kerolosmohsen/ui-ios --ref main
```

The device-spec work continues with the requested real Simulator screenshot measurement fallback. This manual step is not required if that fallback satisfies the frame requirement.
