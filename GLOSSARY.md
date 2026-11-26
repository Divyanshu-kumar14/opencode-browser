# OpenCode Browser

A plugin that lets an AI agent perceive and act in a real browser while a person may be watching or using the same browser.

## Language

**Agent tab**:
A browser tab owned by one session: the tabs it opened or was given, including popups it caused. A session never sees or acts on another session's tabs or the user's own tabs.
_Avoid_: shared tab, active page

**HUD**:
The agent's visible presence on a page: the current step (or "Thinking…" while the agent plans), a virtual cursor, click ripples, and the Stop button. It appears only on tabs the agent is using.
_Avoid_: overlay, status bar, toolbar

**Hand-off**:
The agent giving a tab to the user for a step only the user should do, such as signing in or solving a CAPTCHA. The tab says "Your turn" until the agent acts again.
_Avoid_: pause, wait, takeover

**Take over**:
The user pressing Stop on the HUD. The agent's session is interrupted and the tab returns to manual control.
_Avoid_: unlock, pause, cancel

**SoM overlay**:
The numbered badges painted on a page only while a screenshot is taken, so the agent can refer to elements by number.
_Avoid_: annotations, labels
