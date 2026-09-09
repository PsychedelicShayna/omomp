#!/usr/bin/env bash
# Build the omp CLI into a standalone binary at packages/coding-agent/dist/omp.
#
# Nothing on PATH is touched here. ./install.sh takes the result and installs
# it as `omomp`, alongside (never over) an upstream `omp`.
#
# On NixOS this always builds inside the flake's dev shell, so every machine
# you pull to gets the same pinned toolchain. Anywhere else it builds with
# whatever is on PATH, after checking up front that all of it is present.
set -euo pipefail

SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
cd "$(dirname "$SELF")"

# What the native addon build (crates/pi-natives via cargo) needs when we are
# not in the dev shell. The dev shell supplies all of it itself.
#
# The libraries matter as much as the binaries: audiopus_sys links the system
# opus rather than its own cmake build, because that build installs into lib64
# while the crate's link search hardcodes lib.
REQUIRED_BINS=(bun cargo cc c++ cmake make pkg-config)
REQUIRED_LIBS=(opus)

in_dev_shell() {
	[ -n "${OMOMP_DEV_SHELL:-}" ] || [ -n "${IN_NIX_SHELL:-}" ]
}

is_nixos() {
	[ -e /etc/NIXOS ] || grep -qs '^ID=nixos$' /etc/os-release
}

if ! in_dev_shell; then
	if is_nixos; then
		if ! command -v nix >/dev/null 2>&1; then
			echo "error: this looks like NixOS but 'nix' is not on PATH" >&2
			exit 1
		fi
		echo "==> NixOS detected, building inside 'nix develop'"
		exec nix develop --command env OMOMP_DEV_SHELL=1 "$SELF" "$@"
	fi

	missing=()
	for bin in "${REQUIRED_BINS[@]}"; do
		command -v "$bin" >/dev/null 2>&1 || missing+=("$bin (command)")
	done
	if command -v pkg-config >/dev/null 2>&1; then
		for lib in "${REQUIRED_LIBS[@]}"; do
			pkg-config --exists "$lib" 2>/dev/null || missing+=("$lib (library, seen via pkg-config)")
		done
	fi
	if [ ${#missing[@]} -gt 0 ]; then
		echo "error: cannot build, missing:" >&2
		printf '  - %s\n' "${missing[@]}" >&2
		echo >&2
		echo "install those, or build on a machine with nix and let the dev shell supply them." >&2
		exit 1
	fi
fi

echo "==> bun install"
bun install

echo "==> build:native (Rust/N-API addon)"
bun run build:native

echo "==> build coding-agent binary"
bun --cwd=packages/coding-agent run build

BIN="packages/coding-agent/dist/omp"
if [ ! -x "$BIN" ]; then
	echo "error: expected build output at $BIN but it is missing" >&2
	exit 1
fi

echo
echo "Built: $BIN"
"$BIN" --version || true
