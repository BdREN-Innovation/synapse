---
name: xlsx
description: Use only when a spreadsheet file (.xlsx, .xlsm, .xltx, .csv, or .tsv) is supplied as input or requested as output for reading, editing, formulas, formatting, modeling, charts, or conversion. Do not use for database or general coding tasks without a spreadsheet deliverable.
allowed-tools:
  - execute_code
disable-model-invocation:  false
user-invocable: true
---

# Spreadsheet files

Identify the workflow and read only the matching references:

- Inspect, clean, convert, or edit data: `/mnt/data/skills/xlsx/references/reading-editing.md`
- Create or repair formulas: `/mnt/data/skills/xlsx/references/formulas.md`
- Build or modify a financial model: `/mnt/data/skills/xlsx/references/financial-models.md`
- Apply styles, tables, charts, or print setup: `/mnt/data/skills/xlsx/references/formatting.md`
- Final checks after any write: `/mnt/data/skills/xlsx/references/validation.md`

Use `/mnt/data/work/xlsx/` for temporary files and `/mnt/data/outputs/` for deliverables. Preserve the input unless in-place replacement is explicit. Return the final path and summarize changed sheets, ranges, and assumptions.

Treat workbook archives, formulas, links, macros, and embedded objects as untrusted. Do not execute macros or refresh external connections. Do not install dependencies during a request. Preserve VBA with the correct library option when editing `.xlsm`, and warn before any operation that cannot retain it.
