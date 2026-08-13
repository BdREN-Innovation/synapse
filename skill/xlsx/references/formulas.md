# Spreadsheet formulas

Use formulas for derived values when the output must remain responsive to input changes. Put assumptions in labeled cells and reference them; do not hide constants inside long formulas. Keep row and column anchoring intentional and quote sheet names that contain spaces or punctuation.

Prefer widely supported functions when the workbook must work across Excel and LibreOffice. Preserve existing formulas during edits. For each new formula block, test representative first, middle, boundary, blank, zero-denominator, and error cases before filling the full range.

Formula-writing libraries usually do not calculate cached results. Recalculate a copy with baked-in headless LibreOffice, then reopen it in formula and cached-value modes. Check for `#REF!`, `#DIV/0!`, `#VALUE!`, `#NAME?`, `#NUM!`, and `#N/A`. External links may not be available in the sandbox; do not refresh or destroy their cached values without approval.

Finish with `/mnt/data/skills/xlsx/references/validation.md`.
