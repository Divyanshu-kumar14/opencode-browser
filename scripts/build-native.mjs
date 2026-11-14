#!/usr/bin/env node
/**
 * Build the release daemon binary and stage it for packaging.
 *
 * Steps (IMPLEMENTATION-PLAN.md Phase 6): `cargo build --release`, `strip`,
 * copy to `prebuilds/linux-x64/browserd`, `chmod 755`. Prints the staged
 * binary size so the ≤20MB compressed package budget stays visible.
 */
import { accessSync, chmodSync, constants, copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);

function usage() {
  return [
    "usage: node scripts/build-native.mjs [options]",
    "",
    "options:",
    "  --manifest-path PATH   Cargo.toml to build (default: daemon/Cargo.toml)",
    "  --out PATH             staged binary path (default: prebuilds/linux-x64/browserd)",
    "  --no-strip             skip the strip step (keeps symbols; larger binary)",
    "  --dry-run              print the steps without running them",
    "  --help                 print this help and exit 0",
  ].join("\n");
}

function parseArgs(argv) {
  const opts = {
    manifestPath: join(ROOT, "daemon", "Cargo.toml"),
    out: join(ROOT, "prebuilds", "linux-x64", "browserd"),
    strip: true,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else if (arg === "--manifest-path") {
      const value = argv[++i];
      if (!value) throw new Error("--manifest-path needs a value");
      opts.manifestPath = resolve(value);
    } else if (arg === "--out") {
      const value = argv[++i];
      if (!value) throw new Error("--out needs a value");
      opts.out = resolve(value);
    } else if (arg === "--no-strip") {
      opts.strip = false;
    } else if (arg === "--dry-run") {
      opts.dryRun = true;
    } else {
      throw new Error(`unknown flag ${arg} (see --help)`);
    }
  }
  return opts;
}

function run(cmd, args, opts) {
  console.log(`+ ${cmd} ${args.join(" ")}`);
  if (opts.dryRun) return;
  const result = spawnSync(cmd, args, { stdio: "inherit" });
  if (result.error) {
    throw new Error(`${cmd} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${cmd} exited with status ${result.status}`);
  }
}

function which(binary) {
  const pathEnv = process.env["PATH"] ?? "";
  const sep = process.platform === "win32" ? ";" : ":";
  for (const dir of pathEnv.split(sep)) {
    const candidate = join(dir, binary);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not executable here; keep scanning.
    }
  }
  return null;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`error: ${error.message}\n\n${usage()}`);
    process.exit(2);
  }

  if (!existsSync(opts.manifestPath)) {
    console.error(`error: manifest not found: ${opts.manifestPath}`);
    process.exit(2);
  }

  run("cargo", ["build", "--release", "--manifest-path", opts.manifestPath], opts);

  const targetDir = join(dirname(opts.manifestPath), "target", "release");
  const built = join(targetDir, "browserd");
  if (!opts.dryRun && !existsSync(built)) {
    console.error(`error: expected binary missing after build: ${built}`);
    process.exit(1);
  }

  if (opts.strip) {
    const strip = which("strip");
    if (!strip && !opts.dryRun) {
      console.error("error: `strip` not found on PATH (binutils); re-run with --no-strip to skip");
      process.exit(1);
    }
    run("strip", [built], opts);
  }

  console.log(`+ mkdir -p ${dirname(opts.out)} && cp ${built} ${opts.out} && chmod 755 ${opts.out}`);
  if (!opts.dryRun) {
    mkdirSync(dirname(opts.out), { recursive: true });
    copyFileSync(built, opts.out);
    chmodSync(opts.out, 0o755);
    const sizeMb = statSync(opts.out).size / (1024 * 1024);
    console.log(`staged ${opts.out} (${sizeMb.toFixed(2)} MiB)`);
    if (sizeMb > 18) {
      console.warn(
        "warning: staged binary exceeds 18 MiB; the packed npm tarball budget is 20 MB compressed",
      );
    }
  }
}

await main();
