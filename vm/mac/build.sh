#!/bin/bash
# Build tychicus-vm and sign it ad hoc with the virtualization entitlement, which
# Virtualization.framework requires. Prints the path of the signed binary.
set -euo pipefail
cd "$(dirname "$0")"
swift build -c release --product tychicus-vm >&2
bin="$(swift build -c release --show-bin-path)/tychicus-vm"
codesign --force --sign - --entitlements tychicus-vm.entitlements "$bin" >&2
echo "$bin"
