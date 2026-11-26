/**
 * File rules for uploads and downloads: an upload may only read a regular file
 * inside the allowed folders; a download is saved under a safe name.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { InvalidInputError } from "../src/core/errors.ts";
import { MAX_UPLOAD_BYTES, resolveUploadPaths, safeDownloadName } from "../src/core/files.ts";

let root = "";
let project = "";
let downloads = "";
let outside = "";

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-files-"));
  project = path.join(root, "project");
  downloads = path.join(root, "downloads");
  outside = path.join(root, "outside");
  for (const dir of [project, downloads, outside, path.join(project, "docs")]) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(project, "docs", "cv.pdf"), "pdf");
  fs.writeFileSync(path.join(downloads, "report.csv"), "a,b");
  fs.writeFileSync(path.join(outside, "secret.txt"), "nope");
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(project, "link-out.txt"));
  fs.symlinkSync(path.join(project, "docs", "cv.pdf"), path.join(project, "link-in.pdf"));
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const roots = () => [project, downloads];
const rejectsWith = (fn: () => unknown, fragment: string) => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidInputError);
    expect((error as Error).message).toContain(fragment);
    return;
  }
  throw new Error("expected InvalidInputError");
};

describe("upload paths", () => {
  test("a relative path resolves against the project folder", () => {
    expect(resolveUploadPaths(["docs/cv.pdf"], roots())).toEqual([fs.realpathSync(path.join(project, "docs", "cv.pdf"))]);
  });

  test("an absolute path inside any allowed folder is accepted, including a download", () => {
    const files = resolveUploadPaths([path.join(downloads, "report.csv"), path.join(project, "docs", "cv.pdf")], roots());
    expect(files).toHaveLength(2);
  });

  test("a path that climbs out of the folders is refused", () => {
    rejectsWith(() => resolveUploadPaths(["../outside/secret.txt"], roots()), "outside the folders uploads may read");
    rejectsWith(() => resolveUploadPaths([path.join(outside, "secret.txt")], roots()), "outside the folders uploads may read");
  });

  test("a symlink is judged by where it points", () => {
    rejectsWith(() => resolveUploadPaths(["link-out.txt"], roots()), "outside the folders uploads may read");
    expect(resolveUploadPaths(["link-in.pdf"], roots())).toEqual([fs.realpathSync(path.join(project, "docs", "cv.pdf"))]);
  });

  test("a folder, a missing file, or nothing at all is refused", () => {
    rejectsWith(() => resolveUploadPaths(["docs"], roots()), "not a regular file");
    rejectsWith(() => resolveUploadPaths(["docs/missing.pdf"], roots()), "no such file");
    rejectsWith(() => resolveUploadPaths([], roots()), "at least one file");
  });

  test("a file over the size limit is refused", () => {
    const big = path.join(project, "big.bin");
    fs.writeFileSync(big, "");
    fs.truncateSync(big, MAX_UPLOAD_BYTES + 1);
    rejectsWith(() => resolveUploadPaths(["big.bin"], roots()), "larger than");
    fs.rmSync(big);
  });

  test("a prefix of an allowed folder's name does not count as inside it", () => {
    const sibling = project + "-evil";
    fs.mkdirSync(sibling, { recursive: true });
    fs.writeFileSync(path.join(sibling, "x.txt"), "x");
    rejectsWith(() => resolveUploadPaths([path.join(sibling, "x.txt")], roots()), "outside the folders uploads may read");
  });
});

describe("download names", () => {
  test("keeps an ordinary name", () => {
    expect(safeDownloadName("report-2026.pdf")).toBe("report-2026.pdf");
  });

  test("drops any path, so a download cannot leave its folder", () => {
    expect(safeDownloadName("../../.bashrc")).toBe(".bashrc");
    expect(safeDownloadName("C:\\\\Windows\\\\evil.exe")).toBe("evil.exe");
    expect(safeDownloadName("a/b/c.txt")).toBe("c.txt");
  });

  test("removes control characters and caps the length, keeping the extension", () => {
    const name = safeDownloadName("in\u0000voice\n" + "x".repeat(300) + ".pdf");
    expect(name).not.toMatch(/[\u0000-\u001f]/);
    expect(name.length).toBeLessThanOrEqual(120);
    expect(name.endsWith(".pdf")).toBe(true);
  });

  test("falls back to 'download' for an empty or dot-only name", () => {
    expect(safeDownloadName("")).toBe("download");
    expect(safeDownloadName("..")).toBe("download");
    expect(safeDownloadName("/")).toBe("download");
  });
});
