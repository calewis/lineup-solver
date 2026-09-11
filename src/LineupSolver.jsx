import { useState, useEffect, useMemo, useRef } from "react";
import highsLoader from "highs";
import highsWasmUrl from "highs/runtime?url";
import {
  ROLES, GAME_SIZES, DEFAULT_FORMATION, FORMATION_PRESETS, PERIOD_TYPES, timingOf,
  outfieldCount, formationLabel, slotsFor, slotName,
  buildModel, available, assignSlots, swapSlots, checkLineup,
} from "./model.js";

// ---------- Constants ----------
const ROLE_NAME = { D: "Defense", M: "Mid", F: "Forward", GK: "In goal", B: "Bench", O: "Out" };
const ROLE_PHRASE = { any: "on the field", D: "in defense", M: "in midfield", F: "at forward" };
const RULE_TEMPLATES = [
  { type: "between", label: "Balance", desc: "Between M and N of these players at a position (or on the field at all)." },
  { type: "atMost", label: "Cap", desc: "At most N of these players at a position (or on the field at all)." },
  { type: "atLeast", label: "Anchor", desc: "At least N of these players at a position (or on the field at all)." },
  { type: "notBoth", label: "Keep apart", desc: "Never two of these players together at a position." },
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

// First use starts empty: the coach adds players and constraints.
const DEFAULT_PLAYERS = [];
const DEFAULT_RULES = [];
const DEFAULT_SIZE = 9;
const DEFAULT_CFG = {
  gks: ["", ""], // goalie per period
  size: DEFAULT_SIZE, // players per side including the goalie
  formation: { ...DEFAULT_FORMATION[DEFAULT_SIZE] },
  periodType: "halves",
  periodMin: PERIOD_TYPES.halves.periodMin,
  segsPerPeriod: PERIOD_TYPES.halves.segsPerPeriod,
};
const newPlayer = (name) => ({ name, pref: "", pref2: "", never: [], out: null });

// ---------- Solver ----------
// HiGHS (mixed-integer programming) compiled to WebAssembly. Loaded once.
let highsPromise = null;
function getHighs() {
  if (!highsPromise) {
    highsPromise = highsLoader({ locateFile: () => highsWasmUrl }).catch((e) => {
      highsPromise = null; // let the next solve try the download again
      throw e;
    });
  }
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
// Normalise any saved cfg (including ones from earlier versions) into the
// current shape.
function normalizeCfg(c = {}) {
  const size = GAME_SIZES.includes(c.size) ? c.size : DEFAULT_SIZE;
  const f = c.formation || {};
  const formation = ROLES.every((r) => Number.isInteger(f[r]) && f[r] >= 0) ? { D: f.D, M: f.M, F: f.F } : { ...DEFAULT_FORMATION[size] };
  const periodType = PERIOD_TYPES[c.periodType] ? c.periodType : "halves";
  const def = PERIOD_TYPES[periodType];
  const tm = timingOf({ ...c, periodType });
  return {
    gks: tm.gks,
    size,
    formation,
    periodType,
    periodMin: Number.isFinite(c.periodMin) ? c.periodMin : def.periodMin,
    segsPerPeriod: Number.isInteger(c.segsPerPeriod) ? c.segsPerPeriod : def.segsPerPeriod,
  };
}
function loadSetup(d) {
  const players = (d.players || DEFAULT_PLAYERS).map((p) => ({
    name: p.name, pref: p.pref || "", pref2: p.pref2 || "", never: p.never || [], out: p.out ?? null,
  }));
  const cfg = normalizeCfg(d.cfg);
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

// Offer a JSON file for download. The link has to be in the document and the
// blob URL kept alive until the browser has started the download, or Safari
// and Firefox quietly drop it.
function downloadJSON(filename, value) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 1000);
}

// ---------- Derived views ----------
function minutesFor(result, players, cfg) {
  const tm = timingOf(cfg);
  const rows = {};
  for (const p of players) rows[p.name] = { min: 0, roles: {} };
  for (let t = 0; t < tm.T; t++) {
    const gk = tm.gkOf(t);
    const len = tm.lens[t % tm.S];
    if (rows[gk]) {
      rows[gk].min += len;
      rows[gk].roles["GK"] = (rows[gk].roles["GK"] || 0) + 1;
    }
    for (const [n, r] of Object.entries(result.plans[Math.floor(t / tm.S)][t % tm.S])) {
      if (!rows[n]) continue;
      rows[n].min += len;
      rows[n].roles[r] = (rows[n].roles[r] || 0) + 1;
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
function listWithAnd(items) {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

// ---------- UI ----------
export default function LineupSolver() {
  const [players, setPlayers] = useState(DEFAULT_PLAYERS);
  const [cfg, setCfg] = useState(DEFAULT_CFG);
  const [rules, setRules] = useState(DEFAULT_RULES);
  const [seed, setSeed] = useState(7);
  const [sol, setSol] = useState(null);
  const [tab, setTab] = useState("p0");
  const [note, setNote] = useState("");
  const [picker, setPicker] = useState(false);
  const [solving, setSolving] = useState(false);
  const [history, setHistory] = useState([]);
  const [commitOpen, setCommitOpen] = useState(false);
  const [commitLabel, setCommitLabel] = useState("");
  const [commitDate, setCommitDate] = useState(todayISO());
  const [openGame, setOpenGame] = useState(null);
  const [printGame, setPrintGame] = useState(null); // history entry id being printed
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [confirmSolve, setConfirmSolve] = useState(null); // seed waiting for the coach's OK
  const [newName, setNewName] = useState("");
  const [pick, setPick] = useState(null); // chip selected for a swap
  const [swapNote, setSwapNote] = useState(null); // minutes impact of the last manual swap
  const swapTimer = useRef(null);
  const importRef = useRef(null);
  const setupImportRef = useRef(null);

  const tm = useMemo(() => timingOf(cfg), [cfg]);
  const subsPhraseFor = (t) => (t.subTimes.length ? `subs at ${listWithAnd(t.subTimes)} each ${t.type === "halves" ? "half" : "quarter"}` : "no subs within a period");
  const subsPhrase = subsPhraseFor(tm);

  // Printing an old game: swap the print sheet to that game, print once it
  // has rendered, then switch back.
  useEffect(() => {
    if (printGame == null) return;
    const done = () => setPrintGame(null);
    window.addEventListener("afterprint", done);
    const id = setTimeout(() => window.print(), 50);
    return () => { clearTimeout(id); window.removeEventListener("afterprint", done); };
  }, [printGame]);

  const flash = (msg) => {
    setNote(msg);
    setTimeout(() => setNote(""), 2500);
  };

  // A solution remembers the exact inputs it was built from. If the game's
  // shape changes (segments, team size, formation) the solution can no
  // longer be drawn and disappears until the coach re-solves. Any other
  // change (availability, preferences, rules, goalies) leaves it on screen
  // as an out-of-date lineup the coach can keep hand-editing mid-game.
  const solveWith = async (p, c, r, s) => {
    setSolving(true);
    let out;
    try {
      out = await solve(p, c, r, s);
    } catch (e) {
      console.error("solver failed", e);
      out = { reason: "The solver hit an unexpected error." };
    }
    const slots = out.result ? assignSlots(out.result.plans, s, c.formation) : null;
    setSol({ result: out.result || null, slots, original: out.result ? { result: out.result, slots } : null, edited: false, reason: out.reason ?? null, players: p, cfg: c, rules: r });
    setPick(null);
    setSolving(false);
  };
  const run = (s = seed) => solveWith(players, cfg, rules, s);
  // Hand edits are precious on the sideline: ask before a solve replaces them.
  const askRun = (s = seed) => { if (edited) setConfirmSolve(s); else run(s); };
  const reshaped = !!sol && (() => {
    const was = timingOf(sol.cfg);
    return was.P !== tm.P || was.S !== tm.S || sol.cfg.size !== cfg.size ||
      ROLES.some((r) => (sol.cfg.formation || {})[r] !== (cfg.formation || {})[r]);
  })();
  const stale = !!sol && !reshaped && (sol.players !== players || sol.cfg !== cfg || sol.rules !== rules);
  const result = sol && !reshaped ? sol.result : null;
  const slots = sol && !reshaped ? sol.slots : null;
  const failReason = sol && !reshaped && !sol.result ? sol.reason : null;

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

  // Keep the active tab valid when the number of periods changes.
  useEffect(() => {
    if (tab.startsWith("p") && +tab.slice(1) >= tm.P) setTab("p0");
  }, [tm.P, tab]);

  const saveSetup = () => {
    flash(writeJSON(SETUP_KEY, { players, cfg, rules }) ? "Setup saved" : "Couldn't save on this device");
  };
  // Back to the defaults and forget the saved setup. History is untouched.
  const clearSetup = () => {
    setPlayers(DEFAULT_PLAYERS);
    setCfg(DEFAULT_CFG);
    setRules(DEFAULT_RULES);
    setSol(null);
    setPick(null);
    setConfirmClear(false);
    try { window.localStorage.removeItem(SETUP_KEY); } catch (e) { /* ignore */ }
    flash("Setup cleared");
  };
  const exportSetup = () => {
    const name = `greyhounds-setup-${todayISO()}.json`;
    downloadJSON(name, { players, cfg, rules });
    flash(`Downloading ${name}`);
  };
  const importSetup = (file) => {
    if (!file) return;
    file.text().then((text) => {
      try {
        const parsed = JSON.parse(text);
        if (!parsed || !Array.isArray(parsed.players)) throw new Error("bad");
        const d = loadSetup(parsed);
        setPlayers(d.players);
        setCfg(d.cfg);
        setRules(d.rules);
        flash(`Imported ${d.players.length} players`);
      } catch (e) {
        flash("That file isn't a setup export");
      }
    });
  };

  // ----- roster and game editing -----
  const addPlayer = (name) => {
    const n = name.trim();
    if (!n || players.some((p) => p.name === n)) return false;
    setPlayers([...players, newPlayer(n)]);
    return true;
  };
  const removePlayer = (i) => {
    const gone = players[i].name;
    setPlayers(players.filter((_, j) => j !== i));
    setRules(rules.map((r) => ({ ...r, players: r.players.filter((n) => n !== gone) })));
    setCfg({ ...cfg, gks: cfg.gks.map((g) => (g === gone ? "" : g)) });
  };
  const renamePlayer = (i, name) => {
    const old = players[i].name;
    if (players.some((p, j) => j !== i && p.name === name)) { flash(`Another player is already called ${name}`); return; }
    setPlayers(players.map((p, j) => (j === i ? { ...p, name } : p)));
    setRules(rules.map((r) => ({ ...r, players: r.players.map((n) => (n === old ? name : n)) })));
    setCfg({ ...cfg, gks: cfg.gks.map((g) => (g === old ? name : g)) });
  };
  const setPlayer = (i, patch) =>
    setPlayers(players.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const toggleNever = (i, role) => {
    const nv = players[i].never.includes(role)
      ? players[i].never.filter((r) => r !== role)
      : [...players[i].never, role];
    setPlayer(i, { never: nv });
  };
  const setOut = (i, v) => setPlayer(i, { out: v === "" ? null : v === "absent" ? "absent" : +v });
  const setGk = (i, name) => setCfg({ ...cfg, gks: cfg.gks.map((g, j) => (j === i ? name : g)) });
  const setSize = (size) => setCfg({ ...cfg, size, formation: { ...DEFAULT_FORMATION[size] } });
  const setFormation = (formation) => setCfg({ ...cfg, formation });
  const setPeriodType = (periodType) => {
    if (periodType === cfg.periodType) return;
    const def = PERIOD_TYPES[periodType];
    // Carry goalies across: halves -> quarters doubles them up, quarters -> halves keeps Q1 and Q3.
    const gks = periodType === "quarters" ? [cfg.gks[0], cfg.gks[0], cfg.gks[1], cfg.gks[1]] : [cfg.gks[0], cfg.gks[2]];
    setCfg({ ...cfg, periodType, periodMin: def.periodMin, segsPerPeriod: def.segsPerPeriod, gks });
  };
  const formationTotal = outfieldCount(cfg.formation);
  const formationOk = formationTotal === cfg.size - 1;

  const patchRule = (rid, patch) => setRules(rules.map((r) => (r.id === rid ? { ...r, ...patch } : r)));
  const toggleRulePlayer = (rid, name) => {
    const r = rules.find((x) => x.id === rid);
    patchRule(rid, {
      players: r.players.includes(name) ? r.players.filter((p) => p !== name) : [...r.players, name],
    });
  };
  const addRule = (type) => {
    setRules([...rules, { id: Date.now() + Math.random(), type, players: [], role: "any", n: type === "atMost" ? 2 : 1, lo: 1, hi: 3 }]);
    setPicker(false);
  };

  // Availability choices: the value is the first segment the player misses.
  const outOptions = useMemo(() => {
    const opts = [["", "Playing"], ["absent", "Absent"]];
    for (let t = 1; t < tm.T; t++) {
      const s = t % tm.S;
      opts.push([String(t), s === 0 ? `Leaves after ${tm.periodName(Math.floor(t / tm.S) - 1)}` : `Leaves ${tm.periodName(Math.floor(t / tm.S))} ${tm.starts[s]}:00`]);
    }
    return opts;
  }, [tm]);

  const mins = useMemo(() => (result ? minutesFor(result, players, cfg) : null), [result, players, cfg]);
  const edited = !!sol && !reshaped && sol.edited;
  // Check the lineup against the current setup after a hand edit, or after
  // the setup changed underneath it.
  const issues = useMemo(() => (result && (edited || stale) ? checkLineup(result.plans, players, cfg, rules) : []), [result, edited, stale, players, cfg, rules]);
  const hardIssues = issues.filter((i) => i.level === "hard");
  const noteIssues = issues.filter((i) => i.level === "note");
  const undoEdits = () => {
    if (!sol || !sol.original) return;
    setSol({ ...sol, result: sol.original.result, slots: sol.original.slots, edited: false });
    setPick(null);
  };

  // ----- history -----
  const saveHistory = (h) => {
    setHistory(h);
    const ok = writeJSON(HISTORY_KEY, h);
    if (!ok) flash("Couldn't save history on this device");
    return ok;
  };
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
    const ok = saveHistory([entry, ...history]);
    setCommitOpen(false);
    setCommitLabel("");
    if (ok) flash("Game added to history");
  };
  const deleteGame = (id) => {
    saveHistory(history.filter((g) => g.id !== id));
    setConfirmDelete(null);
  };
  const exportHistory = () => {
    const name = `greyhounds-history-${todayISO()}.json`;
    downloadJSON(name, history);
    flash(`Downloading ${name}`);
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
        const added = merged.length - history.length;
        if (saveHistory(merged)) flash(`Imported ${added} game${added === 1 ? "" : "s"}`);
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

  // ----- swaps -----
  const current = result ? { plans: result.plans, slots, cfg, players } : null;
  // Swap two players in one segment. Same row: swap sides, carried through
  // the period. Different rows or the bench: exchange roles and spots in this
  // segment only, then re-check the hard rules.
  const showSwapNote = (n) => {
    setSwapNote(n);
    clearTimeout(swapTimer.current);
    swapTimer.current = setTimeout(() => setSwapNote(null), 8000);
  };
  const doSwap = (h, s, a, b) => {
    if (!slots || a === b) return;
    const seg = current.plans[h][s];
    const ra = seg[a], rb = seg[b];
    if (ra === undefined && rb === undefined) { setPick(null); return; }
    const where = `${tm.segLabels[s]} of the ${tm.periodName(h)}`;
    if (ra !== undefined && ra === rb) {
      setSol({ ...sol, slots: swapSlots(slots, h, s, slots[h][s][a], slots[h][s][b]), edited: true });
      setPick(null);
      showSwapNote({
        title: `Swapped ${a} and ${b} sides from ${where} on`,
        lines: ["Same roles and minutes, just different spots on the field."],
        hardCount: checkLineup(result.plans, players, cfg, rules).filter((i) => i.level === "hard").length,
      });
      return;
    }
    const nseg = { ...seg };
    const nsl = { ...slots[h][s] };
    const sa = nsl[a], sb = nsl[b];
    if (rb !== undefined) { nseg[a] = rb; nsl[a] = sb; } else { delete nseg[a]; delete nsl[a]; }
    if (ra !== undefined) { nseg[b] = ra; nsl[b] = sa; } else { delete nseg[b]; delete nsl[b]; }
    const plans = result.plans.map((per, hh) => per.map((sg, ss) => (hh === h && ss === s ? nseg : sg)));
    const nslots = slots.map((per, hh) => per.map((sg, ss) => (hh === h && ss === s ? nsl : sg)));
    setSol({ ...sol, result: { ...result, plans }, slots: nslots, edited: true });
    setPick(null);
    // Tell the coach what the swap did to minutes and to the hard rules.
    const before = minutesFor(result, players, cfg);
    const after = minutesFor({ plans }, players, cfg);
    const hardCount = checkLineup(plans, players, cfg, rules).filter((i) => i.level === "hard").length;
    const line = (n) => (before[n].min === after[n].min
      ? `${n}: ${after[n].min} min (unchanged)`
      : `${n}: ${before[n].min} → ${after[n].min} min (${after[n].min > before[n].min ? "+" : ""}${after[n].min - before[n].min})`);
    showSwapNote({
      title: ra !== undefined && rb !== undefined ? `Swapped ${a} and ${b} in ${where}` : `${rb === undefined ? b : a} on for ${rb === undefined ? a : b} in ${where}`,
      lines: [line(a), line(b)],
      hardCount,
    });
  };

  // ----- boards -----
  // snap = { plans, slots, cfg, players } so history entries render the same way.
  const boardFor = (h, snap, compact = false, interactive = false) => {
    const st = timingOf(snap.cfg);
    const gk = st.gks[h];
    const grid = [];
    let anyOut = false;
    for (let s = 0; s < st.S; s++) {
      const t = h * st.S + s;
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
              {st.segLabels.map((l, s) => (
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
                      {col[row].sort().map((n) => {
                        const canEdit = interactive && row !== "GK" && row !== "O";
                        const selected = pick && pick.h === h && pick.s === s && pick.name === n;
                        const target = canEdit && pick && pick.h === h && pick.s === s && !selected;
                        const cls = `px-2 ${compact ? "py-px" : "py-0.5"} rounded-md border text-center ${TINT[row]} ${selected ? "ring-2 ring-amber-400" : target ? "ring-2 ring-emerald-500" : ""}`;
                        if (!canEdit) return <span key={n} className={cls}>{n}</span>;
                        return (
                          <button key={n} draggable
                            onClick={() => (target ? doSwap(h, s, pick.name, n) : setPick(selected ? null : { h, s, name: n }))}
                            onDragStart={(e) => { setPick({ h, s, name: n }); e.dataTransfer.effectAllowed = "move"; }}
                            onDragOver={(e) => { if (target) e.preventDefault(); }}
                            onDrop={(e) => { e.preventDefault(); if (pick) doSwap(h, s, pick.name, n); }}
                            title="Tap or drag onto another name in this column to swap them"
                            className={`${cls} cursor-grab active:cursor-grabbing w-full`}>{n}</button>
                        );
                      })}
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

  // Who just came on in this segment, and who they replaced. Arrivals are
  // the players here who were not in the previous segment of the same
  // period. Each is matched to a departed player by named spot first, then
  // by role, then whatever is left, so hand edits never leave one unmatched.
  // Returns { name: replacedName | null }; players not listed have been on
  // since the previous segment.
  const arrivalsFor = (h, s, snap) => {
    if (s === 0) return {};
    const seg = snap.plans[h][s], prev = snap.plans[h][s - 1];
    const sl = (snap.slots && snap.slots[h][s]) || {};
    const psl = (snap.slots && snap.slots[h][s - 1]) || {};
    const on = Object.keys(seg).filter((n) => prev[n] === undefined);
    const gone = new Set(Object.keys(prev).filter((n) => seg[n] === undefined));
    const forWhom = {};
    const take = (n, m) => { forWhom[n] = m; gone.delete(m); };
    for (const n of on) { const m = [...gone].find((m) => psl[m] === sl[n]); if (m) take(n, m); }
    for (const n of on) if (!forWhom[n]) { const m = [...gone].find((m) => prev[m] === seg[n]); if (m) take(n, m); }
    for (const n of on) if (!forWhom[n]) { const m = [...gone][0]; if (m) take(n, m); else forWhom[n] = null; }
    return forWhom;
  };
  // forWhom: undefined = on since the previous segment; a name = just came
  // on for that player; null = just came on with no one-to-one match.
  const chip = (name, slot, h, s, interactive, compact, forWhom) => {
    const selected = pick && pick.h === h && pick.s === s && pick.name === name;
    const sameSeg = pick && pick.h === h && pick.s === s && !selected;
    const arrived = forWhom !== undefined;
    const size = compact ? "text-[11px] px-1.5 py-0.5 min-w-[3.4rem]" : "text-sm px-2 py-1 min-w-[4.5rem]";
    // Just came on: yellow with a heavy dashed border, which still reads as
    // a tinted dashed box on a black-and-white printer.
    const tone = arrived ? "bg-yellow-200 border-[3px] border-dashed border-slate-900" : "bg-white border-2 border-slate-400";
    const Tag = interactive ? "button" : "div";
    return (
      <Tag key={slot} draggable={interactive || undefined}
        onClick={interactive ? () => (sameSeg ? doSwap(h, s, pick.name, name) : setPick(selected ? null : { h, s, name })) : undefined}
        onDragStart={interactive ? (e) => { setPick({ h, s, name }); e.dataTransfer.effectAllowed = "move"; } : undefined}
        onDragOver={interactive ? (e) => { if (sameSeg) e.preventDefault(); } : undefined}
        onDrop={interactive ? (e) => { e.preventDefault(); if (pick) doSwap(h, s, pick.name, name); } : undefined}
        title={interactive ? `${slotName(slot)} — tap or drag onto another player in this segment to swap` : slotName(slot)}
        className={`rounded-md text-slate-900 text-center leading-tight ${tone} ${size} ${interactive ? "cursor-grab active:cursor-grabbing" : ""} ${selected ? "ring-2 ring-amber-500 ring-offset-1" : sameSeg && interactive ? "ring-2 ring-emerald-500" : ""}`}>
        <span className="block font-bold">{name}</span>
        {arrived && <span className={`block font-medium text-slate-700 ${compact ? "text-[9px]" : "text-[11px]"}`}>{forWhom ? `for ${forWhom}` : "just on"}</span>}
      </Tag>
    );
  };
  // One segment as a picture of the field. The first segment of a period is
  // headed as a lineup; later ones as the sub that starts them.
  const fieldView = (h, s, snap, interactive = false, compact = false) => {
    const st = timingOf(snap.cfg);
    const seg = snap.plans[h][s];
    const sl = (snap.slots && snap.slots[h][s]) || {};
    const gk = st.gks[h];
    const t = h * st.S + s;
    const forWhom = arrivalsFor(h, s, snap);
    const bench = snap.players
      .filter((p) => seg[p.name] === undefined && p.name !== gk && available(p, t))
      .map((p) => p.name).sort();
    const formation = snap.cfg.formation || DEFAULT_FORMATION[DEFAULT_SIZE];
    const row = (r) => slotsFor(r, formation[r]).map((slot) => {
      const name = Object.keys(sl).find((n) => sl[n] === slot);
      return name ? chip(name, slot, h, s, interactive, compact, forWhom[name]) : <div key={slot} className="min-w-[3rem]" />;
    });
    const title = s === 0 ? (h === 0 ? "Starting lineup" : `${st.periodName(h)} lineup`) : `${st.starts[s]}m sub`;
    return (
      <div className={`rounded-xl bg-slate-200 text-slate-900 ${compact ? "p-1.5" : "p-2.5"}`}>
        <div className={`flex justify-between items-baseline ${compact ? "mb-1 print:mb-0.5" : "mb-1.5"}`}>
          <span className={`font-extrabold ${compact ? "text-xs" : "text-base"}`}>{title}</span>
          {s > 0 && <span className={`font-semibold text-slate-600 ${compact ? "text-[10px]" : "text-xs"}`}>{st.periodName(h)}</span>}
        </div>
        <div className={`rounded-lg border-2 border-slate-600 ${compact ? "p-1 space-y-1 print:space-y-0.5" : "p-2 space-y-2"}`}>
          {["F", "M", "D"].map((r) => (
            <div key={r} className={`flex justify-around items-stretch ${compact ? "gap-0.5" : "gap-1"}`}>{row(r)}</div>
          ))}
          <div className="flex justify-center">
            <div className={`rounded-md bg-white border-2 border-slate-900 outline-2 outline-white outline-offset-[-5px] text-center leading-tight ${compact ? "text-[11px] px-1.5 py-px min-w-[3.4rem]" : "text-sm px-2 py-0.5 min-w-[4.5rem]"}`}>
              <span className="block font-bold">{gk}</span>
              <span className={`block font-bold tracking-[0.12em] text-slate-500 ${compact ? "text-[8px]" : "text-[9px]"}`}>GK</span>
            </div>
          </div>
        </div>
        <div className={`${compact ? "text-[10px] mt-1 print:mt-0.5" : "text-xs mt-1.5"} flex flex-wrap items-center gap-1`}>
          <span className="text-slate-600">Bench:</span>
          {bench.length === 0 && "—"}
          {!interactive && <span>{bench.join(", ")}</span>}
          {interactive && bench.map((n) => {
            const selected = pick && pick.h === h && pick.s === s && pick.name === n;
            const target = pick && pick.h === h && pick.s === s && !selected;
            return (
              <button key={n} draggable
                onClick={() => (target ? doSwap(h, s, pick.name, n) : setPick(selected ? null : { h, s, name: n }))}
                onDragStart={(e) => { setPick({ h, s, name: n }); e.dataTransfer.effectAllowed = "move"; }}
                onDragOver={(e) => { if (target) e.preventDefault(); }}
                onDrop={(e) => { e.preventDefault(); if (pick) doSwap(h, s, pick.name, n); }}
                title="Tap or drag onto a player on the field to bring this player on in their place"
                className={`px-1.5 py-0.5 rounded border border-slate-400 bg-white cursor-grab ${selected ? "ring-2 ring-amber-500 ring-offset-1" : target ? "ring-2 ring-emerald-500" : ""}`}>{n}</button>
            );
          })}
        </div>
      </div>
    );
  };
  const allFields = (snap, interactive, compact) => {
    const st = timingOf(snap.cfg);
    const out = [];
    for (let h = 0; h < st.P; h++) for (let s = 0; s < st.S; s++) out.push(<div key={`${h}-${s}`} className="break-inside-avoid">{fieldView(h, s, snap, interactive, compact)}</div>);
    return out;
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

  // snap as for boardFor, plus minutes and an optional title for old games.
  const printSheet = (snap, minutes, title) => {
    const st = timingOf(snap.cfg);
    return (
      <div className="hidden print:block p-2 text-slate-900">
        <div className="flex items-baseline justify-between mb-2">
          <h1 className="text-xl font-extrabold text-emerald-950">Greyhounds lineup{title ? ` · ${title}` : ""}</h1>
          <span className="text-xs text-slate-500">{st.P} {st.type} of {st.L} min · {subsPhraseFor(st)}</span>
        </div>
        {Array.from({ length: st.P }, (_, h) => (
          <section key={h} className="mb-3">
            <h2 className="text-sm font-bold text-emerald-950 mb-1">{st.periodName(h)} · {st.gks[h]} in goal</h2>
            {boardFor(h, snap, true)}
          </section>
        ))}
        {minutes && (
          <p className="text-[10px] text-slate-500 leading-relaxed">
            <span className="font-semibold text-slate-600">Minutes: </span>
            {snap.players.filter((p) => p.out !== "absent" && minutes[p.name]).map((p) => `${p.name} ${minutes[p.name].min}`).join(" · ")}
          </p>
        )}
        {snap.slots && (
          <section className="break-before-page">
            <h2 className="text-sm font-bold text-emerald-950 mb-1">Field positions by segment</h2>
            <p className="text-[10px] text-slate-600 mb-2">Dashed box: just came on, for the player named underneath.</p>
            <div className="grid grid-cols-2 gap-x-2 gap-y-1">{allFields(snap, false, true)}</div>
          </section>
        )}
      </div>
    );
  };
  const printing = printGame != null ? history.find((g) => g.id === printGame) : null;

  const numInput = (r, min, max, field = "n") => (
    <input type="number" min={min} max={max} value={r[field]}
      onChange={(e) => patchRule(r.id, { [field]: +e.target.value })}
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
  const tabs = [
    ...Array.from({ length: tm.P }, (_, i) => [`p${i}`, tm.periodName(i)]),
    ["field", "Field"], ["minutes", "Minutes"], ["history", `History (${history.length})`],
  ];
  const lineupTab = tab !== "history";
  const periodTab = tab.startsWith("p") ? +tab.slice(1) : null;

  return (
    <div className="min-h-screen bg-stone-50 print:bg-white text-slate-900" style={{ fontFamily: "ui-sans-serif, system-ui" }}>
      {printing
        ? printSheet({ plans: printing.plans, slots: printing.slots, cfg: printing.cfg, players: printing.players }, printing.minutes, `${printing.label || "Game"} ${printing.date}`)
        : result && printSheet(current, mins)}
      {swapNote && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 max-w-md w-[calc(100%-2rem)] print:hidden">
          <div className={`rounded-xl border shadow-lg p-4 text-sm bg-white ${swapNote.hardCount ? "border-red-400" : "border-emerald-400"}`}>
            <div className="flex items-start justify-between gap-3">
              <p className="font-semibold text-slate-800">{swapNote.title}</p>
              <button onClick={() => setSwapNote(null)} className="text-slate-400 hover:text-slate-700" title="Dismiss">✕</button>
            </div>
            <ul className="mt-1.5 space-y-0.5 text-slate-700">
              {swapNote.lines.map((l) => <li key={l}>{l}</li>)}
            </ul>
            <p className={`mt-1.5 font-medium ${swapNote.hardCount ? "text-red-700" : "text-emerald-700"}`}>
              {swapNote.hardCount ? `Breaks ${swapNote.hardCount} hard rule${swapNote.hardCount === 1 ? "" : "s"} — see the list above the lineup.` : "All hard rules still hold."}
            </p>
          </div>
        </div>
      )}
      <div className="max-w-6xl mx-auto p-4 md:p-8 print:hidden">
        <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-3xl font-extrabold tracking-tight text-emerald-950">Greyhounds lineup solver</h1>
            <p className="text-slate-600 mt-1">
              {tm.P} {tm.type} of {tm.L} minutes, {subsPhrase}.
            </p>
            <div className="mt-2 inline-flex rounded-lg border border-slate-300 bg-white overflow-hidden text-sm">
              {GAME_SIZES.map((n) => (
                <button key={n} onClick={() => setSize(n)}
                  className={`px-3 py-1.5 font-semibold ${cfg.size === n ? "bg-emerald-900 text-white" : "text-slate-700 hover:bg-slate-100"}`}>{n}v{n}</button>
              ))}
              <span className="px-3 py-1.5 text-slate-500 border-l border-slate-200">{formationLabel(cfg.formation)} + GK</span>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 items-center">
            {note && <span className="text-sm text-emerald-700">{note}</span>}
            <button onClick={() => window.print()} disabled={!result} className={btn}>Print</button>
            <button onClick={() => setCommitOpen(!commitOpen)} disabled={!result} className={btn}>Commit to history</button>
            <button onClick={saveSetup} className={btn}>Save setup</button>
            {confirmClear ? (
              <span className="flex gap-1 items-center">
                <button onClick={clearSetup} className="px-3 py-2 rounded-lg bg-red-700 text-white font-medium hover:bg-red-800">Clear it</button>
                <button onClick={() => setConfirmClear(false)} className={btn}>Keep</button>
              </span>
            ) : (
              <button onClick={() => setConfirmClear(true)} className={btn} title="Reset players, goalies, game and constraints to the defaults and forget the saved setup">Clear setup</button>
            )}
            <button onClick={() => { const s = Math.floor(Math.random() * 1e6); setSeed(s); askRun(s); }} disabled={solving}
              className="px-3 py-2 rounded-lg border border-emerald-900 bg-white text-emerald-900 hover:bg-emerald-50 font-medium disabled:opacity-40">Shuffle</button>
            <button onClick={() => askRun(seed)} disabled={solving} className={primary}>{solveLabel}</button>
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
              {tabs.map(([key, label]) => (
                <button key={key} onClick={() => setTab(key)}
                  className={`px-4 py-2 rounded-lg font-semibold ${tab === key ? "bg-emerald-900 text-white" : "bg-white border border-slate-300 text-slate-700 hover:bg-slate-100"}`}>{label}</button>
              ))}
            </div>

            {lineupTab && (
              <>
                {confirmSolve !== null && (
                  <div className="bg-white border border-emerald-300 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
                    <p className="font-semibold text-emerald-950">Solving again will replace your hand-edited lineup.</p>
                    <span className="flex gap-2">
                      <button onClick={() => { const s = confirmSolve; setConfirmSolve(null); run(s); }} className={primary}>Replace it</button>
                      <button onClick={() => setConfirmSolve(null)} className={btn}>Keep my edits</button>
                    </span>
                  </div>
                )}
                {reshaped && (
                  <div className="bg-sky-50 border border-sky-300 rounded-xl p-4 text-sky-900 flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="font-semibold">Game format changed. Solve again for a new lineup.</p>
                    </div>
                    <button onClick={() => run(seed)} disabled={solving} className={primary}>{solveLabel}</button>
                  </div>
                )}
                {stale && result && (
                  <div className="bg-sky-50 border border-sky-300 rounded-xl p-4 text-sky-900 flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="font-semibold">Setup changed since this lineup was solved.</p>
                      <p className="text-sm mt-1">Keep using it, or solve again.</p>
                    </div>
                    <button onClick={() => askRun(seed)} disabled={solving} className={primary}>{solveLabel}</button>
                  </div>
                )}
                {!sol && !solving && (
                  <div className="bg-white border border-slate-200 rounded-xl p-6 text-center text-slate-600">
                    <p className="font-semibold text-slate-800 mb-3">No lineup yet.</p>
                    <button onClick={() => run(seed)} className={primary}>Solve</button>
                  </div>
                )}
                {solving && !result && <p className="text-slate-500">Solving…</p>}
                {failReason !== null && (
                  <div className="bg-amber-50 border border-amber-300 rounded-xl p-4 text-amber-900">
                    <p className="font-semibold">No lineup satisfies this setup.</p>
                    <p className="text-sm mt-1">
                      {failReason || "Loosen a constraint and solve again."}
                    </p>
                  </div>
                )}
                {result && (edited || hardIssues.length > 0) && (
                  <div className={`rounded-xl border p-4 ${hardIssues.length ? "bg-red-50 border-red-300 text-red-900" : "bg-emerald-50 border-emerald-300 text-emerald-900"}`}>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <p className="font-semibold">
                        {hardIssues.length
                          ? `${edited ? "Hand-edited lineup" : "This lineup"} breaks ${hardIssues.length} hard rule${hardIssues.length === 1 ? "" : "s"}.`
                          : "Hand-edited lineup. All hard rules still hold."}
                      </p>
                      {edited && <button onClick={undoEdits} className={btn}>Undo edits</button>}
                    </div>
                    {hardIssues.length > 0 && (
                      <ul className="list-disc ml-5 mt-2 text-sm space-y-0.5">
                        {hardIssues.map((i, k) => <li key={k}>{i.text}</li>)}
                      </ul>
                    )}
                    {noteIssues.length > 0 && (
                      <ul className="list-disc ml-5 mt-2 text-sm space-y-0.5 text-amber-900">
                        {noteIssues.map((i, k) => <li key={k}>{i.text}</li>)}
                      </ul>
                    )}
                  </div>
                )}
                {result && (
                  <>
                    <div className="bg-white rounded-xl border border-slate-200 p-4">
                      {periodTab !== null && (
                        <>
                          {boardFor(periodTab, current, false, true)}
                        </>
                      )}
                      {tab === "field" && (
                        <>
                          <div className="grid sm:grid-cols-2 gap-3">{allFields(current, true, false)}</div>
                        </>
                      )}
                      {tab === "minutes" && mins && minutesTable(mins, players)}
                    </div>
                  </>
                )}
              </>
            )}

            {tab === "history" && (
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
                    <p className="text-sm text-slate-500">No games yet.</p>
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

                {history.map((g) => {
                  const gt = timingOf(g.cfg);
                  const snap = { plans: g.plans, slots: g.slots, cfg: g.cfg, players: g.players };
                  return (
                    <div key={g.id} className="bg-white rounded-xl border border-slate-200 p-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <button onClick={() => setOpenGame(openGame === g.id ? null : g.id)} className="text-left">
                          <span className="font-bold text-emerald-950">{g.label || "Game"}</span>
                          <span className="text-slate-500 text-sm ml-2">{g.date}</span>
                          <span className="block text-xs text-slate-500">
                            {g.cfg.size ? `${g.cfg.size}v${g.cfg.size} ${formationLabel(g.cfg.formation)} · ` : ""}
                            {gt.P} {gt.type} · in goal: {gt.gks.join(", ")}
                            {g.players.some((p) => p.out) && ` · out: ${g.players.filter((p) => p.out).map((p) => p.name).join(", ")}`}
                          </span>
                        </button>
                        <div className="flex gap-2 items-center text-sm">
                          <button onClick={() => setOpenGame(openGame === g.id ? null : g.id)} className={`${btn} py-1`}>
                            {openGame === g.id ? "Hide" : "Show"}
                          </button>
                          <button onClick={() => setPrintGame(g.id)} className={`${btn} py-1`} title="Print this game's schedule">Print</button>
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
                          {Array.from({ length: gt.P }, (_, h) => (
                            <div key={h}>
                              <p className="text-sm font-semibold text-slate-600 mb-1">{gt.periodName(h)}</p>
                              {boardFor(h, snap, true)}
                            </div>
                          ))}
                          {g.slots && <div className="grid sm:grid-cols-2 gap-2">{allFields(snap, false, true)}</div>}
                          {minutesTable(g.minutes || {}, g.players)}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* ---------- Setup ---------- */}
          <div className="space-y-5">
            <section className="bg-white rounded-xl border border-slate-200 p-4">
              <div className="flex items-center justify-between mb-1">
                <h2 className="font-bold text-emerald-950">Players</h2>
                <div className="flex gap-1">
                  <button onClick={exportSetup} disabled={players.length === 0} className={`${btn} text-xs py-1 px-2`} title="Download players, goalies, game settings and constraints as a file to share with another coach">Export</button>
                  <button onClick={() => setupImportRef.current?.click()} className={`${btn} text-xs py-1 px-2`}>Import</button>
                  <input ref={setupImportRef} type="file" accept="application/json" className="hidden"
                    onChange={(e) => { importSetup(e.target.files?.[0]); e.target.value = ""; }} />
                </div>
              </div>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-slate-500">
                    <th className="text-left py-1">Name</th><th>1st</th><th>2nd</th><th>Never</th><th>Status</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {players.length === 0 && (
                    <tr><td colSpan={6} className="py-3 text-center text-slate-400">No players yet.</td></tr>
                  )}
                  {players.map((p, i) => (
                    <tr key={i} className={`border-t border-slate-100 ${p.out ? "text-slate-400" : ""}`}>
                      <td className="py-1 font-medium">
                        <input value={p.name} onChange={(e) => renamePlayer(i, e.target.value)}
                          className="w-20 bg-transparent border-b border-transparent hover:border-slate-300 focus:border-emerald-700 focus:outline-none px-0.5" />
                      </td>
                      {["pref", "pref2"].map((k) => (
                        <td key={k} className="text-center">
                          <select value={p[k]} onChange={(e) => setPlayer(i, { [k]: e.target.value })}
                            className="border border-slate-200 rounded px-0.5 bg-white">
                            <option value="">–</option>
                            {ROLES.filter((r) => !p.never.includes(r) && r !== p[k === "pref" ? "pref2" : "pref"]).map((r) => <option key={r} value={r}>{r}</option>)}
                            {p[k] && (p.never.includes(p[k]) || p[k] === p[k === "pref" ? "pref2" : "pref"]) && <option value={p[k]}>{p[k]}</option>}
                          </select>
                        </td>
                      ))}
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
                          {outOptions.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                        </select>
                      </td>
                      <td className="text-center">
                        <button onClick={() => removePlayer(i)} className="text-slate-300 hover:text-red-600 px-1" title="Remove player">✕</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <form className="mt-2 flex gap-1" onSubmit={(e) => { e.preventDefault(); if (addPlayer(newName)) setNewName(""); }}>
                <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Add a player"
                  className="flex-1 border border-slate-300 rounded-md px-2 py-1 text-sm bg-white" />
                <button type="submit" disabled={!newName.trim() || players.some((p) => p.name === newName.trim())}
                  className="px-3 py-1 rounded-md bg-emerald-900 text-white text-sm font-medium hover:bg-emerald-800 disabled:opacity-40">Add</button>
              </form>
              <p className="text-[11px] text-slate-400 mt-1">{players.length} players</p>
            </section>

            <section className="bg-white rounded-xl border border-slate-200 p-4">
              <h2 className="font-bold text-emerald-950 mb-1">Game clock</h2>
              <div className="inline-flex rounded-lg border border-slate-300 bg-white overflow-hidden text-sm mb-3">
                {Object.keys(PERIOD_TYPES).map((k) => (
                  <button key={k} onClick={() => setPeriodType(k)}
                    className={`px-3 py-1.5 font-semibold capitalize ${cfg.periodType === k ? "bg-emerald-900 text-white" : "text-slate-700 hover:bg-slate-100"}`}>{k}</button>
                ))}
              </div>
              <div className="space-y-2 text-sm">
                <label className="flex items-center justify-between gap-2">
                  <span>Minutes per {tm.type === "halves" ? "half" : "quarter"}</span>
                  <input type="number" min={1} max={60} value={cfg.periodMin}
                    onChange={(e) => setCfg({ ...cfg, periodMin: Math.max(1, +e.target.value || 0) })}
                    className="w-16 border border-slate-300 rounded px-1 py-0.5" />
                </label>
                <label className="flex items-center justify-between gap-2">
                  <span>Segments per {tm.type === "halves" ? "half" : "quarter"}</span>
                  <input type="number" min={1} max={8} value={cfg.segsPerPeriod}
                    onChange={(e) => setCfg({ ...cfg, segsPerPeriod: Math.max(1, Math.min(8, +e.target.value || 1)) })}
                    className="w-16 border border-slate-300 rounded px-1 py-0.5" />
                </label>
                <p className="text-xs text-slate-500">
                  {tm.T} segments of {[...new Set(tm.lens)].join(" or ")} min. {tm.subTimes.length ? `Subs at ${listWithAnd(tm.subTimes)} each ${tm.type === "halves" ? "half" : "quarter"}.` : "No subs within a period."}
                </p>
              </div>
            </section>

            <section className="bg-white rounded-xl border border-slate-200 p-4">
              <h2 className="font-bold text-emerald-950 mb-1">Formation</h2>
              <div className="flex flex-wrap gap-1 mb-2">
                {FORMATION_PRESETS[cfg.size].map(([D, M, F]) => {
                  const on = cfg.formation.D === D && cfg.formation.M === M && cfg.formation.F === F;
                  return (
                    <button key={`${D}${M}${F}`} onClick={() => setFormation({ D, M, F })}
                      className={`px-2 py-1 rounded-md border text-sm font-semibold ${on ? "bg-emerald-900 text-white border-emerald-900" : "bg-white text-slate-700 border-slate-300 hover:bg-slate-100"}`}>{D}-{M}-{F}</button>
                  );
                })}
              </div>
              <div className="flex items-center gap-2 text-sm">
                {ROLES.map((r) => (
                  <label key={r} className="flex items-center gap-1">
                    <span className="text-slate-500">{ROLE_NAME[r]}</span>
                    <input type="number" min={0} max={6} value={cfg.formation[r]}
                      onChange={(e) => setFormation({ ...cfg.formation, [r]: Math.max(0, +e.target.value || 0) })}
                      className="w-12 border border-slate-300 rounded px-1 py-0.5" />
                  </label>
                ))}
              </div>
              {!formationOk && (
                <p className="text-xs text-red-700 mt-2">That adds up to {formationTotal}; {cfg.size}v{cfg.size} needs {cfg.size - 1} on the field plus the goalie.</p>
              )}
            </section>

            <section className="bg-white rounded-xl border border-slate-200 p-4">
              <h2 className="font-bold text-emerald-950 mb-3">Goalies</h2>
              <div className="space-y-2 text-sm">
                {cfg.gks.map((g, i) => (
                  <label key={i} className="flex items-center justify-between gap-2">
                    <span>{tm.periodName(i)} in goal</span>
                    <select value={g} onChange={(e) => setGk(i, e.target.value)}
                      className={`border rounded-md px-2 py-1 bg-white ${g ? "border-slate-300" : "border-red-300"}`}>
                      <option value="">Pick a goalie</option>
                      {players.map((p) => <option key={p.name} value={p.name}>{p.name}{p.out ? " (out)" : ""}</option>)}
                    </select>
                  </label>
                ))}
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
                </div>
              )}

              <div className="space-y-3 text-sm">
                {rules.length === 0 && (
                  <p className="text-slate-400 text-sm">No constraints.</p>
                )}
                {rules.map((r) => (
                  <div key={r.id} className="border border-slate-200 rounded-lg p-2.5 bg-stone-50">
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="font-medium">
                        {r.type === "between" && <>Between {numInput(r, 0, 11, "lo")} and {numInput(r, 0, 11, "hi")} of these {roleSelect(r)}</>}
                        {r.type === "atMost" && <>At most {numInput(r, 0, 11)} of these {roleSelect(r)}</>}
                        {r.type === "atLeast" && <>At least {numInput(r, 1, 11)} of these {roleSelect(r)}</>}
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
