/**
 * Antigravity-style live visual HUD.
 *
 * Serialized as a string and injected into every tracked page. Creates a
 * persistent `<opencode-agent-hud>` host on document.documentElement with an
 * isolated Shadow Root (z-index 2147483647, pointer-events: none).
 *
 * Components:
 *   - status pill: dark-glass pill showing current agent activity
 *   - virtual cursor: SVG pointer that transitions smoothly to action targets
 *   - click ripple: expanding circle at the click point
 *
 * Screenshot hygiene: hide() before capture, show() after so the HUD never
 * pollutes the LLM's visual observation.
 */

import { PAGE_GLOBALS } from "../core/som.ts";

export const AGENT_HUD_SCRIPT = (() => {
  const script = `
(function(){
  if (window[${JSON.stringify(PAGE_GLOBALS.hud)}]) return;
  // Top frame only: installing per-iframe HUDs is wasteful and their scripts
  // can trip host-page Trusted Types enforcement for no benefit.
  try {
    if (window.self !== window.top) return;
  } catch {
    return;
  }
  const host = document.createElement("opencode-agent-hud");
  const mount = () => {
    if (host.isConnected) return;
    const root = document.documentElement;
    if (root) root.appendChild(host);
  };
  mount();
  if (!host.isConnected) {
    document.addEventListener("DOMContentLoaded", mount, { once: true });
  }
  const shadow = host.attachShadow({ mode: "open" });

  const css = [
    ":host { position: fixed; top: 0; left: 0; width: 100%; height: 100%; z-index: 2147483647; pointer-events: none; }",
    ".pill { position: fixed; bottom: 24px; right: 24px; display: inline-flex; align-items: center; gap: 8px; padding: 6px 12px; border-radius: 999px; background: rgba(20, 20, 20, 0.75); color: #fff; border: 1px solid rgba(255,255,255,0.35); backdrop-filter: blur(8px); font: 600 12px/1.2 system-ui, sans-serif; box-shadow: 0 4px 12px rgba(0,0,0,0.35); pointer-events: none; opacity: 0; transition: opacity 120ms ease, transform 120ms ease; transform: translate3d(0, 10px, 0); }",
    ".pill.visible { opacity: 1; transform: translate3d(0, 0, 0); }",
    ".pill .dot { width: 7px; height: 7px; border-radius: 50%; background: #22c55e; box-shadow: 0 0 6px #22c55e; animation: ocPulse 1.2s infinite; }",
    "@keyframes ocPulse { 0%,100%{opacity:1} 50%{opacity:0.45} }",
    ".cursor { position: fixed; left: 0; top: 0; z-index: 2147483647; pointer-events: none; width: 20px; height: 20px; transform-origin: 4px 6px; transition: transform 160ms cubic-bezier(0.22, 1, 0.36, 1); will-change: transform; }",
    ".cursor svg { width: 100%; height: 100%; display: block; }",
    ".ripple { position: fixed; z-index: 2147483647; pointer-events: none; border: 2px solid rgba(59, 130, 246, 0.6); border-radius: 50%; transform: translate3d(-50%, -50%, 0) scale(0); opacity: 0; animation: ocRipple 500ms ease-out forwards; }",
    "@keyframes ocRipple { to { transform: translate3d(-50%, -50%, 0) scale(2.6); opacity: 0; } }",
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

  let visible = false;

  window[${JSON.stringify(PAGE_GLOBALS.hud)}] = {
    updateStatus(text){
      label.textContent = text || "OpenCode";
      if (!text) { pill.classList.remove("visible"); visible = false; return; }
      pill.classList.add("visible"); visible = true;
    },
    moveCursor(x, y){
      // The cursor sits at (0, 0); the transform alone places it, so the
      // offset is applied once and the transition animates it.
      cursor.style.transform = "translate3d(" + x + "px, " + y + "px, 0)";
    },
    showClickRipple(x, y){
      const ripple = document.createElement("div");
      ripple.className = "ripple";
      ripple.style.left = x + "px";
      ripple.style.top = y + "px";
      shadow.appendChild(ripple);
      setTimeout(() => ripple.remove(), 550);
    },
    hide(){
      host.style.visibility = "hidden";
    },
    show(){
      host.style.visibility = "visible";
    },
  };
})();
`;
  return script;
})();
