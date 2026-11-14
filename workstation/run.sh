#!/bin/bash
# Launcher: run.sh session-start [claude|codex|kiro] | pre-write | sync | migrate | consolidate | consolidate-step
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mode="${1:-}"
node_path=""
if [[ -r "$root/node.local.path" ]]; then
    IFS= read -r node_path < "$root/node.local.path" || true
fi
if [[ -z "$node_path" || ! -x "$node_path" ]]; then
    node_path="$(command -v node || true)"
fi
# Opens the sync lock file on descriptor 9; the caller then takes the lock with flock.
take_sync_lock() {
    local lock_dir="$HOME/.local/state/agent-memory"
    mkdir -p -m 700 "$lock_dir"
    exec 9> "$lock_dir/sync.lock"
}
# Opens the consolidation lock file on descriptor 8: one consolidation at a time.
take_consolidate_lock() {
    local lock_dir="$HOME/.local/state/agent-memory"
    mkdir -p -m 700 "$lock_dir"
    exec 8> "$lock_dir/consolidate.lock"
}
require_node() {
    if [[ -z "$node_path" || ! -x "$node_path" ]]; then
        printf '%s\n' 'agent-memory: Node.js was not found. Run setup.sh from agent-memory-kit.' >&2
        exit 1
    fi
}
case "$mode" in
    session-start)
        [[ -n "$node_path" && -x "$node_path" ]] || exit 0
        exec "$node_path" "$root/session-start.mjs" "${@:2}"
        ;;
    pre-write)
        [[ -n "$node_path" && -x "$node_path" ]] || exit 0
        exec "$node_path" "$root/pre-write.mjs"
        ;;
    sync)
        if [[ -z "$node_path" || ! -x "$node_path" ]]; then
            printf '%s\n' 'agent-memory: Node.js was not found. Run setup.sh from agent-memory-kit.' >&2
            exit 1
        fi
        take_sync_lock
        flock -n 9 || exit 0
        exec "$node_path" "$root/sync.mjs"
        ;;
    migrate)
        if [[ -z "$node_path" || ! -x "$node_path" ]]; then
            printf '%s\n' 'agent-memory: Node.js was not found. Run setup.sh from agent-memory-kit.' >&2
            exit 1
        fi
        for arg in "${@:2}"; do
            if [[ "$arg" == --apply ]]; then
                # The whole apply runs under the sync lock; a running sync is waited for.
                take_sync_lock
                if ! flock -w "${AGENT_MEMORY_LOCK_WAIT_SECONDS:-120}" 9; then
                    printf '%s\n' 'agent-memory: a sync is running; try again.' >&2
                    exit 1
                fi
            fi
        done
        exec "$node_path" "$root/migrate.mjs" "${@:2}"
        ;;
    consolidate)
        require_node
        take_consolidate_lock
        if ! flock -n 8; then
            printf '%s\n' 'agent-memory: a consolidation is already running.'
            exit 0
        fi
        exec "$node_path" "$root/consolidate.mjs" "${@:2}"
        ;;
    consolidate-step)
        # A step of a consolidation that reads or writes the clone; a running sync is waited for.
        # Exit 75 (EX_TEMPFAIL) tells the driver that the wait timed out and the step did nothing.
        require_node
        take_sync_lock
        if ! flock -w "${AGENT_MEMORY_LOCK_WAIT_SECONDS:-300}" 9; then
            printf '%s\n' 'agent-memory: a sync is running; try again.' >&2
            exit 75
        fi
        exec "$node_path" "$root/consolidate.mjs" --step "${@:2}"
        ;;
    *)
        printf '%s\n' 'usage: run.sh session-start [claude|codex|kiro] | pre-write | sync | migrate | consolidate extract|organize [options]' >&2
        exit 2
        ;;
esac
