/**
 * Set-of-Mark (SoM) + semantic perception script.
 *
 * Serialized as a string and injected into every tracked page via
 * `page.evaluate(DOM_ANNOTATOR_SCRIPT)`. Installs `window.__opencodeSom` with
 * `indexPage()`, `renderSoMOverlay()`, `removeSoMOverlay()` and `getElements()`.
 *
 * Traverses open shadow trees, filters occluded/invisible nodes, assigns
 * deterministic [1..N] IDs in reading order, caps + truncates for token
 * efficiency, and tags DOM nodes with SOM_ATTRIBUTE (`data-opencode-id`) for fast lookup.
 */

import { HUD_TAG, IMPLICIT_ROLE_BY_TAG, PAGE_GLOBALS, SOM_ATTRIBUTE } from "../core/som.ts";

export function makeDomAnnotatorScript(maxElements = 100): string {
  const script = `
(function(){
  if (window[${JSON.stringify(PAGE_GLOBALS.som)}]) return;
  // Top frame only: the SoM index is always built in the main frame.
  try {
    if (window.self !== window.top) return;
  } catch {
    return;
  }
  const MAX_ELEMENTS = ${maxElements};
  const ATTR = ${JSON.stringify(SOM_ATTRIBUTE)};
  const HUD_TAG = ${JSON.stringify(HUD_TAG)};
  const LABEL_MAX = 60;
  const SELECTOR =
    'a[href],button,input:not([type="hidden"]),textarea,select,summary,details,' +
    '[role],[contenteditable="true"],[onclick],[tabindex]';
  const ROLE_BY_TAG = ${JSON.stringify(IMPLICIT_ROLE_BY_TAG)};

  let indexed = []; // { id, tag, role, label, value, selectorFallback, bbox }
  const byId = new Map(); // id -> element

  // Fields whose value must never leave the page: passwords, card numbers,
  // card security codes, and one-time codes.
  const SENSITIVE_AUTOCOMPLETE = ["cc-number", "cc-csc", "one-time-code"];
  function isSensitive(el){
    if (!el || !el.getAttribute) return false;
    if (el.tagName === "INPUT" && String(el.type).toLowerCase() === "password") return true;
    const ac = (el.getAttribute("autocomplete") || "").toLowerCase().split(/\\s+/);
    for (const token of ac){
      if (SENSITIVE_AUTOCOMPLETE.indexOf(token) !== -1) return true;
    }
    return false;
  }

  function textOf(el){
    if (!el) return "";
    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel) return ariaLabel.trim();
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy){
      // A space-separated id list; ids resolve in the element's own (shadow)
      // root first, then the document.
      const owner = el.ownerDocument || document;
      const root = el.getRootNode ? el.getRootNode() : owner;
      const parts = [];
      for (const id of labelledBy.split(/\\s+/)){
        if (!id) continue;
        let ref = null;
        if (root && root !== owner && typeof root.getElementById === "function") ref = root.getElementById(id);
        if (!ref) ref = owner.getElementById(id);
        if (!ref) continue;
        const t = (ref.textContent || "").trim();
        if (t) parts.push(t);
      }
      const joined = parts.join(" ");
      if (joined) return joined;
    }
    // associated label for inputs / custom controls
    const idAttr = el.getAttribute("id");
    if (idAttr){
      const label = (el.ownerDocument || document).querySelector('label[for="' + idAttr.replace(/"/g, '\\"') + '"]');
      if (label) return (label.textContent || "").trim();
    }
    // wrapping label
    let node = el;
    for (let i = 0; i < 3 && node; i++, node = node.parentElement){
      if (node.tagName === "LABEL") return (node.textContent || "").trim();
    }
    const placeholder = el.getAttribute("placeholder");
    if (placeholder) return placeholder.trim();
    const value = isSensitive(el) ? undefined : el.value;
    if (value !== undefined && value !== "") return value.trim();
    const title = el.getAttribute("title");
    if (title) return title.trim();
    const href = el.getAttribute("href");
    if (href) return href;
    const text = (el.textContent || "").trim();
    return text;
  }

  function truncate(s){
    s = String(s).replace(/\\s+/g, " ").trim();
    if (s.length > LABEL_MAX) s = s.slice(0, LABEL_MAX - 1).trim() + "…";
    return s;
  }

  function roleOf(el){
    const r = el.getAttribute("role");
    if (r) return r;
    const tag = el.tagName.toLowerCase();
    return ROLE_BY_TAG[tag] || tag;
  }

  function labelOf(el){
    return truncate(textOf(el));
  }

  function matchesInteractive(el){
    if (!el || el.nodeType !== 1 || !el.matches) return false;
    try {
      return el.matches(SELECTOR);
    } catch {
      return false;
    }
  }

  // Iframes: same-origin frame documents are walked from here, up to this
  // depth. Cross-origin frames cannot be read and are reported by origin.
  const MAX_FRAME_DEPTH = 3;
  // The element's own window (a same-origin frame's, or this one).
  function winOf(el){
    return (el.ownerDocument && el.ownerDocument.defaultView) || window;
  }
  // Offset of a frame document's viewport within the top viewport.
  function frameOffset(doc){
    let x = 0, y = 0;
    let w = doc.defaultView;
    while (w && w !== window){
      const fe = w.frameElement;
      if (!fe) break;
      const r = fe.getBoundingClientRect();
      const cs = fe.ownerDocument.defaultView.getComputedStyle(fe);
      x += r.x + fe.clientLeft + (parseFloat(cs.paddingLeft) || 0);
      y += r.y + fe.clientTop + (parseFloat(cs.paddingTop) || 0);
      w = fe.ownerDocument.defaultView;
    }
    return { x, y };
  }
  // The iframe element in the top document that contains this document.
  function outermostFrame(doc){
    let w = doc.defaultView, fe = null;
    while (w && w !== window){
      fe = w.frameElement;
      if (!fe) break;
      w = fe.ownerDocument.defaultView;
    }
    return fe;
  }
  // A rect in the top viewport, for an element in any same-origin document.
  function absRect(el){
    const r = el.getBoundingClientRect();
    if (el.ownerDocument === document) return r;
    const o = frameOffset(el.ownerDocument);
    return { x: r.x + o.x, y: r.y + o.y, width: r.width, height: r.height };
  }
  function visibleRect(el){
    const local = el.getBoundingClientRect();
    if (local.width < 4 || local.height < 4) return null;
    const style = winOf(el).getComputedStyle(el);
    if (style.display === "none") return null;
    if (style.visibility === "hidden") return null;
    if (style.opacity === "0") return null;
    if (style.pointerEvents === "none") return null;
    const doc = el.ownerDocument;
    if (doc !== document){
      // Inside a frame: the centre must lie within the frame's own viewport.
      const fw = doc.defaultView;
      const cx = local.x + local.width / 2, cy = local.y + local.height / 2;
      if (cx < 0 || cy < 0 || cx > fw.innerWidth || cy > fw.innerHeight) return null;
    }
    const r = absRect(el);
    return { x: r.x, y: r.y, width: r.width, height: r.height,
             centerX: r.x + r.width / 2, centerY: r.y + r.height / 2,
             localX: local.x + local.width / 2, localY: local.y + local.height / 2 };
  }

  function intersectsViewport(rect, buffer = 50){
    const vw = Math.max(document.documentElement.clientWidth, window.innerWidth || 0);
    const vh = Math.max(document.documentElement.clientHeight, window.innerHeight || 0);
    return !(rect.x + rect.width < -buffer || rect.y + rect.height < -buffer ||
              rect.x > vw + buffer || rect.y > vh + buffer);
  }

  // Hit-test through open shadow roots; document.elementFromPoint stops at
  // the shadow host.
  function deepElementFromPoint(x, y, doc){
    let hit = (doc || document).elementFromPoint(x, y);
    while (hit && hit.shadowRoot){
      const inner = hit.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    return hit;
  }

  // Node.contains across shadow boundaries (walks ShadowRoot.host).
  function composedContains(a, b){
    let n = b;
    while (n){
      if (n === a) return true;
      if (n.parentNode) n = n.parentNode;
      else if (n.host) n = n.host;
      else return false;
    }
    return false;
  }

  // Our own HUD and badge overlay never count as covering the page.
  function isAgentChrome(node){
    let n = node;
    while (n){
      if ((n.tagName && n.tagName.toLowerCase() === HUD_TAG) || n.id === "opencode-som-overlay") return true;
      if (n.parentNode) n = n.parentNode;
      else if (n.host) n = n.host;
      else return false;
    }
    return false;
  }

  function isOccluded(el, rect){
    const doc = el.ownerDocument;
    if (doc !== document){
      // The frame itself must be on top at this point in the top document...
      const topHit = deepElementFromPoint(Math.round(rect.centerX), Math.round(rect.centerY), document);
      const frame = outermostFrame(doc);
      if (topHit && topHit !== frame && !isAgentChrome(topHit)) return true;
      // ...and the element on top inside its own document.
      return occludedIn(doc, el, Math.round(rect.localX), Math.round(rect.localY));
    }
    return occludedIn(document, el, Math.round(rect.centerX), Math.round(rect.centerY));
  }
  function occludedIn(doc, el, cx, cy){
    const top = deepElementFromPoint(cx, cy, doc);
    if (!top) return false;
    if (top === el) return false;
    if (composedContains(el, top)) return false;
    if (isAgentChrome(top)) return false;
    // ancestor <label> covering the input is OK
    let anc = top;
    while (anc && anc !== doc.documentElement){
      if (anc === el) return false;
      if (anc.tagName === "LABEL") {
        // label covering its own control is fine
        const ctrl = anc.querySelector("input,select,textarea");
        if (ctrl && el.contains(ctrl)) return false;
        return false;
      }
      anc = anc.parentElement;
    }
    // within the same interactive control group -> not occluded
    return true; // covered by something else (modal, backdrop, etc.)
  }

  function isHiddenNativeInput(el){
    if (el.tagName !== "INPUT") return false;
    const style = winOf(el).getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (style.opacity === "0" || (r.width < 4 && r.height < 4)) return true;
    return false;
  }

  function collectFromRoot(root, out, visited, roots){
    if (!root || !root.querySelectorAll) return;
    if (roots) roots.add(root);
    try {
      const nodes = root.querySelectorAll(SELECTOR);
      for (const el of nodes){
        // Not instanceof HTMLElement: elements in a frame come from another realm.
        if (!el || el.nodeType !== 1 || !el.style) continue;
        if (visited.has(el)) continue;
        if (isHiddenNativeInput(el)) continue;
        visited.add(el);
        out.push(el);
      }
    } catch {}
    // recurse into shadow roots of all elements under this root
    try {
      const all = root.querySelectorAll("*");
      for (const el of all){
        // The agent's own HUD (Stop button, pill) is never part of the page.
        if (el.tagName.toLowerCase() === HUD_TAG) continue;
        if (el.nodeType === 1 && el.shadowRoot && !visited.has(el)){
          collectFromRoot(el.shadowRoot, out, visited, roots);
        }
      }
    } catch {}
  }

  function indexPage(){
    // Drop the ids from the previous indexing first: an element that leaves
    // the index must not keep an id that is about to be reused.
    for (const old of byId.values()){
      try { old.removeAttribute(ATTR); } catch {}
    }
    indexed = [];
    byId.clear();
    const visited = new Set();
    const candidates = [];
    const searchedRoots = new Set();
    collectFromRoot(document, candidates, visited, searchedRoots);
    // include document.body-level shadow hosts missed above (defensive)
    const roots = [document];
    const seenRoots = new Set([document]);
    const stack = [document.documentElement];
    while (stack.length){
      const node = stack.pop();
      if (!node || !node.shadowRoot) continue;
      if (!seenRoots.has(node.shadowRoot)){
        seenRoots.add(node.shadowRoot);
        collectFromRoot(node.shadowRoot, candidates, visited, searchedRoots);
        roots.push(node.shadowRoot);
      }
      for (let i = node.children.length - 1; i >= 0; i--){
        stack.push(node.children[i]);
      }
    }

    // Same-origin frames, breadth-first. A cross-origin frame cannot be read:
    // it is reported by origin and position only.
    const crossOrigin = [];
    const frameQueue = [];
    const queueFrames = (root, depth) => {
      if (depth > MAX_FRAME_DEPTH) return;
      let frames = [];
      try { frames = Array.from(root.querySelectorAll("iframe, frame")); } catch {}
      for (const fe of frames) frameQueue.push({ fe, depth });
    };
    for (const r of searchedRoots) queueFrames(r, 1);
    while (frameQueue.length){
      const { fe, depth } = frameQueue.shift();
      if (fe.closest && fe.closest(HUD_TAG)) continue;
      const box = visibleRect(fe);
      if (!box || !intersectsViewport(box)) continue;
      let fdoc = null;
      try { fdoc = fe.contentDocument; } catch {}
      if (!fdoc || !fdoc.documentElement){
        let origin = "";
        try { origin = new URL(fe.src || fe.getAttribute("src") || "", location.href).origin; } catch {}
        if (origin && origin !== "null") {
          crossOrigin.push({ origin, bbox: { x: Math.round(box.x), y: Math.round(box.y),
            width: Math.round(box.width), height: Math.round(box.height) } });
        }
        continue;
      }
      const before = new Set(searchedRoots);
      collectFromRoot(fdoc, candidates, visited, searchedRoots);
      for (const r of searchedRoots) if (!before.has(r)) queueFrames(r, depth + 1);
    }
    const rects = [];
    for (const el of candidates){
      if (isHiddenNativeInput(el)) continue;
      const rect = visibleRect(el);
      if (!rect) continue;
      if (!intersectsViewport(rect)) continue;
      if (isOccluded(el, rect)) continue;
      rects.push({ el, rect });
    }

    // natural reading order: top-to-bottom, then left-to-right
    rects.sort((a, b) => {
      const ay = Math.round(a.rect.y), by = Math.round(b.rect.y);
      if (ay !== by) return ay - by;
      return Math.round(a.rect.x) - Math.round(b.rect.x);
    });

    // Sweep ids that survived a lost byId (e.g. a re-installed script).
    for (const root of searchedRoots){
      try {
        for (const stale of root.querySelectorAll("[" + ATTR + "]")) stale.removeAttribute(ATTR);
      } catch {}
    }

    const out = [];
    let n = 0;
    for (const { el, rect } of rects){
      if (n >= MAX_ELEMENTS) break;
      n += 1;
      const id = n;
      const tag = el.tagName.toLowerCase();
      el.setAttribute(ATTR, String(id));
      const entry = {
        id, tag, role: roleOf(el), label: labelOf(el),
        value: el.value === undefined ? ""
          : isSensitive(el) ? (el.value ? "[redacted]" : "")
          : String(el.value),
        href: el.getAttribute("href") || "",
        disabled: el.disabled === true || el.getAttribute("aria-disabled") === "true",
        inFrame: el.ownerDocument !== document,
        selectorFallback: cssSelector(el),
        bbox: { x: Math.round(rect.x), y: Math.round(rect.y),
                width: Math.round(rect.width), height: Math.round(rect.height),
                centerX: Math.round(rect.centerX), centerY: Math.round(rect.centerY) },
      };
      out.push(entry);
      byId.set(id, el);
    }
    indexed = out;
    return { elements: out, count: out.length, capped: rects.length > MAX_ELEMENTS, frames: crossOrigin };
  }

  function cssSelector(el){
    if (el.id) return '#' + CSS.escape(el.id);
    const tag = el.tagName.toLowerCase();
    const cls = el.getAttribute("class");
    const classSel = cls ? '.' + cls.trim().split(/\\s+/).filter(Boolean).join('.') : '';
    const sel = tag + classSel;
    if (el.getAttribute(ATTR)) return '[' + ATTR + '="' + el.getAttribute(ATTR) + '"]';
    return sel;
  }

  function getElementById(id){
    return byId.get(id);
  }

  function renderSoMOverlay(){
    removeSoMOverlay();
    const overlay = document.createElement("div");
    overlay.id = "opencode-som-overlay";
    overlay.style.position = "fixed";
    overlay.style.top = "0"; overlay.style.left = "0";
    overlay.style.width = "100%"; overlay.style.height = "100%";
    overlay.style.zIndex = "2147483646";
    overlay.style.pointerEvents = "none";
    const vw = Math.max(document.documentElement.clientWidth, window.innerWidth || 0);
    const vh = Math.max(document.documentElement.clientHeight, window.innerHeight || 0);
    overlay.style.clipPath = "inset(0)";
    document.documentElement.appendChild(overlay);
    for (const entry of indexed){
      const el = byId.get(entry.id);
      const rect = el ? absRect(el) : null;
      if (!rect) continue;
      let left = rect.x, top = rect.y;
      // clamp badge inside viewport (12px badge size)
      const badge = 12;
      if (left + badge > vw) left = vw - badge;
      if (top + badge > vh) top = vh - badge;
      if (left < 0) left = 0;
      if (top < 0) top = 0;
      const b = document.createElement("div");
      b.style.position = "absolute";
      b.style.left = left + "px"; b.style.top = top + "px";
      b.style.width = badge + "px"; b.style.height = badge + "px";
      b.style.zIndex = "2147483646";
      b.style.pointerEvents = "none";
      b.style.background = "#ff4d4f";
      b.style.color = "#fff";
      b.style.fontFamily = "system-ui, sans-serif";
      b.style.fontSize = "10px"; b.style.fontWeight = "700";
      b.style.lineHeight = "1"; b.style.textAlign = "center";
      b.style.border = "1.5px dashed #fff";
      b.style.borderRadius = "2px";
      b.style.boxShadow = "0 1px 3px rgba(0,0,0,0.6)";
      b.textContent = String(entry.id);
      overlay.appendChild(b);
    }
  }

  function removeSoMOverlay(){
    const overlay = document.getElementById("opencode-som-overlay");
    if (overlay) overlay.remove();
  }

  window[${JSON.stringify(PAGE_GLOBALS.som)}] = {
    indexPage, renderSoMOverlay, removeSoMOverlay, getElements: () => indexed,
  };
})();
`;
  return script;
}

/** Default annotator (100-element cap) for callers that do not override it. */
export const DOM_ANNOTATOR_SCRIPT = makeDomAnnotatorScript();
