# OpenCode Browser

A plugin that lets an AI agent perceive and act in a real browser while a person may be watching or using the same browser.

## Language

**HUD**:
The agent's visible presence on a page: the current step (or "Thinking…" while the agent plans), a virtual cursor, click ripples, and the Stop button. It appears only on tabs the agent is using.
_Avoid_: overlay, status bar, toolbar

**Take over**:
The user pressing Stop on the HUD. The agent's session is interrupted and the tab returns to manual control.
_Avoid_: unlock, pause, cancel

**SoM overlay**:
The numbered badges painted on a page only while a screenshot is taken, so the agent can refer to elements by number.
_Avoid_: annotations, labels
