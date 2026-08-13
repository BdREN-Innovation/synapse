# Spreadsheet validation

Validate structure, calculations, and requested content:

1. Confirm the file is a readable ZIP for OOXML formats and reopen it with a second baked-in reader.
2. Verify expected sheet names, order, visibility, dimensions, tables, names, merges, validations, charts, and print settings.
3. Recalculate formulas with baked-in headless LibreOffice when formulas exist, then scan cached values for spreadsheet errors.
4. Compare representative formulas across filled ranges and reconcile totals or control checks.
5. For edits, compare macros, external links, formulas, styles, and unrelated sheets with the source.
6. For CSV or TSV, reread with the detected dialect and confirm row/column counts and encoding.

Structural checks cannot certify every visual detail. Report material preservation limits, especially for macros, external links, unsupported formulas, or renderer-specific chart layout.
