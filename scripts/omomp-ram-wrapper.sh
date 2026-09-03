#!/usr/bin/env bash

set -euo pipefail
if [[ -n "${OMOMP_TMUX_ENV_FILE:-}" ]]; then
	# Restore the caller's complete exported environment without clobbering the
	# terminal identity selected by tmux itself.
	tmux_term="${TERM:-}"
	source "$OMOMP_TMUX_ENV_FILE"
	rm -f -- "$OMOMP_TMUX_ENV_FILE"
	unset OMOMP_TMUX_ENV_FILE
	if [[ -n "$tmux_term" ]]; then
		export TERM="$tmux_term"
	fi
fi


readonly REAL_OMOMP="${OMOMP_REAL_BINARY:-/usr/local/libexec/omomp-portable}"
readonly PORTABLE_BUNDLE="${OMOMP_PORTABLE_BUNDLE:-/usr/local/lib/omomp-portable}"
readonly FILTER_FILE="${OMOMP_RAM_FILTER:-$PORTABLE_BUNDLE/ram-filter.rules}"
readonly SYNC_POLICY="${OMOMP_RAM_SYNC:-ask}"
export OMOMP_PORTABLE_BUNDLE="$PORTABLE_BUNDLE"

if [[ ! -x "$REAL_OMOMP" ]]; then
	printf 'omomp: portable executable is missing or not executable: %s\n' "$REAL_OMOMP" >&2
	exit 127
fi
if [[ ! -r "$FILTER_FILE" ]]; then
	printf 'omomp: RAM filter is missing or unreadable: %s\n' "$FILTER_FILE" >&2
	exit 78
fi
case "$SYNC_POLICY" in
	ask | always | never) ;;
	*)
		printf 'omomp: OMOMP_RAM_SYNC must be ask, always, or never (got %s)\n' "$SYNC_POLICY" >&2
		exit 2
		;;
esac

if [[ "${OMOMP_RAM_DISABLE:-0}" == "1" ]]; then
	exec "$REAL_OMOMP" "$@"
fi

umask 077
if [[ -n "${PI_CODING_AGENT_DIR:-}" ]]; then
	persistent_agent_dir="$PI_CODING_AGENT_DIR"
else
	persistent_agent_dir="$HOME/${PI_CONFIG_DIR:-.omp}/agent"
fi
persistent_agent_dir="$(realpath -m -- "$persistent_agent_dir")"
profile_key="$(printf '%s' "$persistent_agent_dir" | sha256sum | cut -c1-16)"
readonly RAM_BASE="${OMOMP_RAM_ROOT:-/dev/shm/omomp-${UID}}"
readonly RAM_PROFILE="$RAM_BASE/profiles/$profile_key"
readonly RAM_AGENT="$RAM_PROFILE/agent"
readonly RAM_BIN="$RAM_PROFILE/bin/omomp"
readonly INIT_MARKER="$RAM_PROFILE/.initialized"
readonly LOCK_FILE="$RAM_PROFILE/.lock"

mkdir -p -- "$RAM_PROFILE"
chmod 0700 -- "$RAM_BASE" "$RAM_BASE/profiles" "$RAM_PROFILE" 2>/dev/null || true

interactive=0
if [[ -t 0 && -t 1 ]]; then
	interactive=1
fi

# Probe before creating tmux so a second interactive launch reports the busy
# profile in the caller's terminal instead of flashing a short-lived window.
if ((interactive)) && [[ -z "${TMUX:-}" && -z "${OMOMP_TMUX_BOOTSTRAPPED:-}" ]]; then
	exec 8>"$LOCK_FILE"
	if ! flock -n 8; then
		printf 'omomp: another omomp is using this RAM profile; exit it first, or run OMOMP_RAM_DISABLE=1 omomp\n' >&2
		exit 75
	fi
	flock -u 8
	exec 8>&-
	env_file="$RAM_PROFILE/.tmux-env-$$"
	export -p >"$env_file"
	set +e
	tmux new-session -s "omomp-${UID}-$$" -- env \
		OMOMP_TMUX_BOOTSTRAPPED=1 \
		OMOMP_TMUX_ENV_FILE="$env_file" \
		"$0" "$@"
	tmux_status=$?
	set -e
	rm -f -- "$env_file"
	exit "$tmux_status"
fi

exec 9>"$LOCK_FILE"
if ((interactive)); then
	if ! flock -n 9; then
		printf 'omomp: another omomp is using this RAM profile; exit it first, or run OMOMP_RAM_DISABLE=1 omomp\n' >&2
		exit 75
	fi
else
	flock 9
fi

sqlite_backup() {
	local source=$1 destination=$2 escaped
	escaped=${destination//\"/\"\"}
	sqlite3 "$source" ".backup \"$escaped\""
}

filtered_size() {
	local source=$1
	if [[ ! -d "$source" ]]; then
		printf '0\n'
		return
	fi
	rsync -a --dry-run --filter="merge $FILTER_FILE" --out-format='%l' -- "$source/" "$RAM_PROFILE/.measure/" |
		awk '/^[0-9]+$/ { total += $1 } END { printf "%.0f\n", total + 0 }'
}

if [[ ! -e "$INIT_MARKER" || "${OMOMP_RAM_REFRESH:-0}" == "1" ]]; then
required_bytes="$(filtered_size "$persistent_agent_dir")"
for database in agent.db history.db; do
	if [[ -f "$persistent_agent_dir/$database" ]]; then
		database_bytes="$(stat -c '%s' -- "$persistent_agent_dir/$database")"
		required_bytes=$((required_bytes + database_bytes))
	fi
done
binary_bytes="$(stat -c '%s' -- "$REAL_OMOMP")"
required_bytes=$((required_bytes + binary_bytes))
shm_available="$(df --output=avail -B1 /dev/shm | tail -n 1 | tr -d ' ')"
mem_available="$(awk '/^MemAvailable:/ { print $2 * 1024; exit }' /proc/meminfo)"
limiting_available=$((shm_available < mem_available ? shm_available : mem_available))
default_cap=$((limiting_available / 2))
if ((default_cap > 2147483648)); then
	default_cap=2147483648
fi
cap="${OMOMP_RAM_MAX_BYTES:-$default_cap}"
if [[ ! "$cap" =~ ^[0-9]+$ ]]; then
	printf 'omomp: OMOMP_RAM_MAX_BYTES must be an integer byte count (got %s)\n' "$cap" >&2
	exit 2
fi
if ((required_bytes > cap)); then
	printf 'omomp: RAM profile requires %s bytes but cap is %s bytes (shm available=%s, MemAvailable=%s, default cap=%s)\n' \
		"$required_bytes" "$cap" "$shm_available" "$mem_available" "$default_cap" >&2
	printf 'omomp: run OMOMP_RAM_DISABLE=1 omomp to use persistent storage directly\n' >&2
	exit 75
fi
fi

if [[ ! -e "$INIT_MARKER" || "${OMOMP_RAM_REFRESH:-0}" == "1" ]]; then
	printf 'omomp: loading bounded agent state into RAM from %s (%s bytes)\n' "$persistent_agent_dir" "$required_bytes" >&2
	stage="$RAM_PROFILE/.stage-$$"
	rm -rf -- "$stage"
	mkdir -p -- "$stage/agent" "$stage/bin"
	if [[ -d "$persistent_agent_dir" ]]; then
		rsync -a --filter="merge $FILTER_FILE" -- "$persistent_agent_dir/" "$stage/agent/"
		for database in agent.db history.db; do
			if [[ -f "$persistent_agent_dir/$database" ]]; then
				sqlite_backup "$persistent_agent_dir/$database" "$stage/agent/$database"
			fi
		done
	fi
	install -m 0700 -- "$REAL_OMOMP" "$stage/bin/omomp"
	rm -f -- "$INIT_MARKER"
	rm -rf -- "$RAM_AGENT" "$(dirname -- "$RAM_BIN")"
	mv -- "$stage/agent" "$RAM_AGENT"
	mv -- "$stage/bin" "$(dirname -- "$RAM_BIN")"
	rmdir -- "$stage"
	printf '%s\n' "$persistent_agent_dir" >"$INIT_MARKER"
fi

export PI_CODING_AGENT_DIR="$RAM_AGENT"
set +e
"$RAM_BIN" "$@"
omomp_status=$?
set -e

sync_requested=0
case "$SYNC_POLICY" in
	always) sync_requested=1 ;;
	never) ;;
	ask)
		if ((interactive)) && [[ -r /dev/tty && -w /dev/tty ]]; then
			printf '\nSync this RAM session back to %s? [y/N] ' "$persistent_agent_dir" >/dev/tty
			IFS= read -r answer </dev/tty || answer=""
			case "$answer" in
				y | Y | yes | YES | Yes) sync_requested=1 ;;
			esac
		else
			printf 'omomp: RAM state remains unsynchronized at %s\n' "$RAM_AGENT" >&2
		fi
		;;
esac

sync_failed=0
if ((sync_requested)); then
	printf 'omomp: synchronizing bounded RAM state to %s\n' "$persistent_agent_dir" >&2
	mkdir -p -- "$persistent_agent_dir"
	if ! rsync -ac --filter="merge $FILTER_FILE" -- "$RAM_AGENT/" "$persistent_agent_dir/"; then
		sync_failed=1
	fi
	for database in agent.db history.db; do
		if [[ -f "$RAM_AGENT/$database" ]]; then
			staging="$persistent_agent_dir/.$database.new-$$"
			if sqlite_backup "$RAM_AGENT/$database" "$staging"; then
				rm -f -- "$persistent_agent_dir/$database-wal" "$persistent_agent_dir/$database-shm"
				mv -f -- "$staging" "$persistent_agent_dir/$database"
			else
				rm -f -- "$staging"
				sync_failed=1
			fi
		fi
	done
	if ((sync_failed)); then
		printf 'omomp: synchronization failed; RAM state retained at %s\n' "$RAM_AGENT" >&2
	else
		date -u +'%Y-%m-%dT%H:%M:%SZ' >"$RAM_PROFILE/.last-sync"
		printf 'omomp: synchronization complete\n' >&2
	fi
else
	printf 'omomp: RAM state retained at %s (until sync, discard, or reboot)\n' "$RAM_AGENT" >&2
fi

exit "$omomp_status"
