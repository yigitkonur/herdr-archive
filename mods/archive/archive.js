// Archiving ends a project's terminals (or one tab's), so they stop using memory, and keeps
// what they were: each terminal's folder, and for Claude Code the conversation it had. The
// project then shows as a tab in its machine's "Low priority" space whose only pane is the
// `archived` mod: nothing runs there. Restoring starts a shell per terminal in the old space
// and tab (the same ids, so its name, color, tab names and notes come back) and, where
// Claude ran, resumes that conversation in it.
// Records live in shared("archive.items") { id: record }; each archive and restore is also
// appended to data/archive/log.jsonl, so a conversation's id is never lost.

import { spaces, panes, terminals, machines, focused, run, exec, shared, setShared, readTextFile, writeTextFile, appHome } from "herdr";

export const LOW_NAME = "Low priority";
export const LOW_COLOR = "#6b7280";

const machineOf = (id) => (id.includes("/") ? id.split("/")[0] : null);
const local = (id) => (id.includes("/") ? id.split("/").slice(1).join("/") : id);
const full = (m, id) => (m ? `${m}/${id}` : id);
const pause = (s) => exec("sleep", [String(s)]);
const hex = () => Array.from({ length: 32 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");
const base = (path) => (path ?? "").replace(/\/+$/, "").split("/").pop() || "~";

// Each machine's Low priority space id (as the app shows it), "local" for this computer.
export const lowIds = () => shared("lowspace.ids") ?? {};
export const isLow = (spaceId) => Object.values(lowIds()).includes(spaceId);

// Archived things: { id: { id, machine, at, space, name, named, color, whole, title, low, tabs } },
// `low` the Low priority tab that shows it, `tabs` [{ tab, name, order, terms }], each term
// { cwd, argv, claude, session, addr? } (`addr`: the terminal a restore started for it).
export const items = () => shared("archive.items") ?? {};
export const itemOfTab = (tabId) => Object.values(items()).find((r) => r.low === tabId) ?? null;
function saveItem(rec) { setShared("archive.items", { ...items(), [rec.id]: JSON.parse(JSON.stringify(rec)) }); }
function dropItem(id) { const all = { ...items() }; delete all[id]; setShared("archive.items", all); }

let logging = Promise.resolve();
function log(entry) {
  const dir = `${appHome()}/data/archive`, path = `${dir}/log.jsonl`;
  logging = logging.then(async () => {
    await exec("mkdir", ["-p", dir]);
    let old = await readTextFile(path).catch(() => null);
    // readTextFile stops at 1 MiB: start a new file well before.
    if (old && old.length > 800000) { await exec("mv", [path, `${dir}/log.${Date.now()}.jsonl`]); old = null; }
    await writeTextFile(path, (old ?? "") + JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n", old);
  }).catch((e) => console.log(`archive: couldn't log: ${e?.message ?? e}`));
  return logging;
}

// Waits (at most `s` seconds, another machine can be slow) until `done()` holds, else
// fails. Keeps the lock alive while it waits.
async function until(done, what, s = 20) {
  for (let i = 0; i < s * 10 && !done(); i++) { renew(); await pause(0.1); }
  if (!done()) throw new Error(`timed out: ${what}`);
}

const termOf = (addr) => terminals().find((k) => k.address === addr);
const hasPane = (addr) => panes().some((p) => p.terminal === addr);
const spaceOf = (id) => spaces().find((x) => x.id === id);

// One move at a time. Clicks queue up here, in click order, and each waits for the
// shared lock too: another copy, or this file's previous version after a save, may
// still be moving. The lock is renewed while moving; one left by an app quit expires.
// Each operation holds the lock under its own token: only that operation renews or
// releases it, and every step checks it still holds it (see `renew`).
const EXPIRES = 60000;
const live = () => { const held = shared("archive.lock"); return held && Date.now() - held.at < EXPIRES ? held : null; };
let owner = null; // the token of the operation running in this file version
function lock(id) {
  if (live()) return false;
  owner = `${id}:${Date.now()}:${hex().slice(0, 8)}`;
  setShared("archive.lock", { id, owner, at: Date.now() });
  return true;
}
// Renews the lock; throws if another operation took it (this one stalled past expiry).
function renew() {
  if (!owner) return;
  const held = shared("archive.lock");
  if (held?.owner !== owner) throw new Error("another archive took over; stopped");
  setShared("archive.lock", { ...held, at: Date.now() });
}
function release() {
  if (owner && shared("archive.lock")?.owner === owner) setShared("archive.lock", null);
  owner = null;
}
let chain = Promise.resolve();
const waiting = new Set();
// What is moving now (any copy) and what waits behind it (this copy).
export const moving = () => live()?.id ?? null;
export const queued = (id) => waiting.has(id);

// Runs `work` after everything queued before it; an id already waiting isn't queued twice.
// `done` gets what `work` returned; a failure goes to `failed` and doesn't stop the queue.
export function enqueue(id, work, failed, done = () => {}) {
  if (waiting.has(id) || moving() === id) return chain;
  waiting.add(id);
  chain = chain.then(async () => {
    try {
      while (!lock(id)) await pause(0.2);
      waiting.delete(id);
      done(await work());
    } catch (e) { failed(e); }
    finally { waiting.delete(id); release(); }
  });
  return chain;
}

// The app writes a machine's whole layout, and a write based on an older one wins: a
// command sent while Herdr is still saving the last change can be undone (a rename came
// back unnamed on monster), or a pane dropped with its terminal ended. Herdr writes each
// terminal's "where" (space / tab) from the layout it saved, so when every pane of the
// machine reads what the app shows, the last write landed. Every step waits for that.
function inSync(m) {
  const names = new Map();
  for (const x of spaces()) if ((x.machine ?? null) === m) for (const t of x.tabs) names.set(t.id, `${x.name} / ${t.name}`);
  return panes().every((p) => !p.terminal || machineOf(p.terminal) !== m || termOf(p.terminal)?.labels?.where === names.get(p.tab));
}
async function settle(m) {
  await until(() => inSync(m), `${m ?? "this computer"} saving its layout`, 30);
  await pause(m ? 0.5 : 0.15);
  await until(() => inSync(m), `${m ?? "this computer"} saving its layout`, 30);
}

// The terminals being moved, and the others in the spaces involved, must still be
// running after each step (a dropped pane ends its terminal); if one ended, stop at once.
function guard(addrs, spaceIds) {
  const ids = new Set(spaceIds);
  const tabs = new Set(spaces().filter((x) => ids.has(x.id)).flatMap((x) => x.tabs.map((t) => t.id)));
  const watched = [...new Set([...addrs, ...panes().filter((p) => p.terminal && tabs.has(p.tab)).map((p) => p.terminal)])];
  return () => {
    renew();
    const gone = watched.filter((a) => termOf(a)?.state !== "live");
    if (gone.length) throw new Error(`stopped: ${gone.join(", ")} ended during the move`);
  };
}

// Runs `act` until `ok()` holds once the layout is saved (at most 3 tries).
async function stick(m, ok, act, what) {
  for (let i = 0; i < 3 && !ok(); i++) { act(); await settle(m); }
  if (!ok()) throw new Error(`${what} didn't stick`);
}
const tabInfo = (id) => spaces().flatMap((x) => x.tabs).find((t) => t.id === id);
const renameTab = (m, id, name) => stick(m, () => (name ? tabInfo(id)?.named && tabInfo(id)?.name === name : !tabInfo(id)?.named), () => run("tab.rename", { id, name }), `renaming a tab to "${name}"`);
const renameSpace = (m, id, name) => stick(m, () => spaceOf(id)?.name === name, () => run("space.rename", { id, name }), `renaming a space to "${name}"`);
const placeTab = (m, spaceId, id, index) => stick(m, () => spaceOf(spaceId)?.tabs.findIndex((t) => t.id === id) === index - 1, () => run("tab.move", { id, index }), "putting tabs back in order");

const tabTerminals = (tabId) => panes().filter((p) => p.tab === tabId && p.terminal).map((p) => p.terminal);
// The machine's layout is loaded (this computer's too: while it loads, spaces() is empty).
const ready = (m) => machines().find((k) => (k.name ?? null) === (m ?? null))?.layout === "ready";

// --- what a terminal was running

// The conversation a Claude Code process has open: Claude writes ~/.claude/sessions/<pid>.json;
// kept only if that conversation's file is there to resume.
async function sessionOf(pid, m) {
  if (!/^\d+$/.test(String(pid))) return null;
  const r = await exec("sh", ["-c", `cat "$HOME/.claude/sessions/${pid}.json"`], { on: m });
  let sid = null;
  try { sid = JSON.parse(r.stdout).sessionId; } catch { return null; }
  if (!/^[0-9a-f-]{36}$/.test(sid ?? "")) return null;
  const f = await exec("sh", ["-c", `ls "$HOME"/.claude/projects/*/${sid}.jsonl`], { on: m });
  return f.code === 0 && f.stdout.trim() ? sid : null;
}

async function what(addr, m) {
  const r = await exec("hc", ["get", addr, "--json"]);
  if (r.code !== 0) throw new Error(`hc get ${addr}: ${(r.stderr || r.stdout).trim()}`);
  const d = JSON.parse(r.stdout);
  const fg = d.foreground ?? {};
  const argv = fg.argv ?? null;
  const claude = Boolean(argv?.length && /(^|\/)claude$/.test(argv[0])) || d.status?.app === "claude-code";
  // Another agent (Antigravity's agy --conversation=…, codex resume …): its own command is
  // run again, which brings its conversation back when the command names it.
  const rerun = !claude && Boolean(d.status?.app && argv?.length && !SHELLS.test(base(argv[0])));
  return { cwd: fg.cwd || d.cwd || null, argv, claude, rerun, session: claude ? await sessionOf(fg.pid, m) : null };
}

const SHELLS = /^-?(zsh|bash|sh|fish|nu|dash|ksh|tcsh|csh)$/;

// Claude's flags that pick a conversation (replaced by --resume) or start one with a prompt.
const PICKS = new Set(["-c", "--continue", "--fork-session"]);
const PICKS_VALUE = new Set(["-r", "--resume", "--session-id"]);
const FLAGS = new Set(["--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "--verbose", "--ide", "--strict-mcp-config", "-c", "--continue", "--fork-session"]);
const q = (s) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

// The line typed into the restored shell: the same claude, its conversation resumed
// (`command` skips a shell alias, whose flags are already in the argv it ran with).
export function resumeLine(t) {
  const a = (t.argv ?? ["claude"]).slice(1), out = [];
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    if (PICKS.has(x) || /^--(resume|session-id)=/.test(x)) continue;
    if (PICKS_VALUE.has(x)) { if (a[i + 1] && !a[i + 1].startsWith("-")) i++; continue; }
    // A prompt it was started with: not asked again.
    if (!x.startsWith("-") && (i === 0 || !a[i - 1].startsWith("-") || FLAGS.has(a[i - 1]))) continue;
    out.push(x);
  }
  out.push(...(t.session ? ["--resume", t.session] : ["--continue"]));
  return ["command", "claude", ...out.map(q)].join(" ");
}

// A shell in `space`/`tab` (local ids) on machine `m`, in the terminal's folder; Herdr
// shows it there. Claude is started in it, so its shell stays when Claude quits.
async function start(m, space, tab, t) {
  const args = (cwd) => ["run", "--bg", "--json", "--no-parent", "--no-notify", "--keep", ...(m ? ["--on", m] : []),
    ...(cwd ? ["--cwd", cwd] : []), "--label", `herdr.space=${space}`, "--label", `herdr.tab=${tab}`];
  let r = await exec("hc", args(t.cwd));
  // Its folder is gone: home instead.
  if (r.code !== 0 && t.cwd) r = await exec("hc", args(null));
  if (r.code !== 0) throw new Error(`couldn't start a terminal: ${(r.stderr || r.stdout).trim()}`);
  const addr = JSON.parse(r.stdout).address;
  const line = t.claude ? resumeLine(t) : t.rerun ? ["command", ...t.argv.map(q)].join(" ") : null;
  if (line) {
    const s = await exec("hc", ["send", addr, line]);
    if (s.code !== 0) throw new Error(`couldn't start Claude in ${addr}: ${(s.stderr || s.stdout).trim()}`);
  }
  return addr;
}

// --- the Low priority space and its items

// The machine's Low priority space, made if missing. A space only exists around a tab, so a
// placeholder terminal labelled into it makes it appear (and isn't selected, unlike space.new);
// it's ended once an item is there, and removes itself.
async function lowSpace(m) {
  const key = m ?? "local";
  const known = lowIds()[key];
  if (known && spaceOf(known)) return { id: known, placeholder: null };
  const id = full(m, "sp" + hex());
  setShared("lowspace.ids", { ...lowIds(), [key]: id });
  const r = await exec("hc", ["run", "--bg", "--json", "--no-parent", "--no-notify", "--rm", ...(m ? ["--on", m] : []),
    "--label", `herdr.space=${local(id)}`, "--label", `herdr.tab=tb${hex()}`, "sleep", "300"]);
  if (r.code !== 0) throw new Error(`couldn't make the Low priority space: ${(r.stderr || r.stdout).trim()}`);
  await until(() => Boolean(spaceOf(id)), "the Low priority space showing up");
  setShared("space.colors", { ...(shared("space.colors") ?? {}), [id]: LOW_COLOR });
  return { id, placeholder: JSON.parse(r.stdout).address };
}

// A tab in the Low priority space whose only pane shows `rec`. tab.new selects it.
async function addItem(lowId, rec) {
  const before = new Set(spaceOf(lowId)?.tabs.map((t) => t.id) ?? []);
  run("tab.new", { space: lowId, name: rec.title, mod: "archived", props: { id: rec.id } });
  await until(() => (spaceOf(lowId)?.tabs ?? []).some((t) => !before.has(t.id)), "the archived item showing up");
  return spaceOf(lowId).tabs.find((t) => !before.has(t.id)).id;
}

const count = (n, one) => `${n} ${one}${n === 1 ? "" : "s"}`;

// Puts `chosen` (tabs of space `s`, each [{ tab, addrs, name, order }]) into a record and an
// item, then closes them: the whole space when `whole`, else each tab. Returns what it did.
async function archiveTabs(s, chosen, meta) {
  const m = s.machine ?? null;
  if (!ready(m)) throw new Error(`${m} isn't connected`);
  const rec = { id: "ar" + hex().slice(0, 12), machine: m, at: Date.now(), low: null, tabs: [], ...meta };
  const addrs = [];
  for (const c of chosen) {
    const terms = [];
    for (const addr of c.addrs) { renew(); terms.push(await what(addr, m)); addrs.push(addr); }
    rec.tabs.push({ tab: local(c.tab), name: c.name, order: c.order, terms });
  }
  if (!addrs.length) throw new Error("nothing is running there to archive");
  const f = focused();
  const low = await lowSpace(m);
  saveItem(rec);
  let closing = false;
  try {
    rec.low = await addItem(low.id, rec);
    saveItem(rec);
    // Named only when made here: a name someone gave it stays.
    if (low.placeholder) { await exec("hc", ["kill", low.placeholder]); await renameSpace(m, low.id, LOW_NAME); }
    await log({ archived: rec });
    closing = true;
    if (meta.whole) run("space.close", { id: s.id, confirmed: true });
    else for (const c of chosen) run("tab.close", { id: c.tab, confirmed: true });
    await until(() => addrs.every((a) => termOf(a)?.state !== "live"), "its terminals ending");
  } catch (e) {
    // Nothing closed: undo the item, so the project isn't both running and archived.
    // Once a close is sent it can still land later (a slow machine): the item stays.
    if (!closing && addrs.every((a) => termOf(a)?.state === "live")) {
      if (rec.low && tabInfo(rec.low)) run("tab.close", { id: rec.low, confirmed: true });
      dropItem(rec.id);
    }
    throw e;
  }
  // Archived from elsewhere: back to what was shown. Archived what was shown: its item shows,
  // never the next project (closing a space shows its neighbour), so Cmd+S again restores it
  // instead of archiving that one.
  if (f && spaceOf(f.space) && !(meta.whole && f.space === s.id) && !chosen.some((c) => c.tab === f.tab)) { run("space.select", { id: f.space }); run("tab.select", { id: f.tab }); }
  else { run("space.select", { id: low.id }); run("tab.select", { id: rec.low }); }
  const claude = rec.tabs.flatMap((t) => t.terms).filter((t) => t.claude);
  const lost = claude.filter((t) => !t.session).length;
  return `${rec.title}: ${count(addrs.length, "terminal")} closed` + (claude.length ? `, ${count(claude.length - lost, "Claude conversation")} kept` : "")
    + (lost ? `; ${lost} without a conversation id will continue the folder's latest` : "");
}

export async function archive(spaceId) {
  const s = spaceOf(spaceId);
  if (!s || isLow(s.id)) return null;
  const color = (shared("space.colors") ?? {})[s.id] ?? "";
  const chosen = s.tabs.map((t, order) => ({ tab: t.id, addrs: tabTerminals(t.id), name: t.named ? t.name : "", order }));
  return archiveTabs(s, chosen, { space: local(s.id), name: s.name, named: s.named, color, whole: true, title: s.name });
}

// One tab; its space stays. The last tab of a space takes the space with it.
export async function archiveTab(tabId) {
  const s = spaces().find((x) => x.tabs.some((t) => t.id === tabId));
  if (!s || isLow(s.id)) return null;
  if (s.tabs.length === 1) return archive(s.id);
  const order = s.tabs.findIndex((t) => t.id === tabId), t = s.tabs[order];
  const color = (shared("space.colors") ?? {})[s.id] ?? "";
  return archiveTabs(s, [{ tab: t.id, addrs: tabTerminals(t.id), name: t.named ? t.name : "", order }],
    { space: local(s.id), name: s.name, named: s.named, color, whole: false, title: `${s.name} · ${t.named ? t.name : order + 1}` });
}

export async function restore(id) {
  const rec = items()[id];
  if (!rec) return null;
  const m = rec.machine;
  if (!ready(m)) throw new Error(`${m} isn't connected`);
  const spaceId = full(m, rec.space);
  // Whether its space was still open, decided by the first try: a retry finds the space it made.
  if (rec.existed === undefined) { rec.existed = Boolean(spaceOf(spaceId)); saveItem(rec); }
  const existed = rec.existed;
  const tabs = [...rec.tabs].sort((a, b) => a.order - b.order);
  await settle(m);
  for (const t of tabs) {
    for (const term of t.terms) {
      renew();
      // Started by a restore that stopped midway: not started twice.
      if (term.addr && termOf(term.addr)?.state === "live") continue;
      term.addr = await start(m, rec.space, t.tab, term);
      saveItem(rec);
      await until(() => panes().some((p) => p.terminal === term.addr && p.tab === full(m, t.tab)), `${term.addr} showing up`);
      await settle(m);
    }
  }
  const back = tabs.filter((t) => t.terms.length);
  // Names and order. Into a space that stayed open: only its own tab, at its old place.
  const index = (t, i) => (existed ? Math.min(t.order + 1, spaceOf(spaceId).tabs.length) : i + 1);
  const put = async () => {
    if (!existed) await renameSpace(m, spaceId, rec.name);
    for (const [i, t] of back.entries()) {
      await renameTab(m, full(m, t.tab), t.name);
      await placeTab(m, spaceId, full(m, t.tab), index(t, i));
    }
  };
  await put();
  // A reorder of named tabs changes no "where" label, so settle() can't see it saved:
  // look again after a while and put back whatever an older write undid.
  const right = () => (existed || spaceOf(spaceId)?.name === rec.name) && back.every((t, i) => {
    const id = full(m, t.tab), info = tabInfo(id);
    return spaceOf(spaceId)?.tabs.findIndex((x) => x.id === id) === index(t, i) - 1 && (t.name ? info?.name === t.name : !info?.named);
  });
  for (let i = 0; i < 3; i++) {
    await pause(m ? 1.5 : 0.5);
    await settle(m);
    if (right()) break;
    await put();
  }
  if (!right()) throw new Error("names or tab order didn't stick");
  if (!existed && rec.color) setShared("space.colors", { ...(shared("space.colors") ?? {}), [spaceId]: rec.color });
  dropItem(rec.id);
  await log({ restored: rec });
  if (rec.low && tabInfo(rec.low)) run("tab.close", { id: rec.low, confirmed: true });
  run("space.select", { id: spaceId });
  if (back[0]) run("tab.select", { id: full(m, back[0].tab) });
  const claude = rec.tabs.flatMap((t) => t.terms).filter((t) => t.claude).length;
  return `${rec.title} is back` + (claude ? `: ${count(claude, "Claude conversation")} resumed` : "");
}

// An item whose tab was closed (its menu's "Close (forget it)") is forgotten; the log keeps
// it. Only while nothing archives or restores and its machine's layout is loaded.
export function prune() {
  if (live() || !spaces().length) return;
  const all = items(), tabs = new Set(spaces().flatMap((x) => x.tabs.map((t) => t.id)));
  const gone = Object.values(all).filter((r) => r.low && ready(r.machine) && !tabs.has(r.low));
  if (!gone.length) return;
  const keep = { ...all };
  for (const r of gone) delete keep[r.id];
  setShared("archive.items", keep);
}

// Every item in a Low priority space, in its tab order.
export function itemsIn(lowId) {
  const all = Object.values(items());
  return (spaceOf(lowId)?.tabs ?? []).map((t) => all.find((r) => r.low === t.id)).filter(Boolean);
}

export async function restoreAll(lowId) {
  const done = [];
  for (const r of itemsIn(lowId)) done.push(await restore(r.id));
  return done.filter(Boolean).join("\n");
}

// Low priority as it was before: archived terminals kept running there. Each group (one
// project, or a tab moved there by hand) becomes an item and its terminals end.
export async function migrate(lowId) {
  const low = spaceOf(lowId);
  if (!low) return null;
  const m = low.machine ?? null;
  const groups = new Map();
  for (const t of low.tabs) {
    const addrs = tabTerminals(t.id);
    if (!addrs.length) continue;
    const l = termOf(addrs[0])?.labels ?? {};
    const key = l["herdr.archived.space"] || `sp${hex()}`;
    if (!groups.has(key)) groups.set(key, {
      space: key, name: l["herdr.archived.name"] || base(termOf(addrs[0])?.cwd), named: l["herdr.archived.named"] === "1",
      color: l["herdr.archived.color"] || "", tabs: [] });
    groups.get(key).tabs.push({ tab: t.id, addrs, name: l["herdr.archived.tab"] ?? "", order: Number(l["herdr.archived.order"] ?? groups.get(key).tabs.length) });
  }
  const done = [];
  for (const g of groups.values()) {
    renew();
    done.push(await archiveTabs(low, g.tabs, { space: g.space, name: g.name, named: g.named, color: g.color, whole: false, title: g.name }));
  }
  return done.join("\n");
}

// Moves one tab, its terminals still running, into another space on the same machine,
// keeping its name; then shows it there. Herdr has no command for it: each terminal is
// parked (no pane), then labelled into the other space, and Herdr adopts it there.
export async function moveTab(tabId, toId) {
  const from = spaces().find((x) => x.tabs.some((t) => t.id === tabId));
  const to = spaceOf(toId);
  if (!from || !to || from.id === to.id) return null;
  const m = from.machine ?? null;
  if ((to.machine ?? null) !== m) throw new Error("a tab can't move to another machine");
  const t = from.tabs.find((x) => x.id === tabId);
  const list = tabTerminals(tabId);
  if (!list.length) throw new Error("that tab has no terminal to move");
  const check = guard(list, [from.id, to.id]);
  await settle(m);
  for (const addr of list) {
    renew();
    if (hasPane(addr)) {
      run("terminal.park", { terminal: addr });
      check();
      await until(() => !hasPane(addr) && !termOf(addr)?.labels?.["herdr.space"], `parking ${addr}`);
    }
    const r = await exec("hc", ["label", addr, `herdr.space=${local(to.id)}`, `herdr.tab=${local(tabId)}`]);
    if (r.code !== 0) throw new Error(`hc label ${addr}: ${(r.stderr || r.stdout).trim()}`);
    await until(() => panes().some((p) => p.terminal === addr && p.tab === tabId) && spaceOf(to.id)?.tabs.some((x) => x.id === tabId), `${addr} showing up`);
    await settle(m);
    check();
  }
  await renameTab(m, tabId, t.named ? t.name : "");
  check();
  run("space.select", { id: to.id });
  run("tab.select", { id: tabId });
  return null;
}
