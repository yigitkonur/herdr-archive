#!/bin/sh
# herdr-archive installer.
#   ./install.sh [--layout NAME] [--no-keys]    install or update
#   ./install.sh uninstall [--layout NAME]      take it out again
# It copies the two mods into your herdr-app home, binds Cmd+S / Cmd+D, and adds the
# zero-size controller block to a layout of yours. Nothing is overwritten without a backup
# (in <home>/.archive-backup/<time>/). Safe to run twice.
set -eu
SRC="$(cd "$(dirname "$0")" && pwd)"
HOME_DIR="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
cmd=install; LAYOUT=""; KEYS=1
for a in "$@"; do
  case "$a" in
    install|uninstall) cmd="$a" ;;
    --no-keys) KEYS="" ;;
    --layout) ;;
    --layout=*) LAYOUT="${a#--layout=}" ;;
    *) [ "${prev:-}" = "--layout" ] && LAYOUT="$a" || { echo "usage: $0 [install|uninstall] [--layout NAME] [--no-keys]" >&2; exit 2; } ;;
  esac
  prev="$a"
done
[ -d "$HOME_DIR" ] || { echo "no herdr-app home at $HOME_DIR (start herdr-app once, or set HERDR_APP_HOME)" >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 is needed (only to edit your json files)" >&2; exit 1; }
STAMP="$(date +%Y%m%d-%H%M%S)"; BACKUP="$HOME_DIR/.archive-backup/$STAMP"

if [ "$cmd" = install ]; then
  for m in archive archived; do
    if [ -d "$HOME_DIR/mods/$m" ]; then mkdir -p "$BACKUP/mods"; cp -R "$HOME_DIR/mods/$m" "$BACKUP/mods/"; fi
    mkdir -p "$HOME_DIR/mods/$m"
    cp "$SRC/mods/$m/"* "$HOME_DIR/mods/$m/"
  done
  echo "copied mods/archive and mods/archived"
fi

HOME_DIR="$HOME_DIR" BACKUP="$BACKUP" CMD="$cmd" LAYOUT="$LAYOUT" KEYS="$KEYS" python3 - <<'PY'
import json, os, shutil, sys
home, backup, cmd, want, keys = os.environ["HOME_DIR"], os.environ["BACKUP"], os.environ["CMD"], os.environ["LAYOUT"], os.environ["KEYS"]
SHIPPED = {"main", "terminals", "win98"}   # herdr replaces these at start: edit a clone instead
BIND = {"cmd-s": "archive.toggle-space", "cmd-d": "archive.toggle-tab"}

def load(p):
    with open(p) as f: return json.load(f)
def save(p, d):
    rel = os.path.relpath(p, home)
    os.makedirs(os.path.dirname(os.path.join(backup, rel)), exist_ok=True)
    shutil.copy(p, os.path.join(backup, rel))
    with open(p, "w") as f: json.dump(d, f, indent=2, ensure_ascii=False); f.write("\n")

# --- keys
kp = os.path.join(home, "keys.json")
if keys:
    if not os.path.exists(kp):
        print("keys.json not found: add this to the \"global\" section yourself:\n  " + json.dumps(BIND))
    else:
        k = load(kp); g = k.setdefault("global", {}); changed = False
        for key, act in BIND.items():
            if cmd == "uninstall":
                if g.get(key) == act: del g[key]; changed = True
            elif g.get(key) == act: pass
            elif key in g: print(f"{key} is already bound to {g[key]}: left alone (bind {act} to a key you like)")
            else: g[key] = act; changed = True
        if changed: save(kp, k); print("keys.json updated")

# --- layout: a zero-size floating block on the block that shows the active tab
def blocks(n):
    yield n
    for c in n.get("children", []): yield from blocks(c)
name = want
if not name:
    try: name = load(os.path.join(home, "shared.json")).get("layout")
    except Exception: name = None
if not name:
    sys.exit("couldn't tell which layout you use: run again with --layout NAME (see the layouts folder)")
lp = os.path.join(home, "layouts", name + ".json")
if not os.path.exists(lp): sys.exit(f"no layout {lp}")
if name in SHIPPED and cmd == "install":
    sys.exit(f"'{name}' is a shipped layout (herdr resets it at start). clone it first:\n  herdr-app do layout.clone '{{\"name\":\"{name}\",\"as\":\"mine\"}}'\nthen: ./install.sh --layout mine")
lay = load(lp)
host = next((b for b in blocks(lay) if b.get("type") == "block" and (b.get("content") or {}).get("tab") == "active"), None)
if not host: sys.exit("no block showing the active tab in that layout: add {\"id\":\"archive\",\"content\":{\"mod\":\"archive\"}} to a block's floating list by hand")
fl = host.setdefault("floating", [])
has = any((f.get("content") or {}).get("mod") == "archive" for f in fl)
if cmd == "install" and not has:
    fl.append({"id": "archive", "content": {"mod": "archive"}, "edge": "bottom", "align": "start"}); save(lp, lay); print(f"layout {name}: controller block added")
elif cmd == "uninstall" and has:
    host["floating"] = [f for f in fl if (f.get("content") or {}).get("mod") != "archive"]; save(lp, lay); print(f"layout {name}: controller block removed")
PY

if [ "$cmd" = uninstall ]; then
  mkdir -p "$BACKUP/mods"
  for m in archive archived; do [ -d "$HOME_DIR/mods/$m" ] && { cp -R "$HOME_DIR/mods/$m" "$BACKUP/mods/"; rm -rf "$HOME_DIR/mods/$m"; }; done
  echo "removed the mods (backup in $BACKUP). archived items still in Low priority stay until you restore or close them."
else
  for m in archive archived; do herdr-app check "$HOME_DIR/mods/$m" 2>&1 | tail -1 || true; done
  echo "done. cmd+s archives the shown project, cmd+d the shown tab; on an archived item the same key restores it."
fi
