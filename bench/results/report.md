# M3 benchmark report

_Generated 2026-11-14T23:54:07.662Z by scripts/bench.mjs._

## Config

```json
{
  "driver": "mock",
  "sessions": [
    1,
    4,
    8
  ],
  "calls": 20,
  "runs": 3,
  "fixture": "embedded-data-url",
  "soakMinutes": 0
}
```

## Cold first call

- Driver launch + first navigate: **293.39 ms** (run 1, discarded from warm stats).

## Warm calls (first run discarded)

| method | n | p50 ms | p95 ms | max ms |
|---|---|---|---|---|
| navigate | 104 | 8.75 | 10.95 | 11.17 |
| snapshot | 104 | 11.01 | 13.07 | 13.44 |
| click | 104 | 4.71 | 5.77 | 6.01 |
| fill | 104 | 4.53 | 5.78 | 6.01 |
| screenshot | 104 | 12.61 | 15.18 | 15.66 |

- All-methods aggregate: n=520, p50=8.36 ms, p95=14.08 ms.

## Memory

- Bench-process idle RSS: 58.09 MB.
- Peak total tree RSS by session count: 1=54.86MB, 4=55.75MB, 8=57MB.
- Marginal RSS/session: **0.31 MB** (linear fit across session counts).
- Collisions (cross-session tab access): 0. Failures (other errors): 0.
- Soak: not run (pass --soak-minutes 30 for the 30-min drift gate).

## Decision

> **Pre-registered kill rule:** if Rust shows **<20% improvement** in marginal
> memory per session **and** **<20%** in warm-call p95 versus baseline A,
> do **not** ship the daemon as the default. Ship the JS driver instead.
> (No `results.json` from the other baseline was supplied, so the rule
> cannot be evaluated from this run alone.)

**INCONCLUSIVE** — single-baseline run. Run both baselines (A: JS, B: Rust daemon) and re-run with `--compare <other-results.json` to evaluate the kill rule.

## Reproduce

```sh
node scripts/bench.mjs --driver mock --sessions 1,4,8 --calls 20 --runs 3
```
