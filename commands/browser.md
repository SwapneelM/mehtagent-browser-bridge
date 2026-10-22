---
description: Inspect connected browser profiles and recover this agent's owned tabs.
allowed-tools: Bash(python3:*)
---

Read `${CLAUDE_PLUGIN_ROOT}/AGENTS.md`. Run `python3 "${CLAUDE_PLUGIN_ROOT}/browser.py" status` and report connected profile IDs. Before actions, choose and save a task-specific agent ID, then run recover with it. Use explicit connection IDs and owned targets. If no profile is connected, show README.md's manual setup; do not launch another browser.
