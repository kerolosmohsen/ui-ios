#!/bin/bash
set -euo pipefail

out="${RUNNER_TEMP}/ui-ios-apple-bezels"
mkdir -p "$out"

extract() {
  local device="$1"
  local url="$2"
  local disk="${RUNNER_TEMP}/${device}.dmg"
  local mount="${RUNNER_TEMP}/mount-${device}"
  local destination="${out}/${device}"
  mkdir -p "$mount" "$destination"
  curl --fail --location --silent --show-error --write-out "${device} download: HTTP %{http_code}, %{size_download} bytes\n" "$url" --output "$disk"
  file "$disk"
  hdiutil imageinfo "$disk"
  hdiutil attach -readonly -nobrowse -mountpoint "$mount" "$disk"
  while IFS= read -r -d '' png; do
    local relative="${png#"${mount}/"}"
    mkdir -p "${destination}/$(dirname "$relative")"
    cp "$png" "${destination}/${relative}"
  done < <(find "$mount" -type f -iname '*.png' -print0)
  hdiutil detach "$mount" >/dev/null
  if ! find "$destination" -type f -iname '*.png' -print -quit | grep -q .; then
    echo "No PNG product bezel files were found in the official ${device} Design Resources disk image." >&2
    exit 1
  fi
}

extract iphone15 https://devimages-cdn.apple.com/design/resources/download/Bezel-iPhone-15.dmg
extract iphone17 https://devimages-cdn.apple.com/design/resources/download/Bezel-iPhone-17.dmg
extract iphone18pro https://devimages-cdn.apple.com/design/resources/download/Bezel-iPhone-18.dmg

find "$out" -type f -iname '*.png' -print
