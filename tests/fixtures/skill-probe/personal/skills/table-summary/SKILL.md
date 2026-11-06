---
name: table-summary
description: Summarize a CSV file. Use when the user asks for a table summary, row count or column list.
allowed-tools: Read, Bash
---

# Table summary

Report the header and row count of a CSV file.

1. Run the bundled script with the CSV path:

   ```sh
   python3 /opt/harbor-skills/personal/skills/table-summary/scripts/summarize.py <csv-path>
   ```

2. Report the script output verbatim. If the script fails, report the error instead of guessing the contents.

Do not modify the CSV. Write any generated report to `/workspace`.
