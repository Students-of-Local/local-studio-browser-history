#!/bin/sh
# Installs the Local Studio helper from a GitHub release, on macOS and Linux:
#
#   curl -fsSL https://github.com/baney75/tychicus/releases/latest/download/install.sh | sh
#
# It downloads this computer's archive and SHA256SUMS from the latest release of baney75/tychicus (or the one
# TYCHICUS_VERSION names) into a temporary folder, checks the archive's SHA-256, checks its build attestation when the
# GitHub CLI is on PATH and signed in, unpacks it and runs `tychicus install --release <folder>`, which checks the files again and
# registers the helper with each Chromium browser. It needs no sudo and refuses to run as root.
#
#   sh install.sh [--allow-root] [install options]   with curl: curl -fsSL <url> | sh -s -- --local-studio
#
# Options other than --allow-root and --help go to `tychicus install --release` (--local-studio, --force,
# --browser <name>, --dry-run).
# Environment:
#   TYCHICUS_VERSION            a release version such as 1.2.3 instead of the latest
#   TYCHICUS_GH                 the GitHub CLI to check attestations with, or "none" to skip that check
#   TYCHICUS_INSTALL_BASE_URL   tests only: a loopback http:// address that stands in for the releases page
set -eu

REPO="baney75/tychicus"
WORKFLOW="$REPO/.github/workflows/release.yml"
BASE="https://github.com/$REPO/releases"

say() { printf '%s\n' "$*"; }
fail() {
	printf 'tychicus install: %s\n' "$*" >&2
	exit 1
}

usage() {
	cat <<'USAGE'
Installs the Local Studio helper from the latest release of baney75/tychicus.
  curl -fsSL https://github.com/baney75/tychicus/releases/latest/download/install.sh | sh
  curl -fsSL <same address> | sh -s -- [--allow-root] [--local-studio] [--force] [--browser <name>] [--dry-run]
TYCHICUS_VERSION=1.2.3 installs that release instead. TYCHICUS_GH=none skips the attestation check.
USAGE
}

allow_root=0
dry_run=0
first=1
for arg in "$@"; do
	# Rebuild the argument list without --allow-root, keeping the rest for `tychicus install`.
	if [ "$first" = 1 ]; then
		set --
		first=0
	fi
	case "$arg" in
	--allow-root) allow_root=1 ;;
	-h | --help)
		usage
		exit 0
		;;
	--dry-run)
		dry_run=1
		set -- "$@" "$arg"
		;;
	*) set -- "$@" "$arg" ;;
	esac
done

if [ "$(id -u)" = 0 ] && [ "$allow_root" != 1 ]; then
	fail "refusing to run as root. The helper installs into your own home folder and needs no sudo. Run this as your own user, or pass --allow-root to install for root."
fi

if [ -n "${TYCHICUS_INSTALL_BASE_URL:-}" ]; then
	# The whole host must be loopback: a prefix match would let http://127.0.0.1:x@evil.example through.
	if printf '%s\n' "$TYCHICUS_INSTALL_BASE_URL" | grep -Eq '^http://(127\.0\.0\.1|localhost)(:[0-9]{1,5})?(/[^@]*)?$'; then
		BASE="${TYCHICUS_INSTALL_BASE_URL%/}"
	else
		fail "TYCHICUS_INSTALL_BASE_URL is for tests and must be a loopback http:// address; it is $TYCHICUS_INSTALL_BASE_URL"
	fi
	proto="=http"
else
	proto="=https"
fi

# This computer's archive tag, as release.yml names it: darwin-arm64, linux-x64.
case "$(uname -s)" in
Darwin) os=darwin ;;
Linux) os=linux ;;
*) fail "this script installs on macOS and Linux. On Windows, run in PowerShell: irm https://github.com/$REPO/releases/latest/download/install.ps1 | iex" ;;
esac
case "$(uname -m)" in
x86_64 | amd64) arch=x64 ;;
arm64 | aarch64) arch=arm64 ;;
*) fail "no release is built for $(uname -m). Releases are built for linux-x64 and darwin-arm64: https://github.com/$REPO/releases" ;;
esac
# A shell under Rosetta reports x86_64 on an Apple silicon Mac; the arm64 build is the right one there.
if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
	arch=arm64
fi
tag="$os-$arch"

if command -v curl >/dev/null 2>&1; then
	fetch() { curl -fsSL --proto "$proto" --proto-redir "$proto" --retry 2 -o "$2" "$1"; }
elif command -v wget >/dev/null 2>&1; then
	if [ "$proto" = "=https" ]; then
		fetch() { wget -q --https-only -O "$2" "$1"; }
	else
		fetch() { wget -q -O "$2" "$1"; }
	fi
else
	fail "needs curl or wget to download the release."
fi

if command -v sha256sum >/dev/null 2>&1; then
	sha256() { sha256sum "$1" | cut -d ' ' -f 1; }
elif command -v shasum >/dev/null 2>&1; then
	sha256() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
elif command -v openssl >/dev/null 2>&1; then
	sha256() { openssl dgst -sha256 "$1" | sed 's/^.*= *//'; }
else
	fail "needs sha256sum, shasum or openssl to check the download."
fi

dir=$(mktemp -d "${TMPDIR:-/tmp}/tychicus-install.XXXXXX") || fail "could not make a temporary folder."
trap 'rm -rf "$dir"' EXIT
trap 'exit 1' HUP INT TERM

version="${TYCHICUS_VERSION:-}"
version="${version#v}"
if [ -n "$version" ]; then
	case "$version" in
	*[!0-9.]* | .* | *. | *..*) fail "TYCHICUS_VERSION must be a release version such as 1.2.3; it is $TYCHICUS_VERSION" ;;
	esac
	sums_url="$BASE/download/v$version/SHA256SUMS"
else
	sums_url="$BASE/latest/download/SHA256SUMS"
fi

say "Downloading SHA256SUMS from $sums_url"
fetch "$sums_url" "$dir/SHA256SUMS" || fail "could not download $sums_url. Check the version and your connection."

# The archive name carries the version, so the latest release's SHA256SUMS says which version "latest" is.
line=$(grep -E "^[0-9a-fA-F]{64}  tychicus-[0-9]+\.[0-9]+\.[0-9]+-$tag\.tar\.gz$" "$dir/SHA256SUMS" | head -n 1 || true)
[ -n "$line" ] || fail "this release has no archive for $tag. Releases are built for linux-x64 and darwin-arm64: https://github.com/$REPO/releases"
want=$(printf '%s\n' "$line" | cut -d ' ' -f 1 | tr 'A-F' 'a-f')
archive=$(printf '%s\n' "$line" | sed 's/^[0-9a-fA-F]*  //')
found="${archive#tychicus-}"
found="${found%-"$tag".tar.gz}"
[ -z "$version" ] || [ "$found" = "$version" ] || fail "SHA256SUMS for v$version lists $archive, not version $version."
version="$found"

say "Downloading $archive"
fetch "$BASE/download/v$version/$archive" "$dir/$archive" || fail "could not download $archive."

got=$(sha256 "$dir/$archive")
if [ "$got" != "$want" ]; then
	fail "the SHA-256 of $archive does not match SHA256SUMS (got $got, want $want). The download is damaged or was changed; nothing was installed."
fi
say "Checked: $archive matches SHA256SUMS"

gh="${TYCHICUS_GH:-}"
if [ -z "$gh" ]; then gh=$(command -v gh 2>/dev/null || true); fi
if [ "$gh" = none ] || [ -z "$gh" ]; then
	say "Skipped the build attestation check: the GitHub CLI (gh) is not installed. With it, this also runs gh attestation verify --repo $REPO."
elif ! "$gh" auth status --hostname github.com >/dev/null 2>&1; then
	# gh attestation verify needs a token, so a signed-out gh can't check. GH_TOKEN or GITHUB_TOKEN counts as signed in.
	say "Skipped the build attestation check: the GitHub CLI (gh) is installed but not signed in, so the build attestation was not checked. Run gh auth login to turn the check on."
	# The program checks again below; it must not try what gh just said it can't do.
	TYCHICUS_GH=none
	export TYCHICUS_GH
else
	if ! "$gh" attestation verify "$dir/$archive" --repo "$REPO" --signer-workflow "$WORKFLOW" >"$dir/attestation.log" 2>&1; then
		tail -n 5 "$dir/attestation.log" >&2
		fail "gh attestation verify refused $archive: it was not built by $REPO's release workflow, or gh could not check (run gh auth login). Nothing was installed."
	fi
	say "Checked: $archive was built by $REPO's release workflow (gh attestation verify)"
fi

tar -xzf "$dir/$archive" -C "$dir" || fail "could not unpack $archive."
program="$dir/${archive%.tar.gz}/tychicus"
[ -x "$program" ] || fail "$archive holds no tychicus program."

"$program" install --release "$dir" "$@" || fail "tychicus install --release failed; see above. Nothing changed if it stopped before registering."

[ "$dry_run" = 0 ] || exit 0
root="${XDG_DATA_HOME:-$HOME/.local/share}/tychicus/release"
say ""
say "The Local Studio helper $version is installed in $root."
# The release's install links ~/.local/bin/tychicus to it. When this shell finds that link and it names the release, the
# short name works; a link it left alone (someone else's tychicus) doesn't count.
run="$root/tychicus"
if [ "$(command -v tychicus 2>/dev/null || true)" = "$HOME/.local/bin/tychicus" ] && [ "$(readlink "$HOME/.local/bin/tychicus" 2>/dev/null || true)" = "$root/tychicus" ]; then
	run=tychicus
fi
say "Next: if you added the extension from the Chrome Web Store, its side panel now shows the helper connected. Otherwise load"
say "the extension from the folder printed above. Then connect your coding agents: $run setup"
