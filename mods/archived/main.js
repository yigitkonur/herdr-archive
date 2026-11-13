// An archived project or tab, shown as the only pane of its tab in Low priority
// (spaces-color/archive.js makes it, props { id }). Nothing runs here: Restore starts its
// terminals again in their folders and resumes each Claude conversation (Cmd+S does too).

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, theme, shared, run } from "herdr";

function ago(ms) {
  const m = Math.floor((Date.now() - ms) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.floor(h / 24)} d ago`;
}

const ran = (term) => term.claude
  ? (term.session ? `Claude · resumes ${term.session.slice(0, 8)}` : "Claude · continues the folder's latest conversation")
  : term.rerun ? `${(term.argv[0] ?? "").split("/").pop()} · runs again with its arguments` : "Shell";

export default class Archived extends View {
  render() {
    const t = theme();
    const id = props()?.id;
    const rec = (shared("archive.items") ?? {})[id];
    const lock = shared("archive.lock");
    const busy = Boolean(lock && id) && lock.id === id && Date.now() - lock.at < 60000;
    const page = v_flex().size_full().bg(t.background).text_color(t.foreground).text_size(13).p(28).gap(18);
    if (!rec) return page.child(div().text_color(t.dim).child("This archived item has no record left (already restored, or removed)."));
    const tabs = [...rec.tabs].sort((a, b) => a.order - b.order);
    return page
      .child(v_flex().gap(4)
        .child(div().text_size(17).font_semibold().child(rec.title ?? rec.name))
        .child(div().text_size(12).text_color(t.dim).child(`Archived ${ago(rec.at)} · ${rec.machine ?? "this computer"} · nothing is running`)))
      .child(v_flex().gap(10).max_w(640).children(tabs.map((tab, i) => v_flex().gap(3)
        .child(div().text_color(t.muted).child(tab.name || `Tab ${tab.order + 1}`))
        .children(tab.terms.map((term) => h_flex().gap(10).text_size(12)
          .child(div().w(250).flex_none().truncate().text_color(t.dim).child(term.cwd ?? "~"))
          .child(div().flex_1().min_w(0).truncate().text_color(term.claude || term.rerun ? t.foreground : t.dim).child(ran(term))))))))
      .child(h_flex().gap(10).items_center()
        .child(div().id("restore").h(30).px(14).flex().items_center().gap(7).rounded(7)
          .bg(t.solid).text_color(t.solid_foreground).text_size(12.5)
          .when(busy, (el) => el.opacity(0.6))
          .when(!busy, (el) => el.cursor_pointer().hover((s) => s.opacity(0.85)).on_click(() => run(`archive.restore-${id}`)))
          .child(svg("mods/archived/restore.svg").size(13))
          .child(busy ? "Restoring…" : "Restore"))
        .child(div().text_size(11.5).text_color(t.dim).child("⌘S / ⌘D")));
  }
}
