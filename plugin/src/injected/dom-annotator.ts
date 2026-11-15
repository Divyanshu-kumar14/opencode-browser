/**
 * Set-of-Mark (SoM) + semantic perception script.
 *
 * Serialized as a string and injected into every tracked page via
 * `page.evaluate(DOM_ANNOTATOR_SCRIPT)`. Installs `window.__opencodeSom` with
 * `indexPage()`, `renderSoMOverlay()`, `removeSoMOverlay()` and `getElements()`.
 *
 * Traverses open shadow trees, filters occluded/invisible nodes, assigns
 * deterministic [1..N] IDs in reading order, caps + truncates for token
 * efficiency, and tags DOM nodes with `data-opencode-id` for fast lookup.
 */

export const DOM_ANNOTATOR_SCRIPT = (() => {
  const script = `
(function(){
  if (window.__opencodeSom) return;
  // Top frame only: the SoM index is always built in the main frame.
  try {
    if (window.self !== window.top) return;
  } catch {
    return;
  }
  const MAX_ELEMENTS = 100;
  const LABEL_MAX = 60;
  const SELECTOR =
    'a[href],button,input:not([type="hidden"]),textarea,select,summary,details,' +
    '[role],[contenteditable="true"],[onclick],[tabindex]';
  const ROLE_BY_TAG = {
    a: "link", button: "button", input: "textbox", select: "listbox",
    textarea: "textbox", summary: "button", details: "button"
  };

  let indexed = []; // { id, tag, role, label, value, selectorFallback, bbox }
  const byId = new Map(); // id -> element

  function textOf(el){
    if (!el) return "";
    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel) return ariaLabel.trim();
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy){
      const ref = document.getElementById(labelledBy);
      if (ref) return (ref.textContent || "").trim();
    }
    // associated label for inputs / custom controls
    const idAttr = el.getAttribute("id");
    if (idAttr){
      const label = document.querySelector('label[for="' + idAttr.replace(/"/g, '\\"') + '"]');
      if (label) return (label.textContent || "").trim();
    }
    // wrapping label
    let node = el;
    for (let i = 0; i < 3 && node; i++, node = node.parentElement){
      if (node.tagName === "LABEL") return (node.textContent || "").trim();
    }
    const placeholder = el.getAttribute("placeholder");
    if (placeholder) return placeholder.trim();
    const value = el.value;
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
    if (!(el instanceof HTMLElement)) return false;
    try {
      return el.matches(SELECTOR);
    } catch {
      return false;
    }
  }

  function visibleRect(el){
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return null;
    const style = window.getComputedStyle(el);
    if (style.display === "none") return null;
    if (style.visibility === "hidden") return null;
    if (style.opacity === "0") return null;
    if (style.pointerEvents === "none") return null;
    return { x: r.x, y: r.y, width: r.width, height: r.height,
             centerX: r.x + r.width / 2, centerY: r.y + r.height / 2 };
  }

  function intersectsViewport(rect, buffer = 50){
    const vw = Math.max(document.documentElement.clientWidth, window.innerWidth || 0);
    const vh = Math.max(document.documentElement.clientHeight, window.innerHeight || 0);
    return !(rect.x + rect.width < -buffer || rect.y + rect.height < -buffer ||
              rect.x > vw + buffer || rect.y > vh + buffer);
  }

  function isOccluded(el, rect){
    const cx = Math.round(rect.centerX), cy = Math.round(rect.centerY);
    const top = document.elementFromPoint(cx, cy);
    if (!top) return false;
    if (top === el) return false;
    if (el.contains(top)) return false;
    // ancestor <label> covering the input is OK
    let anc = top;
    while (anc && anc !== document.documentElement){
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
    const style = window.getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (style.opacity === "0" || (r.width < 4 && r.height < 4)) return true;
    return false;
  }

  function collectFromRoot(root, out, visited){
    if (!root || !root.querySelectorAll) return;
    try {
      const nodes = root.querySelectorAll(SELECTOR);
      for (const el of nodes){
        if (!(el instanceof HTMLElement)) continue;
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
        if (el instanceof HTMLElement && el.shadowRoot && !visited.has(el)){
          collectFromRoot(el.shadowRoot, out, visited);
        }
      }
    } catch {}
  }

  function indexPage(){
    indexed = [];
    byId.clear();
    const visited = new Set();
    const candidates = [];
    collectFromRoot(document, candidates, visited);
    // include document.body-level shadow hosts missed above (defensive)
    const roots = [document];
    const seenRoots = new Set([document]);
    const stack = [document.documentElement];
    while (stack.length){
      const node = stack.pop();
      if (!node || !node.shadowRoot) continue;
      if (!seenRoots.has(node.shadowRoot)){
        seenRoots.add(node.shadowRoot);
        collectFromRoot(node.shadowRoot, candidates, visited);
        roots.push(node.shadowRoot);
      }
      for (let i = node.children.length - 1; i >= 0; i--){
        stack.push(node.children[i]);
      }
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

    const out = [];
    let n = 0;
    for (const { el, rect } of rects){
      if (n >= MAX_ELEMENTS) break;
      n += 1;
      const id = n;
      const tag = el.tagName.toLowerCase();
      el.setAttribute("data-opencode-id", String(id));
      const entry = {
        id, tag, role: roleOf(el), label: labelOf(el),
        value: el.value !== undefined ? String(el.value) : "",
        href: el.getAttribute("href") || "",
        selectorFallback: cssSelector(el),
        bbox: { x: Math.round(rect.x), y: Math.round(rect.y),
                width: Math.round(rect.width), height: Math.round(rect.height),
                centerX: Math.round(rect.centerX), centerY: Math.round(rect.centerY) },
      };
      out.push(entry);
      byId.set(id, el);
    }
    indexed = out;
    return { elements: out, count: out.length, capped: rects.length > MAX_ELEMENTS };
  }

  function cssSelector(el){
    if (el.id) return '#' + CSS.escape(el.id);
    const tag = el.tagName.toLowerCase();
    const cls = el.getAttribute("class");
    const classSel = cls ? '.' + cls.trim().split(/\\s+/).filter(Boolean).join('.') : '';
    const sel = tag + classSel;
    if (el.getAttribute("data-opencode-id")) return '[data-opencode-id="' + el.getAttribute("data-opencode-id") + '"]';
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
      const rect = el ? el.getBoundingClientRect() : null;
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

  window.__opencodeSom = {
    indexPage, renderSoMOverlay, removeSoMOverlay, getElements: () => indexed,
  };
})();
`;
  return script;
})();
