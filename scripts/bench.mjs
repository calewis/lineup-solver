// node scripts/bench.mjs — solve a few setups and report timing and fairness.
import highsLoader from "highs";
import { buildModel, available, T } from "../src/model.js";
const roster = [
  ["Michael", "", ["D"]], ["Ethan", "", ["D", "F"]], ["Drew", "F", []], ["Isaac", "F", []],
  ["Khalid", "D", []], ["Theodore", "D", ["F"]], ["Ryan", "D", []], ["Neil", "D", []],
  ["Bobby", "M", []], ["Piers", "M", []], ["Arran", "F", []], ["Adam", "", ["D"]],
  ["Lev", "", []], ["William", "", []],
].map(([name, pref, never]) => ({ name, pref, never, out: null }));
const RULES = [
  { id: 1, type: "between", players: ["Drew", "Isaac", "Khalid", "Theodore"], role: "any", lo: 1, hi: 3 },
];
const cfg = { gk1: "Ethan", gk2: "Michael", goalieFieldSegs: 2 };
const withOut = (edits) => roster.map((p) => ({ ...p, out: edits[p.name] ?? null }));
const cases = [
  ["full roster", roster, cfg],
  ["only 9 players, no rules", withOut({ Bobby: "absent", Piers: "absent", Lev: "absent", Adam: "absent", William: "absent" }), cfg, []],
  ["Bobby absent", withOut({ Bobby: "absent" }), cfg],
  ["Bobby + Piers absent", withOut({ Bobby: "absent", Piers: "absent" }), cfg],
  ["Drew leaves at halftime", withOut({ Drew: 4 }), cfg],
  ["Neil absent, Lev leaves 12:00 H2", withOut({ Neil: "absent", Lev: 6 }), cfg],
  ["goalie absent", withOut({ Michael: "absent" }), cfg],
  ["only 9 players", withOut({ Bobby: "absent", Piers: "absent", Lev: "absent", Adam: "absent", William: "absent" }), cfg],
];
const highs = await highsLoader();
for (const [label, players, c, rules = RULES] of cases) {
  const m = buildModel(players, c, rules, 7);
  if (m.reason) { console.log(`${label}: ${m.reason}`); continue; }
  const t0 = performance.now();
  const res = highs.solve(m.lp);
  const ms = (performance.now() - t0).toFixed(0);
  if (res.Status !== "Optimal") { console.log(`${label}: ${res.Status} (${ms}ms)`); continue; }
  const { plans, score } = m.decode(res.Columns);
  const segs = {};
  let possible = 0;
  for (const p of players) { segs[p.name] = 0; }
  for (let t = 0; t < T; t++) for (const [n, r] of Object.entries(plans[Math.floor(t / 4)][t % 4])) { segs[n]++; }
  for (const p of players) if (p.pref && !(p.name === c.gk1 || p.name === c.gk2)) possible += segs[p.name];
  const line = players.filter((p) => !(p.name === c.gk1 || p.name === c.gk2)).map((p) => `${p.name.slice(0, 3)}${segs[p.name]}`).join(" ");
  console.log(`${label}: ${ms}ms, prefs ${score}/${possible}, segs: ${line}`);
}
