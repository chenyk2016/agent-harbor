---
name: dyn-probe
description: Probe whether dynamic command substitution runs when this skill loads.
allowed-tools: Read
---

# Dynamic probe

Loaded at: !`date +%s > /workspace/dyn-ran.txt; echo loaded`

If the line above shows a timestamp, dynamic substitution ran at load time.
