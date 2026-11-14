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
# The same for a Codex hooks.json that cannot be used, in a real run and in a dry run.
for bad_codex in '{ nope' '[1]' '{"hooks": null}' '{"hooks": {"SessionStart": "x"}}'; do
    for mode in real dry; do
        fresh_home
        mkdir "$home/.codex"
        printf '%s\n' "$bad_codex" > "$home/.codex/hooks.json"
        if [[ $mode == dry ]]; then run_setup --dry-run --init alpha --repo-url "$remote"; else run_setup --init alpha --repo-url "$remote"; fi
        check "bad codex hooks ($mode, $bad_codex) exits 1" test "$status" -eq 1
        check "bad codex hooks ($mode, $bad_codex) names the file" has_text "$out" "$home/.codex/hooks.json"
        check "bad codex hooks ($mode, $bad_codex) writes nothing" nothing_written
        check "bad codex hooks ($mode, $bad_codex) writes no node path" test ! -e "$kit/workstation/node.local.path"
        check "bad codex hooks ($mode, $bad_codex) left as it was" test "$(cat "$home/.codex/hooks.json")" = "$bad_codex"
    done
done
# A shape the hooks would not be added to does not matter when no hooks are registered.
fresh_home
mkdir "$home/.codex"
printf '%s\n' '{"hooks": {"SessionStart": "x"}}' > "$home/.codex/hooks.json"
run_setup --dry-run --no-hooks --init alpha --repo-url "$remote"
check 'odd codex shape with --no-hooks passes the checks' test "$status" -eq 0
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
codex_stamp="$(stat -c %Y.%y "$home/.codex/hooks.json")$(stat -c %y "$home/.kiro/hooks/agent-memory-kit.json")"
run_setup --dry-run
check 'agents rerun dry run exits 0' test "$status" -eq 0
check 'agents rerun dry run does not say it would register Codex' bash -c '! grep -q "would register the Codex" <<< "$1"' _ "$out"
check 'agents rerun dry run does not say it would write Kiro' bash -c '! grep -q "would write .*agent-memory-kit.json" <<< "$1"' _ "$out"
check 'agents rerun leaves both hook files alone' test "$codex_stamp" = "$(stat -c %Y.%y "$home/.codex/hooks.json")$(stat -c %y "$home/.kiro/hooks/agent-memory-kit.json")"
run_setup --dry-run --no-hooks
check 'agents no-hooks dry run exits 0' test "$status" -eq 0
check 'agents no-hooks dry run names the Codex removal' has_text "$out" "would remove the Codex session-start hook from $home/.codex/hooks.json"
check 'agents no-hooks dry run names the Kiro removal' has_text "$out" "would remove $home/.kiro/hooks/agent-memory-kit.json"
check 'agents no-hooks dry run changes nothing' test -e "$home/.kiro/hooks/agent-memory-kit.json"
run_setup --no-hooks --no-enable
check 'agents no-hooks exits 0' test "$status" -eq 0
check 'agents no-hooks removes the kiro file' test ! -e "$home/.kiro/hooks/agent-memory-kit.json"
check 'agents no-hooks keeps the launcher' test -x "$home/.config/agent-memory/run.sh"
check 'agents no-hooks removes the codex entry' bash -c '! grep -q "# agent-memory-kit" "$1"' _ "$home/.codex/hooks.json"
run_setup --dry-run --no-hooks
check 'agents no-hooks dry run says nothing once the entries are gone' bash -c '! grep -q "would remove\|would leave" <<< "$1"' _ "$out"

# Linked folders: a dry run says they would be left unchanged, a real run writes nothing in them
# and prints what to add by hand.
fresh_home
mkdir -p "$tmp/dotfiles/codex" "$tmp/dotfiles/kiro-hooks" "$home/.kiro"
ln -s "$tmp/dotfiles/codex" "$home/.codex"
ln -s "$tmp/dotfiles/kiro-hooks" "$home/.kiro/hooks"
run_setup --dry-run --init alpha --repo-url "$remote"
check 'linked dry run exits 0' test "$status" -eq 0
check 'linked dry run leaves the Codex file' has_text "$out" "would leave $home/.codex/hooks.json unchanged"
check 'linked dry run does not register Codex' bash -c '! grep -q "would register the Codex" <<< "$1"' _ "$out"
check 'linked dry run leaves the Kiro folder' has_text "$out" "would leave $home/.kiro/hooks unchanged"
check 'linked dry run does not write the Kiro file' bash -c '! grep -q "would write .*agent-memory-kit.json" <<< "$1"' _ "$out"
run_setup --init alpha --repo-url "$remote" --no-enable
check 'linked run exits 0' test "$status" -eq 0
check 'linked run writes nothing into the linked folders' test -z "$(ls -A "$tmp/dotfiles/codex")$(ls -A "$tmp/dotfiles/kiro-hooks")"
check 'linked run prints the Codex entry to add' has_text "$out" 'Add this hook to it:'
check 'linked run prints the Kiro document to save' has_text "$out" 'regular file named agent-memory-kit.json'

# Consolidation timers: written from the config's consolidate.extract / consolidate.organize.
udir="$home/.config/systemd/user"
set_consolidate() { # set_consolidate <json of the consolidate block, or "none">
    node -e '
        const fs = require("node:fs");
        const c = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        if (process.argv[2] === "none") delete c.consolidate;
        else c.consolidate = JSON.parse(process.argv[2]);
        fs.writeFileSync(process.argv[1], JSON.stringify(c, null, 2) + "\n");
    ' "$cfg" "$1"
}
both='{"command":"/path/to/claude","model":"model-id","extract":"Sat *-*-* 03:00","organize":"Sun *-*-* 04:30"}'
fresh_home
run_setup --init alpha --repo-url "$remote" --no-enable
check 'no consolidate block exits 0' test "$status" -eq 0
check 'no consolidate block writes no extract unit' test ! -e "$udir/agent-memory-extract.service" -a ! -e "$udir/agent-memory-extract.timer"
check 'no consolidate block writes no organize unit' test ! -e "$udir/agent-memory-organize.service" -a ! -e "$udir/agent-memory-organize.timer"
check 'no consolidate block prints nothing about them' bash -c '! grep -qiE "extract|organize" <<< "$1"' _ "$out"
run_setup --dry-run
check 'no consolidate block dry run prints nothing about them' bash -c '! grep -qiE "extract|organize" <<< "$1"' _ "$out"
set_consolidate "$both"
rm -rf "$udir" "$calls"
run_setup --dry-run
check 'consolidate dry run exits 0' test "$status" -eq 0
check 'consolidate dry run names the extract units' has_text "$out" "would write $udir/agent-memory-extract.service and agent-memory-extract.timer"
check 'consolidate dry run names the organize units' has_text "$out" "would write $udir/agent-memory-organize.service and agent-memory-organize.timer"
check 'consolidate dry run says it would enable them' has_text "$out" 'agent-memory-extract.timer agent-memory-organize.timer'
check 'consolidate dry run writes nothing' test ! -e "$udir"
check 'consolidate dry run does not call systemctl' no_calls
run_setup --no-enable
check 'consolidate run exits 0' test "$status" -eq 0
check 'consolidate no-enable does not call systemctl' no_calls
for name in extract organize; do
    check "$name service exists" test -f "$udir/agent-memory-$name.service"
    check "$name timer exists" test -f "$udir/agent-memory-$name.timer"
    check "$name service ExecStart" has_line "$udir/agent-memory-$name.service" "ExecStart=\"$kit/workstation/run.sh\" consolidate $name"
    check "$name service PATH" has_line "$udir/agent-memory-$name.service" "Environment=PATH=$node_dir:/usr/local/bin:/usr/bin:/bin"
    check "$name service is oneshot" has_line "$udir/agent-memory-$name.service" 'Type=oneshot'
    check "$name service timeout" has_line "$udir/agent-memory-$name.service" 'TimeoutStartSec=4h'
    check "$name service umask" has_line "$udir/agent-memory-$name.service" 'UMask=0077'
    check "$name service is nice" has_line "$udir/agent-memory-$name.service" 'Nice=10'
    check "$name service leaves KillMode alone" bash -c '! grep -q KillMode "$1"' _ "$udir/agent-memory-$name.service"
    check "$name timer persistent" has_line "$udir/agent-memory-$name.timer" 'Persistent=true'
    check "$name timer jitter" has_line "$udir/agent-memory-$name.timer" 'RandomizedDelaySec=10min'
    check "$name timer wanted by timers.target" has_line "$udir/agent-memory-$name.timer" 'WantedBy=timers.target'
done
check 'extract OnCalendar' has_line "$udir/agent-memory-extract.timer" 'OnCalendar=Sat *-*-* 03:00'
check 'organize OnCalendar' has_line "$udir/agent-memory-organize.timer" 'OnCalendar=Sun *-*-* 04:30'
run_setup
check 'consolidate enabling run exits 0' test "$status" -eq 0
check 'consolidate run enables the extract timer' has_line "$calls" '--user enable --now agent-memory-extract.timer'
check 'consolidate run enables the organize timer' has_line "$calls" '--user enable --now agent-memory-organize.timer'
check 'consolidate run still enables the sync timer' has_line "$calls" '--user enable --now agent-memory-sync.timer'
check 'consolidate run reloads once' test "$(grep -cxF -- '--user daemon-reload' "$calls")" -eq 1
# Removing a schedule disables its timer and removes both of its unit files.
set_consolidate '{"command":"/path/to/claude","model":"model-id","extract":"Sat *-*-* 03:00"}'
run_setup --dry-run
check 'removal dry run names the organize files' has_text "$out" "would remove $udir/agent-memory-organize.service"
check 'removal dry run names the organize timer' has_text "$out" "would remove $udir/agent-memory-organize.timer"
check 'removal dry run removes nothing' test -f "$udir/agent-memory-organize.timer"
rm -f "$calls"
run_setup
check 'removal exits 0' test "$status" -eq 0
check 'removal disables the organize timer' has_line "$calls" '--user disable --now agent-memory-organize.timer'
check 'removal removes the organize service' test ! -e "$udir/agent-memory-organize.service"
check 'removal removes the organize timer' test ! -e "$udir/agent-memory-organize.timer"
check 'removal keeps the extract units' test -f "$udir/agent-memory-extract.service" -a -f "$udir/agent-memory-extract.timer"
run_setup --dry-run
check 'a second dry run has nothing left to remove' bash -c '! grep -q "would remove" <<< "$1"' _ "$out"
# Removing the whole block removes the rest.
set_consolidate none
run_setup
check 'removing the block exits 0' test "$status" -eq 0
check 'removing the block removes the extract units' test ! -e "$udir/agent-memory-extract.service" -a ! -e "$udir/agent-memory-extract.timer"
check 'removing the block keeps the sync units' test -f "$svc" -a -f "$tim"
# An invalid block counts as absent.
set_consolidate '{"command":"relative/claude","model":"model-id","extract":"Sat *-*-* 03:00"}'
run_setup --no-enable
check 'an invalid block writes no unit' test ! -e "$udir/agent-memory-extract.timer"

# A failing daemon-reload after a removal under --no-enable does not abort setup.
set_consolidate "$both"
run_setup --no-enable
set_consolidate '{"command":"/path/to/claude","model":"model-id","extract":"Sat *-*-* 03:00"}'
failbin="$tmp/failbin"
mkdir -p "$failbin"
printf '%s\n' '#!/bin/bash' "printf '%s\\n' \"\$*\" >> \"$calls\"" 'if [[ "$*" == *daemon-reload* ]]; then exit 1; fi' > "$failbin/systemctl"
chmod +x "$failbin/systemctl"
rm -f "$calls"
setup_path="$failbin:$PATH" run_setup --no-enable
check 'failing reload after a removal exits 0' test "$status" -eq 0
check 'failing reload still removed the organize files' test ! -e "$udir/agent-memory-organize.timer" -a ! -e "$udir/agent-memory-organize.service"
check 'failing reload is reported' has_text "$out" 'could not reload systemd'

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
