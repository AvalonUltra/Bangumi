#!/usr/bin/env python3

"""Maintain the AltStore source for the unsigned upstream IPA builds.

By default this updates a single version in place and leaves every other entry
untouched. The previous version rebuilt the whole file from the GitHub API on
every run, which meant one flaky download of one checksum asset threw away the
entire AltStore source -- and because the workflow decided what to do from
"does the release have assets", that failure was never retried.

Pass --rebuild-all to reconstruct the file from scratch.
"""

import argparse
import json
import os
import time
import urllib.error
import urllib.request

UPSTREAM = "czy0729/Bangumi"
REPO = os.getenv("GITHUB_REPOSITORY", UPSTREAM)
BRANCH = os.getenv("ALT_STORE_BRANCH", "master")

ICON_URL = f"https://raw.githubusercontent.com/{UPSTREAM}/master/src/assets/images/foreground.png"

APP = {
    "name": "Bangumi",
    "bundleIdentifier": "tv.bangumi.czy0729",
    "developerName": "czy0729",
    "iconURL": ICON_URL,
    "localizedDescription": "Bangumi for iOS",
}

REQUEST_TIMEOUT = 30
MAX_ATTEMPTS = 4


def request(url, *, as_json=True, accept="application/vnd.github+json", authenticated=True):
    headers = {"Accept": accept, "User-Agent": "altstore-generator"}

    # Asset downloads redirect to a signed CDN URL that rejects a second
    # credential, so only the API itself gets the token.
    token = os.getenv("GITHUB_TOKEN")
    if token and authenticated:
        headers["Authorization"] = f"Bearer {token}"

    last_error = None

    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as response:
                payload = response.read()
            return json.loads(payload) if as_json else payload.decode("utf-8")
        except urllib.error.HTTPError as error:
            last_error = error
            if error.code < 500 and error.code != 429:
                raise
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
            last_error = error

        if attempt < MAX_ATTEMPTS:
            delay = 2 ** attempt
            print(f"Retrying {url} in {delay}s ({attempt}/{MAX_ATTEMPTS}): {last_error}")
            time.sleep(delay)

    raise RuntimeError(f"Gave up on {url}: {last_error}")


def version_key(version):
    parts = []

    for part in version.split("."):
        try:
            parts.append(int(part))
        except ValueError:
            parts.append(0)

    return parts


def find_assets(assets):
    found = {"ipa": None, "sha": None, "metadata": None}

    for asset in assets:
        name = asset["name"]

        if name.endswith(".ipa"):
            found["ipa"] = asset
        elif name.endswith(".ipa.sha256"):
            found["sha"] = asset
        elif name.endswith(".ipa.metadata.json"):
            found["metadata"] = asset

    return found


def changelog(version):
    """Upstream's own release notes read better than our build boilerplate."""
    try:
        release = request(f"https://api.github.com/repos/{UPSTREAM}/releases/tags/{version}")
    except Exception as error:  # noqa: BLE001 - notes are a nicety, never a blocker
        print(f"No upstream release notes for {version}: {error}")
        return f"Bangumi {version} · 上游源码构建的未签名 IPA"

    body = (release.get("body") or "").strip()
    lines = [
        line
        for line in body.splitlines()
        if line.strip() and "apk" not in line.lower()
    ]
    text = "\n".join(lines).strip()

    if not text:
        return f"Bangumi {version} · 上游源码构建的未签名 IPA"

    return text[:1500]


def build_entry(version):
    release = request(f"https://api.github.com/repos/{REPO}/releases/tags/upstream-{version}")
    assets = find_assets(release.get("assets", []))

    if assets["ipa"] is None:
        raise RuntimeError(f"Release upstream-{version} has no IPA asset")

    entry = {
        "version": version,
        "buildVersion": "1",
        "date": release["published_at"],
        "downloadURL": assets["ipa"]["browser_download_url"],
        "size": assets["ipa"]["size"],
        "localizedDescription": changelog(version),
    }

    if assets["metadata"] is not None:
        metadata = request(
            assets["metadata"]["browser_download_url"],
            accept="application/octet-stream",
            authenticated=False,
        )
        entry["buildVersion"] = metadata.get("buildVersion") or "1"
        entry["sha256"] = metadata["sha256"]
        entry["size"] = metadata.get("size", entry["size"])
        if metadata.get("minOSVersion"):
            entry["minOSVersion"] = metadata["minOSVersion"]
    elif assets["sha"] is not None:
        checksum = request(
            assets["sha"]["browser_download_url"],
            as_json=False,
            accept="application/octet-stream",
            authenticated=False,
        )
        entry["sha256"] = checksum.split()[0]
    else:
        raise RuntimeError(f"Release upstream-{version} has neither a checksum nor a metadata asset")

    return entry


def all_built_versions():
    versions = []
    page = 1

    while page <= 10:
        releases = request(
            f"https://api.github.com/repos/{REPO}/releases?per_page=100&page={page}"
        )

        for release in releases:
            tag = release.get("tag_name", "")
            if not tag.startswith("upstream-") or release.get("draft"):
                continue

            assets = find_assets(release.get("assets", []))
            if assets["ipa"] is None:
                print(f"Skipping {tag}: no IPA asset")
                continue

            versions.append(tag[len("upstream-"):])

        if len(releases) < 100:
            break

        page += 1

    return versions


def load_existing(path):
    if not os.path.exists(path):
        return []

    try:
        with open(path) as f:
            source = json.load(f)
        return source["apps"][0].get("versions", [])
    except (json.JSONDecodeError, KeyError, IndexError) as error:
        print(f"Could not reuse {path} ({error}); starting from an empty version list")
        return []


def main():
    parser = argparse.ArgumentParser()

    parser.add_argument("--version", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument(
        "--rebuild-all",
        action="store_true",
        help="re-fetch every release instead of updating one version in place",
    )

    args = parser.parse_args()

    if args.rebuild_all:
        versions = [build_entry(version) for version in all_built_versions()]
    else:
        versions = [v for v in load_existing(args.output) if v.get("version") != args.version]
        versions.append(build_entry(args.version))

    if not any(v["version"] == args.version for v in versions):
        raise RuntimeError(f"No entry produced for upstream-{args.version}")

    versions.sort(key=lambda v: version_key(v["version"]), reverse=True)

    source = {
        "name": "Bangumi",
        "identifier": "tv.bangumi.czy0729",
        "sourceURL": (
            f"https://raw.githubusercontent.com/{REPO}/{BRANCH}/{os.path.basename(args.output)}"
        ),
        "apps": [{**APP, "versions": versions}],
    }

    with open(args.output, "w") as f:
        json.dump(source, f, indent=2, ensure_ascii=False)
        f.write("\n")

    print(f"Wrote {args.output}: {len(versions)} versions, newest {versions[0]['version']}")


if __name__ == "__main__":
    main()
