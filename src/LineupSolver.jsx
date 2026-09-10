import { useState, useEffect, useMemo } from "react";

// ---------- Constants ----------
const SEGS = 4; // per half
const SEG_LEN = [6, 6, 6, 7]; // minutes; subs at 6:00, 12:00, 18:00 of a 25-min half
const SEG_LABEL = ["0–6", "6–12", "12–18", "18–25"];
const ROLES = ["D", "M", "F"];
const ROLE_NAME = { D: "Defense", M: "Mid", F: "Forward", GK: "In goal", B: "Bench" };
const TINT = {
  D: "bg-blue-100 border-blue-200 text-slate-800",
  M: "bg-green-100 border-green-200 text-slate-800",
  F: "bg-amber-100 border-amber-200 text-slate-800",
  GK: "bg-slate-800 border-slate-800 text-white",
  B: "bg-transparent border-slate-200 text-slate-400",
};

const DEFAULT_PLAYERS = [
  { name: "Michael", strong: false, pref: "", never: [], },
  { name: "Ethan", strong: false, pref: "", never: [], },
  { name: "Drew", strong: true, pref: "F", never: [] },
  { name: "Isaac", strong: true, pref: "F", never: [] },
  { name: "Khalid", strong: true, pref: "D", never: [] },
  { name: "Theodore", strong: true, pref: "D", never: ["F"] },
  { name: "Ryan", strong: false, pref: "D", never: [] },
  { name: "Neil", strong: false, pref: "D", never: [] },
  { name: "Bobby", strong: false, pref: "M", never: [] },
  { name: "Piers", strong: false, pref: "M", never: [] },
  { name: "Arran", strong: false, pref: "F", never: [] },
  { name: "Adam", strong: false, pref: "", never: ["D"] },
  { name: "Lev", strong: false, pref: "", never: [] },
  { name: "William", strong: false, pref: "", never: [] },
];

const DEFAULT_RULES = [
  { id: 1, type: "atMost", players: ["Adam", "William", "Lev"], role: "M", n: 2 },
  { id: 2, type: "atLeast", players: ["Ryan", "Theodore", "Khalid"], role: "D", n: 1 },
  { id: 3, type: "notBoth", players: ["Lev", "Adam"], role: "D", n: 1 },
];

const DEFAULT_CFG = {
  gk1: "Ethan", // goalie, first half
  gk2: "Michael", // goalie, second half
  goalieFieldSegs: 2, // field segments each goalie gets in their off half
  goalieRoles: { Michael: ["M", "F"], Ethan: ["M"] }, // allowed field roles
  strongMin: 1,
  strongMax: 3,
};

// ---------- Solver ----------
function shuffle(a, rnd) {
  const b = a.slice();
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
}
function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Phase A: decide which segments each player is on the field, per half.
function solvePatterns(names, gk1, gk2, gSegs, rnd) {
  const outfield = names.filter((n) => n !== gk1 && n !== gk2);
  for (let attempt = 0; attempt < 400; attempt++) {
    // split outfielders: which 6 get 3 segments in H1 (the rest get 3 in H2)
    const sh = shuffle(outfield, rnd);
    const h1three = new Set(sh.slice(0, 6));
    const halves = [];
    let ok = true;
    for (let h = 0; h < 2 && ok; h++) {
      const offG = h === 0 ? gk2 : gk1; // the goalie not in net this half
      const parts = outfield.map((n) => ({
        n,
        want: (h === 0 ? h1three.has(n) : !h1three.has(n)) ? 3 : 2,
        noDoubleSit: true,
      }));
      parts.push({ n: offG, want: gSegs, noDoubleSit: gSegs >= 2 });
      const masks = assignMasks(parts, rnd);
      if (!masks) { ok = false; break; }
      halves.push(masks);
    }
    if (!ok) continue;
    // cross-halftime: no outfielder sits last seg of H1 and first seg of H2
    let cross = true;
    for (const n of outfield) {
      const sitsEnd = !(halves[0][n] & (1 << (SEGS - 1)));
      const sitsStart = !(halves[1][n] & 1);
      if (sitsEnd && sitsStart) { cross = false; break; }
    }
    if (!cross) continue;
    return halves;
  }
  return null;
}

function assignMasks(parts, rnd) {
  // randomized backtracking: per-segment capacity is 8 field spots
  const cap = Array(SEGS).fill(8);
  const order = shuffle(parts, rnd);
  const out = {};
  function masksFor(want, noDS) {
    const res = [];
    for (let m = 1; m < 1 << SEGS; m++) {
      let bits = 0;
      for (let s = 0; s < SEGS; s++) if (m & (1 << s)) bits++;
      if (bits !== want) continue;
      if (noDS) {
        let bad = false;
        for (let s = 0; s < SEGS - 1; s++)
          if (!(m & (1 << s)) && !(m & (1 << (s + 1)))) bad = true;
        if (bad) continue;
      }
      res.push(m);
    }
    return res;
  }
  function rec(i) {
    if (i === order.length) return cap.every((c) => c === 0);
    const p = order[i];
    const opts = shuffle(masksFor(p.want, p.noDoubleSit), rnd);
    for (const m of opts) {
      let fits = true;
      for (let s = 0; s < SEGS; s++) if (m & (1 << s) && cap[s] <= 0) fits = false;
      if (!fits) continue;
      for (let s = 0; s < SEGS; s++) if (m & (1 << s)) cap[s]--;
      out[p.n] = m;
      if (rec(i + 1)) return true;
      for (let s = 0; s < SEGS; s++) if (m & (1 << s)) cap[s]++;
      delete out[p.n];
    }
    return false;
  }
  return rec(0) ? out : null;
}

// Phase B: assign roles segment by segment. Returns {plan, score} or null.
function solveRoles(players, masks, gk, offG, cfg, rules, rnd) {
  const byName = Object.fromEntries(players.map((p) => [p.name, p]));
  const plan = []; // plan[s] = { name: role }
  for (let s = 0; s < SEGS; s++) {
    const on = Object.keys(masks).filter((n) => masks[n] & (1 << s));
    const carried = {};
    const free = [];
    for (const n of on) {
      if (s > 0 && masks[n] & (1 << (s - 1))) carried[n] = plan[s - 1][n];
      else free.push(n);
    }
    const need = { D: 3, M: 3, F: 2 };
    for (const n of Object.keys(carried)) need[carried[n]]--;
    if (Object.values(need).some((v) => v < 0)) return null;
    const slots = [];
    for (const r of ROLES) for (let k = 0; k < need[r]; k++) slots.push(r);

    let seg = null;
    for (let t = 0; t < 60 && !seg; t++) {
      const perm = shuffle(slots, rnd);
      const fr = shuffle(free, rnd);
      const asg = { ...carried };
      let ok = true;
      for (let i = 0; i < fr.length; i++) {
        const n = fr[i], r = perm[i];
        const p = byName[n];
        const allowed =
          n === offG
            ? (cfg.goalieRoles[n] || ROLES).includes(r)
            : !(p.never || []).includes(r);
        if (!allowed) { ok = false; break; }
        asg[n] = r;
      }
      if (ok && checkSegment(asg, byName, cfg, rules)) seg = asg;
    }
    if (!seg) return null;
    plan.push(seg);
  }
  // score: preference matches
  let score = 0;
  for (let s = 0; s < SEGS; s++)
    for (const [n, r] of Object.entries(plan[s]))
      if (byName[n] && byName[n].pref === r) score += 1;
  return { plan, score };
}

function checkSegment(asg, byName, cfg, rules) {
  let strong = 0;
  for (const [n, r] of Object.entries(asg)) if (byName[n]?.strong) strong++;
  if (strong < cfg.strongMin || strong > cfg.strongMax) return false;
  for (const rule of rules) {
    const count = rule.players.filter((p) => asg[p] === rule.role).length;
    if (rule.type === "atMost" && count > rule.n) return false;
    if (rule.type === "atLeast" && count < rule.n) return false;
    if (rule.type === "notBoth" && count >= 2) return false;
  }
  return true;
}

function solve(players, cfg, rules, seed) {
  const rnd = mulberry32(seed);
  const names = players.map((p) => p.name);
  let best = null;
  for (let outer = 0; outer < 40; outer++) {
    const halves = solvePatterns(names, cfg.gk1, cfg.gk2, cfg.goalieFieldSegs, rnd);
    if (!halves) continue;
    const r1 = solveRoles(players, halves[0], cfg.gk1, cfg.gk2, cfg, rules, rnd);
    const r2 = solveRoles(players, halves[1], cfg.gk2, cfg.gk1, cfg, rules, rnd);
    if (!r1 || !r2) continue;
    const sol = { halves, plans: [r1.plan, r2.plan], score: r1.score + r2.score };
    if (!best || sol.score > best.score) best = sol;
    if (best && outer > 12) break; // good enough
  }
  return best;
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

  const run = (s = seed) => {
    const result = solve(players, cfg, rules, s);
    setSol(result);
    setFailed(!result);
  };
  useEffect(() => {
    (async () => {
      try {
        const saved = window.localStorage.getItem("greyhounds-setup");
        if (saved) {
          const d = JSON.parse(saved);
          if (d.players) setPlayers(d.players);
          if (d.cfg) setCfg(d.cfg);
          if (d.rules) setRules(d.rules);
          setTimeout(() => run(seed), 0);
          return;
        }
      } catch (e) { /* no saved setup yet */ }
      run(seed);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveSetup = async () => {
    try {
      window.localStorage.setItem("greyhounds-setup", JSON.stringify({ players, cfg, rules }));
      setSavedNote("Setup saved");
    } catch (e) {
      setSavedNote("Couldn't save on this device");
    }
    setTimeout(() => setSavedNote(""), 2500);
  };

  const mins = useMemo(() => (sol ? minutesFor(sol, players, cfg) : null), [sol, players, cfg]);

  const setPlayer = (i, patch) =>
    setPlayers(players.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const toggleNever = (i, role) => {
    const nv = players[i].never.includes(role)
      ? players[i].never.filter((r) => r !== role)
      : [...players[i].never, role];
    setPlayer(i, { never: nv });
  };
  const toggleRulePlayer = (rid, name) =>
    setRules(rules.map((r) => r.id !== rid ? r : {
      ...r,
      players: r.players.includes(name) ? r.players.filter((p) => p !== name) : [...r.players, name],
    }));

  const halfBoard = (h) => {
    const gk = h === 0 ? cfg.gk1 : cfg.gk2;
    const grid = [];
    for (let s = 0; s < SEGS; s++) {
      const col = { GK: [gk], D: [], M: [], F: [], B: [] };
      for (const [n, r] of Object.entries(sol.plans[h][s])) col[r].push(n);
      for (const p of players) {
        const onField = sol.plans[h][s][p.name] !== undefined || p.name === gk;
        if (!onField) col.B.push(p.name);
      }
      grid.push(col);
    }
    return (
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              <th className="text-left p-2 text-slate-500 font-medium w-20"></th>
              {SEG_LABEL.map((l, s) => (
                <th key={s} className="p-2 text-slate-600 font-semibold border-b-2 border-slate-300">{l}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {["GK", "D", "M", "F", "B"].map((row) => (
              <tr key={row} className="align-top">
                <td className="p-2 font-semibold text-slate-600">{ROLE_NAME[row]}</td>
                {grid.map((col, s) => (
                  <td key={s} className="p-1.5 border-l border-slate-200">
                    <div className="flex flex-col gap-1">
                      {col[row].sort().map((n) => (
                        <span key={n} className={`px-2 py-0.5 rounded-md border text-center ${TINT[row]}`}>{n}</span>
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

  return (
    <div className="min-h-screen bg-stone-50 text-slate-900 p-4 md:p-8" style={{ fontFamily: "ui-sans-serif, system-ui" }}>
      <div className="max-w-6xl mx-auto">
        <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-3xl font-extrabold tracking-tight text-emerald-950">Greyhounds lineup solver</h1>
            <p className="text-slate-600 mt-1">Eight segments, subs at 6:00, 12:00 and 18:00. Change any rule and re-solve.</p>
          </div>
          <div className="flex gap-2 items-center">
            {savedNote && <span className="text-sm text-emerald-700">{savedNote}</span>}
            <button onClick={saveSetup} className="px-3 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-100 font-medium">Save setup</button>
            <button onClick={() => { const s = Math.floor(Math.random() * 1e6); setSeed(s); run(s); }}
              className="px-3 py-2 rounded-lg border border-emerald-900 bg-white text-emerald-900 hover:bg-emerald-50 font-medium">Shuffle</button>
            <button onClick={() => run(seed)} className="px-4 py-2 rounded-lg bg-emerald-900 text-white font-semibold hover:bg-emerald-800">Solve</button>
          </div>
        </header>

        <div className="grid md:grid-cols-[340px_1fr] gap-6">
          {/* ---------- Controls ---------- */}
          <div className="space-y-5">
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
                    <option value={1}>1 (~31 min, even)</option>
                  </select>
                </label>
                {[cfg.gk1, cfg.gk2].map((g) => (
                  <div key={g} className="flex items-center justify-between gap-2">
                    <span>{g} on field plays</span>
                    <div className="flex gap-1">
                      {ROLES.map((r) => {
                        const on = (cfg.goalieRoles[g] || ROLES).includes(r);
                        return (
                          <button key={r} onClick={() => {
                            const cur = cfg.goalieRoles[g] || ROLES;
                            const nv = on ? cur.filter((x) => x !== r) : [...cur, r];
                            if (nv.length === 0) return;
                            setCfg({ ...cfg, goalieRoles: { ...cfg.goalieRoles, [g]: nv } });
                          }}
                            className={`w-8 h-7 rounded-md border text-xs font-semibold ${on ? "bg-emerald-900 text-white border-emerald-900" : "bg-white text-slate-500 border-slate-300"}`}>{r}</button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section className="bg-white rounded-xl border border-slate-200 p-4">
              <h2 className="font-bold text-emerald-950 mb-1">Team rules</h2>
              <p className="text-xs text-slate-500 mb-3">Applied to every segment. Tap names to include or exclude them.</p>
              <div className="space-y-3 text-sm">
                <div className="flex items-center justify-between">
                  <span>Strong players on field</span>
                  <span className="flex items-center gap-1">
                    <input type="number" min={0} max={4} value={cfg.strongMin}
                      onChange={(e) => setCfg({ ...cfg, strongMin: +e.target.value })}
                      className="w-12 border border-slate-300 rounded-md px-1 py-0.5" />
                    to
                    <input type="number" min={0} max={4} value={cfg.strongMax}
                      onChange={(e) => setCfg({ ...cfg, strongMax: +e.target.value })}
                      className="w-12 border border-slate-300 rounded-md px-1 py-0.5" />
                  </span>
                </div>
                {rules.map((r) => (
                  <div key={r.id} className="border border-slate-200 rounded-lg p-2.5 bg-stone-50">
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="font-medium">
                        {r.type === "atMost" && <>At most <input type="number" min={0} max={3} value={r.n}
                          onChange={(e) => setRules(rules.map((x) => x.id === r.id ? { ...x, n: +e.target.value } : x))}
                          className="w-10 border border-slate-300 rounded px-1 mx-1" /> of these at</>}
                        {r.type === "atLeast" && <>Always at least <input type="number" min={1} max={3} value={r.n}
                          onChange={(e) => setRules(rules.map((x) => x.id === r.id ? { ...x, n: +e.target.value } : x))}
                          className="w-10 border border-slate-300 rounded px-1 mx-1" /> of these at</>}
                        {r.type === "notBoth" && <>Never two of these together at</>}
                        <select value={r.role} onChange={(e) => setRules(rules.map((x) => x.id === r.id ? { ...x, role: e.target.value } : x))}
                          className="border border-slate-300 rounded px-1 mx-1 bg-white">
                          {ROLES.map((x) => <option key={x} value={x}>{ROLE_NAME[x].toLowerCase()}</option>)}
                        </select>
                      </span>
                      <button onClick={() => setRules(rules.filter((x) => x.id !== r.id))}
                        className="text-slate-400 hover:text-red-600 px-1">✕</button>
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
                <div className="flex gap-2">
                  {[["atMost", "Add cap rule"], ["atLeast", "Add anchor rule"], ["notBoth", "Add pair rule"]].map(([t, label]) => (
                    <button key={t} onClick={() => setRules([...rules, { id: Date.now() + Math.random(), type: t, players: [], role: "D", n: t === "atMost" ? 2 : 1 }])}
                      className="text-xs px-2 py-1 rounded-md border border-slate-300 bg-white hover:bg-slate-100">{label}</button>
                  ))}
                </div>
              </div>
            </section>

            <section className="bg-white rounded-xl border border-slate-200 p-4">
              <h2 className="font-bold text-emerald-950 mb-1">Players</h2>
              <p className="text-xs text-slate-500 mb-2">Star marks your stronger players. Pref nudges the solver; Never is a hard rule.</p>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-slate-500">
                    <th className="text-left py-1">Name</th><th>Star</th><th>Pref</th><th>Never</th>
                  </tr>
                </thead>
                <tbody>
                  {players.map((p, i) => (
                    <tr key={i} className="border-t border-slate-100">
                      <td className="py-1 font-medium">{p.name}</td>
                      <td className="text-center">
                        <button onClick={() => setPlayer(i, { strong: !p.strong })}
                          className={p.strong ? "text-amber-500" : "text-slate-300"}>★</button>
                      </td>
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

          {/* ---------- Results ---------- */}
          <div className="space-y-4">
            {failed && (
              <div className="bg-amber-50 border border-amber-300 rounded-xl p-4 text-amber-900">
                <p className="font-semibold">No schedule satisfies all of these rules together.</p>
                <p className="text-sm mt-1">Loosen something and solve again — the usual culprits are a strong-player range that's too narrow, an anchor rule with too few eligible players, or too many Never restrictions on the same position.</p>
              </div>
            )}
            {sol && (
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
                  Built in: everyone plays 5 of 8 segments, goalies get a full half in net plus their field segments, nobody sits twice in a row (including across halftime), and players keep their position while they stay on the field. Shuffle explores different valid schedules under the same rules.
                </p>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
