#!/bin/bash
# Checks for tychicus-vm that need no guest image. Builds the helper, then runs it on a blank disk, which never
# reaches the agent. The firmware powers a blank disk off after a few seconds, so each step acts at once.
#
# 1. A reset before the guest is ready is refused and leaves it starting, not failed (a failed helper exits
#    3 s later and takes the guest with it).
# 2. SIGTERM and SIGINT save the session, as `down` does, also while a saved session is still being restored.
# 3. Only a reset replaces disk.raw: after kill -9, a plain start boots the disk as it was left, although the
#    guest has a ready point; --from-ready refuses to overwrite it, and works once disk.raw is gone.
set -euo pipefail
cd "$(dirname "$0")"
bin="$(./build.sh)"
dir="$(mktemp -d "${TMPDIR:-/private/tmp}/tychicus-vm-check.XXXXXX")"
pid=""
cleanup() {
	[ -n "$pid" ] && kill -9 "$pid" 2>/dev/null || true
	rm -rf "$dir"
}
trap cleanup EXIT
fail() {
	echo "FAIL: $1" >&2
	sed 's/^/  helper: /' "$dir/helper.log" >&2
	exit 1
}
ask() { echo "$1" | nc -w 10 -U "$dir/control.sock" 2>/dev/null || true; }
start() {
	rm -f "$dir/control.sock"
	"$bin" serve "$dir" "$@" > "$dir/helper.log" 2>&1 &
	pid=$!
	for _ in $(seq 1 100); do [ -S "$dir/control.sock" ] && return; sleep 0.1; done
	fail "the helper opened no socket"
}
# Wait until the VM runs, and print how it started: cold, ready or session.
booted() {
	for _ in $(seq 1 200); do
		status="$(ask '{"op":"status"}')"
		case "$status" in
		*'"boot":"cold"'*) echo cold; return ;;
		*'"boot":"ready"'*) echo ready; return ;;
		*'"boot":"session"'*) echo session; return ;;
		*'"state":"failed"'*) break ;;
		esac
		sleep 0.05
	done
	echo "not started: ${status:-no answer}"
}
# The process exits with the helper, or the VM process that holds the disk goes a moment after it.
gone() {
	wait "$pid" 2>/dev/null || true
	pid=""
	for _ in $(seq 1 100); do [ -z "$(lsof -t "$dir/disk.raw" 2>/dev/null)" ] && return; sleep 0.1; done
	fail "the VM still holds disk.raw"
}
marker() { dd if="$dir/disk.raw" bs=1 skip=33554432 count=6 2>/dev/null; }

echo '{"cpus":1,"memoryMiB":512,"width":640,"height":480}' > "$dir/machine.json"
truncate -s 64m "$dir/disk.raw"

start
reply="$(ask '{"op":"reset"}')"
echo "reset before ready: $reply"
case "$reply" in
*'"ok":false'*'starting'* | *'starting'*'"ok":false'*) ;;
*) fail "reset before ready was not refused as starting" ;;
esac
status="$(ask '{"op":"status"}')"
case "$status" in
*'"state":"starting"'*) echo "ok: the guest is still starting after the refused reset" ;;
*) fail "status after a refused reset: $status" ;;
esac
kill -9 "$pid"
gone

saved=1
for sig in TERM INT; do
	rm -f "$dir/session.vzvmsave"
	start
	how="$(booted)"
	[ "$how" = cold ] || fail "start before SIG$sig: $how"
	kill "-$sig" "$pid"
	gone
	if [ -s "$dir/session.vzvmsave" ]; then
		start
		kill "-$sig" "$pid"
		gone
	fi
	if [ -s "$dir/session.vzvmsave" ]; then
		echo "ok: SIG$sig saved the session, and again during its restore"
	else
		echo "FAIL: SIG$sig saved no session" >&2
		saved=0
	fi
done

# A ready point: a session saved as early as it can be (the firmware has a few seconds), and its disk.
rm -f "$dir/session.vzvmsave"
start
kill -TERM "$pid"
gone
[ -s "$dir/session.vzvmsave" ] || saved=0
if [ "$saved" = 1 ]; then mv "$dir/session.vzvmsave" "$dir/ready.vzvmsave"; else echo none > "$dir/ready.vzvmsave"; fi
rm -f "$dir/session.vzvmsave"
cp -c "$dir/disk.raw" "$dir/ready.raw"
printf MARKER | dd of="$dir/disk.raw" bs=1 seek=33554432 conv=notrunc 2>/dev/null
start
echo "start with a ready point: $(booted)"
kill -9 "$pid"
gone
start
how="$(booted)"
kill -9 "$pid"
gone
[ "$(marker)" = MARKER ] || fail "a plain start after kill -9 replaced disk.raw with the ready point"
[ "$how" = cold ] || fail "a plain start after kill -9 did not cold boot: $how"
echo "ok: after kill -9 a plain start cold boots disk.raw, and the marker survives"
[ "$saved" = 1 ] || exit 1

code=0
"$bin" serve "$dir" --from-ready > "$dir/helper.log" 2>&1 || code=$?
[ "$code" = 1 ] && [ "$(marker)" = MARKER ] || fail "--from-ready with a disk.raw: exit $code, marker '$(marker)'"
echo "ok: --from-ready refuses an existing disk.raw: $(cat "$dir/helper.log")"
rm "$dir/disk.raw"
start --from-ready
how="$(booted)"
[ "$how" = ready ] || fail "--from-ready without a disk.raw: $how"
kill -9 "$pid"
gone
echo "ok: --from-ready without a disk.raw restores the ready point"
