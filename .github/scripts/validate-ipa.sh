#!/usr/bin/env bash
#
# Validate a freshly packaged unsigned IPA and emit the metadata sidecar.
#
# The previous checks only compared version strings and confirmed the app was
# unsigned. An IPA whose JavaScript bundle never made it into the payload -- the
# failure mode that actually ships a broken app -- passed all of them.
#
# Usage: validate-ipa.sh <ipa-path> <expected-version>

set -euo pipefail

ipa_path="${1:?usage: validate-ipa.sh <ipa-path> <expected-version>}"
expected_version="${2:?usage: validate-ipa.sh <ipa-path> <expected-version>}"

app_dir="Payload/Bangumi.app"
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

fail() {
  echo "::error::$1"
  exit 1
}

echo "--- archive integrity"
unzip -t "$ipa_path" > /dev/null || fail "IPA archive is corrupt: $ipa_path"

echo "--- required payload members"
for member in "$app_dir/Info.plist" "$app_dir/Bangumi" "$app_dir/main.jsbundle" \
  "$app_dir/EXConstants.bundle/app.config"; do
  # `unzip -l` exits 11 when nothing matches. Piping into grep here would race
  # with SIGPIPE under `set -o pipefail`.
  unzip -l "$ipa_path" "$member" > /dev/null 2>&1 || fail "IPA is missing $member"
done

unzip -p "$ipa_path" "$app_dir/Info.plist" > "$work_dir/Info.plist"
unzip -p "$ipa_path" "$app_dir/EXConstants.bundle/app.config" > "$work_dir/app.config"
unzip -p "$ipa_path" "$app_dir/Bangumi" > "$work_dir/Bangumi"
unzip -p "$ipa_path" "$app_dir/main.jsbundle" > "$work_dir/main.jsbundle"

plist_value() {
  plutil -extract "$1" raw -o - "$work_dir/Info.plist" 2>/dev/null || echo ""
}

echo "--- versions"
bundle_version="$(plist_value CFBundleShortVersionString)"
build_version="$(plist_value CFBundleVersion)"
min_os_version="$(plist_value MinimumOSVersion)"
bundle_id="$(plist_value CFBundleIdentifier)"
embedded_version="$(node -p "JSON.parse(require('fs').readFileSync('$work_dir/app.config','utf8')).version")"

[ "$bundle_version" = "$expected_version" ] ||
  fail "Info.plist CFBundleShortVersionString is $bundle_version, expected $expected_version"
[ "$embedded_version" = "$expected_version" ] ||
  fail "Embedded Expo config version is $embedded_version, expected $expected_version"
[ -n "$build_version" ] || fail "Info.plist has no CFBundleVersion"
[ -n "$min_os_version" ] || fail "Info.plist has no MinimumOSVersion"
case "$bundle_id" in
  ''|*'$('*) fail "Info.plist CFBundleIdentifier was not substituted at build time: '$bundle_id'" ;;
esac

echo "--- appearance"
# A prebuild whose app.json omits userInterfaceStyle writes Light here, which
# pins the app to light mode in UIKit and silently kills the follow-the-system
# theme. Nothing else in the build notices, so check it in the artifact.
interface_style="$(plist_value UIUserInterfaceStyle)"
case "$interface_style" in
  Automatic|Dark) ;;
  Light) fail "Info.plist pins UIUserInterfaceStyle to Light; the follow-the-system theme cannot work" ;;
  '') fail "Info.plist has no UIUserInterfaceStyle; prebuild should have written one" ;;
  *) fail "Unexpected UIUserInterfaceStyle: $interface_style" ;;
esac
echo "UIUserInterfaceStyle: $interface_style"

echo "--- javascript bundle"
bundle_bytes="$(stat -f%z "$work_dir/main.jsbundle" 2>/dev/null || stat -c%s "$work_dir/main.jsbundle")"
[ "$bundle_bytes" -ge 1048576 ] ||
  fail "main.jsbundle is only $bundle_bytes bytes; the Metro/Hermes phase did not produce a real bundle"
hermes_magic="$(od -An -tx1 -N4 "$work_dir/main.jsbundle" | tr -d ' \n')"
[ "$hermes_magic" = "c61fbc03" ] ||
  echo "::warning::main.jsbundle is not Hermes bytecode (magic $hermes_magic); the app ships plain JavaScript"

echo "--- executable architecture"
archs="$(lipo -archs "$work_dir/Bangumi" 2>/dev/null || echo "")"
case "$archs" in
  *arm64*) ;;
  *) fail "App executable is not built for arm64 (lipo reports: '${archs:-unreadable}')" ;;
esac

echo "--- signature"
payload_dir="$work_dir/extracted"
mkdir -p "$payload_dir"
unzip -q "$ipa_path" -d "$payload_dir"

codesign_output="$(codesign -dv "$payload_dir/$app_dir" 2>&1 || true)"
echo "$codesign_output"
case "$codesign_output" in
  *"code object is not signed at all"*) ;;
  *) fail "Expected an unsigned app; codesign said: $codesign_output" ;;
esac

echo "--- metadata sidecar"
ipa_bytes="$(stat -f%z "$ipa_path" 2>/dev/null || stat -c%s "$ipa_path")"
sha256="$(shasum -a 256 "$ipa_path" | awk '{print $1}')"

cat > "$ipa_path.metadata.json" <<JSON
{
  "version": "$expected_version",
  "buildVersion": "$build_version",
  "minOSVersion": "$min_os_version",
  "bundleIdentifier": "$bundle_id",
  "size": $ipa_bytes,
  "sha256": "$sha256",
  "jsBundleBytes": $bundle_bytes,
  "architectures": "$archs"
}
JSON

cat "$ipa_path.metadata.json"
echo "IPA validated: $expected_version ($build_version), min iOS $min_os_version, $ipa_bytes bytes"
