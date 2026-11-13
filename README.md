# herdr-archive

stop paying ram for agents you're not looking at. archive a project (or one tab) in [herdr](https://herdr.dev), its terminals actually die, and when you bring it back each claude code gets resumed right where you left it. same space, same tab names, same order, same color. like it never left.

no more 40 claude processes sitting in memory "just in case". no more tab graveyards you're scared to close because you'll lose the conversation. close it for real, restore it whenever.

## what it does

| you press | what happens |
|---|---|
| `cmd+s` on a project | every terminal in it gets recorded, then the whole space closes. it shows up as an item under a gray **low priority** space. nothing runs in there |
| `cmd+d` on a tab | same thing but just that one tab. the rest of the space stays put |
| `cmd+s` / `cmd+d` on an archived item | restores it |
| click an archived item | opens a little card: what's in it, which folders, which claude conversations. big restore button |

what gets saved per terminal: its folder, the exact command it was running, and for claude code the **conversation id** (read from `~/.claude/sessions/<pid>.json`, and only kept if that conversation file actually exists).

what restore does: starts a fresh shell per terminal in the old folder, inside the old space and tab (herdr adopts it by label, so names, colors, tab order and anything keyed to the tab id, like notes, come back), then types `claude --resume <id>` with all your original flags (`--model`, `--dangerously-skip-permissions`, whatever). shell stays alive after claude quits, like normal.

other agents (antigravity `agy --conversation=…`, codex, whatever reports a status to herdr) get their own command rerun with the same arguments. works if the command itself names the conversation. if it doesn't, you get a plain agent in the right folder.

it works on other machines too (`hc machine`): archiving a monster project closes it on monster, restores it on monster.

## what you lose (be real about it)

- scrollback / screen contents. the *conversation* survives (claude keeps it), the terminal buffer doesn't
- anything running that isn't an agent: dev servers, builds, a half-typed command. they die. the record keeps the command so you can see what it was
- the split layout inside a tab. terminals come back in the right tab but side by side, not in your old arrangement
- an agent that was mid-turn or waiting on a permission prompt. it's closed, the prompt is gone. restore and say continue
- a claude that had no resumable conversation yet falls back to `claude --continue` (latest in that folder). the card tells you when that's the case

every archive also appends the full record to `<herdr home>/data/archive/log.jsonl`, so even if you wipe an item by accident the conversation ids are still on disk.

## install

needs herdr-app (the native one) with `hc` (herdr-core) on your path, python3 (just to edit json), and a layout of your own. herdr resets the shipped layouts (`main`, `terminals`, `win98`) on start, so if you're on one, clone it first:

```sh
herdr-app do layout.clone '{"name":"main","as":"mine"}'
```

then:

```sh
git clone https://github.com/yigitkonur/herdr-archive
cd herdr-archive
./install.sh                 # uses whatever layout you're on
./install.sh --layout mine   # or pick one
```

it:

1. copies `mods/archive` (headless controller) and `mods/archived` (the card) into `~/.config/herdr-app/mods/` (or `$HERDR_APP_HOME`)
2. binds `cmd-s` → `archive.toggle-space` and `cmd-d` → `archive.toggle-tab` in `keys.json`. if those keys are already taken it leaves them alone and tells you, then bind them to whatever you like
3. adds a zero-size floating block named `archive` to your layout. that's the only way a mod without a ui gets to run. you won't see it
4. runs `herdr-app check` on both

backups of anything it touches go to `<home>/.archive-backup/<timestamp>/`. run it twice, nothing breaks. `./install.sh --no-keys` skips the key binding.

```sh
./install.sh uninstall       # removes the mods, the keys, the layout block (items already in low priority stay until you restore/close them)
```

## commands

all of these are `archive.<command>`, so `"cmd-s": "archive.toggle-space"` in keys.json, or `herdr-app do archive.<command>` from a script:

| command | does |
|---|---|
| `toggle-space` | shown project: archive it. on an archived item: restore it |
| `toggle-tab` | same, for the shown tab only. archiving the last tab of a space takes the space with it |
| `archive-space-<space id>` | archive that space. ids from `herdr-app ls` |
| `archive-tab-<tab id>` | archive that tab |
| `restore-<item id>` | restore an item (ids look like `ar1a2b3c…`, they're in shared state `archive.items`) |
| `restore-all` | restore everything in the shown low priority space |
| `migrate` | if you have terminals parked in low priority from the old "move it there and leave it running" way, turn them into proper items (**ends those terminals**, so only when you mean it) |
| `move-<tab id>-to-<space id>` | bonus: move a running tab to another space on the same machine, no restart |

the by-id ones don't care what's focused. use those in scripts, not the toggles. (the toggles act on whatever you're looking at, which is the point of a shortcut and the reason not to fire them from a test script at your real work. ask me how i know.)

want it in a right-click menu? a menu item just runs `archive.archive-tab-<id>` (that's how it's wired in the author's setup).

## how it works

one headless mod (`archive`) holds all the logic and listens for commands. it's in the layout as a zero-size floating block, which is the trick that gets a ui-less mod running.

archive:
1. `hc get <t>` for each terminal → folder, foreground argv, pid
2. claude? read `~/.claude/sessions/<pid>.json` on that machine → session id, check `~/.claude/projects/*/<id>.jsonl` exists
3. write the record to shared state (`archive.items`) and the log
4. make the machine's low priority space if it isn't there (a placeholder terminal labelled into it, killed right after) and add a tab whose only pane is the `archived` mod
5. only now close the space/tab. if anything failed before that, the item is undone and nothing is closed. once the close is sent, the item stays no matter what (a slow remote can land the close late)

restore:
1. `hc run --bg --keep --label herdr.space=<old> --label herdr.tab=<old>` per terminal, in its folder (home if the folder is gone)
2. `hc send` the resume line
3. wait for herdr's layout to save, put names and tab order back, check they stuck (retries, a slow remote sometimes undoes a rename)
4. drop the record, close the item tab, select the space

moves are serialized with a lock in shared state (`archive.lock`, expires after 60s so a crashed app doesn't wedge it). closing an item's tab forgets it.

shared state keys other mods can read: `archive.items`, `archive.lock`, `lowspace.ids` (each machine's low priority space id). if you also use a mod that stores `space.colors`, the project's color is saved and restored too.

## files

```
mods/archive/archive.js   the logic (archive, restore, migrate, move, lock, prune)
mods/archive/main.js      headless controller: command loop
mods/archived/main.js     the card you see when you click an item
mods/archived/restore.svg icon
install.sh                install / uninstall
```

## troubleshooting

- **nothing happens on cmd+s**: `herdr-app status` should list a float called `archive`. if not, the layout block is missing (`./install.sh --layout yourlayout`). also check the key isn't bound to something else in `keys.json`
- **"stopped: tN ended during the move"**: a terminal died while a move was in flight. whatever didn't move is still in its space or in low priority. restore from there
- **restore says "names or tab order didn't stick"**: herdr was still saving another change. run restore again, it picks up where it stopped (it won't start terminals twice)
- **a claude came back with the wrong conversation**: it had no session file yet (just started, no message sent), so it ran `claude --continue`. the card shows `continues the folder's latest conversation` for those before you restore
- **claude uses `CLAUDE_CONFIG_DIR`**: the session lookup reads `$HOME/.claude`. a custom config dir means no session id is found and you get the `--continue` fallback. patch `sessionOf` in `archive.js` if that's you
- **it's a remote machine and it's slow**: waits are generous (20-30s per step) but a machine that's asleep will time out. it tells you, nothing is lost

## the author's setup

this came out of a fully customized herdr. there the sidebar lists archived items under the low priority space (it just reads the shared `archive.items` / `lowspace.ids` keys described above) and the tab right-click menu has archive / restore items. both are tiny: draw rows from shared state, call `archive.<command>` on click.

## license

mit. do whatever, don't blame me if you archive the thing you were working on. (the by-id commands exist so you can test without that happening.)
