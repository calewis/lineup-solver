import { useState, useEffect, useMemo } from "react";
import highsLoader from "highs";
import highsWasmUrl from "highs/runtime?url";
import { SEGS, SEG_LEN, ROLES, buildModel } from "./model.js";

// ---------- Constants ----------
const SEG_LABEL = ["0–6", "6–12", "12–18", "18–25"];
const ROLE_NAME = { D: "Defense", M: "Mid", F: "Forward", GK: "In goal", B: "Bench" };
const ROLE_PHRASE = { any: "on the field", D: "in defense", M: "in midfield", F: "at forward" };
const RULE_TEMPLATES = [
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
};

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
];

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

// Returns { plans, score } or null when no lineup satisfies the constraints.
async function solve(players, cfg, rules, seed) {
  const highs = await getHighs();
  const { lp, decode } = buildModel(players, cfg, rules, seed);
  const res = highs.solve(lp);
  if (res.Status !== "Optimal") return null;
  return decode(res.Columns);
}

// ---------- Setup persistence ----------
function loadSetup(d) {
  const players = (d.players || DEFAULT_PLAYERS).map((p) => ({
    name: p.name, pref: p.pref || "", never: p.never || [],
  }));
  const c = d.cfg || {};
  const cfg = {
    gk1: c.gk1 ?? DEFAULT_CFG.gk1,
    gk2: c.gk2 ?? DEFAULT_CFG.gk2,
    goalieFieldSegs: c.goalieFieldSegs ?? DEFAULT_CFG.goalieFieldSegs,
  };
  const rules = (d.rules || DEFAULT_RULES).map((r) => ({ ...r, role: r.role || "any" }));
  return { players, cfg, rules };
}

// ---------- Derived views ----------
function minutesFor(sol, players, cfg) {
  const rows = {};
  for (const p of players) rows[p.name] = { min: 0, roles: {} };
  for (let h = 0; h < 2; h++) {
    const gk = h === 0 ? cfg.gk1 : cfg.gk2;
    for (let s = 0; s < SEGS; s++) {
      rows[gk].min += SEG_LEN[s];
      rows[gk].roles["GK"] = (rows[gk].roles["GK"] || 0) + 1;
      for (const [n, r] of Object.entries(sol.plans[h][s])) {
        rows[n].min += SEG_LEN[s];
        rows[n].roles[r] = (rows[n].roles[r] || 0) + 1;
      }
    }
  }
  return rows;
}

// ---------- UI ----------
export default function LineupSolver() {
  const [players, setPlayers] = useState(DEFAULT_PLAYERS);
  const [cfg, setCfg] = useState(DEFAULT_CFG);
  const [rules, setRules] = useState(DEFAULT_RULES);
  const [seed, setSeed] = useState(7);
  const [sol, setSol] = useState(null);
  const [failed, setFailed] = useState(false);
  const [tab, setTab] = useState(0);
  const [savedNote, setSavedNote] = useState("");
  const [picker, setPicker] = useState(false);
  const [solving, setSolving] = useState(false);

  // A solution remembers the exact inputs it was built from. If any of them
  // change, the solution is stale and disappears until the coach re-solves.
  const solveWith = async (p, c, r, s) => {
    setSolving(true);
    let result = null;
    try {
      result = await solve(p, c, r, s);
    } catch (e) {
      console.error("solver failed", e);
    }
    setSol({ result, players: p, cfg: c, rules: r });
    setFailed(!result);
    setSolving(false);
  };
  const run = (s = seed) => solveWith(players, cfg, rules, s);
  const stale = !!sol && (sol.players !== players || sol.cfg !== cfg || sol.rules !== rules);
  const result = sol && !stale ? sol.result : null;

  useEffect(() => {
    let d = { players: DEFAULT_PLAYERS, cfg: DEFAULT_CFG, rules: DEFAULT_RULES };
    try {
      const saved = window.localStorage.getItem("greyhounds-setup");
      if (saved) {
        d = loadSetup(JSON.parse(saved));
        setPlayers(d.players);
        setCfg(d.cfg);
        setRules(d.rules);
      }
    } catch (e) { /* no saved setup yet */ }
    solveWith(d.players, d.cfg, d.rules, seed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveSetup = () => {
    try {
      window.localStorage.setItem("greyhounds-setup", JSON.stringify({ players, cfg, rules }));
      setSavedNote("Setup saved");
    } catch (e) {
      setSavedNote("Couldn't save on this device");
    }
    setTimeout(() => setSavedNote(""), 2500);
  };

  const mins = useMemo(() => (result ? minutesFor(result, players, cfg) : null), [result, players, cfg]);

  const setPlayer = (i, patch) =>
    setPlayers(players.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const toggleNever = (i, role) => {
    const nv = players[i].never.includes(role)
      ? players[i].never.filter((r) => r !== role)
      : [...players[i].never, role];
    setPlayer(i, { never: nv });
  };
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

  const halfBoard = (h, compact = false) => {
    const gk = h === 0 ? cfg.gk1 : cfg.gk2;
    const grid = [];
    for (let s = 0; s < SEGS; s++) {
      const col = { GK: [gk], D: [], M: [], F: [], B: [] };
      for (const [n, r] of Object.entries(result.plans[h][s])) col[r].push(n);
      for (const p of players) {
        const onField = result.plans[h][s][p.name] !== undefined || p.name === gk;
        if (!onField) col.B.push(p.name);
      }
      grid.push(col);
    }
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
            {["GK", "D", "M", "F", "B"].map((row) => (
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
          {halfBoard(h, true)}
        </section>
      ))}
      {mins && (
        <p className="text-[10px] text-slate-500 leading-relaxed">
          <span className="font-semibold text-slate-600">Minutes: </span>
          {players.map((p) => `${p.name} ${mins[p.name].min}`).join(" · ")}
        </p>
      )}
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

  return (
    <div className="min-h-screen bg-stone-50 print:bg-white text-slate-900" style={{ fontFamily: "ui-sans-serif, system-ui" }}>
      {result && printSheet()}
      <div className="max-w-6xl mx-auto p-4 md:p-8 print:hidden">
        <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-3xl font-extrabold tracking-tight text-emerald-950">Greyhounds lineup solver</h1>
            <p className="text-slate-600 mt-1">Eight segments, subs at 6:00, 12:00 and 18:00. Change any constraint and re-solve.</p>
          </div>
          <div className="flex gap-2 items-center">
            {savedNote && <span className="text-sm text-emerald-700">{savedNote}</span>}
            <button onClick={() => window.print()} disabled={!result}
              className="px-3 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-100 font-medium disabled:opacity-40 disabled:hover:bg-white">Print</button>
            <button onClick={saveSetup} className="px-3 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-100 font-medium">Save setup</button>
            <button onClick={() => { const s = Math.floor(Math.random() * 1e6); setSeed(s); run(s); }} disabled={solving}
              className="px-3 py-2 rounded-lg border border-emerald-900 bg-white text-emerald-900 hover:bg-emerald-50 font-medium disabled:opacity-40">Shuffle</button>
            <button onClick={() => run(seed)} disabled={solving}
              className="px-4 py-2 rounded-lg bg-emerald-900 text-white font-semibold hover:bg-emerald-800 disabled:opacity-60">{solving ? "Solving…" : "Solve"}</button>
          </div>
        </header>

        <div className="grid lg:grid-cols-[1fr_380px] gap-6">
          {/* ---------- Results ---------- */}
          <div className="space-y-4">
            {stale && (
              <div className="bg-sky-50 border border-sky-300 rounded-xl p-4 text-sky-900 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="font-semibold">Setup changed.</p>
                  <p className="text-sm mt-1">The previous lineup no longer matches your constraints. Solve again to build a new one.</p>
                </div>
                <button onClick={() => run(seed)} disabled={solving}
                  className="px-4 py-2 rounded-lg bg-emerald-900 text-white font-semibold hover:bg-emerald-800 disabled:opacity-60">{solving ? "Solving…" : "Solve"}</button>
              </div>
            )}
            {solving && !sol && (
              <p className="text-slate-500">Solving…</p>
            )}
            {failed && !stale && (
              <div className="bg-amber-50 border border-amber-300 rounded-xl p-4 text-amber-900">
                <p className="font-semibold">No schedule satisfies all of these constraints together.</p>
                <p className="text-sm mt-1">Loosen something and solve again — the usual culprits are an anchor with too few eligible players, a cap that's too tight, or too many Never restrictions on the same position.</p>
              </div>
            )}
            {result && (
              <>
                <div className="flex gap-2">
                  {["First half", "Second half", "Minutes"].map((t, i) => (
                    <button key={t} onClick={() => setTab(i)}
                      className={`px-4 py-2 rounded-lg font-semibold ${tab === i ? "bg-emerald-900 text-white" : "bg-white border border-slate-300 text-slate-700 hover:bg-slate-100"}`}>{t}</button>
                  ))}
                </div>
                <div className="bg-white rounded-xl border border-slate-200 p-4">
                  {tab < 2 && (
                    <>
                      <p className="text-sm text-slate-500 mb-3">
                        {tab === 0 ? cfg.gk1 : cfg.gk2} is in goal. Reading down a column shows the whole field for that stretch; every change between columns is a straight bench swap.
                      </p>
                      {halfBoard(tab)}
                    </>
                  )}
                  {tab === 2 && mins && (
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-slate-500 border-b-2 border-slate-300">
                          <th className="text-left p-2">Player</th>
                          <th className="p-2">Minutes</th>
                          <th className="text-left p-2">Positions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {players.map((p) => {
                          const r = mins[p.name];
                          const parts = Object.entries(r.roles)
                            .map(([k, v]) => `${v} ${ROLE_NAME[k].toLowerCase()}`).join(", ");
                          return (
                            <tr key={p.name} className="border-t border-slate-100">
                              <td className="p-2 font-medium">{p.name}</td>
                              <td className="p-2 text-center font-semibold">{r.min}</td>
                              <td className="p-2 text-slate-600">{parts}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </div>
                <p className="text-xs text-slate-500">
                  Built in: everyone plays at least 5 of 8 segments, goalies get a full half in net plus their field segments, nobody sits twice in a row (including across halftime), and players keep their position while they stay on the field. Positions follow each player's preference wherever the constraints allow. Shuffle explores different equally good schedules.
                </p>
              </>
            )}
          </div>

          {/* ---------- Constraints ---------- */}
          <div className="space-y-5">
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

            <section className="bg-white rounded-xl border border-slate-200 p-4">
              <h2 className="font-bold text-emerald-950 mb-3">Goalies</h2>
              <div className="space-y-2 text-sm">
                {["gk1", "gk2"].map((k, i) => (
                  <label key={k} className="flex items-center justify-between gap-2">
                    <span>{i === 0 ? "First half in goal" : "Second half in goal"}</span>
                    <select value={cfg[k]} onChange={(e) => setCfg({ ...cfg, [k]: e.target.value })}
                      className="border border-slate-300 rounded-md px-2 py-1 bg-white">
                      {players.map((p) => <option key={p.name}>{p.name}</option>)}
                    </select>
                  </label>
                ))}
                <label className="flex items-center justify-between gap-2">
                  <span>Field segments per goalie</span>
                  <select value={cfg.goalieFieldSegs} onChange={(e) => setCfg({ ...cfg, goalieFieldSegs: +e.target.value })}
                    className="border border-slate-300 rounded-md px-2 py-1 bg-white">
                    <option value={2}>2 (premium, ~37 min)</option>
                    <option value={1}>1 (~31 min, two others get a sixth segment)</option>
                  </select>
                </label>
              </div>
            </section>

            <section className="bg-white rounded-xl border border-slate-200 p-4">
              <h2 className="font-bold text-emerald-950 mb-1">Players</h2>
              <p className="text-xs text-slate-500 mb-2">Pref nudges the solver toward a position; Never is a hard rule.</p>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-slate-500">
                    <th className="text-left py-1">Name</th><th>Pref</th><th>Never</th>
                  </tr>
                </thead>
                <tbody>
                  {players.map((p, i) => (
                    <tr key={i} className="border-t border-slate-100">
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
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
