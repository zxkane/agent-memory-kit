#!/bin/bash
# Enable agent-memory on this machine.
#
#   setup.sh [--dry-run] [--init <host> --repo-url <url>] [--no-enable] [--no-hooks]
#
# --init writes ~/.config/agent-memory/config.json (first run only).
# --dry-run prints what would happen and changes nothing.
# --no-enable writes the systemd units but does not enable the timers.
# When the config has consolidate.extract / consolidate.organize schedules, the matching
# weekly timer is written too; a scope without a schedule has its units removed.
# The same holds for canary.schedule (the timer of the deployed checks of the memory API).
# When the config has a bridge block with agentsRepoUrl and its agentsRepoDir does not exist,
# that repository is cloned there (the URL is never printed).
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
extract_cal=""
organize_cal=""
consolidate_problem=""
agents_dir=""
agents_url=""
bridge_problem=""
canary_cal=""
canary_problem=""
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
        process.stdout.write(JSON.stringify([c.repoDir, c.repoUrl ?? "", c.consolidate?.extract ?? "", c.consolidate?.organize ?? "", c.consolidateProblem ?? "", c.bridge?.agentsRepoDir ?? "", c.bridge?.agentsRepoUrl ?? "", c.bridgeProblem ?? "", c.canary?.schedule ?? "", c.canaryProblem ?? ""]));
    ' "file://$kit_dir/workstation/lib/config.mjs")" || die "$config_file is not a valid, enabled configuration."
    repo_dir="$(node -p 'JSON.parse(process.argv[1])[0]' "$cfg")"
    repo_url="$(node -p 'JSON.parse(process.argv[1])[1]' "$cfg")"
    extract_cal="$(node -p 'JSON.parse(process.argv[1])[2]' "$cfg")"
    organize_cal="$(node -p 'JSON.parse(process.argv[1])[3]' "$cfg")"
    consolidate_problem="$(node -p 'JSON.parse(process.argv[1])[4]' "$cfg")"
    agents_dir="$(node -p 'JSON.parse(process.argv[1])[5]' "$cfg")"
    agents_url="$(node -p 'JSON.parse(process.argv[1])[6]' "$cfg")"
    bridge_problem="$(node -p 'JSON.parse(process.argv[1])[7]' "$cfg")"
    canary_cal="$(node -p 'JSON.parse(process.argv[1])[8]' "$cfg")"
    canary_problem="$(node -p 'JSON.parse(process.argv[1])[9]' "$cfg")"
fi
# A consolidate or canary block that is present but invalid leaves its units as they are:
# reading it as "no schedule" would remove timers that the person did not ask to remove.
# True when systemd-analyze is on the PATH and rejects the calendar expression $2 of scope $1;
# then prints one line, and that scope's units are left as they are. Without the tool, nothing
# is checked here (setup's own check in config.mjs still applies).
calendar_rejected() { # calendar_rejected <extract|organize|canary> <calendar>
    command -v systemd-analyze > /dev/null 2>&1 || return 1
    systemd-analyze calendar "$2" > /dev/null 2>&1 && return 1
    printf 'the %s schedule "%s" is not a valid systemd calendar expression (systemd-analyze calendar rejected it); the %s units were left as they are.\n' "$1" "$2" "$1"
}
invalid_block_line() { # invalid_block_line <consolidate|canary>
    case "$1" in
        canary) printf 'the canary block in %s is invalid (%s); the canary units were left as they are.\n' "$config_file" "$canary_problem" ;;
        *) printf 'the consolidate block in %s is invalid (%s); the consolidation units were left as they are.\n' "$config_file" "$consolidate_problem" ;;
    esac
}
# The problem of the block that holds the schedule of a timer scope; empty when the block is valid.
scope_problem() { # scope_problem <extract|organize|canary>
    case "$1" in
        canary) printf '%s' "$canary_problem" ;;
        *) printf '%s' "$consolidate_problem" ;;
    esac
}

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

# The agents repository of the bridge: cloned when the config names its URL and its folder is
# missing. An existing folder is left alone (the bridge checks it at run time). The URL is never
# printed: it may hold a credential.
agents_clone_needed=0
[[ -n "$agents_url" && -n "$agents_dir" && ! -e "$agents_dir" ]] && agents_clone_needed=1
# The folder must not overlap the notes clone by real path either (config.mjs only compares the
# text): a parent that is a link into the notes clone would put the mirror inside its work tree.
agents_overlaps=0
if [[ $agents_clone_needed -eq 1 ]]; then
    real_agents="$(realpath -m -- "$agents_dir" 2> /dev/null || true)"
    real_notes="$(realpath -m -- "$repo_dir" 2> /dev/null || true)"
    if [[ -z "$real_agents" || -z "$real_notes" || "$real_agents/" == "$real_notes/"* || "$real_notes/" == "$real_agents/"* ]]; then
        agents_clone_needed=0
        agents_overlaps=1
    fi
fi
agents_overlap_line() {
    printf 'the agents repository was not cloned: %s overlaps the notes clone (by real path).\n' "$agents_dir"
}
bridge_problem_line() {
    printf 'the bridge block in %s is invalid (%s); the agents repository was not cloned.\n' "$config_file" "$bridge_problem"
}

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
    [[ -z "$bridge_problem" ]] || bridge_problem_line
    [[ $agents_overlaps -eq 0 ]] || agents_overlap_line
    [[ $agents_clone_needed -eq 0 ]] || printf 'would clone the agents repository into %s\n' "$agents_dir"
    if [[ $hooks -eq 1 ]]; then
        printf 'would run node %s/workstation/install.mjs (hooks in %s)\n' "$kit_dir" "$settings_file"
    else
        printf 'would run node %s/workstation/install.mjs --no-hooks (no hooks in %s)\n' "$kit_dir" "$settings_file"
    fi
    node "$kit_dir/workstation/install.mjs" --plan ${install_flags[@]+"${install_flags[@]}"}
    printf 'would write %s/agent-memory-sync.service and agent-memory-sync.timer\n' "$unit_dir"
    timers_on=""
    [[ -z "$consolidate_problem" ]] || invalid_block_line consolidate
    [[ -z "$canary_problem" ]] || invalid_block_line canary
    for scope in extract organize canary; do
        [[ -z "$(scope_problem "$scope")" ]] || continue
        cal_var="${scope}_cal"
        if [[ -n "${!cal_var}" ]] && calendar_rejected "$scope" "${!cal_var}"; then
            continue
        elif [[ -n "${!cal_var}" ]]; then
            printf 'would write %s/agent-memory-%s.service and agent-memory-%s.timer\n' "$unit_dir" "$scope" "$scope"
            timers_on="$timers_on agent-memory-$scope.timer"
        else
            for f in "$unit_dir/agent-memory-$scope.timer" "$unit_dir/agent-memory-$scope.service"; do
                [[ -e "$f" ]] && printf 'would remove %s\n' "$f"
            done
        fi
    done
    if [[ $enable -eq 1 ]]; then
        printf '%s\n' "would run systemctl --user daemon-reload and enable --now agent-memory-sync.timer$timers_on"
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

[[ -z "$bridge_problem" ]] || bridge_problem_line
[[ $agents_overlaps -eq 0 ]] || agents_overlap_line
if [[ $agents_clone_needed -eq 1 ]]; then
    # Git's own messages are not shown: they repeat the URL. The bridge works on main only, so that
    # branch is cloned. When that fails, the remote is asked what it has: it cannot be reached
    # (nothing is cloned); it has no branch yet (its marker file is still to be created: it is
    # cloned as it is and the local branch is made main, so that a first commit creates main); it
    # has branches but not main (nothing is cloned); or the clone failed for another reason.
    agents_cloned=0
    agents_empty=0
    agents_why=""
    if GIT_TERMINAL_PROMPT=0 git clone -q -b main -- "$agents_url" "$agents_dir" > /dev/null 2>&1; then
        agents_cloned=1
    elif ! agents_heads="$(GIT_TERMINAL_PROMPT=0 git ls-remote --heads -- "$agents_url" 2> /dev/null)"; then
        agents_why='the remote could not be reached'
    elif [[ -z "$agents_heads" ]]; then
        if GIT_TERMINAL_PROMPT=0 git clone -q -- "$agents_url" "$agents_dir" > /dev/null 2>&1; then
            agents_cloned=1
            agents_empty=1
        fi
    elif ! grep -q $'\trefs/heads/main$' <<< "$agents_heads"; then
        agents_why='the agents repository has no main branch, and the bridge works on main only'
    fi
    if [[ $agents_cloned -eq 1 ]]; then
        printf 'cloned the agents repository into %s\n' "$agents_dir"
        if [[ $agents_empty -eq 1 ]]; then
            if ! git -C "$agents_dir" symbolic-ref HEAD refs/heads/main > /dev/null 2>&1; then
                printf 'could not make main the branch of %s; run: git -C %s checkout -b main\n' "$agents_dir" "$agents_dir"
            fi
            printf '%s\n' 'the agents repository is empty; add the marker file .agent-memory-mirror to it on main.'
        fi
    elif [[ -n "$agents_why" ]]; then
        printf 'could not clone the agents repository into %s: %s; check agentsRepoUrl in %s and run setup.sh again.\n' "$agents_dir" "$agents_why" "$config_file"
    else
        printf 'could not clone the agents repository into %s; check agentsRepoUrl in %s and run setup.sh again.\n' "$agents_dir" "$config_file"
    fi
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

# Timers with a schedule in the config: the weekly consolidation of each scope, and the canary. A
# scope without a schedule loses its units. The calendar expression is validated by
# workstation/lib/config.mjs and is one line.
timers_on=()
removed=0
write_timer_units() { # write_timer_units <extract|organize|canary> <calendar>
    local scope="$1" service_desc timer_desc exec_args timeout nice="" jitter
    if [[ "$scope" == canary ]]; then
        service_desc='Check the deployed memory API'
        timer_desc='Check the deployed memory API on a schedule'
        exec_args=canary
        timeout=300
        jitter=5min
    else
        service_desc="Consolidate the shared agent memory ($scope)"
        timer_desc="Consolidate the shared agent memory ($scope) weekly"
        exec_args="consolidate $scope"
        timeout=4h
        nice='Nice=10'
        jitter=10min
    fi
    {
        cat << UNIT
# Managed by agent-memory-kit setup.sh.
[Unit]
Description=$service_desc

[Service]
Type=oneshot
Environment=PATH=$node_dir:/usr/local/bin:/usr/bin:/bin
ExecStart="$kit_dir/workstation/run.sh" $exec_args
TimeoutStartSec=$timeout
UMask=0077
UNIT
        [[ -z "$nice" ]] || printf '%s\n' "$nice"
    } | write_unit "agent-memory-$scope.service"
    write_unit "agent-memory-$scope.timer" << UNIT
# Managed by agent-memory-kit setup.sh.
[Unit]
Description=$timer_desc

[Timer]
OnCalendar=$2
Persistent=true
RandomizedDelaySec=$jitter

[Install]
WantedBy=timers.target
UNIT
    timers_on+=("agent-memory-$scope.timer")
}
[[ -z "$consolidate_problem" ]] || invalid_block_line consolidate
[[ -z "$canary_problem" ]] || invalid_block_line canary
for scope in extract organize canary; do
    [[ -z "$(scope_problem "$scope")" ]] || continue
    cal_var="${scope}_cal"
    if [[ -n "${!cal_var}" ]] && calendar_rejected "$scope" "${!cal_var}"; then
        continue
    elif [[ -n "${!cal_var}" ]]; then
        write_timer_units "$scope" "${!cal_var}"
        printf 'wrote agent-memory-%s.service and agent-memory-%s.timer\n' "$scope" "$scope"
    elif [[ -e "$unit_dir/agent-memory-$scope.timer" || -e "$unit_dir/agent-memory-$scope.service" ]]; then
        if [[ -e "$unit_dir/agent-memory-$scope.timer" ]]; then
            systemctl --user disable --now "agent-memory-$scope.timer" || true
        fi
        rm -f "$unit_dir/agent-memory-$scope.timer" "$unit_dir/agent-memory-$scope.service"
        removed=1
        printf 'removed agent-memory-%s.service and agent-memory-%s.timer\n' "$scope" "$scope"
    fi
done

if [[ $enable -eq 1 ]]; then
    systemctl --user daemon-reload
    systemctl --user enable --now agent-memory-sync.timer
    printf '%s\n' 'enabled agent-memory-sync.timer'
    for t in ${timers_on[@]+"${timers_on[@]}"}; do
        systemctl --user enable --now "$t"
        printf 'enabled %s\n' "$t"
    done
else
    if [[ $removed -ne 0 ]] && ! systemctl --user daemon-reload; then
        printf '%s\n' 'could not reload systemd (systemctl --user daemon-reload failed); run it by hand'
    fi
    printf '%s\n' 'timer not enabled (--no-enable)'
fi
