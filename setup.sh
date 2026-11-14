#!/bin/bash
# Enable agent-memory on this machine.
#
#   setup.sh [--dry-run] [--init <host> --repo-url <url>] [--no-enable] [--no-hooks]
#
# --init writes ~/.config/agent-memory/config.json (first run only).
# --dry-run prints what would happen and changes nothing.
# --no-enable writes the systemd units but does not enable the timer.
# --no-hooks does everything else but does not register the Claude Code, Codex and
#   Kiro hooks (and removes the kit's own entries if present).
set -euo pipefail

die() {
    printf 'setup.sh: %s\n' "$*" >&2
    exit 1
}

usage() {
    printf '%s\n' 'usage: setup.sh [--dry-run] [--init <host> --repo-url <url>] [--no-enable] [--no-hooks]' >&2
    exit 2
}

dry_run=0
enable=1
hooks=1
init_host=""
repo_url_arg=""
init=0
while [[ $# -gt 0 ]]; do
    case "$1" in
        --dry-run) dry_run=1 ;;
        --no-enable) enable=0 ;;
        --no-hooks) hooks=0 ;;
        --init)
            [[ $# -ge 2 ]] || usage
            init=1
            init_host="$2"
            shift
            ;;
        --repo-url)
            [[ $# -ge 2 ]] || usage
            repo_url_arg="$2"
            shift
            ;;
        *) usage ;;
    esac
    shift
done

kit_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

# Paths that end up inside a unit file or a hook command must not need escaping.
# Prints the first character of $1 that is not supported, described in words.
unsafe_char() {
    local s="$1" i
    for ((i = 0; i < ${#s}; i++)); do
        case "${s:i:1}" in
            '"') printf '%s' 'a double quote' ;;
            '$') printf '%s' 'a "$"' ;;
            '`') printf '%s' 'a backtick' ;;
            '%') printf '%s' 'a percent sign' ;;
            '\') printf '%s' 'a backslash' ;;
            '#') printf '%s' 'a "#"' ;;
            '?') printf '%s' 'a "?"' ;;
            ' ') printf '%s' 'a space' ;;
            $'\n') printf '%s' 'a newline' ;;
            *) continue ;;
        esac
        return 0
    done
    return 1
}

# 1. Requirements.
have_node=0
if command -v node > /dev/null 2>&1 && command -v git > /dev/null 2>&1 && command -v flock > /dev/null 2>&1; then
    major="$(node -p 'process.versions.node.split(".")[0]' 2> /dev/null || true)"
    [[ "$major" =~ ^[0-9]+$ ]] && ((major >= 24)) && have_node=1
fi
if [[ $have_node -ne 1 ]]; then
    printf '%s\n' 'Node.js 24, git and flock are required.' >&2
    exit 1
fi
node_bin="$(node -p 'process.execPath')"
node_dir="$(dirname "$node_bin")"

[[ -n "${HOME:-}" && "$HOME" == /* && -d "$HOME" ]] || die 'HOME must be an absolute path to an existing directory.'
if why="$(unsafe_char "$kit_dir")"; then die "the kit path contains $why, which is not supported: $kit_dir"; fi
if why="$(unsafe_char "$node_dir")"; then die "the Node.js path contains $why, which is not supported: $node_dir"; fi

config_file="$HOME/.config/agent-memory/config.json"
unit_dir="$HOME/.config/systemd/user"
settings_file="$HOME/.claude/settings.json"
state_dir="$HOME/.local/state/agent-memory"

# 2-3. Configuration: validate before anything is written.
if [[ $init -eq 1 ]]; then
    [[ "$init_host" =~ ^[a-z0-9][a-z0-9-]{0,30}$ ]] \
        || die 'the host name must be lowercase letters, digits and hyphens, start with a letter or digit, and be at most 31 characters.'
    [[ -n "$repo_url_arg" ]] || die '--init needs --repo-url <url>.'
    [[ "$repo_url_arg" != -* ]] || die 'the repository URL must not start with "-".'
    [[ ! -e "$config_file" ]] || die "$config_file already exists; run setup.sh without --init (edit the file to change the host or URL)."
    repo_dir="$HOME/agent-memory"
    repo_url="$repo_url_arg"
else
    [[ -z "$repo_url_arg" ]] || die '--repo-url is only used together with --init.'
    if [[ ! -f "$config_file" ]]; then
        printf '%s\n' 'agent-memory is not enabled on this machine. Run: setup.sh --init <host> --repo-url <url>' >&2
        exit 1
    fi
    cfg="$(HOME="$HOME" node --input-type=module -e '
        const { loadConfig } = await import(process.argv[1]);
        const c = loadConfig({ HOME: process.env.HOME });
        if (!c) process.exit(3);
        process.stdout.write(JSON.stringify([c.repoDir, c.repoUrl ?? ""]));
    ' "file://$kit_dir/workstation/lib/config.mjs")" || die "$config_file is not a valid, enabled configuration."
    repo_dir="$(node -p 'JSON.parse(process.argv[1])[0]' "$cfg")"
    repo_url="$(node -p 'JSON.parse(process.argv[1])[1]' "$cfg")"
fi

# 4. The notes clone: an existing directory must already be a clone on main.
clone_needed=0
if [[ -e "$repo_dir" ]]; then
    top="$(git -C "$repo_dir" rev-parse --show-toplevel 2> /dev/null || true)"
    here="$(cd -P "$repo_dir" 2> /dev/null && pwd -P || true)"
    branch="$(git -C "$repo_dir" symbolic-ref --short HEAD 2> /dev/null || true)"
    [[ -n "$top" && "$top" == "$here" ]] || die "$repo_dir exists but is not a Git clone."
    [[ "$branch" == main ]] || die "$repo_dir is on branch '${branch:-detached}', not main."
else
    [[ -n "$repo_url" ]] || die "$repo_dir is missing and the configuration has no repoUrl to clone."
    clone_needed=1
fi

# 5. Checks that change nothing: the settings file the hooks go into, the hook files that
# install.mjs would have to read, and the notes repository.
if [[ -e "$settings_file" ]]; then
    node -e '
        let value;
        try {
            value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
        } catch {
            process.exit(3);
        }
        if (value === null || typeof value !== "object" || Array.isArray(value)) process.exit(3);
    ' "$settings_file" || die "$settings_file is not valid JSON holding an object; fix it and run setup.sh again."
fi
install_flags=()
[[ $hooks -eq 1 ]] || install_flags=(--no-hooks)
if ! check_msg="$(node "$kit_dir/workstation/install.mjs" --check ${install_flags[@]+"${install_flags[@]}"} 2>&1)"; then
    die "$check_msg"
fi
if [[ $init -eq 1 || $clone_needed -eq 1 ]]; then
    GIT_TERMINAL_PROMPT=0 git ls-remote --exit-code "$repo_url" main > /dev/null \
        || die "the notes repository does not answer: git ls-remote --exit-code $repo_url main failed."
fi

if [[ $dry_run -eq 1 ]]; then
    [[ $init -eq 1 ]] && printf 'would write %s (host %s)\n' "$config_file" "$init_host"
    [[ $clone_needed -eq 1 ]] && printf 'would clone %s into %s\n' "$repo_url" "$repo_dir"
    if [[ $hooks -eq 1 ]]; then
        printf 'would run node %s/workstation/install.mjs (hooks in %s)\n' "$kit_dir" "$settings_file"
    else
        printf 'would run node %s/workstation/install.mjs --no-hooks (no hooks in %s)\n' "$kit_dir" "$settings_file"
    fi
    node "$kit_dir/workstation/install.mjs" --plan ${install_flags[@]+"${install_flags[@]}"}
    printf 'would write %s/agent-memory-sync.service and agent-memory-sync.timer\n' "$unit_dir"
    if [[ $enable -eq 1 ]]; then
        printf '%s\n' 'would run systemctl --user daemon-reload and enable --now agent-memory-sync.timer'
    fi
    exit 0
fi

if [[ $init -eq 1 ]]; then
    AM_HOST="$init_host" AM_REPO_DIR="$repo_dir" AM_REPO_URL="$repo_url" AM_FILE="$config_file" node --input-type=module -e '
        import { mkdirSync, writeFileSync } from "node:fs";
        import { dirname } from "node:path";
        const e = process.env;
        mkdirSync(dirname(e.AM_FILE), { recursive: true, mode: 0o700 });
        const body = { enabled: true, host: e.AM_HOST, repoDir: e.AM_REPO_DIR, repoUrl: e.AM_REPO_URL };
        writeFileSync(e.AM_FILE, JSON.stringify(body, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    '
    printf 'wrote %s\n' "$config_file"
fi

if [[ $clone_needed -eq 1 ]]; then
    git clone -b main -- "$repo_url" "$repo_dir"
fi

mkdir -p "$(dirname "$state_dir")"
mkdir -p -m 700 "$state_dir"

# 6. Hooks and the recorded Node.js path.
if [[ $hooks -eq 1 ]]; then
    node "$kit_dir/workstation/install.mjs"
else
    node "$kit_dir/workstation/install.mjs" --no-hooks
    printf '%s\n' 'hooks not registered (--no-hooks)'
fi

# 7. systemd units.
mkdir -p "$unit_dir"
write_unit() { # write_unit <name> (content on stdin)
    local tmp="$unit_dir/.$1.tmp.$$"
    cat > "$tmp"
    mv -f "$tmp" "$unit_dir/$1"
}
write_unit agent-memory-sync.service << UNIT
# Managed by agent-memory-kit setup.sh.
[Unit]
Description=Sync the shared agent memory clone with its remote

[Service]
Type=oneshot
Environment=PATH=$node_dir:/usr/local/bin:/usr/bin:/bin
ExecStart="$kit_dir/workstation/run.sh" sync
TimeoutStartSec=120
UMask=0077
UNIT
write_unit agent-memory-sync.timer << 'UNIT'
# Managed by agent-memory-kit setup.sh.
[Unit]
Description=Sync the shared agent memory clone every two minutes

[Timer]
OnStartupSec=1min
OnUnitActiveSec=2min
AccuracySec=10s

[Install]
WantedBy=timers.target
UNIT
printf 'wrote units in %s\n' "$unit_dir"

if [[ $enable -eq 1 ]]; then
    systemctl --user daemon-reload
    systemctl --user enable --now agent-memory-sync.timer
    printf '%s\n' 'enabled agent-memory-sync.timer'
else
    printf '%s\n' 'timer not enabled (--no-enable)'
fi
