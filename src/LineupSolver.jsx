import { useState, useEffect, useMemo, useRef } from "react";
import highsLoader from "highs";
import highsWasmUrl from "highs/runtime?url";
import { SEGS, SEG_LEN, ROLES, SLOTS, buildModel, available, assignSlots, swapSlots } from "./model.js";

// ---------- Constants ----------
const SEG_LABEL = ["0–6", "6–12", "12–18", "18–25"];
const SLOT_NAME = { LF: "Left forward", RF: "Right forward", LM: "Left mid", CM: "Center mid", RM: "Right mid", LB: "Left back", CB: "Center back", RB: "Right back" };
const ROLE_NAME = { D: "Defense", M: "Mid", F: "Forward", GK: "In goal", B: "Bench", O: "Out" };
const ROLE_PHRASE = { any: "on the field", D: "in defense", M: "in midfield", F: "at forward" };
const RULE_TEMPLATES = [
  { type: "atMost", label: "Cap", desc: "At most N of these players at a position (or on the field at all)." },
  { type: "atLeast", label: "Anchor", desc: "At least N of these players at a position (or on the field at all)." },
  { type: "notBoth", label: "Keep apart", desc: "Never two of these players together at a position." },
];
// Availability choices. The value is the first segment the player misses.
const OUT_OPTIONS = [
  ["", "Playing"], ["absent", "Absent"],
  ["1", "Leaves 6:00"], ["2", "Leaves 12:00"], ["3", "Leaves 18:00"], ["4", "Leaves at halftime"],
  ["5", "Leaves 31:00"], ["6", "Leaves 37:00"], ["7", "Leaves 43:00"],
];
const TINT = {
  D: "bg-blue-100 border-blue-200 text-slate-800",
  M: "bg-green-100 border-green-200 text-slate-800",
  F: "bg-amber-100 border-amber-200 text-slate-800",
  GK: "bg-slate-800 border-slate-800 text-white",
  B: "bg-transparent border-slate-200 text-slate-400",
  O: "bg-transparent border-transparent text-slate-300 line-through",
};
const SETUP_KEY = "greyhounds-setup";
const HISTORY_KEY = "greyhounds-history";

const DEFAULT_PLAYERS = [
  { name: "Michael", pref: "", never: ["D"] },
  { name: "Ethan", pref: "", never: ["D", "F"] },
  { name: "Drew", pref: "F", never: [] },
  { name: "Isaac", pref: "F", never: [] },
  { name: "Khalid", pref: "D", never: [] },
  { name: "Theodore", pref: "D", never: ["F"] },
  { name: "Ryan", pref: "D", never: [] },
  { name: "Neil", pref: "D", never: [] },
  { name: "Bobby", pref: "M", never: [] },
  { name: "Piers", pref: "M", never: [] },
  { name: "Arran", pref: "F", never: [] },
  { name: "Adam", pref: "", never: ["D"] },
  { name: "Lev", pref: "", never: [] },
  { name: "William", pref: "", never: [] },
].map((p) => ({ ...p, out: null }));

const DEFAULT_RULES = [
  { id: 1, type: "atLeast", players: ["Drew", "Isaac", "Khalid", "Theodore"], role: "any", n: 1 },
  { id: 2, type: "atMost", players: ["Drew", "Isaac", "Khalid", "Theodore"], role: "any", n: 3 },
  { id: 3, type: "atMost", players: ["Adam", "William", "Lev"], role: "M", n: 2 },
  { id: 4, type: "atLeast", players: ["Ryan", "Theodore", "Khalid"], role: "D", n: 1 },
  { id: 5, type: "notBoth", players: ["Lev", "Adam"], role: "D", n: 1 },
];

const DEFAULT_CFG = {
  gk1: "Ethan", // goalie, first half
  gk2: "Michael", // goalie, second half
  goalieFieldSegs: 2, // field segments each goalie gets in their off half
};

// ---------- Solver ----------
// HiGHS (mixed-integer programming) compiled to WebAssembly. Loaded once.
let highsPromise = null;
function getHighs() {
  if (!highsPromise) highsPromise = highsLoader({ locateFile: () => highsWasmUrl });
  return highsPromise;
}

// Returns { result } or { reason } when no lineup satisfies the setup.
async function solve(players, cfg, rules, seed) {
  const model = buildModel(players, cfg, rules, seed);
  if (model.reason) return { reason: model.reason };
  const highs = await getHighs();
  const res = highs.solve(model.lp);
  if (res.Status !== "Optimal") return { reason: "" };
  return { result: model.decode(res.Columns) };
}

// ---------- Persistence ----------
function loadSetup(d) {
  const players = (d.players || DEFAULT_PLAYERS).map((p) => ({
    name: p.name, pref: p.pref || "", never: p.never || [], out: p.out ?? null,
  }));
  const c = d.cfg || {};
  const cfg = {
    gk1: c.gk1 ?? DEFAULT_CFG.gk1,
    gk2: c.gk2 ?? DEFAULT_CFG.gk2,
    goalieFieldSegs: DEFAULT_CFG.goalieFieldSegs,
  };
  const rules = (d.rules || DEFAULT_RULES).map((r) => ({ ...r, role: r.role || "any" }));
  return { players, cfg, rules };
}
function readJSON(key) {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}
function writeJSON(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    return false;
  }
}

// ---------- Derived views ----------
function minutesFor(result, players, cfg) {
  const rows = {};
  for (const p of players) rows[p.name] = { min: 0, roles: {} };
  for (let h = 0; h < 2; h++) {
    const gk = h === 0 ? cfg.gk1 : cfg.gk2;
    for (let s = 0; s < SEGS; s++) {
      if (rows[gk]) {
        rows[gk].min += SEG_LEN[s];
        rows[gk].roles["GK"] = (rows[gk].roles["GK"] || 0) + 1;
      }
      for (const [n, r] of Object.entries(result.plans[h][s])) {
        if (!rows[n]) continue;
        rows[n].min += SEG_LEN[s];
        rows[n].roles[r] = (rows[n].roles[r] || 0) + 1;
      }
    }
  }
  return rows;
}
function rolesText(roles) {
  return Object.entries(roles).map(([k, v]) => `${v} ${ROLE_NAME[k].toLowerCase()}`).join(", ");
}
function todayISO() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

// ---------- UI ----------
export default function LineupSolver() {
  const [players, setPlayers] = useState(DEFAULT_PLAYERS);
  const [cfg, setCfg] = useState(DEFAULT_CFG);
  const [rules, setRules] = useState(DEFAULT_RULES);
  const [seed, setSeed] = useState(7);
  const [sol, setSol] = useState(null);
  const [tab, setTab] = useState(0);
  const [note, setNote] = useState("");
  const [picker, setPicker] = useState(false);
  const [solving, setSolving] = useState(false);
  const [history, setHistory] = useState([]);
  const [commitOpen, setCommitOpen] = useState(false);
  const [commitLabel, setCommitLabel] = useState("");
  const [commitDate, setCommitDate] = useState(todayISO());
  const [openGame, setOpenGame] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [pick, setPick] = useState(null); // chip selected for a position swap
  const importRef = useRef(null);

  const flash = (msg) => {
    setNote(msg);
    setTimeout(() => setNote(""), 2500);
  };

  // A solution remembers the exact inputs it was built from. If any of them
  // change, the solution is stale and disappears until the coach re-solves.
  const solveWith = async (p, c, r, s) => {
    setSolving(true);
    let out;
    try {
      out = await solve(p, c, r, s);
    } catch (e) {
      console.error("solver failed", e);
      out = { reason: "The solver hit an unexpected error." };
    }
    const slots = out.result ? assignSlots(out.result.plans, s) : null;
    setSol({ result: out.result || null, slots, reason: out.reason ?? null, players: p, cfg: c, rules: r });
    setPick(null);
    setSolving(false);
  };
  const run = (s = seed) => solveWith(players, cfg, rules, s);
  const stale = !!sol && (sol.players !== players || sol.cfg !== cfg || sol.rules !== rules);
  const result = sol && !stale ? sol.result : null;
  const slots = sol && !stale ? sol.slots : null;
  const failReason = sol && !stale && !sol.result ? sol.reason : null;

  // Restore a saved setup and history. Only a saved setup gets solved on load;
  // otherwise the coach starts from a blank slate and presses Solve.
  useEffect(() => {
    const saved = readJSON(SETUP_KEY);
    if (saved) {
      const d = loadSetup(saved);
      setPlayers(d.players);
      setCfg(d.cfg);
      setRules(d.rules);
      solveWith(d.players, d.cfg, d.rules, seed);
    }
    const h = readJSON(HISTORY_KEY);
    if (Array.isArray(h)) setHistory(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveSetup = () => {
    flash(writeJSON(SETUP_KEY, { players, cfg, rules }) ? "Setup saved" : "Couldn't save on this device");
  };
  const saveHistory = (h) => {
    setHistory(h);
    if (!writeJSON(HISTORY_KEY, h)) flash("Couldn't save history on this device");
  };

  const mins = useMemo(() => (result ? minutesFor(result, players, cfg) : null), [result, players, cfg]);

  // ----- history -----
  const commitGame = () => {
    if (!result) return;
    const entry = {
      id: Date.now(),
      date: commitDate || todayISO(),
      label: commitLabel.trim(),
      cfg: { ...cfg },
      players: players.map((p) => ({ ...p })),
      plans: result.plans,
      slots,
      minutes: mins,
    };
    saveHistory([entry, ...history]);
    setCommitOpen(false);
    setCommitLabel("");
    flash("Game added to history");
  };
  const deleteGame = (id) => {
    saveHistory(history.filter((g) => g.id !== id));
    setConfirmDelete(null);
  };
  const exportHistory = () => {
    const blob = new Blob([JSON.stringify(history, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `greyhounds-history-${todayISO()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const importHistory = (file) => {
    if (!file) return;
    file.text().then((text) => {
      try {
        const incoming = JSON.parse(text);
        if (!Array.isArray(incoming)) throw new Error("not a list");
        const seen = new Set(history.map((g) => g.id));
        const merged = [...history, ...incoming.filter((g) => g && g.id && !seen.has(g.id))]
          .sort((a, b) => (b.date || "").localeCompare(a.date || "") || b.id - a.id);
        saveHistory(merged);
        flash(`Imported ${merged.length - history.length} game${merged.length - history.length === 1 ? "" : "s"}`);
      } catch (e) {
        flash("That file isn't a history export");
      }
    });
  };
  const totals = useMemo(() => {
    const t = {};
    for (const g of history) {
      for (const [n, r] of Object.entries(g.minutes || {})) {
        if (!t[n]) t[n] = { games: 0, min: 0, roles: {} };
        if (r.min > 0) t[n].games++;
        t[n].min += r.min;
        for (const [k, v] of Object.entries(r.roles)) t[n].roles[k] = (t[n].roles[k] || 0) + v;
      }
    }
    return t;
  }, [history]);

  // ----- setup editing -----
  const setPlayer = (i, patch) =>
    setPlayers(players.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const toggleNever = (i, role) => {
    const nv = players[i].never.includes(role)
      ? players[i].never.filter((r) => r !== role)
      : [...players[i].never, role];
    setPlayer(i, { never: nv });
  };
  const setOut = (i, v) => setPlayer(i, { out: v === "" ? null : v === "absent" ? "absent" : +v });
  const patchRule = (rid, patch) => setRules(rules.map((r) => (r.id === rid ? { ...r, ...patch } : r)));
  const toggleRulePlayer = (rid, name) => {
    const r = rules.find((x) => x.id === rid);
    patchRule(rid, {
      players: r.players.includes(name) ? r.players.filter((p) => p !== name) : [...r.players, name],
    });
  };
  const addRule = (type) => {
    setRules([...rules, { id: Date.now() + Math.random(), type, players: [], role: "any", n: type === "atMost" ? 2 : 1 }]);
    setPicker(false);
  };
  const restoreDefaults = () => {
    setRules(DEFAULT_RULES);
    setPicker(false);
  };

  // ----- boards -----
  // snap = { plans, cfg, players } so history entries render the same way.
  const halfBoard = (h, snap, compact = false) => {
    const gk = h === 0 ? snap.cfg.gk1 : snap.cfg.gk2;
    const grid = [];
    let anyOut = false;
    for (let s = 0; s < SEGS; s++) {
      const t = h * SEGS + s;
      const col = { GK: [gk], D: [], M: [], F: [], B: [], O: [] };
      for (const [n, r] of Object.entries(snap.plans[h][s])) col[r].push(n);
      for (const p of snap.players) {
        const onField = snap.plans[h][s][p.name] !== undefined || p.name === gk;
        if (onField) continue;
        if (available(p, t)) col.B.push(p.name);
        else { col.O.push(p.name); anyOut = true; }
      }
      grid.push(col);
    }
    const rows = ["GK", "D", "M", "F", "B", ...(anyOut ? ["O"] : [])];
    const pad = compact ? "p-1" : "p-2";
    return (
      <div className="overflow-x-auto">
        <table className={`w-full border-collapse ${compact ? "text-xs" : "text-sm"}`}>
          <thead>
            <tr>
              <th className={`text-left ${pad} text-slate-500 font-medium w-20`}></th>
              {SEG_LABEL.map((l, s) => (
                <th key={s} className={`${pad} text-slate-600 font-semibold border-b-2 border-slate-300`}>{l}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row} className="align-top">
                <td className={`${pad} font-semibold text-slate-600`}>{ROLE_NAME[row]}</td>
                {grid.map((col, s) => (
                  <td key={s} className={`${compact ? "p-1" : "p-1.5"} border-l border-slate-200`}>
                    <div className={`flex flex-col ${compact ? "gap-0.5" : "gap-1"}`}>
                      {col[row].sort().map((n) => (
                        <span key={n} className={`px-2 ${compact ? "py-px" : "py-0.5"} rounded-md border text-center ${TINT[row]}`}>{n}</span>
                      ))}
                    </div>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };
  const current = result ? { plans: result.plans, slots, cfg, players } : null;

  // ----- field view with named positions -----
  const doSwap = (h, s, a, b) => {
    if (!slots || a === b) return;
    const seg = current.plans[h][s];
    if (seg[a] !== seg[b]) return; // only within a role
    setSol({ ...sol, slots: swapSlots(slots, h, s, slots[h][s][a], slots[h][s][b]) });
    setPick(null);
  };
  const chip = (name, slot, h, s, interactive, compact) => {
    const selected = pick && pick.h === h && pick.s === s && pick.name === name;
    const sameRow = pick && pick.h === h && pick.s === s && current.plans[h][s][pick.name] === current.plans[h][s][name];
    const size = compact ? "text-[9px] px-1 py-px min-w-[3.2rem]" : "text-xs px-2 py-1 min-w-[4.5rem]";
    const Tag = interactive ? "button" : "div";
    return (
      <Tag key={slot} draggable={interactive || undefined}
        onClick={interactive ? () => (pick ? (sameRow ? doSwap(h, s, pick.name, name) : setPick({ h, s, name })) : setPick({ h, s, name })) : undefined}
        onDragStart={interactive ? (e) => { setPick({ h, s, name }); e.dataTransfer.effectAllowed = "move"; } : undefined}
        onDragOver={interactive ? (e) => { if (sameRow) e.preventDefault(); } : undefined}
        onDrop={interactive ? (e) => { e.preventDefault(); if (pick) doSwap(h, s, pick.name, name); } : undefined}
        title={interactive ? `${SLOT_NAME[slot]} — tap or drag onto a teammate in the same row to swap` : SLOT_NAME[slot]}
        className={`rounded-md bg-white text-slate-900 text-center leading-tight shadow-sm ${size} ${interactive ? "cursor-grab active:cursor-grabbing" : ""} ${selected ? "ring-2 ring-amber-400" : sameRow && interactive ? "ring-2 ring-white/70" : ""}`}>
        <span className="block font-semibold">{name}</span>
        <span className="block text-slate-500">{slot}</span>
      </Tag>
    );
  };
  const fieldView = (h, s, snap, interactive = false, compact = false) => {
    const seg = snap.plans[h][s];
    const sl = (snap.slots && snap.slots[h][s]) || {};
    const gk = h === 0 ? snap.cfg.gk1 : snap.cfg.gk2;
    const t = h * SEGS + s;
    const bench = snap.players
      .filter((p) => seg[p.name] === undefined && p.name !== gk && available(p, t))
      .map((p) => p.name).sort();
    const row = (r) => SLOTS[r].map((slot) => {
      const name = Object.keys(sl).find((n) => sl[n] === slot);
      return name ? chip(name, slot, h, s, interactive, compact) : <div key={slot} className="min-w-[3rem]" />;
    });
    return (
      <div className={`rounded-xl bg-emerald-700 text-white ${compact ? "p-1.5" : "p-2.5"}`}>
        <div className={`flex justify-between font-semibold ${compact ? "text-[10px] mb-1" : "text-xs mb-1.5"}`}>
          <span>{h === 0 ? "1st half" : "2nd half"} · {SEG_LABEL[s]}</span>
          <span className="opacity-80">{gk} in goal</span>
        </div>
        <div className={`rounded-lg border-2 border-white/60 ${compact ? "p-1 space-y-1" : "p-2 space-y-2"}`}>
          {["F", "M", "D"].map((r) => (
            <div key={r} className={`flex justify-around ${compact ? "gap-0.5" : "gap-1"}`}>{row(r)}</div>
          ))}
          <div className="flex justify-center">
            <div className={`rounded-md bg-slate-900 text-white text-center ${compact ? "text-[9px] px-1 py-px min-w-[3.2rem]" : "text-xs px-2 py-1 min-w-[4.5rem]"}`}>
              <span className="block font-semibold">{gk}</span>
              <span className="block text-slate-400">GK</span>
            </div>
          </div>
        </div>
        <div className={`${compact ? "text-[9px] mt-1" : "text-[11px] mt-1.5"} opacity-90`}>Bench: {bench.join(", ") || "—"}</div>
      </div>
    );
  };

  const minutesTable = (rows, ps) => (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-slate-500 border-b-2 border-slate-300">
          <th className="text-left p-2">Player</th>
          <th className="p-2">Minutes</th>
          <th className="text-left p-2">Positions</th>
        </tr>
      </thead>
      <tbody>
        {ps.map((p) => {
          const r = rows[p.name] || { min: 0, roles: {} };
          const out = p.out === "absent";
          return (
            <tr key={p.name} className={`border-t border-slate-100 ${out ? "text-slate-400" : ""}`}>
              <td className="p-2 font-medium">{p.name}</td>
              <td className="p-2 text-center font-semibold">{r.min}</td>
              <td className="p-2 text-slate-600">{out ? "absent" : rolesText(r.roles)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );

  const printSheet = () => (
    <div className="hidden print:block p-2 text-slate-900">
      <div className="flex items-baseline justify-between mb-2">
        <h1 className="text-xl font-extrabold text-emerald-950">Greyhounds lineup</h1>
        <span className="text-xs text-slate-500">Subs at 6:00, 12:00 and 18:00 each half</span>
      </div>
      {[0, 1].map((h) => (
        <section key={h} className="mb-3">
          <h2 className="text-sm font-bold text-emerald-950 mb-1">
            {h === 0 ? "First half" : "Second half"} · {h === 0 ? cfg.gk1 : cfg.gk2} in goal
          </h2>
          {halfBoard(h, current, true)}
        </section>
      ))}
      {mins && (
        <p className="text-[10px] text-slate-500 leading-relaxed">
          <span className="font-semibold text-slate-600">Minutes: </span>
          {players.filter((p) => p.out !== "absent").map((p) => `${p.name} ${mins[p.name].min}`).join(" · ")}
        </p>
      )}
      <section className="break-before-page">
        <h2 className="text-sm font-bold text-emerald-950 mb-2">Field positions by segment</h2>
        <div className="grid grid-cols-2 gap-2">
          {[0, 1].map((h) => [0, 1, 2, 3].map((s) => (
            <div key={`${h}-${s}`}>{fieldView(h, s, current, false, true)}</div>
          )))}
        </div>
      </section>
    </div>
  );

  const numInput = (r, min, max) => (
    <input type="number" min={min} max={max} value={r.n}
      onChange={(e) => patchRule(r.id, { n: +e.target.value })}
      className="w-12 border border-slate-300 rounded px-1 mx-1" />
  );
  const roleSelect = (r) => (
    <select value={r.role} onChange={(e) => patchRule(r.id, { role: e.target.value })}
      className="border border-slate-300 rounded px-1 mx-1 bg-white">
      {Object.keys(ROLE_PHRASE).map((x) => <option key={x} value={x}>{ROLE_PHRASE[x]}</option>)}
    </select>
  );
  const btn = "px-3 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-100 font-medium disabled:opacity-40 disabled:hover:bg-white";
  const primary = "px-4 py-2 rounded-lg bg-emerald-900 text-white font-semibold hover:bg-emerald-800 disabled:opacity-60";
  const solveLabel = solving ? "Solving…" : "Solve";

  return (
    <div className="min-h-screen bg-stone-50 print:bg-white text-slate-900" style={{ fontFamily: "ui-sans-serif, system-ui" }}>
      {result && printSheet()}
      <div className="max-w-6xl mx-auto p-4 md:p-8 print:hidden">
        <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-3xl font-extrabold tracking-tight text-emerald-950">Greyhounds lineup solver</h1>
            <p className="text-slate-600 mt-1">Eight segments, subs at 6:00, 12:00 and 18:00. Change any constraint and re-solve.</p>
          </div>
          <div className="flex flex-wrap gap-2 items-center">
            {note && <span className="text-sm text-emerald-700">{note}</span>}
            <button onClick={() => window.print()} disabled={!result} className={btn}>Print</button>
            <button onClick={() => setCommitOpen(!commitOpen)} disabled={!result} className={btn}>Commit to history</button>
            <button onClick={saveSetup} className={btn}>Save setup</button>
            <button onClick={() => { const s = Math.floor(Math.random() * 1e6); setSeed(s); run(s); }} disabled={solving}
              className="px-3 py-2 rounded-lg border border-emerald-900 bg-white text-emerald-900 hover:bg-emerald-50 font-medium disabled:opacity-40">Shuffle</button>
            <button onClick={() => run(seed)} disabled={solving} className={primary}>{solveLabel}</button>
          </div>
        </header>

        <div className="grid lg:grid-cols-[1fr_380px] gap-6">
          {/* ---------- Results ---------- */}
          <div className="space-y-4">
            {commitOpen && result && (
              <div className="bg-white border border-emerald-300 rounded-xl p-4 flex flex-wrap items-end gap-3">
                <label className="text-sm">
                  <span className="block text-slate-500 mb-1">Opponent or note</span>
                  <input value={commitLabel} onChange={(e) => setCommitLabel(e.target.value)} placeholder="vs. Tigers"
                    className="border border-slate-300 rounded-md px-2 py-1 bg-white w-48" />
                </label>
                <label className="text-sm">
                  <span className="block text-slate-500 mb-1">Date</span>
                  <input type="date" value={commitDate} onChange={(e) => setCommitDate(e.target.value)}
                    className="border border-slate-300 rounded-md px-2 py-1 bg-white" />
                </label>
                <button onClick={commitGame} className={primary}>Commit this lineup</button>
                <button onClick={() => setCommitOpen(false)} className={btn}>Cancel</button>
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              {["First half", "Second half", "Field", "Minutes", `History (${history.length})`].map((t, i) => (
                <button key={t} onClick={() => setTab(i)}
                  className={`px-4 py-2 rounded-lg font-semibold ${tab === i ? "bg-emerald-900 text-white" : "bg-white border border-slate-300 text-slate-700 hover:bg-slate-100"}`}>{t}</button>
              ))}
            </div>

            {tab < 4 && (
              <>
                {stale && (
                  <div className="bg-sky-50 border border-sky-300 rounded-xl p-4 text-sky-900 flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="font-semibold">Setup changed.</p>
                      <p className="text-sm mt-1">The previous lineup no longer matches your setup. Solve again to build a new one.</p>
                    </div>
                    <button onClick={() => run(seed)} disabled={solving} className={primary}>{solveLabel}</button>
                  </div>
                )}
                {!sol && !solving && (
                  <div className="bg-white border border-slate-200 rounded-xl p-6 text-center text-slate-600">
                    <p className="font-semibold text-slate-800">No lineup yet.</p>
                    <p className="text-sm mt-1 mb-3">Mark anyone who's out, check the goalies, then solve.</p>
                    <button onClick={() => run(seed)} className={primary}>Solve</button>
                  </div>
                )}
                {solving && !result && <p className="text-slate-500">Solving…</p>}
                {failReason !== null && (
                  <div className="bg-amber-50 border border-amber-300 rounded-xl p-4 text-amber-900">
                    <p className="font-semibold">No lineup satisfies this setup.</p>
                    <p className="text-sm mt-1">
                      {failReason || "Loosen something and solve again — the usual culprits are an anchor with too few eligible players, a cap that's too tight, or too many Never restrictions on the same position."}
                    </p>
                  </div>
                )}
                {result && (
                  <>
                    <div className="bg-white rounded-xl border border-slate-200 p-4">
                      {tab < 2 && (
                        <>
                          <p className="text-sm text-slate-500 mb-3">
                            {tab === 0 ? cfg.gk1 : cfg.gk2} is in goal. Reading down a column shows the whole field for that stretch; every change between columns is a straight bench swap.
                          </p>
                          {halfBoard(tab, current)}
                        </>
                      )}
                      {tab === 2 && (
                        <>
                          <p className="text-sm text-slate-500 mb-3">
                            Positions within a line are assigned at random. Tap a player, then a teammate in the same row, to swap them; the swap carries forward through the rest of that half. No re-solve needed.
                          </p>
                          <div className="grid sm:grid-cols-2 gap-3">
                            {[0, 1].map((h) => [0, 1, 2, 3].map((s) => (
                              <div key={`${h}-${s}`}>{fieldView(h, s, current, true)}</div>
                            )))}
                          </div>
                        </>
                      )}
                      {tab === 3 && mins && minutesTable(mins, players)}
                    </div>
                    <p className="text-xs text-slate-500">
                      Built in: playing time is shared evenly among everyone who's here, nobody sits twice in a row (including across halftime), goalies get a full half in net plus their field segments, and players keep their position while they stay on the field. Positions follow each player's preference wherever the constraints allow. Shuffle explores different equally good schedules.
                    </p>
                  </>
                )}
              </>
            )}

            {tab === 4 && (
              <div className="space-y-4">
                <div className="bg-white rounded-xl border border-slate-200 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                    <h2 className="font-bold text-emerald-950">Season totals</h2>
                    <div className="flex gap-2">
                      <button onClick={exportHistory} disabled={history.length === 0} className={`${btn} text-sm py-1`}>Export</button>
                      <button onClick={() => importRef.current?.click()} className={`${btn} text-sm py-1`}>Import</button>
                      <input ref={importRef} type="file" accept="application/json" className="hidden"
                        onChange={(e) => { importHistory(e.target.files?.[0]); e.target.value = ""; }} />
                    </div>
                  </div>
                  {history.length === 0 ? (
                    <p className="text-sm text-slate-500">No games yet. Solve a lineup, then use “Commit to history” to record it. History lives in this browser; export it to share with another coach.</p>
                  ) : (
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-slate-500 border-b-2 border-slate-300">
                          <th className="text-left p-2">Player</th>
                          <th className="p-2">Games</th>
                          <th className="p-2">Minutes</th>
                          <th className="p-2">Avg</th>
                          <th className="text-left p-2">Positions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {Object.entries(totals).sort((a, b) => b[1].min - a[1].min).map(([n, r]) => (
                          <tr key={n} className="border-t border-slate-100">
                            <td className="p-2 font-medium">{n}</td>
                            <td className="p-2 text-center">{r.games}</td>
                            <td className="p-2 text-center font-semibold">{r.min}</td>
                            <td className="p-2 text-center text-slate-600">{r.games ? Math.round(r.min / r.games) : 0}</td>
                            <td className="p-2 text-slate-600">{rolesText(r.roles)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>

                {history.map((g) => (
                  <div key={g.id} className="bg-white rounded-xl border border-slate-200 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <button onClick={() => setOpenGame(openGame === g.id ? null : g.id)} className="text-left">
                        <span className="font-bold text-emerald-950">{g.label || "Game"}</span>
                        <span className="text-slate-500 text-sm ml-2">{g.date}</span>
                        <span className="block text-xs text-slate-500">
                          {g.cfg.gk1} then {g.cfg.gk2} in goal
                          {g.players.some((p) => p.out) && ` · out: ${g.players.filter((p) => p.out).map((p) => p.name).join(", ")}`}
                        </span>
                      </button>
                      <div className="flex gap-2 items-center text-sm">
                        <button onClick={() => setOpenGame(openGame === g.id ? null : g.id)} className={`${btn} py-1`}>
                          {openGame === g.id ? "Hide" : "Show"}
                        </button>
                        {confirmDelete === g.id ? (
                          <>
                            <button onClick={() => deleteGame(g.id)} className="px-3 py-1 rounded-lg bg-red-700 text-white font-medium">Delete</button>
                            <button onClick={() => setConfirmDelete(null)} className={`${btn} py-1`}>Keep</button>
                          </>
                        ) : (
                          <button onClick={() => setConfirmDelete(g.id)} className="text-slate-400 hover:text-red-600 px-1" title="Delete game">✕</button>
                        )}
                      </div>
                    </div>
                    {openGame === g.id && (
                      <div className="mt-3 space-y-4">
                        {[0, 1].map((h) => (
                          <div key={h}>
                            <p className="text-sm font-semibold text-slate-600 mb-1">{h === 0 ? "First half" : "Second half"}</p>
                            {halfBoard(h, { plans: g.plans, cfg: g.cfg, players: g.players }, true)}
                          </div>
                        ))}
                        {g.slots && (
                          <div className="grid sm:grid-cols-2 gap-2">
                            {[0, 1].map((h) => [0, 1, 2, 3].map((s) => (
                              <div key={`${h}-${s}`}>{fieldView(h, s, { plans: g.plans, slots: g.slots, cfg: g.cfg, players: g.players }, false, true)}</div>
                            )))}
                          </div>
                        )}
                        {minutesTable(g.minutes || {}, g.players)}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ---------- Setup ---------- */}
          <div className="space-y-5">
            <section className="bg-white rounded-xl border border-slate-200 p-4">
              <h2 className="font-bold text-emerald-950 mb-1">Players</h2>
              <p className="text-xs text-slate-500 mb-2">Pref nudges the solver toward a position; Never is a hard rule. Mark anyone absent or leaving early.</p>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-slate-500">
                    <th className="text-left py-1">Name</th><th>Pref</th><th>Never</th><th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {players.map((p, i) => (
                    <tr key={i} className={`border-t border-slate-100 ${p.out ? "text-slate-400" : ""}`}>
                      <td className="py-1 font-medium">{p.name}</td>
                      <td className="text-center">
                        <select value={p.pref} onChange={(e) => setPlayer(i, { pref: e.target.value })}
                          className="border border-slate-200 rounded px-1 bg-white">
                          <option value="">–</option>
                          {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                        </select>
                      </td>
                      <td className="text-center">
                        <div className="flex gap-0.5 justify-center">
                          {ROLES.map((r) => (
                            <button key={r} onClick={() => toggleNever(i, r)}
                              className={`w-6 h-5 rounded border text-[10px] ${p.never.includes(r) ? "bg-red-700 text-white border-red-700" : "bg-white text-slate-400 border-slate-200"}`}>{r}</button>
                          ))}
                        </div>
                      </td>
                      <td className="text-center">
                        <select value={p.out == null ? "" : String(p.out)} onChange={(e) => setOut(i, e.target.value)}
                          className={`border rounded px-1 bg-white max-w-[7.5rem] ${p.out ? "border-red-300 text-red-700" : "border-slate-200"}`}>
                          {OUT_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            <section className="bg-white rounded-xl border border-slate-200 p-4">
              <h2 className="font-bold text-emerald-950 mb-3">Goalies</h2>
              <div className="space-y-2 text-sm">
                {["gk1", "gk2"].map((k, i) => (
                  <label key={k} className="flex items-center justify-between gap-2">
                    <span>{i === 0 ? "First half in goal" : "Second half in goal"}</span>
                    <select value={cfg[k]} onChange={(e) => setCfg({ ...cfg, [k]: e.target.value })}
                      className="border border-slate-300 rounded-md px-2 py-1 bg-white">
                      {players.map((p) => <option key={p.name} value={p.name}>{p.name}{p.out ? " (out)" : ""}</option>)}
                    </select>
                  </label>
                ))}
                <p className="text-xs text-slate-500">Each goalie also gets two field segments in their other half.</p>
              </div>
            </section>

            <section className="bg-white rounded-xl border border-slate-200 p-4">
              <div className="flex items-center justify-between mb-1">
                <h2 className="font-bold text-emerald-950">Constraints</h2>
                <button onClick={() => setPicker(!picker)}
                  className="text-sm px-3 py-1 rounded-md bg-emerald-900 text-white font-medium hover:bg-emerald-800">
                  {picker ? "Close" : "+ Add"}
                </button>
              </div>
              <p className="text-xs text-slate-500 mb-3">Applied to every segment. Tap names to include or exclude them.</p>

              {picker && (
                <div className="mb-3 border border-emerald-200 bg-emerald-50 rounded-lg p-2.5 space-y-2 text-sm">
                  <p className="text-xs font-semibold text-emerald-900 uppercase tracking-wide">Choose a constraint</p>
                  {RULE_TEMPLATES.map((t) => (
                    <button key={t.type} onClick={() => addRule(t.type)}
                      className="w-full text-left rounded-md border border-slate-200 bg-white hover:bg-emerald-100 px-2.5 py-2">
                      <span className="font-semibold">{t.label}</span>
                      <span className="block text-xs text-slate-500">{t.desc}</span>
                    </button>
                  ))}
                  <button onClick={restoreDefaults}
                    className="w-full text-left rounded-md border border-slate-200 bg-white hover:bg-emerald-100 px-2.5 py-2">
                    <span className="font-semibold">Restore the Greyhounds defaults</span>
                    <span className="block text-xs text-slate-500">Replace the current list with the standard set of constraints.</span>
                  </button>
                </div>
              )}

              <div className="space-y-3 text-sm">
                {rules.length === 0 && (
                  <p className="text-slate-400 text-sm">No constraints. Any valid rotation goes.</p>
                )}
                {rules.map((r) => (
                  <div key={r.id} className="border border-slate-200 rounded-lg p-2.5 bg-stone-50">
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="font-medium">
                        {r.type === "atMost" && <>At most {numInput(r, 0, 8)} of these {roleSelect(r)}</>}
                        {r.type === "atLeast" && <>At least {numInput(r, 1, 8)} of these {roleSelect(r)}</>}
                        {r.type === "notBoth" && <>Never two of these together {roleSelect(r)}</>}
                      </span>
                      <button onClick={() => setRules(rules.filter((x) => x.id !== r.id))}
                        className="text-slate-400 hover:text-red-600 px-1" title="Remove">✕</button>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {players.map((p) => (
                        <button key={p.name} onClick={() => toggleRulePlayer(r.id, p.name)}
                          className={`px-1.5 py-0.5 rounded text-xs border ${r.players.includes(p.name) ? "bg-emerald-900 text-white border-emerald-900" : "bg-white text-slate-500 border-slate-300"}`}>
                          {p.name}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
