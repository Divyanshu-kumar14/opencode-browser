#!/usr/bin/env node
/**
 * M3 bench harness (IMPLEMENTATION-PLAN.md Phase 5).
 *
 * Workload: 1 / 4 / 8 concurrent sessions x 20 calls per session, cycling
 *   navigate -> snapshot -> click -> fill -> screenshot (4 rounds).
 * Runs: 3 by default, first run discarded as cold.
 *
 * Metrics: cold first call, warm per-method p50/p95, daemon idle RSS
 * (/proc), marginal RSS/session, total tree RSS sampled @1Hz, cross-session
 * collisions, optional 30-min soak drift (--soak-minutes).
 *
 * Drivers: --driver mock (default-safe, no Chrome; exit condition for Agent D)
 *   or --driver js (real Baseline A via plugin/legacy/src/driver/js.ts, needs Chrome).
 *   Comparing against the Rust daemon (Baseline B) uses --compare to evaluate
 *   the pre-registered kill rule: <20% win on BOTH marginal-RSS/session AND
 *   warm-call p95 => ship the JS driver, do not default the daemon.
 *
 * Outputs: results JSON (--out) + decision-memo markdown (--report).
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const DEFAULT_OUT = join(ROOT, "bench", "results", "results.json");
const DEFAULT_REPORT = join(ROOT, "bench", "results", "report.md");

const FIXTURE_HTML = [
  "<!doctype html><html><head><title>Bench fixture</title></head><body>",
  '<main><h1>Sign in</h1><form action="#">',
  '<label>Email <input id="email" name="email" aria-label="Email" value=""></label>',
  '<label>Password <input id="pw" name="pw" type="password" aria-label="Password" value=""></label>',
  '<button type="submit">Sign in</button>',
  '<a href="#forgot">Forgot password</a>',
  "</form></main></body></html>",
].join("");
const FIXTURE_URL = `data:text/html,${encodeURIComponent(FIXTURE_HTML)}`;

const METHODS = ["navigate", "snapshot", "click", "fill", "screenshot"];

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage() {
  return [
    "usage: node scripts/bench.mjs [options]",
    "",
    "options:",
    "  --driver mock|js        which baseline to drive (default: mock)",
    "  --mock                  shorthand for --driver mock",
    "  --sessions 1,4,8        concurrent session counts (default: 1,4,8)",
    "  --calls N               total ops per session, cycling nav/snap/click/fill/shot (default: 20)",
    "  --runs N                repetitions; first run is discarded as cold (default: 3)",
    "  --fixture URL           page to navigate to (default: embedded data: fixture)",
    "  --chrome PATH           Chrome binary for --driver js (default: auto-detect)",
    "  --soak-minutes N        idle soak after workload to measure RSS drift (default: 0 = skip)",
    "  --out PATH              results JSON path (default: bench/results/results.json)",
    "  --report PATH           decision-memo markdown path (default: bench/results/report.md)",
    "  --compare PATH          another results.json (the other baseline) to evaluate the kill rule",
    "  --guard PATH            baseline results.json for the CI regression guard",
    "  --max-regression-pct N  fail if any warm p95 regresses more than N% vs --guard (default: 10)",
    "  --help                  print this help and exit 0",
    "",
    "examples:",
    "  node scripts/bench.mjs --mock",
    "  node scripts/bench.mjs --driver js --sessions 1,4,8 --runs 3",
    "  node scripts/bench.mjs --mock --compare bench/results/results-js.json",
  ].join("\n");
}

function parseArgs(argv) {
  const opts = {
    driver: "mock",
    sessions: [1, 4, 8],
    calls: 20,
    runs: 3,
    fixture: FIXTURE_URL,
    chrome: "",
    soakMinutes: 0,
    out: DEFAULT_OUT,
    report: DEFAULT_REPORT,
    compare: "",
    guard: "",
    maxRegressionPct: 10,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${arg} needs a value`);
      }
      i++;
      return value;
    };
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else if (arg === "--mock") {
      opts.driver = "mock";
    } else if (arg === "--driver") {
      const value = next();
      if (value !== "mock" && value !== "js") throw new Error(`--driver must be mock or js, got ${value}`);
      opts.driver = value;
    } else if (arg === "--sessions") {
      opts.sessions = next().split(",").map((s) => {
        const n = Number(s.trim());
        if (!Number.isInteger(n) || n < 1 || n > 64) throw new Error(`bad session count: ${s}`);
        return n;
      });
    } else if (arg === "--calls") {
      opts.calls = Number(next());
      if (!Number.isInteger(opts.calls) || opts.calls < 5) throw new Error("--calls must be an integer >= 5");
    } else if (arg === "--runs") {
      opts.runs = Number(next());
      if (!Number.isInteger(opts.runs) || opts.runs < 1) throw new Error("--runs must be an integer >= 1");
    } else if (arg === "--fixture") {
      opts.fixture = next();
    } else if (arg === "--chrome") {
      opts.chrome = next();
    } else if (arg === "--soak-minutes") {
      opts.soakMinutes = Number(next());
      if (!Number.isFinite(opts.soakMinutes) || opts.soakMinutes < 0) {
        throw new Error("--soak-minutes must be >= 0");
      }
    } else if (arg === "--out") {
      opts.out = resolve(next());
    } else if (arg === "--report") {
      opts.report = resolve(next());
    } else if (arg === "--compare") {
      opts.compare = resolve(next());
    } else if (arg === "--guard") {
      opts.guard = resolve(next());
    } else if (arg === "--max-regression-pct") {
      opts.maxRegressionPct = Number(next());
      if (!Number.isFinite(opts.maxRegressionPct) || opts.maxRegressionPct < 0) {
        throw new Error("--max-regression-pct must be >= 0");
      }
    } else {
      throw new Error(`unknown flag ${arg} (see --help)`);
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// /proc RSS helpers (mirrors daemon/src/paths.rs logic).
// ---------------------------------------------------------------------------

function readVmRssKb(pid) {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    for (const line of status.split("\n")) {
      if (line.startsWith("VmRSS:")) {
        const parts = line.split(/\s+/);
        const kb = Number(parts[1]);
        return Number.isFinite(kb) ? kb : 0;
      }
    }
  } catch {
    // Process gone or /proc unavailable (non-Linux): report 0, never crash.
  }
  return 0;
}

function processTreeRssMb(rootPid) {
  let children;
  try {
    children = new Map();
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number(entry);
      let stat;
      try {
        stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      } catch {
        continue;
      }
      const rest = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
      // fields after comm: state(0) ppid(1) ...
      const ppid = Number(rest[1]);
      if (!Number.isFinite(ppid)) continue;
      if (!children.has(ppid)) children.set(ppid, []);
      children.get(ppid).push(pid);
    }
  } catch {
    return readVmRssKb(rootPid) / 1024;
  }
  let totalKb = readVmRssKb(rootPid);
  const stack = [...(children.get(rootPid) ?? [])];
  while (stack.length > 0) {
    const pid = stack.pop();
    totalKb += readVmRssKb(pid);
    const kids = children.get(pid);
    if (kids) stack.push(...kids);
  }
  return totalKb / 1024;
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return sorted[low];
  return sorted[low] + (sorted[high] - sorted[low]) * (rank - low);
}

function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: round2(percentile(sorted, 50)),
    p95: round2(percentile(sorted, 95)),
    max: round2(sorted[sorted.length - 1] ?? 0),
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/// Minimum warm samples per method for p50/p95 to be more than
/// interpolation noise (Blind-spot #7: floor, then flag).
const N_FLOOR = 30;

function tCrit95(df) {
  const table = {1:12.706,2:4.303,3:3.182,4:2.776,5:2.571,6:2.447,7:2.365,8:2.306,9:2.262,10:2.228,11:2.201,12:2.179,13:2.160,14:2.145,15:2.131,16:2.120,17:2.110,18:2.101,19:2.093,20:2.086,21:2.080,22:2.074,23:2.069,24:2.064,25:2.060,26:2.056,27:2.052,28:2.048,29:2.045,30:2.042};
  if (Number.isInteger(df) && df >= 1 && df <= 30) return table[df];
  return 1.96;
}

/// Ordinary least-squares slope of ys over xs with two-sided 95% CI
/// (t, df = n-2) and R². With 2 points there is no CI: the slope is
/// reported as-is with a note to re-run with ≥3 session counts.
function olsSlopeCI(xs, ys) {
  const n = xs.length;
  if (n < 2 || xs[n - 1] === xs[0]) {
    return { slope: 0, lo: 0, hi: 0, r2: 0, note: "need >=2 distinct session counts" };
  }
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) ** 2;
    sxy += (xs[i] - mx) * (ys[i] - my);
  }
  if (sxx === 0) {
    return { slope: 0, lo: 0, hi: 0, r2: 0, note: "degenerate session counts" };
  }
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  let sse = 0;
  let sst = 0;
  for (let i = 0; i < n; i++) {
    const resid = ys[i] - (slope * xs[i] + intercept);
    sse += resid * resid;
    sst += (ys[i] - my) ** 2;
  }
  const r2 = sst > 0 ? 1 - sse / sst : 0;
  if (n < 3) {
    return { slope: round2(slope), lo: round2(slope), hi: round2(slope), r2: round2(r2), note: "2 points: no CI, re-run with >=3 session counts" };
  }
  const se = Math.sqrt(sse / (n - 2) / sxx);
  const t = tCrit95(n - 2);
  return { slope: round2(slope), lo: round2(slope - t * se), hi: round2(slope + t * se), r2: round2(r2), note: "" };
}

// ---------------------------------------------------------------------------
// Mock driver: same method names as JsDriver, seeded latencies, zero Chrome.
// ---------------------------------------------------------------------------

function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

function mockError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function createMockDriver(seed = 1234) {
  const random = lcg(seed);
  const latency = { navigate: 9, snapshot: 11, click: 5, fill: 5, screenshot: 13 };
  const tabs = new Map();
  let launched = false;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const jitter = (base) => sleep(base * (0.8 + random() * 0.4));
  const tabFor = (session) => {
    let tab = tabs.get(session);
    if (!tab) {
      tab = { generation: 1, uids: ["g1-1", "g1-2"] };
      tabs.set(session, tab);
    }
    return tab;
  };
  const checkUid = (session, uid) => {
    const tab = tabFor(session);
    const m = /^g(\d+)-(\d+)$/.exec(uid);
    if (!m) throw mockError("UID_NOT_FOUND", `uid ${uid} was never issued`);
    if (Number(m[1]) !== tab.generation) throw mockError("UID_STALE", `uid ${uid} is stale`);
    if (!tab.uids.includes(uid)) throw mockError("UID_NOT_FOUND", `uid ${uid} not in snapshot`);
  };
  return {
    kind: "mock",
    chromePid: () => null,
    async launch() {
      launched = true;
      await sleep(120);
    },
    async navigate(session, url) {
      if (!launched) throw mockError("CHROME_DEAD", "not launched");
      const tab = tabFor(session);
      tab.generation += 1;
      tab.uids = [`g${tab.generation}-1`, `g${tab.generation}-2`];
      await jitter(latency.navigate);
      return { tabId: `mock-${session}`, url, title: "Mock page", status: 200 };
    },
    async snapshot(session) {
      if (!launched) throw mockError("CHROME_DEAD", "not launched");
      const tab = tabFor(session);
      await jitter(latency.snapshot);
      const nodes = tab.uids.map((uid, i) => ({
        uid,
        role: i === 0 ? "textbox" : "button",
        name: i === 0 ? "Email" : "Sign in",
      }));
      return {
        tabId: `mock-${session}`,
        url: "mock://page",
        text: nodes.map((n) => `[${n.uid}] ${n.role} "${n.name}"`).join("\n"),
        nodes,
        truncated: false,
        generation: tab.generation,
      };
    },
    async click(session, uid) {
      if (!launched) throw mockError("CHROME_DEAD", "not launched");
      checkUid(session, uid);
      await jitter(latency.click);
      return { ok: true };
    },
    async fill(session, uid) {
      if (!launched) throw mockError("CHROME_DEAD", "not launched");
      checkUid(session, uid);
      await jitter(latency.fill);
      return { ok: true };
    },
    async screenshot(session) {
      if (!launched) throw mockError("CHROME_DEAD", "not launched");
      tabFor(session);
      await jitter(latency.screenshot);
      return { bytes: 42000, width: 1280, height: 800 };
    },
    async close() {
      launched = false;
    },
  };
}

// ---------------------------------------------------------------------------
// Workload
// ---------------------------------------------------------------------------

async function runOnce(driver, { sessions, calls, fixture }) {
  const perMethod = { navigate: [], snapshot: [], click: [], fill: [], screenshot: [] };
  let collisions = 0;
  let failures = 0;
  const rssSamples = [];
  const selfPid = process.pid;
  const chromePid = typeof driver.chromePid === "function" ? driver.chromePid() : null;

  const sampler = setInterval(() => {
    rssSamples.push({
      t: Date.now(),
      selfMb: round2(readVmRssKb(selfPid) / 1024),
      treeMb: round2(chromePid ? processTreeRssMb(chromePid) : readVmRssKb(selfPid) / 1024),
    });
  }, 1000);
  // Never let a hanging interval keep the process alive.
  sampler.unref?.();

  const runSession = async (index) => {
    const session = `bench-ses-${index}`;
    const lastUids = [];
    for (let i = 0; i < calls; i++) {
      const method = METHODS[i % METHODS.length];
      const start = performance.now();
      try {
        if (method === "navigate") {
          await driver.navigate(session, fixture);
        } else if (method === "snapshot") {
          const snap = await driver.snapshot(session);
          lastUids.length = 0;
          for (const node of snap.nodes ?? []) lastUids.push(node.uid);
        } else if (method === "click") {
          await driver.click(session, lastUids[0] ?? "g0-0");
        } else if (method === "fill") {
          await driver.fill(session, lastUids[1] ?? lastUids[0] ?? "g0-0", "bench@example.com");
        } else {
          await driver.screenshot(session);
        }
        perMethod[method].push(performance.now() - start);
      } catch (error) {
        perMethod[method].push(performance.now() - start);
        if (error?.code === "TAB_FORBIDDEN") collisions += 1;
        else failures += 1;
      }
    }
  };

  const startAll = performance.now();
  await Promise.all(Array.from({ length: sessions }, (_, i) => runSession(i)));
  const wallMs = performance.now() - startAll;
  clearInterval(sampler);
  // Guarantee at least one sample: sub-second runs finish before the 1Hz
  // sampler fires, which would otherwise report a peak of 0.
  rssSamples.push({
    t: Date.now(),
    selfMb: round2(readVmRssKb(selfPid) / 1024),
    treeMb: round2(chromePid ? processTreeRssMb(chromePid) : readVmRssKb(selfPid) / 1024),
  });
  const peakTreeMb = rssSamples.length > 0 ? Math.max(...rssSamples.map((s) => s.treeMb)) : 0;

  return { perMethod, collisions, failures, wallMs: round2(wallMs), peakTreeMb: round2(peakTreeMb), rssSamples };
}

async function soak(driver, minutes) {
  if (!(minutes > 0)) return null;
  const samples = [];
  const totalMs = minutes * 60 * 1000;
  const stepMs = Math.min(5000, Math.max(1000, totalMs / 12));
  const start = Date.now();
  const chromePid = typeof driver.chromePid === "function" ? driver.chromePid() : null;
  while (Date.now() - start < totalMs) {
    await new Promise((r) => setTimeout(r, stepMs));
    samples.push({
      t: Date.now(),
      selfMb: round2(readVmRssKb(process.pid) / 1024),
      treeMb: round2(chromePid ? processTreeRssMb(chromePid) : readVmRssKb(process.pid) / 1024),
    });
  }
  if (samples.length < 2) {
    return { minutes, driftPct: 0, samples, note: "too few samples" };
  }
  const first = samples[0].treeMb || 1;
  const last = samples[samples.length - 1].treeMb;
  return { minutes, driftPct: round2(((last - first) / first) * 100), samples };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function methodTable(summaries) {
  const rows = METHODS.map((method) => {
    const summary = summaries[method] ?? { n: 0, p50: 0, p95: 0, max: 0 };
    return `| ${method} | ${summary.n} | ${summary.p50} | ${summary.p95} | ${summary.max} |`;
  });
  return ["| method | n | p50 ms | p95 ms | max ms |", "|---|---|---|---|---|", ...rows].join("\n");
}

/// CI regression guard: fail when any warm p95 (per method + aggregate)
/// regresses more than `maxPct`% versus a committed baseline results.json.
/// Same driver, same fixture, same machine class — otherwise the comparison
/// is meaningless and the guard must not run.
function evaluateGuard(current, baselinePath, maxPct) {
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  if (!baseline.warm?.byMethod || current.warm == null) {
    throw new Error(`${baselinePath} has no warm.byMethod stats`);
  }
  const deltas = [];
  const keys = [...METHODS, "all"];
  for (const key of keys) {
    const base = key === "all" ? baseline.warm.all?.p95 : baseline.warm.byMethod[key]?.p95;
    const cur = key === "all" ? current.warm.all.p95 : current.warm.byMethod[key]?.p95;
    if (typeof base !== "number" || typeof cur !== "number" || base <= 0) {
      deltas.push({ key, base, cur, pct: null, ok: true, note: "no baseline" });
      continue;
    }
    const pct = round2(((cur - base) / base) * 100);
    deltas.push({ key, base, cur, pct, ok: pct <= maxPct, note: "" });
  }
  const failures = deltas.filter((d) => !d.ok);
  const lines = [
    `Baseline: \`${baselinePath}\` (generated ${baseline.generatedAt ?? "unknown"}), threshold: +${maxPct}% warm p95.`,
    ...deltas.map((d) =>
      d.pct == null
        ? `- ${d.key}: cur=${d.cur}ms, no baseline — skipped.`
        : `- ${d.key}: base=${d.base}ms cur=${d.cur}ms (${d.pct >= 0 ? "+" : ""}${d.pct}%) ${d.ok ? "OK" : "**REGRESSED**"}`,
    ),
    failures.length === 0
      ? "Guard: **PASS** — no warm p95 regressed beyond the threshold."
      : `Guard: **FAIL** — ${failures.length} warm p95(s) regressed >+${maxPct}%: ${failures.map((f) => f.key).join(", ")}.`,
  ];
  return { baseline: baselinePath, maxRegressionPct: maxPct, pass: failures.length === 0, deltas, lines };
}

function buildReport(results, comparison, guard) {
  const { config, cold, warm, rss, collisions, failures, soak: soakResult } = results;
  let verdict;
  let killBox;
  if (!comparison) {
    verdict = "**INCONCLUSIVE** — single-baseline run. Run both baselines (A: JS, B: Rust daemon) and re-run with `--compare <other-results.json` to evaluate the kill rule.";
    killBox = [
      "> **Pre-registered kill rule:** if Rust shows **<20% improvement** in marginal",
      "> memory per session **and** **<20%** in warm-call p95 versus baseline A,",
      "> do **not** ship the daemon as the default. Ship the JS driver instead.",
      "> (No `results.json` from the other baseline was supplied, so the rule",
      "> cannot be evaluated from this run alone.)",
    ].join("\n");
  } else {
    const rust = results.driverKind === "rust"
      ? results
      : comparison.driverKind === "rust"
        ? comparison
        : null;
    const js = rust === results ? comparison : results;
    if (!rust) {
      verdict = "**INCONCLUSIVE** — the `--compare` file is not a Rust-daemon result (`driverKind` must be `\"rust\"`, as produced by `browserd bench`). Supply the Baseline B results to evaluate the kill rule.";
      killBox = [
        "> **Pre-registered kill rule:** if Rust shows **<20% improvement** in marginal",
        "> memory per session **and** **<20%** in warm-call p95 versus baseline A,",
        "> do **not** ship the daemon as the default. Ship the JS driver instead.",
        `> (Compared ${results.driverKind} vs ${comparison.driverKind ?? "unknown"}: neither side is the Rust baseline.)`,
      ].join("\n");
    } else {
      const rssA = js.rss.marginalPerSessionMb || 0.01;
      const rssB = rust.rss.marginalPerSessionMb;
      const p95A = js.warm.all.p95 || 0.01;
      const p95B = rust.warm.all.p95;
      const rssWin = ((rssA - rssB) / rssA) * 100;
      const p95Win = ((p95A - p95B) / p95A) * 100;
      const kill = rssWin < 20 && p95Win < 20;
      verdict = kill
        ? `**KILL THE DAEMON DEFAULT** — Rust improves marginal RSS by ${round2(rssWin)}% and warm p95 by ${round2(p95Win)}%: both <20%. Recommendation: ship the JS driver as the default backend (per PRD §14).`
        : `**SHIP THE DAEMON** — Rust improves marginal RSS by ${round2(rssWin)}% and warm p95 by ${round2(p95Win)}%: at least one axis ≥20%. The daemon earns its complexity.`;
      killBox = [
        `> Marginal RSS/session: A=${rssA} MB vs B=${rssB} MB → Rust ${round2(rssWin)}% better.`,
        `> Warm-call p95 (all methods): A=${p95A} ms vs B=${p95B} ms → Rust ${round2(p95Win)}% better.`,
      ].join("\n");
    }
  }
  const soakLine = soakResult
    ? `Soak: ${soakResult.minutes} min, tree-RSS drift ${soakResult.driftPct}% (n=${soakResult.samples.length}).`
    : "Soak: not run (pass --soak-minutes 30 for the 30-min drift gate).";
  return [
    "# M3 benchmark report",
    "",
    `_Generated ${new Date().toISOString()} by scripts/bench.mjs._`,
    "",
    "## Config",
    "",
    "```json",
    JSON.stringify(config, null, 2),
    "```",
    "",
    "## Cold first call",
    "",
    `- Driver launch + first navigate: **${cold.launchPlusFirstNavigateMs} ms** (run 1, discarded from warm stats).`,
    "",
    "## Warm calls (first run discarded)",
    "",
    methodTable(warm.byMethod),
    "",
    `- All-methods aggregate: n=${warm.all.n}, p50=${warm.all.p50} ms, p95=${warm.all.p95} ms.`,
    "",
    "## Memory",
    "",
    `- Bench-process idle RSS: ${rss.selfIdleMb} MB.`,
    `- Peak total tree RSS by session count: ${Object.entries(rss.peakTreeMbBySessions).map(([k, v]) => `${k}=${v}MB`).join(", ")}.`,
    `- Marginal RSS/session: **${rss.marginalPerSessionMb} MB** (OLS slope across session counts, 95% CI [${rss.marginalSlopeCI95.lo}, ${rss.marginalSlopeCI95.hi}], R²=${rss.marginalR2})${rss.marginalNote ? ` — ${rss.marginalNote}` : ""}.`,
    ...(results.nFloorMet
      ? []
      : [`- n-floor WARNING: per-method n<${N_FLOOR} for ${METHODS.filter((m) => !results.nFloors[m]).join(",")}: p50/p95 are interpolation noise, re-run with more calls/runs.`]),
    `- Collisions (cross-session tab access): ${collisions}. Failures (other errors): ${failures}.`,
    `- ${soakLine}`,
    "",
    ...(guard
      ? [
          "## Regression guard",
          "",
          ...guard.lines,
          "",
        ]
      : []),
    "## Decision",
    "",
    killBox,
    "",
    verdict,
    "",
    "## Reproduce",
    "",
    "```sh",
    `node scripts/bench.mjs --driver ${config.driver} --sessions ${config.sessions.join(",")} --calls ${config.calls} --runs ${config.runs}`,
    "```",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function loadDriver(opts) {
  if (opts.driver === "mock") return createMockDriver();
  const modulePath = join(ROOT, "plugin", "legacy", "src", "driver", "js.ts");
  let mod;
  try {
    mod = await import(modulePath);
  } catch (error) {
    throw new Error(
      `could not load the JS driver from ${modulePath}: ${error.message}\n` +
        "hint: run under Node >= 22.18 (type stripping) or Bun; or use --driver mock",
    );
  }
  if (typeof mod.createBaselineDriver !== "function") {
    throw new Error(`driver module has no createBaselineDriver factory (got: ${Object.keys(mod).join(",")})`);
  }
  return mod.createBaselineDriver("js", { chromePath: opts.chrome || undefined });
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`error: ${error.message}\n\n${usage()}`);
    process.exit(2);
  }

  const driver = await loadDriver(opts);
  const allRuns = [];
  let coldMs = 0;

  for (const sessionCount of opts.sessions) {
    const perCount = [];
    for (let run = 0; run < opts.runs; run++) {
      const launchStart = performance.now();
      await driver.launch();
      const result = await runOnce(driver, { sessions: sessionCount, calls: opts.calls, fixture: opts.fixture });
      if (run === 0 && sessionCount === opts.sessions[0]) {
        coldMs = round2(performance.now() - launchStart);
      }
      perCount.push(result);
      await driver.close();
    }
    allRuns.push({ sessions: sessionCount, runs: perCount });
  }

  // Merge warm runs (drop run 0 of each session count) into per-method stats.
  const warmMethods = { navigate: [], snapshot: [], click: [], fill: [], screenshot: [] };
  let collisions = 0;
  let failures = 0;
  const peakTreeMbBySessions = {};
  for (const { sessions, runs } of allRuns) {
    const warm = opts.runs > 1 ? runs.slice(1) : runs.map((r, i) => (i === 0 ? { ...r } : r));
    peakTreeMbBySessions[String(sessions)] = Math.max(...runs.map((r) => r.peakTreeMb));
    for (const run of warm) {
      for (const method of METHODS) warmMethods[method].push(...run.perMethod[method]);
      collisions += run.collisions;
      failures += run.failures;
    }
  }

  const allWarm = METHODS.flatMap((m) => warmMethods[m]);
  const byMethod = {};
  for (const method of METHODS) byMethod[method] = summarize(warmMethods[method]);

  // Marginal RSS/session: ordinary least-squares slope of peak tree RSS
  // over session counts (Blind-spot #7: the old 2-point slope amplified
  // noise). Reports the slope, its two-sided 95% CI (t, df = n-2) and R².
  const xs = Object.keys(peakTreeMbBySessions).map(Number).sort((a, b) => a - b);
  const ys = xs.map((x) => peakTreeMbBySessions[String(x)]);
  const fit = olsSlopeCI(xs, ys);
  const marginal = fit.slope;

  // n≥30/method floor: percentiles on tiny samples are interpolation noise.
  const nFloors = {};
  for (const method of METHODS) nFloors[method] = byMethod[method].n >= N_FLOOR;
  const floorMet = METHODS.every((m) => nFloors[m]);

  let soakResult = null;
  if (opts.soakMinutes > 0) {
    await driver.launch();
    soakResult = await soak(driver, opts.soakMinutes);
    await driver.close();
  }

  const results = {
    version: 1,
    driverKind: driver.kind,
    generatedAt: new Date().toISOString(),
    config: {
      driver: opts.driver,
      sessions: opts.sessions,
      calls: opts.calls,
      runs: opts.runs,
      fixture: opts.fixture === FIXTURE_URL ? "embedded-data-url" : opts.fixture,
      soakMinutes: opts.soakMinutes,
    },
    cold: { launchPlusFirstNavigateMs: coldMs },
    warm: { byMethod, all: summarize(allWarm) },
    rss: {
      selfIdleMb: round2(readVmRssKb(process.pid) / 1024),
      peakTreeMbBySessions,
      marginalPerSessionMb: round2(marginal),
      marginalSlopeCI95: { lo: fit.lo, hi: fit.hi },
      marginalR2: fit.r2,
      marginalNote: fit.note,
    },
    nFloors,
    nFloorMet: floorMet,
    collisions,
    failures,
    soak: soakResult,
    guard: null,
  };

  if (opts.guard) {
    try {
      results.guard = evaluateGuard(results, opts.guard, opts.maxRegressionPct);
    } catch (error) {
      console.error(`error: cannot evaluate --guard: ${error.message}`);
      process.exit(2);
    }
  }

  let comparison = null;
  if (opts.compare) {
    try {
      comparison = JSON.parse(readFileSync(opts.compare, "utf8"));
    } catch (error) {
      console.error(`error: cannot read --compare file: ${error.message}`);
      process.exit(2);
    }
  }

  mkdirSync(dirname(opts.out), { recursive: true });
  // results.json is gitignored (bench/results/*.json) — it is an artifact, not a claim.
  writeFileSync(opts.out, `${JSON.stringify(results, null, 2)}\n`);
  mkdirSync(dirname(opts.report), { recursive: true });
  writeFileSync(opts.report, buildReport(results, comparison, results.guard));

  console.log(`driver=${results.driverKind} cold=${coldMs}ms warm-p50=${results.warm.all.p50}ms warm-p95=${results.warm.all.p95}ms marginal=${results.rss.marginalPerSessionMb}MB/ses CI95=[${results.rss.marginalSlopeCI95.lo},${results.rss.marginalSlopeCI95.hi}] R²=${results.rss.marginalR2} nFloor=${results.nFloorMet ? "ok" : "WARN"} collisions=${collisions} failures=${failures}`);
  console.log(`wrote ${opts.out}`);
  console.log(`wrote ${opts.report}`);
  if (!results.nFloorMet) {
    console.log(`warning: per-method n<${N_FLOOR} for ${METHODS.filter((m) => !results.nFloors[m]).join(",")}: p50/p95 are interpolation noise`);
  }
  if (results.guard) {
    console.log(`guard: ${results.guard.pass ? "PASS" : "FAIL"} vs ${results.guard.baseline} (threshold +${results.guard.maxRegressionPct}% warm p95)`);
    if (!results.guard.pass) process.exitCode = 1;
  }
}

await main();
