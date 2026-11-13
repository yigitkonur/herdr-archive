// The archive controller: no UI, it only listens for commands and does the work in archive.js.
// It must sit in your layout as a zero-size block (install.sh adds it). Commands, as
// "archive.<command>" in keys.json or `herdr-app do archive.<command>`:
//   toggle-space        the shown project: archive it; on an archived item, restore it
//   toggle-tab          the same for the shown tab only
//   archive-space-<id>  archive that space (id as `herdr-app ls` shows it)   } by id, for scripts
//   archive-tab-<id>    archive that tab                                     } and menus: they
//   restore-<item id>   restore an item                                      } don't depend on
//   move-<tab>-to-<space>  move a tab to another space, still running        } what's shown
//   restore-all         restore everything in the shown Low priority space
//   migrate             turn terminals parked in Low priority (old way) into items

import { View, div } from "gpui-kit";
import { focused, nextCommand, notify } from "herdr";
import { archive, archiveTab, restore, restoreAll, migrate, moveTab, prune, isLow, lowIds, items, itemOfTab, enqueue } from "./archive.js";

export default class Archive extends View {
  init(_props, cx) {
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        try { this.command(c, cx); } catch (e) { notify({ title: "Archive", body: String(e?.message ?? e), level: "error" }); }
      }
    });
    cx.timer.every(1000, () => prune());
  }

  // Runs `work` after anything already moving, and says how it went.
  act(cx, id, work) {
    enqueue(id, work,
      (e) => notify({ title: "Archive stopped", body: `${e?.message ?? e}`, level: "error" }),
      (said) => { if (said) notify({ title: said.includes("is back") ? "Restored" : "Archived", body: said, level: "success", timeout: 6000 }); });
  }

  command(c, cx) {
    const f = focused();
    const low = f?.space && isLow(f.space) ? f.space : null;
    const item = low ? itemOfTab(f.tab) : null;
    if (c === "toggle-space") {
      if (item) this.act(cx, item.id, () => restore(item.id));
      else if (f?.space && !low) this.act(cx, f.space, () => archive(f.space));
    } else if (c === "toggle-tab") {
      if (item) this.act(cx, item.id, () => restore(item.id));
      else if (f?.tab && !low) this.act(cx, f.tab, () => archiveTab(f.tab));
    } else if (c.startsWith("archive-space-")) { const id = c.slice(14); this.act(cx, id, () => archive(id)); }
    else if (c.startsWith("archive-tab-")) { const id = c.slice(12); this.act(cx, id, () => archiveTab(id)); }
    else if (c.startsWith("restore-ar")) { const id = c.slice(8); if (items()[id]) this.act(cx, id, () => restore(id)); }
    else if (c.startsWith("move-") && c.includes("-to-")) { const [tab, to] = c.slice(5).split("-to-"); this.act(cx, tab, () => moveTab(tab, to)); }
    else if (c === "restore-all" && low) this.act(cx, low, () => restoreAll(low));
    else if (c === "migrate") for (const id of Object.values(lowIds())) this.act(cx, `migrate-${id}`, () => migrate(id));
  }

  render() { return div().size(0); }
}
