/**
 * Site rules: which hosts agent tabs may load. Pure matching, no browser.
 */
import { describe, expect, test } from "bun:test";
import { blockedReason, parseSiteRules } from "../src/core/site-rules.ts";

const rules = (allow: string, deny: string) => parseSiteRules(allow, deny);

describe("site rules", () => {
  test("no rules allow everything", () => {
    const r = rules("", "");
    expect(r.active).toBe(false);
    expect(blockedReason("https://anything.test/x", r)).toBeNull();
  });

  test("a plain host covers itself and its subdomains, not look-alikes", () => {
    const r = rules("", "example.com");
    expect(blockedReason("https://example.com/", r)).toContain("example.com");
    expect(blockedReason("https://www.example.com/a?b", r)).toContain("example.com");
    expect(blockedReason("https://badexample.com/", r)).toBeNull();
    expect(blockedReason("https://example.com.evil.test/", r)).toBeNull();
  });

  test("*.host covers subdomains only", () => {
    const r = rules("", "*.corp.net");
    expect(blockedReason("https://wiki.corp.net/", r)).not.toBeNull();
    expect(blockedReason("https://corp.net/", r)).toBeNull();
  });

  test("host:port pins the port", () => {
    const r = rules("", "localhost:3000");
    expect(blockedReason("http://localhost:3000/", r)).not.toBeNull();
    expect(blockedReason("http://localhost:4000/", r)).toBeNull();
  });

  test("an allow list blocks every other host; deny wins over allow", () => {
    const r = rules("docs.example.com, github.com", "gist.github.com");
    expect(blockedReason("https://docs.example.com/x", r)).toBeNull();
    expect(blockedReason("https://github.com/a/b", r)).toBeNull();
    expect(blockedReason("https://news.test/", r)).toContain("not in OPENCODE_BROWSER_ALLOW_ORIGINS");
    expect(blockedReason("https://gist.github.com/x", r)).toContain("OPENCODE_BROWSER_DENY_ORIGINS");
  });

  test("about:blank and data: frames are never blocked", () => {
    const r = rules("example.com", "");
    expect(blockedReason("about:blank", r)).toBeNull();
    expect(blockedReason("about:srcdoc", r)).toBeNull();
  });

  test("hosts are matched case-insensitively, ignoring a trailing dot and the scheme", () => {
    const r = rules("", "Example.COM.");
    expect(blockedReason("https://EXAMPLE.com/", r)).not.toBeNull();
    expect(blockedReason("http://example.com./", r)).not.toBeNull();
  });

  test("IP addresses match exactly", () => {
    const r = rules("", "10.0.0.5");
    expect(blockedReason("http://10.0.0.5:8080/", r)).not.toBeNull();
    expect(blockedReason("http://10.0.0.50/", r)).toBeNull();
  });

  test("junk entries are ignored, not fatal", () => {
    const r = rules(" , ,", " ,https://, ");
    expect(r.active).toBe(false);
  });

  test("an entry written as a URL is read as its host", () => {
    const r = rules("", "https://example.com/path");
    expect(blockedReason("https://example.com/other", r)).not.toBeNull();
  });
});
