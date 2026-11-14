# agent-memory-kit

agent-memory-kit keeps the memory notes of coding agents in a private Git repository and syncs them between your machines. Each machine works on its own clone, so a note written on one machine shows up on the others within a few minutes.

## How it works

Each machine keeps a clone of a private notes repository at `~/agent-memory`. Notes live in two places:

- `global/` holds facts that apply everywhere.
- `projects/<repository directory name>/` holds one folder of notes per repository.

```
  Claude Code session                       systemd user timer (every 2 minutes)
  -------------------                       ------------------------------------
  SessionStart hook                         sync:
    links the repository's memory folder      1. scan for credentials
    to projects/<name>/ in the clone          2. commit
    prints the global index                   3. merge the remote
  PreToolUse hook                             4. send the result to the remote
    refuses to write credentials
    into the clone                                  ~/agent-memory  <---->  remote
```

- **Clone and links.** The SessionStart hook points Claude Code's per-repository memory folder at the matching project folder in the clone through a symlink. Notes already in that folder are copied over first, and the old folder is kept as a backup. The hook also prints the global index into the session.
- **Codex and Kiro.** Their session-start hook prints the same kind of summary as plain text, without linking anything: the global index, the project's index when the repository has project notes, where to write new notes and the sync warnings. See "Codex and Kiro".
- **Write guard.** The PreToolUse hook refuses to write content that looks like a credential into the clone.
- **Sync.** A systemd user timer runs a sync every two minutes. The sync scans for credentials, commits, merges the remote and sends the result to the remote. Sessions never run Git on the clone; only the sync does, and it holds a lock while it runs.
- **Same result on every machine.** The sync commits with a fixed identity (`agent-memory-sync`). Inside the notes clone it ignores your global ignore file (`core.excludesFile`), Git hooks and commit signing settings, so a personal ignore list cannot keep a note or a `.project` file on one machine. Your credential helper and other global settings still apply.
- **Conflicts.** A note changed on two machines at once is kept twice. The local version is saved as `<name>.conflict-<host>.md` next to the other one.
- **Secret scan.** Files the scan flags are moved to `~/.local/state/agent-memory/quarantine` instead of being committed.

Nothing happens on a machine until `setup.sh --init` has written `~/.config/agent-memory/config.json`. Without that file every hook exits quietly and the sync does nothing. Hooks are best-effort: an internal error never blocks a session and is appended to `~/.local/state/agent-memory/hook-errors.log`. The only deliberate block is the refusal to write a credential.

## Requirements

- Linux with systemd user units, and user lingering enabled (`loginctl enable-linger`) so that the timer also runs while you are not logged in
- Node.js 24 or later
- Git 2.30 or later
- `flock` (part of util-linux)
- A private Git repository that the machine can write to without a prompt (an SSH key or a credential helper)
- Git and the credential helper must be reachable on the timer's `PATH`, which is `<directory of the Node.js binary>:/usr/local/bin:/usr/bin:/bin`. A credential helper installed elsewhere needs an absolute path in your Git configuration.

## Set up the notes repository

Create an empty private repository and add these two files at its root.

`.gitattributes`:

```
* text=auto eol=lf
MEMORY.md merge=union
```

`.gitignore`:

```
*.tmp.*
.DS_Store
```

Also create an empty `global/MEMORY.md`, then commit and push so that the default branch `main` exists before you set up the first machine.

## Install

Clone this repository somewhere permanent. The hooks and the timer call the scripts in this clone by absolute path, so do not move it afterwards without running setup again. The path must not contain a double quote, `$`, a backtick, `%`, a backslash, `#`, `?`, a space or a newline; the same holds for the directory of the Node.js binary.

```
git clone https://example.com/you/agent-memory-kit.git ~/agent-memory-kit
cd ~/agent-memory-kit
./setup.sh --init alpha --repo-url git@example.com:you/agent-notes.git
```

`alpha` is a short name for this machine: lowercase letters, digits and hyphens, at most 31 characters, starting with a letter or digit. Use a different name on each machine.

`setup.sh` checks everything first and writes nothing if a check fails:

1. Node.js 24 or later, Git and `flock` are installed, and the kit path and the Node.js path contain no unsupported character.
2. With `--init`, the host name and URL are valid and `~/.config/agent-memory/config.json` does not exist yet.
3. An existing `~/agent-memory` is a clone on `main`.
4. An existing `~/.claude/settings.json` is valid JSON holding an object.
5. An existing `~/.codex/hooks.json` that setup would edit (a regular file, not a symbolic link and not in a linked folder) is valid JSON holding an object, and, when hooks are registered, its `hooks` is an object and its `hooks.SessionStart` an array. This also runs with `--dry-run`.
6. With `--init`, or when the clone is missing, the notes repository answers: `git ls-remote --exit-code <url> main` succeeds.

Then it:

1. With `--init`, writes `~/.config/agent-memory/config.json` (mode 600).
2. Clones the notes repository to `~/agent-memory` if it is missing.
3. Creates `~/.local/state/agent-memory` (mode 700).
4. Adds the two hooks to `~/.claude/settings.json`, keeping every other setting, records the path of the Node.js binary in `workstation/node.local.path` (ignored by Git), writes the launcher `~/.config/agent-memory/run.sh` and, when `~/.codex` or `~/.kiro` exists, registers their session-start hook (see "Codex and Kiro").
5. Writes `agent-memory-sync.service` and `agent-memory-sync.timer` to `~/.config/systemd/user/` and enables the timer. When the configuration has a `consolidate` block with `extract` or `organize` schedules, it also writes and enables the matching weekly timers, and removes those of a schedule that is gone (see "Consolidation").

Options:

- `--dry-run` runs the checks, prints what would happen and changes nothing. For Codex and Kiro it says whether a file would be written, or left unchanged because it or its folder is a symbolic link, and, with `--no-hooks`, what would be removed.
- `--no-enable` writes the units but does not enable the timers. (A timer whose schedule was removed is still disabled before its unit files are deleted.)
- `--no-hooks` does everything else but does not register the Claude Code, Codex and Kiro hooks, and removes the kit's own hook entries if they are present. Running `setup.sh` later without the flag registers them.

On a machine that already has Claude Code memory, this order lets you move the existing notes and review the result before sessions start adopting folders on their own:

```
./setup.sh --init alpha --repo-url git@example.com:you/agent-notes.git --no-hooks --no-enable
workstation/run.sh migrate --dry-run
workstation/run.sh migrate --apply
./setup.sh
```

Running `./setup.sh` again without `--init` is safe. Use it after moving the kit or upgrading Node.js.

## Move existing Claude Code memory

If Claude Code already kept memory notes on this machine before you installed the kit, move them into the notes repository once. Each repository has a folder `~/.claude/projects/<folder name>/memory`. The command finds those folders. For each one that belongs to a repository it copies the notes to `projects/<repository directory name>/` in the clone, renames the old folder to `memory.local-backup-<timestamp>` and puts a link in its place.

```
workstation/run.sh migrate --dry-run
workstation/run.sh migrate --apply [--skip-flagged]
```

Both refuse to run until `~/agent-memory` is a clone (*agent-memory: `<clone>` is not a clone; run setup.sh first.*), and create nothing.

`--dry-run` changes nothing and can be repeated. It prints one line per folder (folder name, number of files, the project it would go to or the reason it is skipped, and the number of secret-scan findings), then a summary. Findings are listed as file, pattern id and line number; the matched text is never shown.

A folder is skipped when:

- it holds anything other than regular files, such as a subfolder or a symlink (`nested-entries`);
- it is empty (`empty`);
- no session record names the repository it belongs to (`no-repository`);
- the repository's directory name is not usable as a project name (`unsafe-project-name`);
- the repository has no shareable `origin` remote (`no-remote`), see "Day to day";
- the project folder in the clone is already bound to a different repository, or another folder in the same run claims that name for a different repository (`name-collision`).

A folder whose `memory` is already a link is left out of the list, so running `--apply` again does nothing.

`--apply` holds the sync lock for its whole run. If a sync is running it waits for it, up to two minutes (*agent-memory: a sync is running; try again.*). It then runs one sync, so that the clone and the `.project` files in it are current, and stops without migrating if that sync fails. It refuses to run while any file to be copied is flagged by the secret scan. Remove the credential from the file, or add `--skip-flagged` to leave the flagged files out of the copy; they stay in the backup folder. If `MEMORY.md` itself is flagged it is not copied either, so the copied notes have no index lines: the result lists the folder under `indexNotCopied`, and you need to rebuild the index by hand. The result is printed as JSON; `adoptedFolders` lists, for each folder copied, its `backupDir` and the names of the flagged files left out (`leftOut`).

After a folder is copied, notes whose frontmatter has `type: user` under `metadata:` are moved to `global/`, together with their lines in `MEMORY.md`. If `global/` already has a different file of that name, both are kept as `<name>.<host>.md`.

## Codex and Kiro

If `~/.codex` or `~/.kiro` exists when `setup.sh` runs, it also registers a session-start hook for that tool. At the start of a session the tool then sees a plain-text summary: the shared-memory indexes (global and, for a repository that has project notes, that project's), where to write new notes and the same sync warnings as in Claude Code. Notes themselves are the same Markdown files in the clone.

Only this session-start text is provided for these tools. There is no write guard: a credential written into the clone is caught by the sync's secret scan, which moves the file to quarantine instead of committing it.

- **Launcher.** Setup writes `~/.config/agent-memory/run.sh`, a small script that calls this clone's `workstation/run.sh`. The hook command calls that fixed path and exits silently when the file or a valid, enabled configuration is missing, so one hook file can be shared between machines. The launcher itself exits silently when the kit folder has been moved or deleted. Running `setup.sh` again after moving the kit refreshes the launcher.
- **Codex.** The entry goes into `SessionStart` in `~/.codex/hooks.json`; other hooks and settings in the file are kept. Codex skips a new or changed hook until you review it: start a session and run `/hooks`.
- **Kiro.** Setup writes `~/.kiro/hooks/agent-memory-kit.json`. Kiro runs hook files only with its V3 agent engine.
- **Symbolic links.** Setup never writes, creates or removes a Codex or Kiro hook file through a symbolic link, because the link usually points into a repository you manage. (`~/.claude/settings.json` is different: setup follows a link there and edits the file it points to.) For Codex this holds when `~/.codex/hooks.json` is a link and when `~/.codex` (or any folder on the way) is a link, for example with GNU Stow. Setup then prints the entry to add to the file the link leads to (or nothing, when the entry is already there):

  ```
  {
    "hooks": {
      "SessionStart": [
        {
          "hooks": [
            {
              "type": "command",
              "command": "r=\"$HOME/.config/agent-memory/run.sh\"; [ ! -x \"$r\" ] || \"$r\" session-start codex # agent-memory-kit",
              "timeout": 20
            }
          ]
        }
      ]
    }
  }
  ```

  For Kiro the same holds when `~/.kiro` or `~/.kiro/hooks` is a link: setup writes nothing there and prints the folder and the JSON document to save in it as a regular file named `agent-memory-kit.json`. A symbolic link at the Kiro hook path itself, inside a real `~/.kiro/hooks` folder, is replaced by a regular file; its target is not touched.

`--no-hooks` removes these entries again (the launcher stays). For a linked file or folder it removes nothing and asks you to remove the kit's entry or file by hand. A `hooks.json` that is not valid JSON holding an object stops setup with an error naming the file, and so does one whose `hooks` is not an object or whose `hooks.SessionStart` is not an array (when hooks are registered). Setup stops before it writes anything.

## Day to day

Write notes as ordinary Markdown files in `global/` or in a project folder; Claude Code's own memory feature does this for you once the link is in place. Each folder may keep a `MEMORY.md` index, and index files from different machines are merged line by line.

Each project folder holds a one-line file named `.project` with the identity of the repository it belongs to: the `origin` URL without scheme, user, password, port or trailing `.git` (for example `example.com/Owner/Repo`). The first session in a repository writes it, and it syncs like any other note. A repository needs an `origin` remote with a shareable URL to share its memory: without one (or with a local path or a `file://` URL) two repositories with the same directory name cannot be told apart, so its memory folder is not linked and stays on this machine. A repository with the same directory name but a different `origin` is not linked to that folder either. If a repository that is already linked changes its remote, the session warns and leaves the link alone. The same repository reached through a different URL form, for example an SSH host alias or different letter case, counts as a different repository. To rebind on purpose, for example after a repository moves to a new remote, delete or edit `.project` in the project folder (`~/agent-memory/projects/<name>/.project`).

The result of the last sync is in `~/.local/state/agent-memory/status.json`: when it last ran, when it last succeeded, whether it committed, merged and pushed, how many files are in quarantine or in conflict, and which project folders had their `.project` claimed by different repositories on two machines (`markerConflicts`).

## Consolidation

Over time notes pile up: duplicates, notes that contradict each other, an index that outgrows what a session can read, facts that only appear in old conversations. Consolidation is an optional weekly job in which a language model tidies the notes, and a driver applies the result only if fixed checks accept it. Nothing about it is active until you add a `consolidate` block to the configuration; a machine without the block behaves exactly as before.

There are two jobs, each run per folder of notes (a "scope": one project folder, or `global/`):

- **Extract** reads the recent conversations of one project and corrects or adds notes for what they show. It works on project folders only, never on `global/`, and it never retires a note.
- **Organize** tidies a folder: it merges notes that say the same thing, repairs frontmatter, marks facts that cannot both be true, turns relative dates into absolute ones, and keeps `MEMORY.md` complete and within 200 lines and 25,000 bytes. For a project it also sees `global/` and may move a note about the person there. It may retire a note (see below).

Both are started with `workstation/run.sh consolidate extract|organize [--project <name>]... [--dry-run] [--keep] [--model <id>] [--min-retention <0..1>]`.

### How a run is kept safe

1. The driver first runs a sync, then copies the scope's note files (and, for an Organize run on a project, `global/`) to a private work folder under `~/.local/state/agent-memory/consolidate/<timestamp>-<pid>/<scope>/` (mode 700).
2. The model client runs inside that copy with file tools only (`Read`, `Write`, `Edit`, `Glob`, `Grep`), no permission prompts, no MCP servers, no saved session, a turn limit and a spending limit. It cannot run commands, so it cannot touch Git, and it cannot delete or rename files. It is started in the copy, not in the clone.
3. Afterwards the driver compares the copy with the live folder and applies the result only if every rule below holds. A rejected result changes nothing in your notes.
4. The applied change is committed as one commit, `consolidate(<host>): <kind> projects/<name>` (or `... global`), together with a report, and the next sync pushes it. The subject ends with the number of files, for example `consolidate(alpha): organize projects/demo (3 file(s))`.

The rules:

- Only note files change: a regular `*.md` file with a plain name. Links, folders and other file types in the copy reject the result.
- Retirement: a note is retired by replacing its whole content with the single line `MOVED TO [[name]]` (or `MOVED TO [[global:name]]` for a note that went to `global/`). The target must exist, must not itself be retired and must not be the index, and the index must not be retired. A retired file is deleted when the result is applied. An Extract run cannot retire: such a file is listed under "Not applied".
- No credentials: a changed or new note, or a file name, that the secret scan flags rejects the result.
- A note may not be emptied (retire it instead), may not be made into a malformed retirement line (for example `MOVED TO [[name]]` with extra text), and may not exceed 100000 bytes.
- The index may not lose notes: the number of notes without an index line may not grow, and the index may not be emptied while notes remain.
- Content retention (next section).
- The live folder must still be what was copied: if a session or a sync changed a note meanwhile, nothing is applied (`changed-meanwhile`). Applying checks again, file by file, immediately before it writes.

**Content retention.** To stop a run from "tidying" by dropping facts, each retired or changed note is compared with its previous version. The terms are its distinct words of four or more letters (for Han characters, every pair of adjacent characters), taken from the note body without the frontmatter. A term of a retired note counts as kept only when it is in the note it was retired into. A term of a changed note counts as kept when it is in the note's new body, or in another note that this run wrote and that did not have the term before. A note with 15 or more terms is rejected when it keeps less than a quarter of them, and so is a run whose touched notes (with 60 or more terms in all) keep less than a quarter overall. The default is `0.25`. For one deliberate, heavy clean-up, pass `--min-retention <0..1>`, for example `--min-retention 0.1`; `--min-retention 0` turns the check off for that run. The setting is only for the command line, not for the timers.

### Configure

Add a `consolidate` block to `~/.config/agent-memory/config.json`. `command` and `model` are required; everything else has the default shown. A value outside its bound, or of the wrong type, makes the whole block count as absent (the rest of the configuration still works), so check with a dry run.

```json
{
  "consolidate": {
    "command": "/path/to/claude",
    "model": "<model-id>",
    "env": { "SETTING_NAME": "<value>" },
    "extract": "Sat *-*-* 03:00",
    "organize": "Sun *-*-* 04:30",
    "maxProjects": 5,
    "maxTranscriptBytes": 200000,
    "maxTurns": 200,
    "maxBudgetUsd": 5,
    "timeoutMinutes": 30
  }
}
```

| Field | Default | Meaning and bounds |
|---|---|---|
| `command` | required | Absolute path of the model client. |
| `model` | required | Model ID passed to the client, no spaces. Use a full model ID; see "What was tested". `--model <id>` overrides it for one run. |
| `env` | `{}` | Extra environment variables for the client, for example the settings it needs to reach its model service. Names start with an upper-case letter or `_`, then upper-case letters, digits and `_`; values are text without control characters. Besides these the client gets only `HOME`, `PATH`, `LANG` and `TZ` of the calling process. The timer's own `PATH` is only `<directory of the Node.js binary>:/usr/local/bin:/usr/bin:/bin`, so a client that needs more (or a different `PATH`) gets it through `env`. |
| `extract`, `organize` | absent | A systemd calendar expression for the weekly timer, for example `Sat *-*-* 03:00`. At most 80 characters from letters, digits, space and `* : , . / ~ -`, with at least one that is not a space. Absent means no timer for that job. |
| `maxProjects` | 5 | Scopes consolidated per run, 1 to 50. Does not limit a run that names its scopes with `--project`. |
| `maxTranscriptBytes` | 200000 | Extract: size of the conversation text given to the model, 10000 to 2000000. |
| `maxTurns` | 200 | Turns the model may take for one scope, 1 to 1000. |
| `maxBudgetUsd` | 5 | Spending limit for one scope, a number above 0 and at most 100. It is passed to the client as the client's own limit, which may be overshot slightly. |
| `timeoutMinutes` | 30 | Time limit for one scope, 1 to 240. The driver stops the client when it is reached. |

The cost is bounded three ways: at most `maxProjects` scopes per run, at most `maxBudgetUsd` for each, and a ceiling for the whole run of `maxProjects` times `maxBudgetUsd` (a scope whose cost is not reported counts at its full limit). The ceiling is checked between scopes, so a scope that overshoots its own limit is not cut off by it. When the ceiling is reached the run stops with a message and the remaining scopes wait for the next run. Start with a dry run on one project (see "Try it first").

### The weekly timers

After editing the configuration, run `./setup.sh` again. For each schedule it writes `agent-memory-extract.service` / `.timer` and `agent-memory-organize.service` / `.timer` to `~/.config/systemd/user/` and enables the timers (not with `--no-enable`). Each timer has `Persistent=true`, so a run missed while the machine was off happens at the next start, and `RandomizedDelaySec=10min`. Each service runs `run.sh consolidate extract` or `organize` at low priority (`Nice=10`) with a four-hour limit (`TimeoutStartSec=4h`). A run of `maxProjects` scopes at up to `timeoutMinutes` each can exceed four hours (at the defaults it cannot: 5 times 30 minutes); systemd then stops the unit like `systemctl --user stop` below, and the scopes not yet done wait for the next run. When you remove a schedule (or the whole block) and run `./setup.sh` again, that timer is disabled and its two unit files are removed. Read the log with `journalctl --user -u agent-memory-organize.service`.

Only one consolidation runs at a time on a machine: a second start prints *agent-memory: a consolidation is already running.* and exits. A run in your terminal can be stopped with Ctrl-C (also SIGTERM and SIGHUP): the model is stopped, no further scope is started and the work folder is removed (unless `--keep`). An apply step that has started is not stopped by these signals: it finishes (if the signal also stopped the sync after applying, the push is pending and the next sync sends it), its outcome stands, and then the run stops, so you can see `applied` followed by the *interrupted* line; a signal during the scan or a snapshot stops the run before the model starts. Stopping the service with `systemctl --user stop` does the same, because the unit keeps systemd's default of stopping everything in its control group, which includes the model client.

**Which machine.** When several machines share the notes, enable Organize on one machine only, and Extract on each. Two machines organizing the same folders would rewrite the same notes at the same time and produce conflict copies, and each machine remembers only its own runs, so both would repeat the same work. Extract reads the conversations stored on the machine it runs on, so every machine that has conversations should run it, at a different hour. Schedule Organize after the Extract runs.

### Which scopes a run takes

Per run, at most `maxProjects` scopes (all named ones with `--project`).

- **Organize** takes a scope that has notes and whose content changed since this machine last organized it (or that was never organized). A scope that did not change but is still over the index limits (200 lines or 25,000 bytes) or still holds a `.conflict-` copy is taken again after 28 days: the model could not fix it last time. The order is: over the limits, then holding a conflict copy, then the rest; inside each group the scope whose model was started longest ago goes first (never started first, then by when it was last organized), so one that fails every time does not keep the others waiting.
- **Extract** takes a project folder when this machine has Claude Code conversation folders linked to it and a conversation file changed since the last Extract (in the last 7 days when it never ran). The project whose model was started longest ago goes first (never started first), then the one extracted longest ago, then the one with the newest session. It reads this machine's interactive sessions (typed by a person) and sessions that wrote memory, newest first; automated sessions that did neither are skipped. The text is cut to `maxTranscriptBytes`, and every line the secret scan flags, and each private key block, is replaced by `[redacted]`. The conversation text never leaves the machine except as the prompt to the configured model; it is not written into the notes repository (the notes the model writes from it are).

State is kept in `~/.local/state/agent-memory/consolidate.json` (per scope: the marks, and the last outcome). Two kinds of mark exist. The content marks (when the scope was last extracted or organized, and the content it was organized at) move after `applied` (for Extract only when the model completed: after a run that stopped early, the notes it wrote stay and the same conversations are read again next time), after `no-change` (the model completed and found nothing), after `no-session`, and, for Organize only, after `rejected` when the model completed: the same notes would only give the same rejection, so the scope waits until its content changes (or 28 days, while still over the limits). They never move after `model-failed` or `apply-interrupted`, or after a `rejected` result from a model that did not complete, and Extract's never move after `rejected`: those conversations are read again. The ordering marks (when the model was last started for the scope) move whenever the model process was started, whatever came of it. A dry run moves none of them. An unreadable state file is moved aside and the run starts afresh.

### Try it first

Run Organize on one project with a dry run and keep the work folder:

```
workstation/run.sh consolidate organize --project <name> --dry-run --keep
```

The model runs for real (and costs what a real run costs), but nothing in your notes changes and no marks move. The sync before the copy still runs, as in any run. The output is a headline, `organize <name>: dry-run, <n> change(s), USD <cost>, stopped: <reason>`, and the report that a real run would commit (a scope that never reached the model, such as `no-session`, has no `stopped:` part):

- the model, turns, cost and why it stopped (see "Why the model stopped" below). A model that stopped early but left changes still has them judged: they are applied if they pass the rules and rejected if not, with the reason in the headline and the report;
- index lines and bytes before and after, and the number of notes with no index line before and after;
- note bytes before and after, and the bytes of the notes retired (`retired: <n> bytes`);
- the share of distinct terms kept (the retention check);
- the lists Added (with each note's description), Changed, Retired (`note -> target`) and Not applied.

If the result would be rejected, the rule violations are listed instead of `dry-run`. If the model failed (`model-failed`, below) the run exits with 1, also in a dry run. The last line gives the kept work folder. Compare it with the live notes:

```
diff -r <work folder>/notes ~/agent-memory/projects/<name>
```

(`<work folder>/global` for the `global/` copy.) The folder is mode 700 and is never removed automatically. For an Extract run it also holds `input/digest.md`, the conversation text given to the model: **a kept Extract folder contains conversation text**, so delete it (`rm -r`) when you are done. Folders from a killed run that were not kept are removed by the next run when older than a day.

Satisfied? Run the same command without `--dry-run` for one project, check the commit, then enable the timers.

### Outcomes

Each scope prints one headline with details beneath it. Most outcomes read `<kind> <scope>: <outcome>, <n> change(s), USD <cost>, stopped: <reason>`. Four print "nothing applied" instead of a change count: `rejected, nothing applied (<n> rule violation(s))`, `changed meanwhile, nothing applied`, `aborted, nothing applied` and `model-failed, nothing applied`. One prints a warning instead: `apply interrupted, changes may have been applied`, when the apply step ended without reporting. A scope that never reached the model (`no-session`, `skipped`, a failed first sync or step) shows `USD 0.00` and no `stopped:` part.

| Outcome | Meaning and what to do |
|---|---|
| `applied` | The result was accepted, written, reported in `_reports/<date>-<host>-<kind>-<scope>.md` and committed. *push pending* means the sync after it failed; the next sync retries. *the report could not be written* means the notes changed but the report did not. |
| `no-change` | The model completed (`stopped: completed`) and found nothing to change. Nothing to do. |
| `model-failed` | The model did not complete and left nothing to apply, so nothing was applied and no content mark moved; the run exits with 1 once the other scopes are done, and `stopped:` says why (next section). When the command could not be started, the run stops at once with *stopped; the model command could not be started (`<reason>`)*. |
| `dry-run` | With `--dry-run`: the result would be applied. The report is printed. |
| `rejected` | A rule above failed; the violations are listed and nothing was applied. Read them. A retention message means the model dropped content: look at the kept folder, and use `--min-retention` only if you accept the loss. A repeated rejection of the same folder usually means the notes need a manual change first. |
| `changed-meanwhile` | A note changed during the run, so nothing was applied; the files are named. The next run tries again. |
| `sync-failed` | The sync before the snapshot or before applying failed (the reason is shown), so nothing was applied and the run stops. Fix the sync first: `journalctl --user -u agent-memory-sync.service` and `status.json`. |
| `skipped` | The folder was not available (the reason is shown). |
| `no-session` | Extract found no usable conversation text. Nothing was run. |
| `aborted` | The run was interrupted before the scope's apply step started; nothing was applied. A scope whose apply step had started keeps its own outcome (see above). |
| `apply-interrupted` | The apply step ended without reporting its result, for example because it was killed with SIGKILL: changes may have been applied and committed. Look at the log of the notes repository (`git -C ~/agent-memory log`) for a `consolidate(...)` commit, and at its working tree; the next sync commits and pushes whatever was written. No content mark moves. The run stops and exits with 1, or with the signal's code. |
| `step-failed`, `error` | A step could not run or failed (the step and reason are shown), for example because the clone is missing or a sync held the lock for over five minutes. The run stops and exits with 1, unless a signal caused the failure: the scope is then `aborted` and the exit code is the signal's. |

Other lines: *`<kind>`: nothing to do*; *stopped; the model cost of this run reached its ceiling*; *stopped; the sync failed...*; *stopped; the model command could not be started*; *interrupted by SIGINT; nothing more was applied* (a signal during the first scan reads *nothing was applied*); *agent-memory: consolidation is not configured.*; an error line when the scan of the notes cannot run; and an error for a `--project` name that is not a project folder. A project folder named `global` is never consolidated.

**Exit codes.** A green unit does not mean the notes were tidied: `applied`, `no-change`, `no-session`, `skipped`, `rejected`, `changed-meanwhile` and `sync-failed` all leave the run at exit 0, so read the lines (`journalctl --user -u agent-memory-organize.service`). Exit 1: a step failure (`step-failed`, `error`, `apply-interrupted`), any `model-failed` scope, or a scan that could not run. Exit 2: a usage error or an unknown `--project`. 130, 143 and 129 after Ctrl-C, SIGTERM and SIGHUP.

### Why the model stopped

The `stopped:` value of a scope, and what to check:

| Stopped | Meaning and what to check |
|---|---|
| `completed` | The client finished normally. |
| `spawn-failed` | The `command` could not be started: check that the path exists and is executable for the user the timer runs as. The run stops at once. |
| `no-result` | The client ended without a readable JSON result (or printed more than 1 MiB). Check `model` (a full model ID; an alias may not resolve in restricted mode), `env` and the client's credentials by running a dry run by hand. |
| `error`, or the client's own error reason | The client reported an error: same checks as `no-result`. |
| `timeout` | `timeoutMinutes` was reached: raise it or work on a smaller scope. |
| a turn or budget limit of the client | `maxTurns` or `maxBudgetUsd` was reached: raise it, or work on a smaller scope. |
| `aborted` | The run was interrupted. |

With any reason except `completed`, a result with no changes is `model-failed`; a result with changes is judged as usual, and applied if it passes.

### Undo a run

Every applied run is a single commit in the notes repository. To undo it:

```
git -C ~/agent-memory log --oneline --grep '^consolidate('
git -C ~/agent-memory revert <commit>
```

The next sync pushes the revert; retired notes come back with it. The run's report is part of the same commit, so the revert removes it too (Organize runs also delete reports older than 90 days).

An Organize run you revert will be done again: the folder's content then differs from what was recorded as organized, so the next Organize run treats it as changed and repeats the tidy-up. To make the undo stick, first remove or change the `organize` schedule and run `./setup.sh`, or fix the notes by hand so that the tidy-up is not wanted. An Extract run does not repeat, because its mark has already moved past those conversations; the facts it added stay out until new conversations show them again.

### What was tested

Tested with Claude Code's command-line client, started in its restricted mode, with a full model ID from the model service in use. A model alias (a short name such as a family name) may not resolve in restricted mode, so put the full ID in `model`. Another client needs to accept the same options: `-p`, `--restricted`, `--tools`, `--permission-mode acceptEdits`, `--permission-prompts none`, `--strict-mcp-config`, `--no-session-persistence`, `--output-format json`, `--model`, `--max-turns`, `--max-budget-usd` and `--add-dir`, and report its cost and turns in the JSON result.

## Session messages

At the start of a session you may see one of these lines. `<...>` stands for a value filled in by the session.

- *WARNING: shared memory is enabled but `<clone>` is not a usable clone. Notes written now stay local. Run setup.sh from agent-memory-kit.* The clone is missing or broken. Run `setup.sh` again.
- *This directory is not inside a Git repository, so its memory stays on this machine.* In Codex and Kiro sessions the line reads *...so it has no project notes.*, and the same ending replaces *so its memory stays on this machine* in the next three lines about a project name, an `origin` remote and a shared name. These sessions have no project folder to link, so the other lines (the link, a remote that no longer matches) do not appear there.
- *This repository's directory name cannot be used as a project name, so its memory stays on this machine.* Project names start with a letter or digit and use only letters, digits, `.`, `_` and `-`.
- *This repository has no shareable "origin" remote, so its memory stays on this machine.* Add an `origin` remote to share it.
- *This repository's memory folder could not be linked (`<reason>`), so its memory stays on this machine.* The reason is `nested-entries` (the folder holds a subfolder or a symlink; move them out), `foreign-symlink` (it is a link to somewhere else), `not-a-directory`, `link-path-taken` (something appeared at the link path during adoption; the copied notes are in the clone and the old folder is in its backup) or `lock-timeout` (another session was adopting it; the next session retries).
- *This repository shares its name with another project in shared memory (`<identity>`), so its memory stays on this machine.* See `.project` above.
- *WARNING: this repository's remote no longer matches the project its memory is linked to (`<identity>`).* The link is left alone; edit `.project` if the repository moved.
- *WARNING: memory sync has not succeeded since `<time>`. Notes written now stay on this machine until it recovers.* (or *since it was set up*). The timer has not completed a sync recently (default: ten minutes; set `staleAfterSeconds` in the config file to change it). Check `status.json` and `journalctl --user -u agent-memory-sync.service`.
- *WARNING: the secret scan set aside `<n>` file(s) in `<state directory>`/quarantine. Review them.* See the next section.
- *WARNING: `<n>` project folder(s) were claimed by a different repository on another machine. Notes written here before that may be mixed in; see `<state directory>`/status.json.* See the next section.
- *Note: `<n>` note(s) changed on two machines; both versions were kept as \*.conflict-\*.md.*

## When something is set aside

- **Quarantine.** `~/.local/state/agent-memory/quarantine` holds files, or lines taken out of an index file, that the secret scan flagged. They are not committed. Review them, remove the credential, and move the content back into the clone if you still want it. A commit made by hand that contains flagged content is rebuilt by the next sync: its changes are committed again without the flagged files or lines, which go to quarantine.
- **Conflicts.** A file named `<name>.conflict-<host>.md` is the version from the machine named `<host>`, saved when the same note was changed on two machines at once. Merge the two files by hand and delete the `.conflict-` file.
- **Project folders claimed twice.** When two machines bound the same project folder to different repositories before they synced, the remote's `.project` is kept and no conflict copy is made, but notes from both repositories may now share the folder. `status.json` lists such folders under `markerConflicts`. Move notes that belong to the other repository by hand. The list, and the session warning with it, stays until you delete `~/.local/state/agent-memory/status.json`; the next sync writes a new one.

## Limits of the secret scan

The scan is a safety net with a fixed list of patterns: cloud access key ids, GitHub and Slack tokens, API keys with a common prefix, private key blocks, JSON web tokens, and assignments such as `password = ...`. It is not a guarantee:

- The pattern list is fixed. A credential in a shape the list does not know will be committed and pushed.
- Assignments are flagged only when the value is at least 20 characters long and contains both a letter and a digit. A `name: value` or `name=value` pair is judged wherever it stands on the line, also when it is written inside another value without a space: once with its whole value, and once with the value cut at the next such name.
- An access key id is not flagged when its 16 characters after the `AKIA` or `ASIA` prefix contain `EXAMPLE`, `TEST`, `FAKE`, `INVALID` or `DUMMY` in upper case, because documentation and fixtures use such ids.
- An assignment is not flagged when the name ends with `FILE`, `PATH` or `DIR` (any case) and the value starts with `/`, `./` or `../` (a value starting with `~` is not matched as an assignment in the first place). Both must hold; a value that only starts with `/` under another name is still flagged, and so is a real assignment written directly after the path on the same line.
- Files larger than 5 MiB are set aside in quarantine without being scanned.
- File names are not scanned.

Keep the notes repository private and do not write credentials into notes.

## If a secret reached the remote

1. Stop the timer on every machine: `systemctl --user stop agent-memory-sync.timer`.
2. Rotate the credential. Treat it as exposed even after it is removed from the repository.
3. Rewrite the remote's history to remove it, and force-push the result.
4. On each machine: move `~/agent-memory` aside (for example to `~/agent-memory.old`), run `./setup.sh --no-enable` to clone afresh, copy over any notes written since the rewrite from the old clone, and start the timer: `systemctl --user start agent-memory-sync.timer`.

A clone that still has the old history refuses to sync with *remote history was rewritten; re-clone `<clone>` (see README)*, so it cannot push the removed commits back.

## Turn it off

On each machine:

1. Delete `~/.config/agent-memory/config.json`. The hooks and the sync stop acting immediately.
2. Disable the timer: `systemctl --user disable --now agent-memory-sync.timer`, and, if you enabled consolidation, `agent-memory-extract.timer` and `agent-memory-organize.timer` the same way.
3. Remove the two hook entries from `~/.claude/settings.json`: the commands that end with `# agent-memory-kit`, one under `SessionStart` and one under `PreToolUse`. `./setup.sh --no-hooks --no-enable`, run before step 1, does this for you, and also removes the Codex and Kiro hook entries (a `~/.codex/hooks.json` that is a symbolic link or in a linked folder is not edited, nor is a linked Kiro file removed; setup says what to remove).
4. To unlink the memory folders: each linked folder `~/.claude/projects/<folder name>/memory` is a symlink into the clone, with a `memory.local-backup-<timestamp>` folder beside it. Remove the symlink, create the `memory` folder again and copy the project's notes from `~/agent-memory/projects/<name>/` into it. Delete the backup folders once you have confirmed that their notes are in the clone.

Your notes stay in `~/agent-memory` and in the remote repository.

## Memory API

The `api/` directory holds an optional HTTP API for tools that cannot reach your machines, such as an MCP gateway (a service that turns an HTTP API into tools for agents). It lets such a tool list, search and read the notes, and lets agents write notes of their own. It is separate from the workstation sync above: nothing on a workstation needs it, and the sync does not need it.

```
  workstation sync ---->  S3 bucket (replica of the notes)  <----  Memory API  <----  MCP gateway
  (one-way copy)                  agents/<agent>/  <-----------  memory_write
```

The notes in the bucket are meant to be a replica of the workstation notes. The API reads the replica and writes only under `agents/<agent>/`. Those agent scopes are not part of the clone on your machines.

**The replica writer is not part of this repository yet.** Nothing here copies workstation notes into `mem/` or builds `index/mem.json`, so a fresh deployment has an empty replica: `memory_scopes` lists only agent scopes, and reads and searches of `global` and `projects/<project>` find nothing until a writer (the roles named in `AGENT_MEMORY_WORKSTATION_ROLE_ARNS`) fills it. A writer must produce:

- the notes as objects under `mem/`: `mem/global/<file>.md` and `mem/projects/<project>/<file>.md`, with each scope's index at `mem/<scope>/MEMORY.md`;
- the search snapshot `index/mem.json`:

  ```
  { "version": 1, "notes": [ { "path": "global/n.md", "name": "n", "description": "...", "type": "reference", "body": "..." } ] }
  ```

  `path` is the note's path in the client-scope form that `memory_read` takes (`global/<file>.md` or `projects/<project>/<file>.md`, without the `mem/` prefix). `MEMORY.md` files are not listed. Entries outside `global/` and `projects/` are ignored.

The API writes the matching agent-side objects itself: `agents/<agent>/<name>.md`, `agents/<agent>/MEMORY.md` and `index/agents.json`.

### Operations

| Operation | Request | What it does | Token scope |
|---|---|---|---|
| `memory_scopes` | `GET /v1/scopes` | Lists the scopes that hold notes, with a note count each. | `agent-memory/read` |
| `memory_index` | `GET /v1/index?scope=<scope>` | Returns the `MEMORY.md` index of one scope. | `agent-memory/read` |
| `memory_search` | `GET /v1/search?q=<words>` | Keyword search over note names, descriptions and text. | `agent-memory/read` |
| `memory_read` | `GET /v1/note?path=<path>` | Returns one note. | `agent-memory/read` |
| `memory_write` | `POST /v1/notes` | Creates or replaces a note in `agents/<agent>/`. | `agent-memory/write` |

`api/openapi.json` describes the operations, including the text the gateway shows to the model. Errors are `{ "error": { "code", "message" } }`.

### Limits and trust

- The API reads a replica of the workstation notes and can write only under `agents/<agent>/`. It has no delete operation.
- The API cannot tell callers apart. The gateway presents one machine identity, so any caller the gateway lets use `memory_write` can write to any agent's scope, including replacing another agent's note. Which callers may use which tool is the gateway's job. Earlier versions of a replaced note remain available through the bucket's object versions for 90 days.
- The function's role trusts only the Lambda service (SST would otherwise also add the account as a trusted principal, so the trust policy is set explicitly).
- The function has no permission to list the bucket. S3 therefore reports a missing object as "access denied" instead of "not found", and the API treats both as "not found" (404 `not_found` for a read). This is safe for writes: every create is conditional on the object not existing and every update on its current version, so a read that was denied for an object that does exist makes the following write fail as a conflict (409) instead of overwriting it.
- Two writes of the same note name at the same moment can leave the note file and the search snapshot holding different text (the file from one request, the snapshot from the other) until the next write of that note. Reading the note and searching it may then disagree briefly. No data is lost: S3 keeps the earlier versions.
- Each agent scope holds at most 200 notes and about 240 KB of text, and there are at most 16 agent scopes. A write that would exceed the first two limits fails with `scope_full`; a write that would exceed the number of scopes or the total size of the agent store fails with `store_full`. There is no way to free space through the API, because it cannot delete. An operator removes notes in the bucket directly.
- Credentials: a note, a name or a description that looks like a credential is refused with `secret_detected`. This is a safety net with a fixed list of patterns, so a credential in an unusual shape can pass. It is not a guarantee.
- Notes are data, not instructions. Anything an agent reads through the API was written by a person or an agent and may be wrong or hostile.
- API Gateway checks the token and the scope of each route. The function checks the token's scope again, so a route deployed without a scope requirement still refuses a token that lacks it.

### Deploy

Run from `api/`. You need AWS credentials that may create the resources of the stack (a bucket, a user pool with a token endpoint, an HTTP API, one function, parameters and log groups) and the bootstrap resources that SST keeps for itself in the account. Create that role before the first deploy; the deploy does not create it.

```
cd api
npm install
npm run typecheck:infra
AGENT_MEMORY_REGION=<region> npx sst deploy --stage <stage>
```

The infrastructure program is not type-checked in CI, so run `npm run typecheck:infra` before each deploy.

`AGENT_MEMORY_WORKSTATION_ROLE_ARNS` optionally holds a comma-separated list of IAM role ARNs that may write the replica (the `mem/` and `index/` prefixes) and read the agent scopes, for the job that copies the workstation notes into the bucket. The function itself cannot write under `mem/`. The `prod` stage keeps its resources when removed; every other stage deletes them.

The deployment creates:

- a versioned bucket that holds the replica and the agent scopes; superseded versions expire after 90 days (after 1 day for the search snapshots under `index/`, which are rewritten on every write; the 20 most recent earlier versions of each search snapshot are kept for up to 90 days);
- a token issuer with two clients that use the client-credentials flow: `hub` (for the gateway) and `probe` (for the checks, with tokens that last 5 minutes; read-only on `prod`), and two scopes, `agent-memory/read` and `agent-memory/write`;
- an HTTP API with one route per operation and a function behind it;
- SSM parameters under `/agent-memory/<stage>/mcp/`: `gateway/url`, `cognito/issuer`, `cognito/token-endpoint`, `cognito/hub/client-id`, `cognito/hub/client-secret` (a secure string), `cognito/hub/credential-version`, `cognito/probe/client-id`, `cognito/probe/client-secret` (a secure string) and `bucket/name`.

### Check a deployment

After a deploy, from `api/`:

```
node scripts/verify-deployed.ts --stage <stage> [--region <region>] [--expired]
```

The script reads the `probe` client's parameters, asks the token endpoint for tokens with HTTP Basic authentication and prints one `PASS` or `FAIL` line per check. It exits non-zero when a check fails. It keeps the secret and the tokens in memory and prints neither. The checks:

1. Every route refuses a request without a token (401).
2. Every route refuses a malformed token (401).
3. Every route refuses a well-formed token signed by another issuer (401). The script makes the key for it.
4. A token with only `agent-memory/read` gets 403 on `POST /v1/notes`, and the 403 comes from API Gateway itself (its body is `{"message":"Forbidden"}`), not from the function (whose body has `error.code`). A 403 from the function means the gateway let the request through and the route may have lost its scope.
5. Two steps. 5a always runs: with a read-only token, `memory_scopes` answers 200 with a `scopes` array and `memory_search` answers 200 with `results` and `total`; `memory_read` of a note that cannot exist and `memory_index` of a scope that cannot exist answer 404 `not_found` (a 500 there means a missing object did not read as not found). 5b runs only when the probe client can get the write scope: a token with both scopes writes a note `deployed-check` in agent `probe`, then reads it, finds it in the index and in the list of scopes. When the token endpoint refuses the write scope, 5b is reported as `SKIP` and does not change the exit code. 5b is also skipped when the write answers 400 `scope_full` or `store_full`. Any other answer to the write, including a network error or a timeout, is a failure.
6. Each response the run received has the fields in the `required` list of its schema in `openapi.json`.
7. An unknown path (`GET /v1/nope`) answers 404 or 401, never 200.
8. With `--expired`, the script waits about five minutes until a probe token has expired and expects 401.

On the `prod` stage the probe client must be read-only: if a token with the write scope can be issued there, the script reports a failure and does not run 5b. The write path is exercised only on other stages. When 5b runs, the check note stays in the bucket as `agents/probe/deployed-check.md` and is replaced by the next run.

### Register the API with an MCP gateway

A gateway that turns an OpenAPI description into tools can use `api/openapi.json`. Print the document with the stage's URL filled in:

```
node scripts/render-openapi.ts "$(aws ssm get-parameter --name /agent-memory/<stage>/mcp/gateway/url --query Parameter.Value --output text)"
```

Register the output as the gateway target, with the OAuth client-credentials flow, the stage's `cognito/token-endpoint`, the `hub` client's ID and secret, and the scopes `agent-memory/read agent-memory/write`. To give some callers read access only, request only `agent-memory/read` for them or leave `memory_write` out of their tools at the gateway.

### Cost

You pay per request: API Gateway requests, function invocations and run time, and bucket requests and storage, plus the log storage. A stage that gets no requests costs nothing for the API and the function. The bucket's storage and the token issuer's own charges depend on current AWS pricing; check it rather than relying on a figure written here. The API Gateway stage limits traffic to a small burst, so a runaway caller is throttled.

### Remove

```
cd api
AGENT_MEMORY_REGION=<region> npx sst remove --stage <stage>
```

This deletes every resource of a non-`prod` stage, including the bucket and the notes in it. The `prod` stage is protected and its resources are retained: SST does not remove them, and the bucket is not emptied for you. To retire `prod`, turn off `protect` and `removal: "retain"` in `api/sst.config.ts`, empty the bucket yourself (all object versions), and then remove the stage.

## Development

```
npm test
```

runs the unit tests (`node --test`, no dependencies) and the setup script test, which uses a temporary home directory and a fake `systemctl`. The tests run Git with a temporary home directory and without the system configuration, so your own Git settings do not change their results. CI also runs them with Git 2.30 in a Debian 11 container.

## License

MIT. See [LICENSE](LICENSE).
