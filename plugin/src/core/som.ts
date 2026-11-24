/** Attribute the injected SoM annotator tags indexed nodes with. */
export const SOM_ATTRIBUTE = "data-opencode-id";

/** CSS selector for an indexed element id. */
export function somSelector(elementId: number): string {
  return `[${SOM_ATTRIBUTE}="${elementId}"]`;
}
