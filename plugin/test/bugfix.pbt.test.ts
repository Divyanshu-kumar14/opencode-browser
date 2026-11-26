/// <reference lib="dom" />
/**
 * Bug-sweep property-based tests (fast-check). Pure properties run without a
 * browser; DOM properties share one headless page.
 * Spec: .kiro/specs/browser-plugin-bug-sweep/
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fc from "fast-check";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { chromium } from "playwright";
import { BrowserSessionManager } from "../src/core/session-manager.ts";
import { PlaywrightBrowserSession } from "../src/core/browser-session.ts";
import type { ToolEditor } from "@opencode/plugin/promise/tool";
import type { Page } from "playwright";
import { checkNavigationUrl, redactUrl } from "../src/core/url-policy.ts";
import type { ToolResult } from "../src/core/turn.ts";
import { registerBrowserTools } from "../src/tools/index.ts";
import * as som from "../src/core/som.ts";
import { formatElementMap, type ElementLine } from "../src/utils/formatter.ts";
import { formatElementMap as oracleFormatElementMap } from "./oracle/formatter.ts";
import { makeDomAnnotatorScript as makeOracleAnnotator } from "./oracle/dom-annotator.ts";
import { Telemetry } from "../src/core/telemetry.ts";
import { Telemetry as OracleTelemetry } from "./oracle/telemetry.ts";
import { skipReason, startBrowser, startBugFixtureServer, type BrowserHandle, type FixtureServer } from "./harness.ts";

const CONTEXT = { sessionID: "ses_pbt", agent: "build", messageID: "msg_pbt", id: "call_pbt" };

let server: FixtureServer | null = null;
let env: BrowserHandle | null = null;
let launchError: string | null = null;

function ready(): boolean {
  if (env) return true;
  console.warn(`SKIP: ${skipReason(launchError)}`);
  return false;
}

function page(): Page {
  return env!.manager.tabs.active()!;
}

function text(result: { content: unknown }): string {
  const parts = result.content as Array<{ type: string; text?: string }>;
  return parts.find((p) => p.type === "text")?.text ?? "";
}

/** Replace the body of the shared page (the annotator stays installed). */
async function setBody(html: string): Promise<void> {
  await page().evaluate((h) => {
    const g = globalThis as unknown as Record<string, any>;
    g["scrollTo"](0, 0);
    g["document"].body.innerHTML = h;
  }, html);
}

beforeAll(async () => {
  server = startBugFixtureServer();
  try {
    env = await startBrowser();
    await env.session.turn({ kind: "navigate", action: "goto", url: server.url + "second" });
  } catch (error) {
    launchError = error instanceof Error ? error.message : String(error);
    env = null;
  }
}, 60000);

afterAll(async () => {
  await env?.close();
  server?.stop();
}, 60000);

// ---------------------------------------------------------------------------
// Group 1: security controls
// ---------------------------------------------------------------------------

const SENSITIVE_TOKENS = new Set(["cc-number", "cc-csc", "one-time-code"]);

describe("Group 1: security controls (PBT)", () => {
  test("1.6 a value appears in the map exactly when the field is not sensitive", async () => {
    if (!ready()) return;
    const field = fc.record({
      type: fc.constantFrom("text", "password", "email", "search", "tel"),
      tokens: fc.subarray(["section-x", "billing", "shipping", "cc-number", "cc-csc", "one-time-code", "email", "name"]),
      value: fc.stringMatching(/^[a-f0-9]{8}$/).map((s) => `v${s}z`),
    });
    await fc.assert(
      fc.asyncProperty(fc.uniqueArray(field, { minLength: 1, maxLength: 6, selector: (f) => f.value }), async (fields) => {
        await setBody(
          fields
            .map((f, i) => `<input id="f${i}" type="${f.type}" autocomplete="${f.tokens.join(" ")}" value="${f.value}"><br>`)
            .join(""),
        );
        const out = text(await env!.session.turn({ kind: "observe" }));
        for (const f of fields) {
          const sensitive = f.type === "password" || f.tokens.some((t) => SENSITIVE_TOKENS.has(t));
          expect({ f, shown: out.includes(f.value) }).toEqual({ f, shown: !sensitive });
        }
      }),
      { numRuns: 50 },
    );
  }, 120000);

  test("3.9 approved evals render JSON values, undefined, and thrown errors as on F", async () => {
    if (!ready()) return;
    const tools = new Map<string, { execute: (i: unknown, c: unknown) => Promise<ToolResult> }>();
    const editor = { add: (t: { name: string }) => tools.set(t.name, t as never) } as unknown as ToolEditor;
    registerBrowserTools(editor, { session: env!.session, permission: { assert: async () => undefined } }, "browse");
    const evalTool = tools.get("eval")!;
    const resultLine = (r: ToolResult): string => text(r).split("\n")[1] ?? "";

    const json = fc.jsonValue().filter((v) => !JSON.stringify(v).includes("__proto__"));
    await fc.assert(
      fc.asyncProperty(json, async (v) => {
        const encoded = JSON.stringify(v);
        const r = await evalTool.execute({ expression: `JSON.parse(${JSON.stringify(encoded)})` }, CONTEXT);
        expect(resultLine(r)).toBe(JSON.stringify(JSON.parse(encoded)));
        expect(r.metadata["threw"]).toBe(false);
      }),
      { numRuns: 50 },
    );
    const undef = await evalTool.execute({ expression: "undefined" }, CONTEXT);
    expect(resultLine(undef)).toBe("undefined");
    const thrown = await evalTool.execute({ expression: "(() => { throw new Error('x') })()" }, CONTEXT);
    expect(resultLine(thrown)).toStartWith("Error: ");
    expect(resultLine(thrown)).toContain("x");
    expect(thrown.metadata["threw"]).toBe(true);
  }, 120000);
});

describe("Group 1: URL policy (PBT, pure)", () => {
  const scheme = fc.constantFrom("http", "https", "about", "file", "javascript", "data", "chrome", "ftp", "ws", "blob", "HTTP");
  const host = fc.stringMatching(/^[a-z][a-z0-9-]{0,10}\.(test|example)$/);
  const seg = fc.stringMatching(/^[a-zA-Z0-9._~-]{0,8}$/);
  const url = fc
    .record({
      scheme,
      host,
      path: fc.array(seg, { maxLength: 3 }),
      query: fc.option(fc.stringMatching(/^[a-z]+=[a-z0-9]*$/), { nil: undefined }),
      hash: fc.option(fc.stringMatching(/^[a-z0-9]+$/), { nil: undefined }),
    })
    .map(({ scheme, host, path, query, hash }) => ({
      scheme,
      raw: `${scheme}://${host}/${path.join("/")}${query ? `?${query}` : ""}${hash ? `#${hash}` : ""}`,
    }));
  const ALLOWED = new Set(["http", "https", "about"]);

  test("checkNavigationUrl accepts exactly the allowed schemes", () => {
    fc.assert(
      fc.property(url, fc.boolean(), ({ scheme, raw }, allowFile) => {
        const s = scheme.toLowerCase();
        const allowed = ALLOWED.has(s) || (s === "file" && allowFile);
        let accepted = true;
        try {
          checkNavigationUrl(raw, { allowFile });
        } catch {
          accepted = false;
        }
        expect({ raw, allowFile, accepted }).toEqual({ raw, allowFile, accepted: allowed });
      }),
      { numRuns: 500 },
    );
  });

  test("garbage strings are rejected unless they parse as an allowed URL", () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        let parsed: URL | null = null;
        try {
          parsed = new URL(raw);
        } catch {
          parsed = null;
        }
        const allowed = parsed !== null && ALLOWED.has(parsed.protocol.slice(0, -1));
        let accepted = true;
        try {
          checkNavigationUrl(raw, { allowFile: false });
        } catch {
          accepted = false;
        }
        expect(accepted).toBe(allowed);
      }),
      { numRuns: 500 },
    );
  });

  test("redactUrl keeps origin and path, drops query and fragment, and is idempotent", () => {
    fc.assert(
      fc.property(url.filter((u) => u.scheme.startsWith("http") || u.scheme === "HTTP"), ({ raw }) => {
        const r = redactUrl(raw);
        const before = new URL(raw);
        const after = new URL(r);
        expect(after.origin).toBe(before.origin);
        expect(after.pathname).toBe(before.pathname);
        expect(r).not.toContain("?");
        expect(r).not.toContain("#");
        expect(redactUrl(r)).toBe(r);
      }),
      { numRuns: 500 },
    );
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const r = redactUrl(raw);
        expect(r).not.toContain("?");
        expect(r).not.toContain("#");
        expect(redactUrl(r)).toBe(r);
      }),
      { numRuns: 500 },
    );
  });
});

// ---------------------------------------------------------------------------
// Group 2: annotator and formatter
// ---------------------------------------------------------------------------

const IMPLICIT: Record<string, string> =
  (som as unknown as { IMPLICIT_ROLE_BY_TAG?: Record<string, string> }).IMPLICIT_ROLE_BY_TAG ?? {
    a: "link", button: "button", input: "textbox", select: "listbox",
    textarea: "textbox", summary: "button", details: "button",
  };

const TAGS = [...Object.keys(IMPLICIT), "div", "span"];

const elementLine = (opts: { redundantRoleOnly: boolean; disabled: boolean }) =>
  fc
    .record({
      tag: fc.constantFrom(...TAGS),
      roleKind: opts.redundantRoleOnly
        ? fc.constantFrom("empty", "tag", "implicit")
        : fc.constantFrom("empty", "tag", "implicit", "other"),
      other: fc.constantFrom("combobox", "tab", "menuitem", "switch", "link", "button", "x\ny"),
      label: fc.string({ maxLength: 12 }),
      value: fc.oneof(fc.constant(""), fc.constant("[redacted]"), fc.string({ maxLength: 8 })),
      href: fc.oneof(fc.constant(""), fc.string({ maxLength: 10 }).map((s) => `/p\u0001${s}`)),
      disabled: opts.disabled ? fc.option(fc.boolean(), { nil: undefined }) : fc.constant(undefined),
    })
    .map((r): ElementLine => {
      const role =
        r.roleKind === "empty" ? "" : r.roleKind === "tag" ? r.tag : r.roleKind === "implicit" ? IMPLICIT[r.tag] ?? r.tag : r.other;
      return {
        id: 0,
        tag: r.tag,
        role,
        label: r.label,
        value: r.value,
        href: r.href,
        selectorFallback: "",
        ...(r.disabled === undefined ? {} : { disabled: r.disabled }),
      };
    });

function numbered(lines: ElementLine[]): ElementLine[] {
  return lines.map((l, i) => ({ ...l, id: i + 1 }));
}

describe("Group 2: formatter (PBT, pure)", () => {
  test("1.23 role is printed iff non-redundant; disabled iff set", () => {
    fc.assert(
      fc.property(fc.array(elementLine({ redundantRoleOnly: false, disabled: true }), { minLength: 1, maxLength: 8 }), (raw) => {
        const els = numbered(raw);
        const lines = formatElementMap(els).split("\n");
        els.forEach((el, i) => {
          const line = lines[i]!;
          const head = line.slice(0, line.indexOf(">") + 1);
          const redundant = el.role === "" || el.role === el.tag || el.role === IMPLICIT[el.tag];
          expect({ el, role: head.includes(' role="') }).toEqual({ el, role: !redundant });
          expect({ el, disabled: head.endsWith(" disabled>") }).toEqual({ el, disabled: el.disabled === true });
        });
      }),
      { numRuns: 500 },
    );
  });

  test("Property 4: output equals the oracle formatter when neither role nor disabled applies", () => {
    expect(formatElementMap([{ id: 1, tag: "input", role: "textbox", label: "Email", value: "", selectorFallback: "#email" }])).toBe(
      '[1] <input> "Email"',
    );
    fc.assert(
      fc.property(fc.array(elementLine({ redundantRoleOnly: true, disabled: false }), { maxLength: 8 }), (raw) => {
        const els = numbered(raw);
        expect(formatElementMap(els)).toBe(oracleFormatElementMap(els));
      }),
      { numRuns: 500 },
    );
  });
});

interface Control {
  readonly key: number;
  readonly cell: number;
  readonly shadow: boolean;
  readonly covered: boolean;
}

interface RoundReport {
  readonly dupes: string[];
  readonly tagged: number;
  readonly count: number;
  readonly labels: string[];
  readonly visible: { key: number; covered: boolean }[];
}

/** Rebuild the control set on the shared page, scroll, index, and report. */
async function annotatorRound(controls: Control[], scrollY: number): Promise<RoundReport> {
  return page().evaluate(
    ({ controls, scrollY }) => {
      const COLS = 10;
      const cellXY = (cell: number) => ({ x: (cell % COLS) * 110 + 10, y: Math.floor(cell / COLS) * 34 + 10 });
      let stage = document.getElementById("pbt-stage");
      if (!stage) {
        document.body.innerHTML = "";
        stage = document.createElement("div");
        stage.id = "pbt-stage";
        stage.style.cssText = "position:relative;height:3000px;margin:0";
        document.body.style.margin = "0";
        document.body.appendChild(stage);
      }
      const wanted = new Set(controls.map((c) => String(c.key)));
      for (const node of Array.from(stage.querySelectorAll<HTMLElement>("[data-key]"))) {
        if (!wanted.has(node.dataset["key"]!)) node.remove();
      }
      for (const c of controls) {
        if (stage.querySelector(`[data-key="${c.key}"]`)) continue;
        const { x, y } = cellXY(c.cell);
        const box = `position:absolute;left:${x}px;top:${y}px;width:90px;height:26px;margin:0`;
        const wrap = document.createElement("div");
        wrap.dataset["key"] = String(c.key);
        if (c.shadow) {
          const host = document.createElement("div");
          host.style.cssText = box;
          const root = host.attachShadow({ mode: "open" });
          const b = document.createElement("button");
          b.textContent = `C${c.key}`;
          b.style.cssText = "width:90px;height:26px;margin:0";
          root.appendChild(b);
          wrap.appendChild(host);
        } else {
          const b = document.createElement("button");
          b.textContent = `C${c.key}`;
          b.style.cssText = box;
          wrap.appendChild(b);
        }
        if (c.covered) {
          const cover = document.createElement("div");
          cover.style.cssText = `${box};z-index:10;background:rgba(0,0,0,.3)`;
          wrap.appendChild(cover);
        }
        stage.appendChild(wrap);
      }
      window.scrollTo(0, scrollY);
      const result = (window as unknown as { __opencodeSom: { indexPage(): { count: number; elements: { label: string }[] } } })
        .__opencodeSom.indexPage();

      const counts: Record<string, number> = {};
      let tagged = 0;
      const visit = (root: Document | ShadowRoot): void => {
        for (const el of Array.from(root.querySelectorAll("[data-opencode-id]"))) {
          const k = el.getAttribute("data-opencode-id")!;
          counts[k] = (counts[k] ?? 0) + 1;
          tagged += 1;
        }
        for (const el of Array.from(root.querySelectorAll("*"))) if (el.shadowRoot) visit(el.shadowRoot);
      };
      visit(document);

      const vw = document.documentElement.clientWidth;
      const vh = window.innerHeight;
      const visible: { key: number; covered: boolean }[] = [];
      for (const c of controls) {
        const wrap = stage.querySelector(`[data-key="${c.key}"]`)!;
        const r = (wrap.firstElementChild as HTMLElement).getBoundingClientRect();
        if (r.top >= 0 && r.bottom <= vh && r.left >= 0 && r.right <= vw) visible.push({ key: c.key, covered: c.covered });
      }
      return {
        dupes: Object.entries(counts).filter(([, n]) => n > 1).map(([k]) => k),
        tagged,
        count: result.count,
        labels: result.elements.map((e) => e.label),
        visible,
      };
    },
    { controls, scrollY },
  );
}

describe("Group 2: annotator (PBT, one page)", () => {
  const control = fc.record({ cell: fc.nat({ max: 849 }), shadow: fc.boolean(), covered: fc.boolean() });
  const round = fc.record({
    inserts: fc.array(control, { maxLength: 6 }),
    removes: fc.array(fc.nat(), { maxLength: 3 }),
    scrollY: fc.nat({ max: 2200 }),
  });

  test("Property 3: unique ids, uncovered (shadow) controls present, covered ones absent", async () => {
    if (!ready()) return;
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(control, { minLength: 1, maxLength: 30, selector: (c) => c.cell }),
        fc.array(round, { minLength: 1, maxLength: 4 }),
        async (initial, rounds) => {
          await setBody("");
          let nextKey = 0;
          let controls: Control[] = initial.map((c) => ({ ...c, key: nextKey++ }));
          for (const r of rounds) {
            for (const idx of r.removes) {
              if (controls.length > 1) controls = controls.filter((_, i) => i !== idx % controls.length);
            }
            const used = new Set(controls.map((c) => c.cell));
            for (const ins of r.inserts) {
              if (used.has(ins.cell) || controls.length >= 30) continue;
              used.add(ins.cell);
              controls.push({ ...ins, key: nextKey++ });
            }
            const report = await annotatorRound(controls, r.scrollY);
            expect(report.dupes).toEqual([]);
            expect(report.tagged).toBe(report.count);
            for (const v of report.visible) {
              expect({ v, present: report.labels.includes(`C${v.key}`) }).toEqual({ v, present: !v.covered });
            }
          }
        },
      ),
      { numRuns: 25 },
    );
  }, 180000);

  test("Property 4: on pages outside the bug condition, the map equals the oracle annotator's", async () => {
    if (!ready()) return;
    await page().evaluate(makeOracleAnnotator(100));
    const elementHtml = fc.oneof(
      fc.string({ maxLength: 10 }).map((s) => `<button>${s.replace(/[<&]/g, "")}b</button>`),
      fc.nat({ max: 9 }).map((n) => `<a href="/p${n}">link ${n}</a>`),
      fc.constantFrom("text", "email", "search", "checkbox").map((t) => `<input type="${t}" placeholder="ph-${t}">`),
      fc.string({ maxLength: 6 }).map((s) => `<input value="${s.replace(/[<&"]/g, "")}v">`),
      fc.constant('<label for="lf">Labelled</label><input id="lf">'),
      fc.constant('<span id="one">Single</span><input aria-labelledby="one">'),
      fc.constant("<textarea>notes</textarea>"),
      fc.constant("<select><option>o1</option></select>"),
      fc.constant('<div tabindex="0">focusable</div>'),
      fc.constant("<details><summary>More</summary>body</details>"),
    );
    await fc.assert(
      fc.asyncProperty(fc.array(elementHtml, { minLength: 1, maxLength: 12 }), async (parts) => {
        // Top-left only: nothing near the HUD pill at the bottom-right.
        await setBody(`<div style="width:600px">${parts.join("<br>")}</div>`);
        const [live, oracle] = await page().evaluate(() => {
          const w = window as unknown as Record<string, { indexPage(): { elements: unknown[] } }>;
          return [w["__opencodeSom"]!.indexPage().elements, w["__opencodeSomOracle"]!.indexPage().elements];
        });
        expect(formatElementMap(live as ElementLine[])).toBe(oracleFormatElementMap(oracle as ElementLine[]));
      }),
      { numRuns: 25 },
    );
  }, 120000);
});

// ---------------------------------------------------------------------------
// Group 3: telemetry model (pure)
// ---------------------------------------------------------------------------

type TelOp =
  | { op: "console"; text: string }
  | { op: "response"; status: number; path: string; query: string | null; hash: string | null }
  | { op: "pageerror"; msg: string }
  | { op: "drain" };

function telemetryEmitter() {
  const handlers: Record<string, Array<(a: unknown) => void>> = {};
  return {
    page: { on: (e: string, f: (a: unknown) => void) => (handlers[e] ??= []).push(f) },
    emit: (e: string, a: unknown) => {
      for (const f of handlers[e] ?? []) f(a);
    },
  };
}

function rawUrl(op: Extract<TelOp, { op: "response" }>): string {
  return `https://api.test/${op.path}${op.query === null ? "" : `?${op.query}`}${op.hash === null ? "" : `#${op.hash}`}`;
}

/** Feed ops to a Telemetry implementation; return the drain results. */
function runTelemetry(t: { attach(p: never): void; drain(): { events: { text: string; source: string }[] } }, ops: TelOp[]) {
  const em = telemetryEmitter();
  t.attach(em.page as never);
  const drains: { text: string; source: string }[][] = [];
  for (const op of ops) {
    if (op.op === "drain") drains.push(t.drain().events.map((e) => ({ text: e.text, source: e.source })));
    else if (op.op === "console")
      em.emit("console", { type: () => "error", text: () => op.text, location: () => ({ url: "" }) });
    else if (op.op === "response")
      em.emit("response", { status: () => op.status, url: () => rawUrl(op), request: () => ({ method: () => "GET" }) });
    else {
      const e = new Error(op.msg);
      e.stack = `Error: ${op.msg}\n    at f (https://cdn.test/a.js?v=${op.msg}:1:2)`;
      em.emit("pageerror", e);
    }
  }
  drains.push(t.drain().events.map((e) => ({ text: e.text, source: e.source })));
  return drains;
}

/** Reference model: unbounded log, last `max` kept, drain since the last drain. */
function modelDrains(max: number, ops: TelOp[]) {
  interface Ev { seq: number; type: string; base: string; text: string; source: string; count: number }
  const log: Ev[] = [];
  let seq = 0;
  let lastDrain = 0;
  const kept = () => log.slice(Math.max(0, log.length - max));
  const drains: { text: string; source: string }[][] = [];
  const drain = () => {
    const out = kept().filter((e) => e.seq > lastDrain);
    lastDrain = seq;
    drains.push(out.map((e) => ({ text: e.text, source: e.source })));
  };
  for (const op of ops) {
    if (op.op === "drain") {
      drain();
      continue;
    }
    if (op.op === "console") {
      const base = `[ERROR] ${op.text} ((inline))`;
      const last = log[log.length - 1];
      if (last && last.type === "console" && last.base === base && last.seq > lastDrain) {
        last.count += 1;
        last.text = `${base} (x${last.count})`;
        continue;
      }
      log.push({ seq: ++seq, type: "console", base, text: base, source: "(console)", count: 1 });
    } else if (op.op === "response") {
      const clean = `https://api.test/${op.path}`;
      log.push({ seq: ++seq, type: "response", base: "", text: `[HTTP ${op.status}] GET ${clean}`, source: clean, count: 1 });
    } else {
      log.push({
        seq: ++seq,
        type: "pageerror",
        base: "",
        text: `[PAGE ERROR] ${op.msg} |     at f (https://cdn.test/a.js:1:2)`,
        source: "(page)",
        count: 1,
      });
    }
  }
  drain();
  return drains;
}

const telOp = (opts: { queries: boolean }): fc.Arbitrary<TelOp> =>
  fc.oneof(
    fc.constantFrom("a", "b", "c").map((text) => ({ op: "console" as const, text })),
    fc.record({
      op: fc.constant("response" as const),
      status: fc.constantFrom(400, 404, 500),
      path: fc.stringMatching(/^[a-z]{1,5}$/),
      query: opts.queries ? fc.option(fc.stringMatching(/^[a-z]+=[a-z0-9]+$/), { nil: null }) : fc.constant(null),
      hash: opts.queries ? fc.option(fc.stringMatching(/^[a-z0-9]+$/), { nil: null }) : fc.constant(null),
    }),
    fc.stringMatching(/^[a-z]{1,4}$/).map((msg) => ({ op: "pageerror" as const, msg })),
    fc.constant({ op: "drain" as const }),
  );

describe("Group 3: telemetry (PBT, pure)", () => {
  test("Property 5: every drain equals the reference model; nothing leaks a query, fragment, or userinfo", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 6 }), fc.array(telOp({ queries: true }), { maxLength: 60 }), (max, ops) => {
        const live = runTelemetry(new Telemetry(max), ops);
        expect(live).toEqual(modelDrains(max, ops));
        for (const e of live.flat()) {
          expect(e.text).not.toMatch(/[?#@]/);
          expect(e.source).not.toMatch(/[?#@]/);
        }
      }),
      { numRuns: 1000 },
    );
  });

  test("Property 6: a ring that never evicts and sees no query URLs drains like the oracle", () => {
    const noEvict = fc.integer({ min: 10, max: 20 }).chain((max) =>
      fc.tuple(
        fc.constant(max),
        fc
          .array(telOp({ queries: false }), { maxLength: 40 })
          .filter((ops) => ops.filter((o) => o.op !== "drain").length <= max),
      ),
    );
    fc.assert(
      fc.property(noEvict, ([max, ops]) => {
        // Console sources and stacks here carry no query, so redaction is a no-op.
        const stackFree = (t: Telemetry | OracleTelemetry) => {
          const em = telemetryEmitter();
          t.attach(em.page as never);
          const drains: { text: string; source: string }[][] = [];
          for (const op of ops) {
            if (op.op === "drain") drains.push(t.drain().events.map((e) => ({ text: e.text, source: e.source })));
            else if (op.op === "console")
              em.emit("console", { type: () => "error", text: () => op.text, location: () => ({ url: "https://cdn.test/app.js" }) });
            else if (op.op === "response")
              em.emit("response", { status: () => op.status, url: () => rawUrl(op), request: () => ({ method: () => "GET" }) });
            else {
              const e = new Error(op.msg);
              e.stack = `Error: ${op.msg}\n    at f (https://cdn.test/a.js:1:2)`;
              em.emit("pageerror", e);
            }
          }
          drains.push(t.drain().events.map((e) => ({ text: e.text, source: e.source })));
          return drains;
        };
        expect(stackFree(new Telemetry(max))).toEqual(stackFree(new OracleTelemetry(max)));
      }),
      { numRuns: 500 },
    );
  });
});

// ---------------------------------------------------------------------------
// Group 4: eval bound (one page)
// ---------------------------------------------------------------------------

describe("Group 4: eval bound (PBT, one page)", () => {
  test("Property 7/8: evals return before T - 50 ms, time out after T + 50 ms, never exceed T + 1000 ms", async () => {
    if (!ready()) return;
    const T = 300;
    const b = await startBrowser({ evalTimeoutMs: T });
    try {
      await b.session.turn({ kind: "navigate", action: "goto", url: server!.url + "second" });
      await fc.assert(
        fc.asyncProperty(fc.oneof(fc.integer({ min: 0, max: T - 51 }), fc.integer({ min: T + 51, max: 2 * T })), async (d) => {
          const started = Date.now();
          const r = await b.session.turn({
            kind: "evaluate",
            expression: `new Promise((resolve) => setTimeout(() => resolve(${d}), ${d}))`,
          });
          const elapsed = Date.now() - started;
          const line = text(r).split("\n")[1] ?? "";
          if (d < T - 50) expect({ d, line }).toEqual({ d, line: String(d) });
          else expect({ d, timedOut: line.startsWith("Error: timed out") }).toEqual({ d, timedOut: true });
          expect({ d, elapsed: elapsed <= T + 1000 }).toEqual({ d, elapsed: true });
        }),
        { numRuns: 10 },
      );
    } finally {
      await b.close();
    }
  }, 120000);
});

// ---------------------------------------------------------------------------
// Group 5: concurrency (cold manager per run)
// ---------------------------------------------------------------------------

describe("Group 5: concurrent turns (PBT)", () => {
  test("Property 9: k concurrent turns all fulfill, launch once, and never overlap", async () => {
    if (!ready()) return;
    const probe =
      "(async () => { window.__c = (window.__c || 0) + 1; window.__max = Math.max(window.__max || 0, window.__c);" +
      " await new Promise((r) => setTimeout(r, 30)); window.__c -= 1; return window.__max; })()";
    const original = chromium.launchPersistentContext;
    let launches = 0;
    chromium.launchPersistentContext = ((...args: Parameters<typeof original>) => {
      launches += 1;
      return original.apply(chromium, args);
    }) as typeof original;
    try {
      await fc.assert(
        fc.asyncProperty(fc.array(fc.constantFrom("observe", "evaluate", "wait"), { minLength: 2, maxLength: 5 }), async (kinds) => {
          launches = 0;
          const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-pbt-prof-"));
          const screenshotDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-pbt-shots-"));
          const manager = new BrowserSessionManager({ headless: true, profileDir, screenshotDir });
          const session = new PlaywrightBrowserSession(manager);
          try {
            const results = await Promise.allSettled(
              kinds.map((k) =>
                k === "observe"
                  ? session.turn({ kind: "observe" })
                  : k === "evaluate"
                    ? session.turn({ kind: "evaluate", expression: probe })
                    : session.turn({ kind: "act", actions: [{ type: "wait" }] }),
              ),
            );
            expect({ kinds, statuses: results.map((r) => r.status) }).toEqual({
              kinds,
              statuses: kinds.map(() => "fulfilled"),
            });
            expect(launches).toBe(1);
            const max = await manager.tabs.active()!.evaluate("window.__max || 0");
            expect(max as number).toBeLessThanOrEqual(1);
          } finally {
            await manager.close().catch(() => undefined);
            fs.rmSync(profileDir, { recursive: true, force: true });
            fs.rmSync(screenshotDir, { recursive: true, force: true });
          }
        }),
        { numRuns: 10 },
      );
    } finally {
      chromium.launchPersistentContext = original;
    }
  }, 180000);
});
