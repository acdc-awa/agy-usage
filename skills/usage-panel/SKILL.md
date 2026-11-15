---
name: usage-panel
description: Open the native Usage side-pane panel to inspect token volume, API-equivalent cost, prompt cache savings, and model, session, or daily breakdowns across Antigravity. Use when the user asks to open the Usage panel or inspect token and cost analytics.
---

# Usage panel

Open or guide the user to the **Usage** side-pane panel (`usage/usage_panel`). Note that `/usage` in the CLI remains Antigravity's built-in quota command; this panel complements it with full token, cache, and API-equivalent cost telemetry across conversations.

## Instructions

1. Check read-only whether the `usage/usage_panel` sidecar is active:
   - Check `~/.gemini/antigravity/sidecar_data/usage/usage_panel/logs/sidecar.log` or inspect `GetAllPlugins` for `usage` (`disabled == false`).
2. **If active**, output the one-click pill on its own line:
   `[Usage](sidecar://usage/usage_panel/)`
   Mention that the user can open it from the `+` button (`Cmd+T`) in the side panel, and pin it via **Right-click tab -> Pin Tab**.
3. **If not yet enabled**, do not emit a `sidecar://usage/usage_panel/` link. Instead, provide:
   - `[Usage](customization://usage)`
   - `[Open Sidecars Dashboard](sidecar://dashboard)`
   Ask the user to enable the **Usage** sidecar once so it appears in the side panel `+` menu (`Cmd+T`) at zero token cost.
