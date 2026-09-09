#!/usr/bin/env bash
# Build this fork and install it as a separate binary named `omomp`.
#
# The update loop this exists for:
#   git pull && ./install.sh
#
# HARD RULE (see AGENTS.md): this never touches the live `omp` on PATH. That
# binary is the daily driver; the fork installs beside it under its own name,
# and the two deliberately share ~/.omp config, state and session history.
#
# Install location defaults to ~/.local/bin; override with OMOMP_INSTALL_DIR.
# Toolchain handling lives in build.sh: on NixOS it builds inside the flake's
# dev shell, elsewhere it preflights the host tools and reports what is absent.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

INSTALL_DIR="${OMOMP_INSTALL_DIR:-$HOME/.local/bin}"
TARGET="$INSTALL_DIR/omomp"

if [ -e "$TARGET" ] && [ ! -w "$TARGET" ]; then
	echo "error: $TARGET exists and is not writable" >&2
	exit 1
fi

./build.sh

BIN="packages/coding-agent/dist/omp"
mkdir -p "$INSTALL_DIR"
install -m 755 "$BIN" "$TARGET"

echo
echo "Installed: $TARGET"
"$TARGET" --version || true

case ":$PATH:" in
*":$INSTALL_DIR:"*) ;;
*)
	echo
	echo "note: $INSTALL_DIR is not on your PATH. Add it, e.g.:"
	echo "  export PATH=\"$INSTALL_DIR:\$PATH\""
	;;
esac

echo
echo "Run it with: omomp"
