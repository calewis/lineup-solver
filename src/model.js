// Integer-programming model for the lineup problem.
// buildModel() turns the setup into an LP-format string for HiGHS and returns
// a decoder that maps the solved variables back into per-segment lineups.
// When the setup can be ruled out before solving, it returns { reason }.

export const SEGS = 4; // per half
export const SEG_LEN = [6, 6, 6, 7]; // minutes
export const ROLES = ["D", "M", "F"];
export const NEED = { D: 3, M: 3, F: 2 };
export const T = 2 * SEGS; // segments in the game
const FIELD = ROLES.reduce((a, r) => a + NEED[r], 0); // players on the field

// Availability: p.out is null (plays the whole game), "absent", or the index
// of the first segment the player misses after leaving early.
export function available(p, t) {
  if (p.out == null) return true;
  if (p.out === "absent") return false;
  return t < p.out;
}

export function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Named positions within each role, listed left to right as seen from the
// team's own goal.
export const SLOTS = { F: ["LF", "RF"], M: ["LM", "CM", "RM"], D: ["LB", "CB", "RB"] };

function shuffle(a, rnd) {
  const b = a.slice();
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
}

// Give every on-field player a named position. A player who stays on in the
// same role keeps their spot; newcomers take the vacated spots at random.
export function assignSlots(plans, seed) {
  const rnd = mulberry32(seed * 7 + 1);
  return plans.map((half) => {
    const out = [];
    half.forEach((seg, s) => {
      const asg = {};
      for (const r of ROLES) {
        const names = Object.keys(seg).filter((n) => seg[n] === r);
        const free = new Set(SLOTS[r]);
        const fresh = [];
        for (const n of names) {
          const prev = s > 0 && half[s - 1][n] === r ? out[s - 1][n] : null;
          if (prev && free.has(prev)) { asg[n] = prev; free.delete(prev); }
          else fresh.push(n);
        }
        const open = shuffle([...free], rnd);
        fresh.forEach((n, i) => { asg[n] = open[i]; });
      }
      out.push(asg);
    });
    return out;
  });
}

// Swap two named positions from segment s through the end of the half, so
// everyone who stays on the field keeps a consistent spot.
export function swapSlots(slots, h, s, slotA, slotB) {
  return slots.map((half, hh) => hh !== h ? half : half.map((seg, ss) => {
    if (ss < s) return seg;
    const next = {};
    for (const [n, sl] of Object.entries(seg)) next[n] = sl === slotA ? slotB : sl === slotB ? slotA : sl;
    return next;
  }));
}

export function buildModel(players, cfg, rules, seed) {
  const rnd = mulberry32(seed);
  const names = players.map((p) => p.name);
  const idx = Object.fromEntries(names.map((n, i) => [n, i]));
  const byName = Object.fromEntries(players.map((p) => [p.name, p]));
  const gkOf = (t) => (t < SEGS ? cfg.gk1 : cfg.gk2);
  const isGoalie = (n) => n === cfg.gk1 || n === cfg.gk2;
  const inNet = (n, t) => n === gkOf(t);

  // Goalies must be there for their half in net.
  for (const g of [cfg.gk1, cfg.gk2]) {
    if (!byName[g]) return { reason: `${g} is not on the roster.` };
    const half = g === cfg.gk1 ? 0 : 1;
    for (let s = 0; s < SEGS; s++) {
      if (!available(byName[g], half * SEGS + s)) return { reason: `${g} is in goal for the ${half === 0 ? "first" : "second"} half but is marked out.` };
    }
  }

  // Who can be on the field when.
  const onField = (n, t) => !inNet(n, t) && available(byName[n], t);
  const canPlay = (n, t, r) => onField(n, t) && !(byName[n].never || []).includes(r);

  // Playing-time targets. Field slots left after the goalies' field segments
  // are shared among outfielders in proportion to how much of the game each
  // one is here for; everyone lands within one segment of their share.
  const target = {};
  const avail = {};
  for (const n of names) {
    let k = 0;
    for (let t = 0; t < T; t++) if (onField(n, t)) k++;
    avail[n] = k;
  }
  let slots = FIELD * T;
  const goalies = [cfg.gk1, cfg.gk2];
  for (const g of goalies) {
    const want = Math.min(cfg.goalieFieldSegs, avail[g]);
    target[g] = { lo: want, hi: want };
    slots -= want;
  }
  const outfield = names.filter((n) => !isGoalie(n));
  const totalAvail = outfield.reduce((a, n) => a + avail[n], 0);
  // Short-handed: goalies pick up extra field segments before giving up.
  while (totalAvail < slots) {
    const g = goalies.find((n) => target[n].hi < avail[n]);
    if (!g) return { reason: "Not enough players to fill the field for every segment." };
    target[g].lo++;
    target[g].hi++;
    slots--;
  }
  for (const n of outfield) {
    const share = totalAvail ? (slots * avail[n]) / totalAvail : 0;
    target[n] = { lo: Math.floor(share), hi: Math.min(avail[n], Math.ceil(share)) };
  }
  for (let t = 0; t < T; t++) {
    if (names.filter((n) => onField(n, t)).length < FIELD) return { reason: "Not enough players to fill the field for every segment." };
  }

  const cons = [];
  const obj = [];
  const bins = new Set();
  const x = (n, t, r) => `x_${idx[n]}_${t}_${r}`;
  const y = (n, t) => `y_${idx[n]}_${t}`;

  // y = sum of x over roles; objective favours preferred roles with a
  // seeded jitter so different seeds explore different optimal lineups.
  for (const n of names) for (let t = 0; t < T; t++) {
    if (!onField(n, t)) continue;
    const terms = [];
    for (const r of ROLES) {
      if (!canPlay(n, t, r)) continue;
      bins.add(x(n, t, r));
      terms.push(x(n, t, r));
      // First choice counts in full, second choice half.
      const w = (byName[n].pref === r ? 1 : byName[n].pref2 === r ? 0.5 : 0) + 0.001 * rnd();
      obj.push(`${w.toFixed(4)} ${x(n, t, r)}`);
    }
    if (terms.length === 0) return { reason: `${n} has every position marked Never.` };
    bins.add(y(n, t));
    cons.push(`${terms.join(" + ")} - ${y(n, t)} = 0`);
  }

  // Formation each segment.
  for (let t = 0; t < T; t++) for (const r of ROLES) {
    const terms = names.filter((n) => canPlay(n, t, r)).map((n) => x(n, t, r));
    if (terms.length < NEED[r]) return { reason: `Not enough players allowed at ${r} to fill the formation.` };
    cons.push(`${terms.join(" + ")} = ${NEED[r]}`);
  }

  // Playing time.
  for (const n of names) {
    const ts = [];
    for (let t = 0; t < T; t++) if (onField(n, t)) ts.push(t);
    if (ts.length === 0) continue;
    const all = ts.map((t) => y(n, t)).join(" + ");
    const { lo, hi } = target[n];
    cons.push(`${all} >= ${lo}`);
    if (hi > lo) {
      // z marks the extra segment. Charging it back at the preference weight
      // keeps the solver from handing extra minutes to whoever has a
      // preference set.
      const z = `z_${idx[n]}`;
      bins.add(z);
      cons.push(`${all} - ${z} <= ${lo}`);
      if (byName[n].pref) obj.push(`-1 ${z}`);
    } else {
      cons.push(`${all} <= ${hi}`);
    }
    // Never sit twice in a row (including across halftime) while here.
    // Skipped for anyone whose share is too small to make that possible,
    // such as a goalie getting a single field segment.
    if (hi >= Math.floor(ts.length / 2)) {
      for (let t = 0; t < T - 1; t++) {
        if (onField(n, t) && onField(n, t + 1)) cons.push(`${y(n, t)} + ${y(n, t + 1)} >= 1`);
      }
    }
    // Outfielders here for the whole game split their time evenly across halves.
    if (!isGoalie(n) && ts.length === T) {
      const h1 = [], h2 = [];
      for (let s = 0; s < SEGS; s++) { h1.push(y(n, s)); h2.push(y(n, SEGS + s)); }
      const diff = `${h1.join(" + ")} - ${h2.join(" - ")}`;
      cons.push(`${diff} <= 1`);
      cons.push(`${diff} >= -1`);
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
      .filter((n) => n in idx && (rule.role === "any" ? onField(n, t) : canPlay(n, t, rule.role)))
      .map((n) => (rule.role === "any" ? y(n, t) : x(n, t, rule.role)));
    if (rule.type === "atMost") {
      if (terms.length > rule.n) cons.push(`${terms.join(" + ")} <= ${rule.n}`);
    } else if (rule.type === "atLeast") {
      if (terms.length < rule.n) return { reason: "An anchor constraint needs more eligible players than are available in some segment." };
      cons.push(`${terms.join(" + ")} >= ${rule.n}`);
    } else if (rule.type === "between") {
      if (rule.lo > rule.hi) return { reason: "A balance constraint has its minimum above its maximum." };
      if (terms.length < rule.lo) return { reason: "A balance constraint needs more eligible players than are available in some segment." };
      if (rule.lo > 0) cons.push(`${terms.join(" + ")} >= ${rule.lo}`);
      if (terms.length > rule.hi) cons.push(`${terms.join(" + ")} <= ${rule.hi}`);
    } else if (rule.type === "notBoth") {
      if (terms.length >= 2) cons.push(`${terms.join(" + ")} <= 1`);
    }
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
          if (byName[n].pref === r) score += 1;
          else if (byName[n].pref2 === r) score += 0.5;
        }
      }
      plans[Math.floor(t / SEGS)].push(seg);
    }
    return { plans, score };
  };

  return { lp, decode };
}
