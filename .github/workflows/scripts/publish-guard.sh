#!/usr/bin/env bash
#
# FAIL-CLOSED publish guard. Runs immediately before EVERY npm publish and refuses (exit 1)
# unless the channel's invariants all hold. The cardinal rule it enforces: a nightly build can
# only ever reach the `nightly` tag, and a stable build can only ever reach @latest from main —
# the two paths are mutually unreachable, so nothing on the prerelease branch can move @latest.
#
# Usage: publish-guard.sh <channel> <package.json> <intended-npm-tag>
#   channel  = nightly | stable
#   package.json = path to the package about to be published
#   intended-npm-tag = the exact --tag value the caller will pass to `npm publish`
#
# nightly channel asserts:
#   - version matches *-nightly.*      (a semver pre-release; sorts below the clean X.Y.Z)
#   - intended tag == "nightly"        (never the default `latest` tag)
# stable channel asserts:
#   - GITHUB_REF == refs/heads/main    (stable publishes ONLY from main)
#   - version has NO prerelease suffix (a clean X.Y.Z)
#   - intended tag is "latest" or empty (the npm default)
set -euo pipefail

channel="${1:?usage: publish-guard.sh <channel> <package.json> <intended-npm-tag>}"
pkg="${2:?missing package.json path}"
tag="${3:-}"

[[ -f "$pkg" ]] || { echo "GUARD FAIL: no such package.json: $pkg" >&2; exit 1; }
ver="$(jq -r .version "$pkg")"
name="$(jq -r .name "$pkg")"

fail() { echo "GUARD FAIL [$channel] $name@$ver (tag='${tag:-<default>}'): $1" >&2; exit 1; }

case "$channel" in
  nightly)
    [[ "${GITHUB_REF:-}" == "refs/heads/prerelease" ]] || fail "nightly publishes only from prerelease"
    [[ "$ver" =~ ^[0-9]+\.[0-9]+\.[0-9]+-nightly\.[0-9]+$ ]] || fail "version is not a -nightly.N pre-release"
    [[ "$tag" == "nightly"   ]] || fail "nightly must publish with --tag nightly, never the default @latest"
    ;;
  stable)
    [[ "${GITHUB_REF:-}" == "refs/heads/main" ]] || fail "stable publishes only from main (GITHUB_REF='${GITHUB_REF:-<unset>}')"
    [[ "$ver" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "stable version must be clean X.Y.Z with no pre-release suffix"
    [[ -z "$tag" || "$tag" == "latest" ]] || fail "stable must publish to @latest (default), not tag '$tag'"
    ;;
  *)
    echo "GUARD FAIL: unknown channel '$channel' (want nightly|stable)" >&2; exit 1 ;;
esac

echo "guard ok: [$channel] $name@$ver -> tag ${tag:-latest}"
