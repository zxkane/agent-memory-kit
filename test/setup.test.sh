#!/bin/bash
# Tests for setup.sh. Uses a copy of the kit, a temporary HOME, a local bare
# repository as the notes remote and a fake systemctl; touches nothing else.
set -euo pipefail

src="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
tmp="$(cd "$tmp" && pwd -P)"

kit="$tmp/kit"
home="$tmp/home"
bin="$tmp/bin"
remote="$tmp/remote.git"
seed="$tmp/seed"
calls="$tmp/systemctl.log"
mkdir -p "$kit" "$home" "$bin"

# The kit under test: tracked and not-ignored files from the working tree. Listed before HOME
# is replaced, so that a safe.directory entry for a checkout owned by another user (as in a
# CI container) still applies; a personal ignore file is not used.
(cd "$src" && git -c core.excludesFile=/dev/null ls-files -z --cached --others --exclude-standard | tar --null -T - -cf -) | tar -xf - -C "$kit"

# From here on, Git in this test never reads the machine's own configuration.
export HOME="$tmp/git-home" GIT_CONFIG_NOSYSTEM=1
unset XDG_CONFIG_HOME GIT_CONFIG_GLOBAL
mkdir -p "$HOME"

git init -q --bare -b main "$remote"
git init -q -b main "$seed"
git -C "$seed" -c user.name=seed -c user.email=seed@example.com commit -q --allow-empty -m 'chore: initial'
git -C "$seed" push -q "$remote" main

printf '%s\n' '#!/bin/bash' "printf '%s\\n' \"\$*\" >> \"$calls\"" > "$bin/systemctl"
chmod +x "$bin/systemctl"

fails=0
check() { # check <description> <command...>
    local desc="$1"
    shift
    if ! "$@"; then
        printf 'FAIL: %s\n' "$desc" >&2
        fails=$((fails + 1))
    fi
}
run_setup() { # run_setup <args...>; sets $out and $status. $setup_path replaces PATH.
    set +e
    out="$(env -i HOME="$home" GIT_CONFIG_NOSYSTEM=1 PATH="${setup_path:-$bin:$PATH}" bash "$kit/setup.sh" "$@" 2>&1)"
    status=$?
    set -e
}
home_empty() { [[ -z "$(ls -A "$home")" ]]; }
fresh_home() { rm -rf "$home" "$calls"; mkdir "$home"; }
# Nothing of a real run exists: no config, no clone, no units, no state directory.
nothing_written() {
    [[ ! -e "$home/.config/agent-memory" && ! -e "$home/agent-memory" && ! -e "$home/.config/systemd" && ! -e "$home/.local" ]] && no_calls
}
has_text() { grep -qF -- "$2" <<< "$1"; }
no_calls() { [[ ! -e "$calls" ]]; }
has_line() { grep -qxF -- "$2" "$1"; }

# 1. No config: refuses and creates nothing.
run_setup
check 'no config exits 1' test "$status" -eq 1
check 'no config explains' grep -q 'agent-memory is not enabled on this machine.' <<< "$out"
check 'no config creates nothing' home_empty
check 'no config does not call systemctl' no_calls

# 2. Dry run: creates nothing.
run_setup --dry-run --init alpha --repo-url "$remote"
check 'dry run exits 0' test "$status" -eq 0
check 'dry run creates nothing' home_empty
check 'dry run does not call systemctl' no_calls
check 'dry run writes no node path' test ! -e "$kit/workstation/node.local.path"

# Invalid input writes nothing.
run_setup --init Bad_Host --repo-url "$remote"
check 'bad host exits non-zero' test "$status" -ne 0
check 'bad host creates nothing' home_empty
run_setup --init alpha
check 'missing url exits non-zero' test "$status" -ne 0
check 'missing url creates nothing' home_empty

# Checks before anything is written: a malformed settings.json and a notes repository that
# does not answer each stop the run.
for bad_settings in '{ not json' '[1, 2]' 'null'; do
    fresh_home
    mkdir "$home/.claude"
    printf '%s\n' "$bad_settings" > "$home/.claude/settings.json"
    run_setup --init alpha --repo-url "$remote"
    check "bad settings ($bad_settings) exits 1" test "$status" -eq 1
    check "bad settings ($bad_settings) says why" has_text "$out" "$home/.claude/settings.json is not valid JSON holding an object"
    check "bad settings ($bad_settings) writes nothing" nothing_written
    check "bad settings ($bad_settings) left as it was" test "$(cat "$home/.claude/settings.json")" = "$bad_settings"
done
git init -q --bare -b main "$tmp/no-main.git"
for bad_url in "$tmp/missing.git" "$tmp/no-main.git"; do
    fresh_home
    run_setup --init alpha --repo-url "$bad_url"
    check "unreachable url exits 1 ($bad_url)" test "$status" -eq 1
    check "unreachable url says why ($bad_url)" has_text "$out" "git ls-remote --exit-code $bad_url main failed"
    check "unreachable url writes nothing ($bad_url)" home_empty
    check "unreachable url does not call systemctl ($bad_url)" no_calls
done
fresh_home

# 3. Real run.
run_setup --init alpha --repo-url "$remote"
check 'init exits 0' test "$status" -eq 0
cfg="$home/.config/agent-memory/config.json"
check 'config mode is 600' test "$(stat -c %a "$cfg")" = 600
check 'config host' grep -q '"host": *"alpha"' "$cfg"
check 'config enabled' grep -q '"enabled": *true' "$cfg"
check 'clone is on main' test "$(git -C "$home/agent-memory" rev-parse --abbrev-ref HEAD)" = main
svc="$home/.config/systemd/user/agent-memory-sync.service"
tim="$home/.config/systemd/user/agent-memory-sync.timer"
check 'service exists' test -f "$svc"
check 'timer exists' test -f "$tim"
check 'service ExecStart' has_line "$svc" "ExecStart=\"$kit/workstation/run.sh\" sync"
node_dir="$(dirname "$(cat "$kit/workstation/node.local.path")")"
check 'service PATH' has_line "$svc" "Environment=PATH=$node_dir:/usr/local/bin:/usr/bin:/bin"
check 'timer interval' has_line "$tim" 'OnUnitActiveSec=2min'
settings="$home/.claude/settings.json"
hook_count() { # hook_count <event> <action>: number of marked commands for that action
    node -e '
        const s = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
        const want = `"${process.argv[2]}/workstation/run.sh" ${process.argv[4]} # agent-memory-kit`;
        const groups = s.hooks[process.argv[3]] ?? [];
        console.log(groups.flatMap((g) => g.hooks).filter((h) => h.command === want).length);
    ' "$settings" "$kit" "$1" "$2"
}
check 'session hook' test "$(hook_count SessionStart session-start)" = 1
check 'pre-write hook' test "$(hook_count PreToolUse pre-write)" = 1
check 'timer enabled' has_line "$calls" '--user enable --now agent-memory-sync.timer'
check 'daemon reloaded' has_line "$calls" '--user daemon-reload'
check 'state directory mode is 700' test "$(stat -c %a "$home/.local/state/agent-memory")" = 700

# 4. Run again without --init.
cp "$cfg" "$tmp/config.before"
head_before="$(git -C "$home/agent-memory" rev-parse HEAD)"
run_setup
check 'rerun exits 0' test "$status" -eq 0
check 'rerun keeps config' cmp -s "$cfg" "$tmp/config.before"
check 'rerun keeps clone' test "$(git -C "$home/agent-memory" rev-parse HEAD)" = "$head_before"
check 'one session hook' test "$(hook_count SessionStart session-start)" = 1
check 'one pre-write hook' test "$(hook_count PreToolUse pre-write)" = 1

# 5. --init over an existing config.
run_setup --init beta --repo-url "$remote"
check 'init over config fails' test "$status" -ne 0
check 'init over config keeps file' cmp -s "$cfg" "$tmp/config.before"

# 6. --no-enable writes units but does not enable.
rm -rf "$home/.config/systemd" "$calls"
run_setup --no-enable
check 'no-enable exits 0' test "$status" -eq 0
check 'no-enable writes service' test -f "$svc"
check 'no-enable does not enable' no_calls

# A directory that is not a clone is an error.
rm -rf "$home/agent-memory"
mkdir "$home/agent-memory"
run_setup --no-enable
check 'non-clone directory fails' test "$status" -ne 0
check 'non-clone directory untouched' test -z "$(ls -A "$home/agent-memory")"

# A kit path that needs escaping is refused, naming the character.
for case in '%:a percent sign' ' :a space' '#:a "#"' '?:a "?"'; do
    char="${case%%:*}"
    why="${case#*:}"
    bad="$tmp/kit${char}dir"
    rm -rf "$bad"
    cp -r "$kit" "$bad"
    set +e
    out="$(env -i HOME="$home" GIT_CONFIG_NOSYSTEM=1 PATH="$bin:$PATH" bash "$bad/setup.sh" --dry-run 2>&1)"
    status=$?
    set -e
    check "unsafe kit path ($why) fails" test "$status" -ne 0
    check "unsafe kit path ($why) is named" has_text "$out" "the kit path contains $why, which is not supported: $bad"
done

# --no-hooks does everything else but leaves the hooks out; a later plain run adds them,
# and --no-hooks again removes only the kit's own entries.
fresh_home
run_setup --init alpha --repo-url "$remote" --no-hooks --no-enable
check 'no-hooks exits 0' test "$status" -eq 0
check 'no-hooks writes the config' test -f "$cfg"
check 'no-hooks clones' test -d "$home/agent-memory/.git"
check 'no-hooks writes the units' test -f "$svc"
check 'no-hooks records the node path' test -f "$kit/workstation/node.local.path"
check 'no-hooks registers no hook' test ! -e "$settings"
run_setup --no-enable
check 'plain run after no-hooks exits 0' test "$status" -eq 0
check 'plain run adds the session hook' test "$(hook_count SessionStart session-start)" = 1
check 'plain run adds the pre-write hook' test "$(hook_count PreToolUse pre-write)" = 1
node -e '
    const fs = require("node:fs");
    const s = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    s.model = "kept";
    s.hooks.Stop = [{ hooks: [{ type: "command", command: "/srv/other.sh" }] }];
    fs.writeFileSync(process.argv[1], JSON.stringify(s));
' "$settings"
run_setup --no-hooks --no-enable
check 'no-hooks again exits 0' test "$status" -eq 0
check 'no-hooks again removes the kit hooks' bash -c '! grep -q "# agent-memory-kit" "$1"' _ "$settings"
check 'no-hooks again keeps other settings' grep -q '"model": *"kept"' "$settings"
check 'no-hooks again keeps other hooks' grep -q '/srv/other.sh' "$settings"

# Codex and Kiro: with ~/.codex and ~/.kiro present, a dry run says what it would register and
# changes nothing; a real run writes the launcher and the Kiro hook file and prints the trust notice.
fresh_home
mkdir "$home/.codex" "$home/.kiro"
run_setup --dry-run --init alpha --repo-url "$remote"
check 'agents dry run exits 0' test "$status" -eq 0
check 'agents dry run names the Codex hook' has_text "$out" "would register the Codex session-start hook ($home/.codex/hooks.json)"
check 'agents dry run names the Kiro file' has_text "$out" "would write $home/.kiro/hooks/agent-memory-kit.json"
check 'agents dry run changes nothing' test -z "$(ls -A "$home/.codex")$(ls -A "$home/.kiro")"
check 'agents dry run writes no launcher' test ! -e "$home/.config"
run_setup --init alpha --repo-url "$remote" --no-enable
check 'agents run exits 0' test "$status" -eq 0
check 'launcher is executable' test -x "$home/.config/agent-memory/run.sh"
check 'launcher runs the kit' grep -qF "exec \"$kit/workstation/run.sh\" \"\$@\"" "$home/.config/agent-memory/run.sh"
check 'kiro hook file exists' test -f "$home/.kiro/hooks/agent-memory-kit.json"
check 'codex hooks file exists' test -f "$home/.codex/hooks.json"
check 'codex trust notice is printed' has_text "$out" 'Codex: start a session and run /hooks to trust the new hook; Codex skips it until then.'
run_setup --no-enable
check 'agents rerun exits 0' test "$status" -eq 0
check 'agents rerun prints no trust notice' bash -c '! grep -qF "run /hooks" <<< "$1"' _ "$out"
run_setup --no-hooks --no-enable
check 'agents no-hooks exits 0' test "$status" -eq 0
check 'agents no-hooks removes the kiro file' test ! -e "$home/.kiro/hooks/agent-memory-kit.json"
check 'agents no-hooks keeps the launcher' test -x "$home/.config/agent-memory/run.sh"
check 'agents no-hooks removes the codex entry' bash -c '! grep -q "# agent-memory-kit" "$1"' _ "$home/.codex/hooks.json"

# Node.js 24 or later is accepted, an older one is not.
real_node="$(command -v node)"
for version in 25 23; do
    mkdir -p "$tmp/node$version"
    printf '%s\n' '#!/bin/bash' \
        "if [[ \"\$1\" == -p && \"\$2\" == *process.versions* ]]; then echo $version; exit 0; fi" \
        "exec \"$real_node\" \"\$@\"" > "$tmp/node$version/node"
    chmod +x "$tmp/node$version/node"
done
setup_path="$tmp/node25:$bin:$PATH" run_setup --dry-run
check 'node 25 is accepted' test "$status" -eq 0
setup_path="$tmp/node23:$bin:$PATH" run_setup --dry-run
check 'node 23 is refused' test "$status" -eq 1
check 'node 23 says why' has_text "$out" 'Node.js 24, git and flock are required.'

if [[ $fails -ne 0 ]]; then
    printf '%d setup test check(s) failed\n' "$fails" >&2
    exit 1
fi
