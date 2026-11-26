/**
 * The agent's presence on a page, in the style of Antigravity's browser use.
 *
 * Serialized as a string and injected into every document. Creates a
 * `<opencode-agent-hud>` host on document.documentElement with an isolated
 * Shadow Root (z-index 2147483647). The host is hidden until the plugin marks
 * the tab as one the agent is using (`setPresent(true)`); other tabs never
 * show anything.
 *
 * Components:
 *   - status pill (bottom centre): the agent's current step, or "Thinking…"
 *   - virtual cursor: SVG pointer that transitions smoothly to action targets
 *   - click ripple: expanding circle at the click point
 *   - Stop button (bottom right, red circle): the only part that takes
 *     pointer events. A trusted click calls the host binding, which interrupts
 *     the agent and hands the tab back to the user. It steps to the bottom
 *     left when the agent needs to act on something beneath it.
 *
 * Nothing blocks the user: the page stays fully interactive.
 *
 * Screenshot hygiene: hide() before capture, show() after so the HUD never
 * pollutes the LLM's visual observation. show() restores the presence state,
 * so a tab that is not presented stays hidden.
 */

import { HUD_TAG, PAGE_GLOBALS } from "../core/som.ts";

export const AGENT_HUD_SCRIPT = (() => {
  const script = `
(function(){
  const HUD = ${JSON.stringify(PAGE_GLOBALS.hud)};
  const STOP = ${JSON.stringify(PAGE_GLOBALS.stop)};
  // Take the Stop binding and remove the global in every document, so page
  // scripts cannot call it. Init scripts run before page scripts.
  const fresh = typeof window[STOP] === "function" ? window[STOP] : null;
  try { delete window[STOP]; } catch {}
  // A window can outlive its document (a popup's initial about:blank navigates
  // in place) and init scripts do not run again then, so every HUD method
  // re-attaches the host to the current document first (see mount()).
  if (window[HUD]) { window[HUD].remount(fresh); return; }
  // Top frame only: installing per-iframe HUDs is wasteful and their scripts
  // can trip host-page Trusted Types enforcement for no benefit.
  try {
    if (window.self !== window.top) return;
  } catch {
    return;
  }
  const host = document.createElement(${JSON.stringify(HUD_TAG)});
  host.style.visibility = "hidden";
  let present = false;
  let stop = fresh;
  const mount = () => {
    const root = document.documentElement;
    // isConnected is not enough: a host left in a replaced document still
    // reports true. It must be a child of the current document's root.
    if (root && host.parentNode === root) return;
    if (root) root.appendChild(host);
    else document.addEventListener("DOMContentLoaded", mount, { once: true });
  };
  mount();
  const shadow = host.attachShadow({ mode: "open" });

  const css = [
    ":host { position: fixed; top: 0; left: 0; width: 100%; height: 100%; z-index: 2147483647; pointer-events: none; }",
    ".pill { position: fixed; bottom: 24px; left: 50%; display: inline-flex; align-items: center; gap: 8px; padding: 6px 12px; border-radius: 999px; background: rgba(20, 20, 20, 0.75); color: #fff; border: 1px solid rgba(255,255,255,0.35); backdrop-filter: blur(8px); font: 600 12px/1.2 system-ui, sans-serif; box-shadow: 0 4px 12px rgba(0,0,0,0.35); pointer-events: none; opacity: 0; transition: opacity 120ms ease, transform 120ms ease; transform: translate3d(-50%, 10px, 0); }",
    ".pill.visible { opacity: 1; transform: translate3d(-50%, 0, 0); }",
    ".pill .dot { width: 7px; height: 7px; border-radius: 50%; background: #22c55e; box-shadow: 0 0 6px #22c55e; animation: ocPulse 1.2s infinite; }",
    "@keyframes ocPulse { 0%,100%{opacity:1} 50%{opacity:0.45} }",
    ".cursor { position: fixed; left: 0; top: 0; z-index: 2147483647; pointer-events: none; width: 20px; height: 20px; opacity: 0; transform-origin: 4px 6px; transition: transform 160ms cubic-bezier(0.22, 1, 0.36, 1); will-change: transform; }",
    ".cursor.active { opacity: 1; }",
    // A dark outline keeps the white pointer visible on light pages.
    ".cursor svg { width: 100%; height: 100%; display: block; filter: drop-shadow(0 0 1px #000) drop-shadow(0 0 1px #000) drop-shadow(0 1px 2px rgba(0,0,0,0.5)); }",
    ".ripple { position: fixed; z-index: 2147483647; pointer-events: none; border: 2px solid rgba(59, 130, 246, 0.6); border-radius: 50%; transform: translate3d(-50%, -50%, 0) scale(0); opacity: 0; animation: ocRipple 500ms ease-out forwards; }",
    "@keyframes ocRipple { to { transform: translate3d(-50%, -50%, 0) scale(2.6); opacity: 0; } }",
    ".stop { position: fixed; right: 20px; bottom: 20px; width: 44px; height: 44px; padding: 0; border-radius: 50%; border: 2px solid rgba(255,255,255,0.9); background: #dc2626; box-shadow: 0 4px 12px rgba(0,0,0,0.4); display: flex; align-items: center; justify-content: center; cursor: pointer; pointer-events: auto; transition: transform 120ms ease, background 120ms ease; }",
    ".stop.left { right: auto; left: 20px; }",
    ".stop:hover { background: #b91c1c; transform: scale(1.06); }",
    ".stop .square { width: 14px; height: 14px; border-radius: 2px; background: #fff; }",
  ].join("\\n");

  const style = document.createElement("style");
  style.textContent = css;
  shadow.appendChild(style);

  const pill = document.createElement("div");
  pill.className = "pill";
  const dot = document.createElement("div");
  dot.className = "dot";
  const label = document.createElement("span");
  pill.appendChild(dot);
  pill.appendChild(label);
  shadow.appendChild(pill);

  const cursor = document.createElement("div");
  cursor.className = "cursor";
  // Built via DOM API (never innerHTML) so host pages enforcing Trusted Types
  // (e.g. YouTube) don't block the install.
  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("viewBox", "0 0 20 20");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "#fff");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  const cursorPath = document.createElementNS(svgNS, "path");
  cursorPath.setAttribute("d", "M17 3l-3 3-1-1L3 17");
  const cursorDot = document.createElementNS(svgNS, "circle");
  cursorDot.setAttribute("cx", "5");
  cursorDot.setAttribute("cy", "15");
  cursorDot.setAttribute("r", "1");
  svg.appendChild(cursorPath);
  svg.appendChild(cursorDot);
  cursor.appendChild(svg);
  shadow.appendChild(cursor);

  const stopButton = document.createElement("button");
  stopButton.className = "stop";
  stopButton.type = "button";
  stopButton.setAttribute("aria-label", "Stop the agent");
  stopButton.title = "Stop the agent and take over";
  const square = document.createElement("span");
  square.className = "square";
  stopButton.appendChild(square);
  shadow.appendChild(stopButton);
  // Only a real click counts: a page script cannot press Stop for the user.
  stopButton.addEventListener("click", (event) => {
    if (!event.isTrusted || !stop) return;
    try { stop(); } catch {}
  }, true);

  // Step the Stop button out of the way of a point the agent is about to hit.
  function avoid(x, y){
    const margin = 24;
    const r = stopButton.getBoundingClientRect();
    if (r.width === 0) return;
    const onButton = x >= r.left - margin && x <= r.right + margin && y >= r.top - margin && y <= r.bottom + margin;
    if (onButton) stopButton.classList.toggle("left");
  }

  window[HUD] = {
    updateStatus(text){
      mount();
      label.textContent = text || "OpenCode";
      if (!text) { pill.classList.remove("visible"); return; }
      pill.classList.add("visible");
    },
    moveCursor(x, y){
      mount();
      // The cursor sits at (0, 0); the transform alone places it, so the
      // offset is applied once and the transition animates it.
      cursor.style.transform = "translate3d(" + x + "px, " + y + "px, 0)";
      cursor.classList.add("active");
      avoid(x, y);
    },
    showClickRipple(x, y){
      mount();
      const ripple = document.createElement("div");
      ripple.className = "ripple";
      ripple.style.left = x + "px";
      ripple.style.top = y + "px";
      shadow.appendChild(ripple);
      setTimeout(() => ripple.remove(), 550);
    },
    /** Show or hide the whole HUD: only tabs the agent is using are presented. */
    setPresent(on){
      mount();
      present = !!on;
      host.style.visibility = present ? "visible" : "hidden";
      if (!present) {
        pill.classList.remove("visible");
        cursor.classList.remove("active");
      }
    },
    /** Screenshot hygiene: hidden for the capture, then back to the presence state. */
    hide(){
      host.style.visibility = "hidden";
    },
    show(){
      mount();
      host.style.visibility = present ? "visible" : "hidden";
    },
    /** Re-attach to the current document and adopt a fresh Stop binding. */
    remount(binding){
      if (binding) stop = binding;
      mount();
    },
  };
})();
`;
  return script;
})();
