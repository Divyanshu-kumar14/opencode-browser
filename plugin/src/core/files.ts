/**
 * Files the browser touches: uploads read from the user's disk and downloads
 * write to it, so both are fenced.
 *
 * Uploads may only read regular files inside the allowed folders (the project
 * folder and the download folder). Paths are resolved through symlinks before
 * the check, so a link cannot point an upload at ~/.ssh.
 *
 * Downloads are saved to a private folder (0700) as private files (0600) under
 * a name that cannot climb out of it, and reported to the agent: in the turn
 * that started them, or the next turn when the browser begins the download
 * only after that turn has finished.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Download, Page } from "playwright";
import { InvalidInputError } from "./errors.ts";
import { sanitizePageText } from "../utils/formatter.ts";

/** Largest file one upload may send (50 MB). */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/**
 * Resolve upload paths (relative ones against the first root) to real files
 * inside `roots`. Throws InvalidInputError naming the first bad path.
 */
export function resolveUploadPaths(paths: readonly string[], roots: readonly string[]): string[] {
  if (paths.length === 0) throw new InvalidInputError("pass at least one file to upload");
  const realRoots = roots.map((root) => {
    try {
      return fs.realpathSync(root);
    } catch {
      return path.resolve(root);
    }
  });
  const first = realRoots[0] ?? process.cwd();
  return paths.map((requested) => {
    const candidate = path.resolve(first, requested);
    let real: string;
    try {
      real = fs.realpathSync(candidate);
    } catch {
      throw new InvalidInputError(`no such file: ${requested}`, "use a path inside the project folder");
    }
    const inside = realRoots.some((root) => real === root || real.startsWith(root + path.sep));
    if (!inside) {
      throw new InvalidInputError(
        `${requested} is outside the folders uploads may read (${realRoots.join(", ")})`,
        "copy the file into the project folder, or set OPENCODE_BROWSER_UPLOAD_DIR",
      );
    }
    const stat = fs.statSync(real);
    if (!stat.isFile()) throw new InvalidInputError(`${requested} is not a regular file`);
    if (stat.size > MAX_UPLOAD_BYTES) {
      throw new InvalidInputError(`${requested} is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`);
    }
    return real;
  });
}

const MAX_NAME = 120;

/** A download's suggested name, reduced to a safe single file name. */
export function safeDownloadName(suggested: string): string {
  const base = suggested.split(/[\\/]/).pop() ?? "";
  let name = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (name === "" || /^\.+$/.test(name)) return "download";
  if (name.length > MAX_NAME) {
    const ext = path.extname(name).slice(0, 16);
    name = name.slice(0, MAX_NAME - ext.length) + ext;
  }
  return name;
}

/** Create `dir` owner-only (0700); refuse a symlink or a non-directory. */
export function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new Error(`${dir} is not a directory (or is a symlink)`);
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid !== null && st.uid === uid && (st.mode & 0o777) !== 0o700) fs.chmodSync(dir, 0o700);
}

/** Saves every download on a tracked tab and reports it to that tab's turns. */
export class Downloads {
  private readonly notices = new WeakMap<object, string[]>();
  private readonly inFlight = new WeakMap<object, Set<Promise<void>>>();

  private readonly isOwned: (page: object) => boolean;

  /** Only downloads from tabs a session owns are saved; the user's are left to the browser. */
  constructor(
    private readonly dir: string,
    options: { readonly isOwned?: (page: object) => boolean } = {},
  ) {
    this.isOwned = options.isOwned ?? (() => true);
  }

  attach(page: Pick<Page, "on">): void {
    page.on("download", (download) => {
      if (!this.isOwned(page)) return;
      const job = this.save(page, download);
      const set = this.inFlight.get(page) ?? new Set();
      set.add(job);
      this.inFlight.set(page, set);
      void job.finally(() => set.delete(job));
    });
  }

  /** Wait briefly for downloads on `page` that are still being written. */
  async settle(page: object, timeoutMs: number): Promise<void> {
    const pending = [...(this.inFlight.get(page) ?? [])];
    if (pending.length === 0) return;
    await Promise.race([Promise.all(pending), new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
  }

  /** Reports for the downloads finished since the last call. */
  take(page: object): string[] {
    const out = this.notices.get(page) ?? [];
    this.notices.delete(page);
    return out;
  }

  private async save(page: object, download: Pick<Download, "suggestedFilename" | "saveAs" | "failure">): Promise<void> {
    const name = safeDownloadName(download.suggestedFilename());
    const shown = sanitizePageText(name);
    let report: string;
    try {
      ensurePrivateDir(this.dir);
      const file = path.join(this.dir, `${Date.now()}-${crypto.randomBytes(3).toString("hex")}-${name}`);
      await download.saveAs(file);
      fs.chmodSync(file, 0o600);
      const kb = Math.max(1, Math.round(fs.statSync(file).size / 1024));
      report = `saved "${shown}" (${kb} KB) to ${file}`;
    } catch (error) {
      const reason = (await download.failure().catch(() => null)) ?? (error instanceof Error ? error.message : String(error));
      report = `"${shown}" failed: ${sanitizePageText(String(reason)).slice(0, 200)}`;
    }
    const list = this.notices.get(page) ?? [];
    list.push(report);
    this.notices.set(page, list);
  }
}
