// Integer-programming model for the lineup problem.
// buildModel() turns the setup into an LP-format string for HiGHS and returns
// a decoder that maps the solved variables back into per-segment lineups.

export const SEGS = 4; // per half
export const SEG_LEN = [6, 6, 6, 7]; // minutes
export const ROLES = ["D", "M", "F"];
export const NEED = { D: 3, M: 3, F: 2 };
const T = 2 * SEGS; // segments in the game

function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildModel(players, cfg, rules, seed) {
  const rnd = mulberry32(seed);
  const names = players.map((p) => p.name);
  const idx = Object.fromEntries(names.map((n, i) => [n, i]));
  const byName = Object.fromEntries(players.map((p) => [p.name, p]));
  const gkOf = (t) => (t < SEGS ? cfg.gk1 : cfg.gk2);
  const isGoalie = (n) => n === cfg.gk1 || n === cfg.gk2;
  const gSegs = cfg.goalieFieldSegs;

  const cons = [];
  const obj = [];
  const bins = new Set();
  const x = (n, t, r) => `x_${idx[n]}_${t}_${r}`;
  const y = (n, t) => `y_${idx[n]}_${t}`;

  // Which (player, segment, role) triples are even possible.
  const canPlay = (n, t, r) => n !== gkOf(t) && !(byName[n].never || []).includes(r);
  const onField = (n, t) => n !== gkOf(t);

  // y = sum of x over roles; objective favours preferred roles with a
  // seeded jitter so different seeds explore different optimal lineups.
  for (const n of names) for (let t = 0; t < T; t++) {
    if (!onField(n, t)) continue;
    const terms = [];
    for (const r of ROLES) {
      if (!canPlay(n, t, r)) continue;
      bins.add(x(n, t, r));
      terms.push(x(n, t, r));
      const w = (byName[n].pref === r ? 1 : 0) + 0.001 * rnd();
      obj.push(`${w.toFixed(4)} ${x(n, t, r)}`);
    }
    bins.add(y(n, t));
    cons.push(`${terms.join(" + ")} - ${y(n, t)} = 0`);
  }

  // Formation each segment.
  for (let t = 0; t < T; t++) for (const r of ROLES) {
    const terms = names.filter((n) => canPlay(n, t, r)).map((n) => x(n, t, r));
    cons.push(`${terms.join(" + ")} = ${NEED[r]}`);
  }

  // Playing time.
  for (const n of names) {
    if (isGoalie(n)) {
      const off = n === cfg.gk1 ? 1 : 0; // half in which this goalie is on the field
      const ts = [];
      for (let s = 0; s < SEGS; s++) ts.push(off * SEGS + s);
      cons.push(`${ts.map((t) => y(n, t)).join(" + ")} = ${gSegs}`);
      if (gSegs >= 2) for (let s = 0; s < SEGS - 1; s++) {
        const t = off * SEGS + s;
        cons.push(`${y(n, t)} + ${y(n, t + 1)} >= 1`);
      }
    } else {
      const all = [];
      for (let t = 0; t < T; t++) all.push(y(n, t));
      // Everyone gets at least 5 of 8; the cap of 3 per half keeps it at 6 at most.
      // z marks a sixth segment. Charging it back at the preference weight keeps
      // the solver from handing extra minutes to whoever has a preference set.
      const z = `z_${idx[n]}`;
      bins.add(z);
      cons.push(`${all.join(" + ")} >= 5`);
      cons.push(`${all.join(" + ")} - ${z} <= 5`);
      if (byName[n].pref) obj.push(`-1 ${z}`);
      for (let h = 0; h < 2; h++) {
        const half = [];
        for (let s = 0; s < SEGS; s++) half.push(y(n, h * SEGS + s));
        cons.push(`${half.join(" + ")} >= 2`);
        cons.push(`${half.join(" + ")} <= 3`);
      }
      // Never sit twice in a row, including across halftime.
      for (let t = 0; t < T - 1; t++) cons.push(`${y(n, t)} + ${y(n, t + 1)} >= 1`);
    }
  }

  // Keep position while staying on the field within a half.
  for (const n of names) for (let t = 0; t < T; t++) {
    if (t % SEGS === 0 || !onField(n, t) || !onField(n, t - 1)) continue;
    for (const r of ROLES) {
      if (!canPlay(n, t, r) || !canPlay(n, t - 1, r)) continue;
      // x[t-1][r] + y[t] - 1 <= x[t][r]
      cons.push(`${x(n, t - 1, r)} + ${y(n, t)} - ${x(n, t, r)} <= 1`);
    }
  }

  // Coach constraints, applied to every segment.
  for (const rule of rules) for (let t = 0; t < T; t++) {
    const terms = rule.players
      .filter((n) => n in idx && onField(n, t) && (rule.role === "any" || canPlay(n, t, rule.role)))
      .map((n) => (rule.role === "any" ? y(n, t) : x(n, t, rule.role)));
    const lhs = terms.length ? terms.join(" + ") : null;
    if (rule.type === "atMost") { if (lhs) cons.push(`${lhs} <= ${rule.n}`); }
    else if (rule.type === "atLeast") { cons.push(`${lhs || "0 " + y(names[0], names[0] === gkOf(t) ? (t + SEGS) % T : t)} >= ${rule.n}`); }
    else if (rule.type === "notBoth") { if (lhs) cons.push(`${lhs} <= 1`); }
  }

  const lp = [
    "Maximize",
    " obj: " + obj.join(" + "),
    "Subject To",
    ...cons.map((c, i) => ` c${i}: ${c}`),
    "Binary",
    " " + [...bins].join(" "),
    "End",
  ].join("\n");

  const decode = (columns) => {
    const plans = [[], []];
    let score = 0;
    for (let t = 0; t < T; t++) {
      const seg = {};
      for (const n of names) for (const r of ROLES) {
        const v = columns[x(n, t, r)];
        if (v && v.Primal > 0.5) {
          seg[n] = r;
          if (byName[n].pref === r) score++;
        }
      }
      plans[Math.floor(t / SEGS)].push(seg);
    }
    return { plans, score };
  };

  return { lp, decode };
}
