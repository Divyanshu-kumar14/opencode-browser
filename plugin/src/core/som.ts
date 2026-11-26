/** Page globals the injected scripts install (HUD and SoM indexer). */
export const PAGE_GLOBALS = {
  hud: "__opencodeHud",
  som: "__opencodeSom",
  /** Binding the host exposes for the HUD's Stop button; the HUD captures and removes it. */
  stop: "__opencodeStop",
} as const;

/** Tag of the HUD host element; the annotator never indexes anything inside it. */
export const HUD_TAG = "opencode-agent-hud";

/** Attribute the injected SoM annotator tags indexed nodes with. */
export const SOM_ATTRIBUTE = "data-opencode-id";

/** CSS selector for an indexed element id. */
export function somSelector(elementId: number): string {
  return `[${SOM_ATTRIBUTE}="${elementId}"]`;
}

/**
 * Implicit role per tag. The annotator uses it to derive a role when the
 * element has none, and the formatter uses it to omit redundant roles. One
 * table, so the two cannot drift.
 */
export const IMPLICIT_ROLE_BY_TAG: Readonly<Record<string, string>> = {
  a: "link",
  button: "button",
  input: "textbox",
  select: "listbox",
  textarea: "textbox",
  summary: "button",
  details: "button",
};
