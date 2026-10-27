# ui-ios session runner

This private repository is used by the ui-ios CLI to run a short-lived, personal iOS Simulator preview on GitHub Actions. Session snapshots are pushed to orphan `session/<id>` branches and are removed when a run ends. Do not add unrelated files or share access to this repository.

GitHub Actions is intended for development and testing. A macOS session can consume private-repository Actions minutes at the macOS multiplier and is capped at 5h30. This is not a hosted remote desktop service.
