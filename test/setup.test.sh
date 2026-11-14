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
# F4: an invalid block leaves existing consolidation units alone and says which field failed.
set_consolidate "$both"
run_setup --no-enable
set_consolidate '{"command":"/path/to/claude","model":"model-id","extract":"Sat *-*-* 03:00","maxTurns":2000}'
cp "$udir/agent-memory-organize.timer" "$tmp/organize.timer.before"
rm -f "$calls"
run_setup --dry-run
invalid_line="the consolidate block in $cfg is invalid (maxTurns); the consolidation units were left as they are."
check 'invalid block dry run exits 0' test "$status" -eq 0
check 'invalid block dry run names the field' has_text "$out" "$invalid_line"
check 'invalid block dry run would write no consolidation unit' bash -c '! grep -qE "would (write|remove) .*agent-memory-(extract|organize)" <<< "$1"' _ "$out"
check 'invalid block dry run still names the sync units' has_text "$out" "would write $udir/agent-memory-sync.service"
run_setup
check 'invalid block run exits 0' test "$status" -eq 0
check 'invalid block run names the field' has_text "$out" "$invalid_line"
check 'invalid block keeps the organize units' cmp -s "$udir/agent-memory-organize.timer" "$tmp/organize.timer.before"
check 'invalid block keeps the extract units' test -f "$udir/agent-memory-extract.service" -a -f "$udir/agent-memory-extract.timer"
check 'invalid block does not disable a consolidation timer' bash -c '! grep -qE "disable.*agent-memory-(extract|organize)" "$1"' _ "$calls"
check 'invalid block does not enable a consolidation timer' bash -c '! grep -qE "enable --now agent-memory-(extract|organize)" "$1"' _ "$calls"
check 'invalid block still enables the sync timer' has_line "$calls" '--user enable --now agent-memory-sync.timer'
# Item 4: an unknown key makes the block invalid, named like any other field.
set_consolidate '{"command":"/path/to/claude","model":"model-id","organise":"Sun *-*-* 04:30"}'
run_setup --dry-run
check 'an unknown key is named' has_text "$out" "the consolidate block in $cfg is invalid (organise); the consolidation units were left as they are."
set_consolidate none
run_setup --no-enable

# m11: each schedule is checked with `systemd-analyze calendar` when that tool is on the PATH.
sa_accept="$tmp/sa-accept"
sa_reject="$tmp/sa-reject"
mkdir -p "$sa_accept" "$sa_reject"
printf '%s\n' '#!/bin/bash' 'exit 0' > "$sa_accept/systemd-analyze"
printf '%s\n' '#!/bin/bash' '[[ "$1" == calendar && "$2" == *Saturday* ]] && exit 1' 'exit 0' > "$sa_reject/systemd-analyze"
chmod +x "$sa_accept/systemd-analyze" "$sa_reject/systemd-analyze"
set_consolidate "$both"
rm -f "$udir"/agent-memory-extract.* "$udir"/agent-memory-organize.* "$calls"
setup_path="$sa_accept:$bin:$PATH" run_setup --no-enable
check 'accepted schedules are written' test -f "$udir/agent-memory-extract.timer" -a -f "$udir/agent-memory-organize.timer"
cp "$udir/agent-memory-extract.timer" "$tmp/extract.timer.before"
set_consolidate '{"command":"/path/to/claude","model":"model-id","extract":"Saturday 3am","organize":"Sun *-*-* 04:30"}'
rejected_line='the extract schedule "Saturday 3am" is not a valid systemd calendar expression (systemd-analyze calendar rejected it); the extract units were left as they are.'
setup_path="$sa_reject:$bin:$PATH" run_setup --dry-run
check 'rejected schedule dry run exits 0' test "$status" -eq 0
check 'rejected schedule dry run names it' has_text "$out" "$rejected_line"
check 'rejected schedule dry run would not touch the extract units' bash -c '! grep -qE "would (write|remove) .*agent-memory-extract" <<< "$1"' _ "$out"
check 'rejected schedule dry run still writes the organize units' has_text "$out" "would write $udir/agent-memory-organize.service and agent-memory-organize.timer"
rm -f "$calls"
setup_path="$sa_reject:$bin:$PATH" run_setup
check 'rejected schedule run exits 0' test "$status" -eq 0
check 'rejected schedule run names it' has_text "$out" "$rejected_line"
check 'rejected schedule keeps the extract timer as it was' cmp -s "$udir/agent-memory-extract.timer" "$tmp/extract.timer.before"
check 'rejected schedule does not enable the extract timer' bash -c '! grep -q "enable --now agent-memory-extract.timer" "$1"' _ "$calls"
check 'rejected schedule still enables the organize timer' has_line "$calls" '--user enable --now agent-memory-organize.timer'
# Without systemd-analyze on the PATH, the schedule is written as before.
no_sa="$tmp/no-systemd-analyze"
mkdir -p "$no_sa"
IFS=: read -ra path_dirs <<< "$bin:$PATH"
for d in "${path_dirs[@]}"; do
    for f in "$d"/*; do
        n="${f##*/}"
        [[ -f "$f" && -x "$f" && "$n" != systemd-analyze && ! -e "$no_sa/$n" ]] || continue
        ln -s "$f" "$no_sa/$n"
    done
done
setup_path="$no_sa" run_setup --no-enable
check 'without systemd-analyze setup exits 0' test "$status" -eq 0
check 'without systemd-analyze the schedule is written' has_line "$udir/agent-memory-extract.timer" 'OnCalendar=Saturday 3am'
check 'without systemd-analyze nothing is said about it' bash -c '! grep -q "not a valid systemd calendar" <<< "$1"' _ "$out"

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

# Bridge: the second repository is cloned where bridge.agentsRepoDir says, when it is missing.
agents_remote="$tmp/agents-remote.git"
agents_dir="$tmp/agents-clone"
git init -q --bare -b main "$agents_remote"
set_bridge() { # set_bridge <json of the bridge block, or "none">
    node -e '
        const fs = require("node:fs");
        const c = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        delete c.consolidate;
        if (process.argv[2] === "none") delete c.bridge;
        else c.bridge = JSON.parse(process.argv[2]);
        fs.writeFileSync(process.argv[1], JSON.stringify(c, null, 2) + "\n");
    ' "$cfg" "$1"
}
bridge_block="{\"agentsRepoDir\":\"$agents_dir\",\"agentsRepoUrl\":\"$agents_remote\"}"
fresh_home
run_setup --init alpha --repo-url "$remote" --no-enable
set_bridge none
run_setup --dry-run
check 'no bridge block: dry run prints nothing about the agents repository' bash -c '! grep -qi "agents" <<< "$1"' _ "$out"
run_setup --no-enable
check 'no bridge block: run prints nothing about the agents repository' bash -c '! grep -qi "agents" <<< "$1"' _ "$out"
check 'no bridge block: nothing is cloned' test ! -e "$agents_dir"
set_bridge "$bridge_block"
run_setup --dry-run
check 'bridge dry run exits 0' test "$status" -eq 0
check 'bridge dry run says it would clone' has_text "$out" "would clone the agents repository into $agents_dir"
check 'bridge dry run never prints the URL' bash -c '! grep -qF -- "$2" <<< "$1"' _ "$out" "$agents_remote"
check 'bridge dry run creates nothing' test ! -e "$agents_dir"
run_setup --no-enable
check 'bridge run exits 0' test "$status" -eq 0
check 'bridge run clones the agents repository' test -d "$agents_dir/.git"
check 'bridge run says where' has_text "$out" "cloned the agents repository into $agents_dir"
check 'bridge run never prints the URL' bash -c '! grep -qF -- "$2" <<< "$1"' _ "$out" "$agents_remote"
check 'bridge run leaves the origin of the clone as configured' test "$(git -C "$agents_dir" remote get-url origin)" = "$agents_remote"
# An existing directory is left alone, in a dry run and in a run.
printf 'mine\n' > "$agents_dir/keep.txt"
head_before="$(git -C "$agents_dir" rev-parse --git-dir)"
run_setup --dry-run
check 'existing agents directory: dry run says nothing about cloning' bash -c '! grep -qi "clone the agents" <<< "$1"' _ "$out"
run_setup --no-enable
check 'existing agents directory: run says nothing about cloning' bash -c '! grep -qi "clone the agents" <<< "$1"' _ "$out"
check 'existing agents directory is left alone' test "$(cat "$agents_dir/keep.txt")" = mine -a "$(git -C "$agents_dir" rev-parse --git-dir)" = "$head_before"
# An existing directory that is not a clone is left alone too (the bridge refuses it at run time).
rm -rf "$agents_dir"
mkdir "$agents_dir"
run_setup --no-enable
check 'a plain existing directory is not cloned into' test ! -e "$agents_dir/.git"
check 'a plain existing directory does not fail setup' test "$status" -eq 0
rm -rf "$agents_dir"
# A bridge block without a URL clones nothing and says nothing.
set_bridge "{\"agentsRepoDir\":\"$agents_dir\"}"
run_setup --no-enable
check 'bridge without a URL exits 0' test "$status" -eq 0
check 'bridge without a URL clones nothing' test ! -e "$agents_dir"
# An invalid bridge block: one line naming the field, nothing cloned.
set_bridge "{\"agentsRepoDir\":\"$agents_dir\",\"agentsRepoUrl\":\"$agents_remote\",\"bucket\":\"X_bad\",\"up\":true,\"region\":\"ap-northeast-1\"}"
for mode in --dry-run --no-enable; do
    run_setup "$mode"
    check "invalid bridge block ($mode) exits 0" test "$status" -eq 0
    check "invalid bridge block ($mode) names the field" has_text "$out" "the bridge block in $cfg is invalid (bucket); the agents repository was not cloned."
    check "invalid bridge block ($mode) clones nothing" test ! -e "$agents_dir"
done
# A clone that fails does not abort setup and does not print the URL.
set_bridge "{\"agentsRepoDir\":\"$agents_dir\",\"agentsRepoUrl\":\"$tmp/no-such-remote.git\"}"
run_setup --no-enable
check 'a failing agents clone does not abort setup' test "$status" -eq 0
check 'a failing agents clone is reported' has_text "$out" "could not clone the agents repository into $agents_dir"
check 'a failing agents clone leaves nothing behind' test ! -e "$agents_dir"
check 'a failing agents clone does not print the URL' bash -c '! grep -qF -- "$2" <<< "$1"' _ "$out" "$tmp/no-such-remote.git"
# The bridge works on main only: a remote whose only branch is another one is not cloned.
other_remote="$tmp/agents-master.git"
git init -q --bare -b master "$other_remote"
git init -q -b master "$tmp/agents-master-seed"
git -C "$tmp/agents-master-seed" -c user.name=seed -c user.email=seed@example.com commit -q --allow-empty -m 'chore: initial'
git -C "$tmp/agents-master-seed" push -q "$other_remote" master
set_bridge "{\"agentsRepoDir\":\"$agents_dir\",\"agentsRepoUrl\":\"$other_remote\"}"
run_setup --no-enable
check 'a remote without a main branch is not cloned' test ! -e "$agents_dir"
check 'a remote without a main branch is reported' has_text "$out" "could not clone the agents repository into $agents_dir"
check 'a remote without a main branch says so' has_text "$out" 'the agents repository has no main branch'
check 'a remote without a main branch does not print the URL' bash -c '! grep -qF -- "$2" <<< "$1"' _ "$out" "$other_remote"
# F1: a remote that cannot be reached is said to be unreachable, without its URL; nothing is cloned.
set_bridge "{\"agentsRepoDir\":\"$agents_dir\",\"agentsRepoUrl\":\"$tmp/no-such-remote.git\"}"
run_setup --no-enable
check 'an unreachable agents remote says it cannot be reached' has_text "$out" 'the remote could not be reached'
check 'an unreachable agents remote clones nothing' test ! -e "$agents_dir"
check 'an unreachable agents remote does not print the URL' bash -c '! grep -qF -- "$2" <<< "$1"' _ "$out" "$tmp/no-such-remote.git"
# A branch whose name only ends like main (foo/refs/heads/main) is not main.
nested_remote="$tmp/agents-nested.git"
git init -q --bare -b foo/refs/heads/main "$nested_remote"
git init -q -b foo/refs/heads/main "$tmp/agents-nested-seed"
git -C "$tmp/agents-nested-seed" -c user.name=seed -c user.email=seed@example.com commit -q --allow-empty -m 'chore: initial'
git -C "$tmp/agents-nested-seed" push -q "$nested_remote" foo/refs/heads/main
set_bridge "{\"agentsRepoDir\":\"$agents_dir\",\"agentsRepoUrl\":\"$nested_remote\"}"
run_setup --no-enable
check 'a remote whose only branch is foo/refs/heads/main is not cloned' test ! -e "$agents_dir"
check 'a remote whose only branch is foo/refs/heads/main has no main branch' has_text "$out" 'the agents repository has no main branch'
check 'an unreachable agents remote does not abort setup' test "$status" -eq 0
# F1: a remote with no branch at all is cloned, the local branch is main, and the person is told what is missing.
empty_remote="$tmp/agents-empty.git"
git init -q --bare -b trunk "$empty_remote"
set_bridge "{\"agentsRepoDir\":\"$agents_dir\",\"agentsRepoUrl\":\"$empty_remote\"}"
run_setup --no-enable
check 'an empty agents remote exits 0' test "$status" -eq 0
check 'an empty agents remote is cloned' test -d "$agents_dir/.git"
check 'an empty agents remote says where it was cloned' has_text "$out" "cloned the agents repository into $agents_dir"
check 'an empty agents remote says it is empty and needs the marker on main' has_text "$out" 'the agents repository is empty; add the marker file .agent-memory-mirror to it on main.'
check 'an empty agents remote does not print the URL' bash -c '! grep -qF -- "$2" <<< "$1"' _ "$out" "$empty_remote"
check 'an empty agents remote leaves the local branch on main' test "$(git -C "$agents_dir" symbolic-ref --short HEAD)" = main
git -C "$agents_dir" -c user.name=seed -c user.email=seed@example.com commit -q --allow-empty -m 'chore: first'
check 'a first commit creates main' test "$(git -C "$agents_dir" rev-parse --abbrev-ref HEAD)" = main
check 'a first commit creates no other branch' test "$(git -C "$agents_dir" branch --format='%(refname:short)')" = main
rm -rf "$agents_dir"
# w2: a folder that reaches the notes clone through a link is not cloned into, in a dry run and a run.
ln -s "$home/agent-memory" "$tmp/notes-link"
for inside in "$tmp/notes-link/mirror" "$tmp/notes-link/deeper/mirror"; do
    set_bridge "{\"agentsRepoDir\":\"$inside\",\"agentsRepoUrl\":\"$empty_remote\"}"
    for mode in --dry-run --no-enable; do
        run_setup "$mode"
        check "a mirror folder inside the notes clone through a link ($mode) exits 0" test "$status" -eq 0
        check "a mirror folder inside the notes clone through a link ($mode) says so" has_text "$out" 'overlaps the notes clone (by real path)'
        check "a mirror folder inside the notes clone through a link ($mode) is not cloned" test ! -e "$home/agent-memory/mirror" -a ! -e "$home/agent-memory/deeper"
        check "a mirror folder inside the notes clone through a link ($mode) does not say it would clone" bash -c '! grep -q "clone the agents repository" <<< "$1"' _ "$out"
        check "a mirror folder inside the notes clone through a link ($mode) does not print the URL" bash -c '! grep -qF -- "$2" <<< "$1"' _ "$out" "$empty_remote"
    done
done
check 'nothing was cloned into the notes clone' test -z "$(git -C "$home/agent-memory" status --porcelain)"
rm -f "$tmp/notes-link"

# Canary: one timer for the deployed checks, written from canary.schedule like the consolidation timers.
set_canary() { # set_canary <json of the canary block, or "none">
    node -e '
        const fs = require("node:fs");
        const c = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        delete c.consolidate;
        delete c.bridge;
        if (process.argv[2] === "none") delete c.canary;
        else c.canary = JSON.parse(process.argv[2]);
        fs.writeFileSync(process.argv[1], JSON.stringify(c, null, 2) + "\n");
    ' "$cfg" "$1"
}
canary_block='{"stage":"prod","region":"ap-northeast-1","schedule":"*-*-* 00/6:15:00"}'
csvc="$udir/agent-memory-canary.service"
ctim="$udir/agent-memory-canary.timer"
fresh_home
run_setup --init alpha --repo-url "$remote" --no-enable
set_canary none
run_setup --dry-run
check 'no canary block: dry run prints nothing about it' bash -c '! grep -qi canary <<< "$1"' _ "$out"
run_setup --no-enable
check 'no canary block: run prints nothing about it' bash -c '! grep -qi canary <<< "$1"' _ "$out"
check 'no canary block: no unit' test ! -e "$csvc" -a ! -e "$ctim"
set_canary "$canary_block"
rm -rf "$udir" "$calls"
run_setup --dry-run
check 'canary dry run exits 0' test "$status" -eq 0
check 'canary dry run names the units' has_text "$out" "would write $udir/agent-memory-canary.service and agent-memory-canary.timer"
check 'canary dry run says it would enable the timer' has_text "$out" 'enable --now agent-memory-sync.timer agent-memory-canary.timer'
check 'canary dry run writes nothing' test ! -e "$udir"
check 'canary dry run does not call systemctl' no_calls
run_setup --no-enable
check 'canary run exits 0' test "$status" -eq 0
check 'canary run says it wrote the units' has_text "$out" 'wrote agent-memory-canary.service and agent-memory-canary.timer'
check 'canary no-enable does not call systemctl' no_calls
check 'canary service exists' test -f "$csvc"
check 'canary timer exists' test -f "$ctim"
check 'canary service is oneshot' has_line "$csvc" 'Type=oneshot'
check 'canary service PATH' has_line "$csvc" "Environment=PATH=$node_dir:/usr/local/bin:/usr/bin:/bin"
check 'canary service ExecStart' has_line "$csvc" "ExecStart=\"$kit/workstation/run.sh\" canary"
check 'canary service timeout' has_line "$csvc" 'TimeoutStartSec=300'
check 'canary service umask' has_line "$csvc" 'UMask=0077'
check 'canary service is marked as managed' has_line "$csvc" '# Managed by agent-memory-kit setup.sh.'
check 'canary service has no Nice and no KillMode' bash -c '! grep -qE "Nice|KillMode" "$1"' _ "$csvc"
check 'canary timer OnCalendar' has_line "$ctim" 'OnCalendar=*-*-* 00/6:15:00'
check 'canary timer persistent' has_line "$ctim" 'Persistent=true'
check 'canary timer jitter' has_line "$ctim" 'RandomizedDelaySec=5min'
check 'canary timer wanted by timers.target' has_line "$ctim" 'WantedBy=timers.target'
check 'canary run writes no consolidation unit' test ! -e "$udir/agent-memory-extract.timer" -a ! -e "$udir/agent-memory-organize.timer"
run_setup
check 'canary enabling run exits 0' test "$status" -eq 0
check 'canary run enables the canary timer' has_line "$calls" '--user enable --now agent-memory-canary.timer'
check 'canary run still enables the sync timer' has_line "$calls" '--user enable --now agent-memory-sync.timer'
check 'canary run reloads once' test "$(grep -cxF -- '--user daemon-reload' "$calls")" -eq 1
# The canary and the consolidation timers are independent of each other.
set_canary "$canary_block"
node -e '
    const fs = require("node:fs");
    const c = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    c.consolidate = { command: "/path/to/claude", model: "model-id", extract: "Sat *-*-* 03:00" };
    fs.writeFileSync(process.argv[1], JSON.stringify(c, null, 2) + "\n");
' "$cfg"
run_setup --no-enable
check 'canary and extract timers are both written' test -f "$ctim" -a -f "$udir/agent-memory-extract.timer"
check 'canary alongside consolidation leaves the organize units absent' test ! -e "$udir/agent-memory-organize.timer"
# Removing the schedule (block kept) or the whole block disables the timer and removes both unit files.
set_canary '{"stage":"prod","region":"ap-northeast-1"}'
run_setup --dry-run
check 'canary removal dry run names the service' has_text "$out" "would remove $csvc"
check 'canary removal dry run names the timer' has_text "$out" "would remove $ctim"
check 'canary removal dry run removes nothing' test -f "$ctim" -a -f "$csvc"
rm -f "$calls"
run_setup
check 'canary removal exits 0' test "$status" -eq 0
check 'canary removal disables the timer' has_line "$calls" '--user disable --now agent-memory-canary.timer'
check 'canary removal removes both files' test ! -e "$csvc" -a ! -e "$ctim"
check 'canary removal says so' has_text "$out" 'removed agent-memory-canary.service and agent-memory-canary.timer'
run_setup --dry-run
check 'a second canary dry run has no canary left to remove' bash -c '! grep -qi "would remove.*canary" <<< "$1"' _ "$out"
set_canary "$canary_block"
run_setup --no-enable
check 'canary units come back' test -f "$csvc" -a -f "$ctim"
set_canary none
rm -f "$calls"
run_setup
check 'removing the whole canary block removes its units' test ! -e "$csvc" -a ! -e "$ctim"
check 'removing the whole canary block disables the timer' has_line "$calls" '--user disable --now agent-memory-canary.timer'
# An invalid block leaves existing units alone and names the field; so does an unknown key.
set_canary "$canary_block"
run_setup --no-enable
cp "$ctim" "$tmp/canary.timer.before"
cp "$csvc" "$tmp/canary.service.before"
for bad in '{"stage":"Prod","region":"ap-northeast-1","schedule":"hourly"}:stage' '{"stage":"prod","region":"ap-northeast-1","schedual":"hourly"}:schedual'; do
    set_canary "${bad%:*}"
    canary_line="the canary block in $cfg is invalid (${bad##*:}); the canary units were left as they are."
    rm -f "$calls"
    run_setup --dry-run
    check "invalid canary block dry run exits 0 (${bad##*:})" test "$status" -eq 0
    check "invalid canary block dry run names the field (${bad##*:})" has_text "$out" "$canary_line"
    check "invalid canary block dry run would touch no canary unit (${bad##*:})" bash -c '! grep -qE "would (write|remove) .*agent-memory-canary" <<< "$1"' _ "$out"
    run_setup
    check "invalid canary block run exits 0 (${bad##*:})" test "$status" -eq 0
    check "invalid canary block run names the field (${bad##*:})" has_text "$out" "$canary_line"
    check "invalid canary block keeps the timer (${bad##*:})" cmp -s "$ctim" "$tmp/canary.timer.before"
    check "invalid canary block keeps the service (${bad##*:})" cmp -s "$csvc" "$tmp/canary.service.before"
    check "invalid canary block does not disable the timer (${bad##*:})" bash -c '! grep -q "disable" "$1"' _ "$calls"
    check "invalid canary block does not enable the canary timer (${bad##*:})" bash -c '! grep -q "enable --now agent-memory-canary" "$1"' _ "$calls"
    check "invalid canary block still enables the sync timer (${bad##*:})" has_line "$calls" '--user enable --now agent-memory-sync.timer'
done
# A valid consolidate block is not disturbed by an invalid canary block, and the other way round.
node -e '
    const fs = require("node:fs");
    const c = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    c.consolidate = { command: "/path/to/claude", model: "model-id", extract: "Sun *-*-* 03:00" };
    fs.writeFileSync(process.argv[1], JSON.stringify(c, null, 2) + "\n");
' "$cfg"
run_setup --no-enable
check 'an invalid canary block does not stop the extract timer from being written' has_line "$udir/agent-memory-extract.timer" 'OnCalendar=Sun *-*-* 03:00'
check 'an invalid canary block says nothing about consolidation' bash -c '! grep -q "consolidate block" <<< "$1"' _ "$out"
# systemd-analyze rejecting the canary schedule leaves its units as they are.
set_canary '{"stage":"prod","region":"ap-northeast-1","schedule":"Saturday 3am"}'
rm -f "$calls"
setup_path="$sa_reject:$bin:$PATH" run_setup
check 'a rejected canary schedule exits 0' test "$status" -eq 0
check 'a rejected canary schedule names it' has_text "$out" 'the canary schedule "Saturday 3am" is not a valid systemd calendar expression (systemd-analyze calendar rejected it); the canary units were left as they are.'
check 'a rejected canary schedule keeps the timer as it was' cmp -s "$ctim" "$tmp/canary.timer.before"
check 'a rejected canary schedule does not enable it' bash -c '! grep -q "enable --now agent-memory-canary.timer" "$1"' _ "$calls"
set_canary none
run_setup --no-enable

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
