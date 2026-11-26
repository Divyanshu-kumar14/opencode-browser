/**
 * Site rules: which hosts the agent's tabs may load.
 *
 *   OPENCODE_BROWSER_DENY_ORIGINS   hosts the agent may never load
 *   OPENCODE_BROWSER_ALLOW_ORIGINS  when set, the only hosts it may load
 *
 * Entries are comma-separated. `example.com` covers the host and its
 * subdomains; `*.corp.net` covers subdomains only; `host:port` pins a port. A
 * deny entry wins over an allow entry. `about:` pages are never blocked.
 */

export interface SitePattern {
  readonly host: string;
  readonly subdomainsOnly: boolean;
  readonly port: string | null;
  readonly text: string;
}

export interface SiteRules {
  readonly allow: readonly SitePattern[];
  readonly deny: readonly SitePattern[];
  /** True when any rule is set (only then are navigations checked). */
  readonly active: boolean;
}

function parseList(raw: string): SitePattern[] {
  const out: SitePattern[] = [];
  for (const piece of raw.split(",")) {
    let entry = piece.trim().toLowerCase();
    if (entry === "") continue;
    // Accept an entry written as a URL.
    if (entry.includes("://")) {
      try {
        const url = new URL(entry);
        entry = url.host;
      } catch {
        continue;
      }
    }
    let subdomainsOnly = false;
    if (entry.startsWith("*.")) {
      subdomainsOnly = true;
      entry = entry.slice(2);
    }
    let port: string | null = null;
    const colon = entry.lastIndexOf(":");
    if (colon > 0 && /^\d+$/.test(entry.slice(colon + 1))) {
      port = entry.slice(colon + 1);
      entry = entry.slice(0, colon);
    }
    entry = entry.replace(/\.$/, "");
    if (entry === "" || /[/\s]/.test(entry)) continue;
    out.push({ host: entry, subdomainsOnly, port, text: piece.trim() });
  }
  return out;
}

export function parseSiteRules(allow: string, deny: string): SiteRules {
  const a = parseList(allow);
  const d = parseList(deny);
  return { allow: a, deny: d, active: a.length > 0 || d.length > 0 };
}

function matches(pattern: SitePattern, host: string, port: string): boolean {
  if (pattern.port !== null && pattern.port !== port) return false;
  if (host === pattern.host) return !pattern.subdomainsOnly;
  return host.endsWith("." + pattern.host);
}

/** Why `url` may not be loaded in an agent tab, or null when it may. */
export function blockedReason(url: string, rules: SiteRules): string | null {
  if (!rules.active) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  const denied = rules.deny.find((p) => matches(p, host, port));
  if (denied) return `${host} is blocked by OPENCODE_BROWSER_DENY_ORIGINS (${denied.text})`;
  if (rules.allow.length > 0 && !rules.allow.some((p) => matches(p, host, port))) {
    return `${host} is not in OPENCODE_BROWSER_ALLOW_ORIGINS`;
  }
  return null;
}
