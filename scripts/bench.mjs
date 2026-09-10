import highsLoader from "highs";
import { buildModel } from "../src/model.js";
const PLAYERS = [
  { name: "Michael", pref: "", never: ["D"] }, { name: "Ethan", pref: "", never: ["D","F"] },
  { name: "Drew", pref: "F", never: [] }, { name: "Isaac", pref: "F", never: [] },
  { name: "Khalid", pref: "D", never: [] }, { name: "Theodore", pref: "D", never: ["F"] },
  { name: "Ryan", pref: "D", never: [] }, { name: "Neil", pref: "D", never: [] },
  { name: "Bobby", pref: "M", never: [] }, { name: "Piers", pref: "M", never: [] },
  { name: "Arran", pref: "F", never: [] }, { name: "Adam", pref: "", never: ["D"] },
  { name: "Lev", pref: "", never: [] }, { name: "William", pref: "", never: [] },
];
const RULES = [
  { id: 1, type: "atLeast", players: ["Drew","Isaac","Khalid","Theodore"], role: "any", n: 1 },
  { id: 2, type: "atMost", players: ["Drew","Isaac","Khalid","Theodore"], role: "any", n: 3 },
  { id: 3, type: "atMost", players: ["Adam","William","Lev"], role: "M", n: 2 },
  { id: 4, type: "atLeast", players: ["Ryan","Theodore","Khalid"], role: "D", n: 1 },
  { id: 5, type: "notBoth", players: ["Lev","Adam"], role: "D", n: 1 },
];
const highs = await highsLoader();
for (const [label, cfg] of [["2 goalie segs", { gk1:"Ethan", gk2:"Michael", goalieFieldSegs:2 }], ["1 goalie seg", { gk1:"Ethan", gk2:"Michael", goalieFieldSegs:1 }]]) {
  for (const seed of [7, 8]) {
    const { lp, decode } = buildModel(PLAYERS, cfg, RULES, seed);
    const t0 = performance.now();
    const res = highs.solve(lp);
    const ms = (performance.now() - t0).toFixed(0);
    if (res.Status !== "Optimal") { console.log(label, seed, res.Status, ms + "ms"); continue; }
    const { plans, score } = decode(res.Columns);
    const prefCount = PLAYERS.filter(p => p.pref).length * 5;
    console.log(`${label} seed ${seed}: ${ms}ms, pref matches ${score} of ${prefCount} possible`);
    console.log("  H1 seg0:", JSON.stringify(plans[0][0]));
  }
}
