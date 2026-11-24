#!/bin/bash
# Checks for tychicus-vm that need no guest image. Builds the helper, then:
# a reset before the guest is ready is refused and leaves it starting, not failed (a failed helper exits
# 3 s later and takes the guest with it). The guest is a blank disk, so it never reaches the agent; its
# firmware powers it off after a few seconds, so the status is read at once.
set -euo pipefail
cd "$(dirname "$0")"
bin="$(./build.sh)"
dir="$(mktemp -d "${TMPDIR:-/private/tmp}/tychicus-vm-check.XXXXXX")"
pid=""
cleanup() {
	[ -n "$pid" ] && kill "$pid" 2>/dev/null || true
	rm -rf "$dir"
}
trap cleanup EXIT
echo '{"cpus":1,"memoryMiB":512,"width":640,"height":480}' > "$dir/machine.json"
truncate -s 64m "$dir/disk.raw"
"$bin" serve "$dir" > "$dir/helper.log" 2>&1 &
pid=$!
ask() { echo "$1" | nc -w 10 -U "$dir/control.sock"; }
for _ in $(seq 1 100); do [ -S "$dir/control.sock" ] && break; sleep 0.1; done
reply="$(ask '{"op":"reset"}')"
echo "reset before ready: $reply"
case "$reply" in
*'"ok":false'*'starting'* | *'starting'*'"ok":false'*) ;;
*) echo "FAIL: reset before ready was not refused as starting" >&2; exit 1 ;;
esac
status="$(ask '{"op":"status"}')"
case "$status" in
*'"state":"starting"'*) echo "ok: the guest is still starting after the refused reset" ;;
*) echo "FAIL: status after a refused reset: $status" >&2; exit 1 ;;
esac
