// Integer-programming model for the lineup problem.
// buildModel() turns the setup into an LP-format string for HiGHS and returns
// a decoder that maps the solved variables back into per-segment lineups.
// When the setup can be ruled out before solving, it returns { reason }.

export const SEGS = 4; // per half
export const SEG_LEN = [6, 6, 6, 7]; // minutes
export const ROLES = ["D", "M", "F"];
export const T = 2 * SEGS; // segments in the game

// Game sizes (players per side including the goalie) with a default
// formation for each, and the common alternatives listed as D-M-F.
export const GAME_SIZES = [7, 9, 11];
export const DEFAULT_FORMATION = {
  7: { D: 3, M: 2, F: 1 },
  9: { D: 3, M: 3, F: 2 },
  11: { D: 4, M: 4, F: 2 },
};
export const FORMATION_PRESETS = {
  7: [[3, 2, 1], [2, 3, 1], [3, 1, 2], [2, 2, 2]],
  9: [[3, 3, 2], [3, 2, 3], [2, 4, 2], [3, 4, 1], [4, 3, 1]],
  11: [[4, 4, 2], [4, 3, 3], [3, 5, 2], [4, 5, 1], [3, 4, 3], [5, 3, 2]],
};
export const outfieldCount = (formation) => ROLES.reduce((a, r) => a + (formation[r] || 0), 0);
export const formationLabel = (f) => `${f.D}-${f.M}-${f.F}`;

// Named spots for a line of n players, left to right from the team's own goal.
const LINE = { D: "B", M: "M", F: "F" };
export function slotsFor(role, n) {
  const suffix = LINE[role];
  const width = { 1: ["C"], 2: ["L", "R"], 3: ["L", "C", "R"], 4: ["L", "LC", "RC", "R"], 5: ["L", "LC", "C", "RC", "R"], 6: ["L", "LC", "C", "C2", "RC", "R"] };
  return (width[n] || width[5]).slice(0, n).map((w) => `${w}${suffix}`);
}
const SIDE_NAME = { L: "Left", R: "Right", C: "Center", LC: "Left-center", RC: "Right-center", C2: "Center" };
const LINE_NAME = { B: "back", M: "mid", F: "forward" };
export function slotName(code) {
  const side = code.slice(0, -1), line = code.slice(-1);
  return `${SIDE_NAME[side] || side} ${LINE_NAME[line] || line}`;
}

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
export function assignSlots(plans, seed, formation) {
  const rnd = mulberry32(seed * 7 + 1);
  return plans.map((half) => {
    const out = [];
    half.forEach((seg, s) => {
      const asg = {};
      for (const r of ROLES) {
        const names = Object.keys(seg).filter((n) => seg[n] === r);
        const free = new Set(slotsFor(r, formation[r]));
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
  const NEED = cfg.formation;
  const FIELD = outfieldCount(NEED);
  if (FIELD !== cfg.size - 1) return { reason: `The formation adds up to ${FIELD} but ${cfg.size}v${cfg.size} needs ${cfg.size - 1} on the field plus a goalie.` };
  const names = players.map((p) => p.name);
  if (names.length === 0) return { reason: "Add your players first." };
  if (names.some((n) => !n.trim())) return { reason: "Every player needs a name." };
  if (new Set(names).size !== names.length) return { reason: "Two players have the same name." };
  if (!cfg.gk1 || !cfg.gk2) return { reason: "Pick a goalie for each half." };
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

// ---------- Validation of a hand-edited lineup ----------
const HALF_NAME = ["1st half", "2nd half"];
const SEG_TIMES = ["0–6", "6–12", "12–18", "18–25"];
const ROLE_WORD = { D: "defense", M: "midfield", F: "forward", any: "the field" };
const segLabel = (t) => `${HALF_NAME[Math.floor(t / SEGS)]} ${SEG_TIMES[t % SEGS]}`;

// Returns a list of { level: "hard" | "note", text }. Hard items are rules the
// solver would never break; notes are things the solver balances but a coach
// may choose to override.
export function checkLineup(plans, players, cfg, rules) {
  const NEED = cfg.formation;
  const issues = [];
  const hard = (text) => issues.push({ level: "hard", text });
  const note = (text) => issues.push({ level: "note", text });
  const byName = Object.fromEntries(players.map((p) => [p.name, p]));
  const segAt = (t) => plans[Math.floor(t / SEGS)][t % SEGS];
  const gkOf = (t) => (t < SEGS ? cfg.gk1 : cfg.gk2);

  for (let t = 0; t < T; t++) {
    const seg = segAt(t);
    const counts = { D: 0, M: 0, F: 0 };
    for (const [n, r] of Object.entries(seg)) {
      counts[r]++;
      const p = byName[n];
      if (!p) { hard(`${n} is not on the roster (${segLabel(t)}).`); continue; }
      if (n === gkOf(t)) hard(`${n} is in goal and on the field at once (${segLabel(t)}).`);
      if (!available(p, t)) hard(`${n} is marked out but on the field (${segLabel(t)}).`);
      if ((p.never || []).includes(r)) hard(`${n} is at ${ROLE_WORD[r]} but marked Never (${segLabel(t)}).`);
    }
    for (const r of ROLES) if (counts[r] !== NEED[r]) hard(`${segLabel(t)} has ${counts[r]} at ${ROLE_WORD[r]} instead of ${NEED[r]}.`);
    for (const rule of rules) {
      const c = rule.players.filter((n) => n in seg && (rule.role === "any" || seg[n] === rule.role)).length;
      const who = `of ${rule.players.join(", ")} on ${ROLE_WORD[rule.role]}`;
      if (rule.type === "atMost" && c > rule.n) hard(`${c} ${who}, at most ${rule.n} allowed (${segLabel(t)}).`);
      if (rule.type === "atLeast" && c < rule.n) hard(`${c} ${who}, at least ${rule.n} needed (${segLabel(t)}).`);
      if (rule.type === "between" && (c < rule.lo || c > rule.hi)) hard(`${c} ${who}, must be between ${rule.lo} and ${rule.hi} (${segLabel(t)}).`);
      if (rule.type === "notBoth" && c >= 2) hard(`Two ${who}, they must be kept apart (${segLabel(t)}).`);
    }
  }

  // Sitting twice in a row, and position changes during a stint.
  for (const p of players) {
    const n = p.name;
    for (let t = 0; t < T - 1; t++) {
      const here = available(p, t) && n !== gkOf(t);
      const next = available(p, t + 1) && n !== gkOf(t + 1);
      if (here && next && !(n in segAt(t)) && !(n in segAt(t + 1))) hard(`${n} sits out ${segLabel(t)} and ${segLabel(t + 1)} back to back.`);
      if ((t + 1) % SEGS !== 0 && n in segAt(t) && n in segAt(t + 1) && segAt(t)[n] !== segAt(t + 1)[n]) {
        note(`${n} moves from ${ROLE_WORD[segAt(t)[n]]} to ${ROLE_WORD[segAt(t + 1)[n]]} without leaving the field (${segLabel(t + 1)}).`);
      }
    }
  }

  // Playing time spread among outfielders here for the whole game.
  const full = players.filter((p) => p.out == null && p.name !== cfg.gk1 && p.name !== cfg.gk2);
  const segs = Object.fromEntries(full.map((p) => [p.name, 0]));
  for (let t = 0; t < T; t++) for (const n of Object.keys(segAt(t))) if (n in segs) segs[n]++;
  const vals = Object.values(segs);
  if (vals.length && Math.max(...vals) - Math.min(...vals) > 1) {
    const most = full.filter((p) => segs[p.name] === Math.max(...vals)).map((p) => p.name).join(", ");
    const least = full.filter((p) => segs[p.name] === Math.min(...vals)).map((p) => p.name).join(", ");
    note(`Playing time is uneven: ${most} ${Math.max(...vals)} segments, ${least} ${Math.min(...vals)}.`);
  }
  return issues;
}
