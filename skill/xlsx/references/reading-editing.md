# Reading and editing spreadsheets

Use baked-in `openpyxl` for workbook structure, formulas, and styles; use pandas for bulk tabular transformations. Inspect sheet names, dimensions, hidden rows/columns, merged ranges, tables, names, validations, filters, formulas, links, and macros before modifying an existing workbook.

When an input workbook is supplied, load it with `openpyxl.load_workbook(path)` and edit cell values in place. Never regenerate the workbook from scratch (e.g. `pandas.DataFrame.to_excel()`, `xlsxwriter`, or hand-built XML) when an existing file is being edited — those paths always discard merged ranges, the shared-string table, named ranges, print/view settings, and any custom document properties, even when the visible text looks unchanged. Before writing the output, diff the merged-cell count and row/column dimensions against the input; if either shrank, the edit rebuilt the sheet instead of mutating it and must be redone by loading the original file again. Never leave bracketed placeholder tokens (e.g. `[FIELD_NAME]`) in the output — resolve every field to its real value before saving, or leave the original cell content untouched if no value was provided.

Load `.xlsm` with VBA preservation enabled and save with the matching extension. Never save a workbook loaded in cached-value-only mode because formulas are absent from that view. Write only to the anchor cell of a merged range.

For CSV or TSV, detect encoding, delimiter, quoting, headers, and newline conventions. These formats cannot retain formulas, multiple sheets, styles, or charts; disclose any lossy conversion.

Match the existing workbook's conventions unless redesign is requested. Save a new file under `/mnt/data/outputs/`, then follow `/mnt/data/skills/xlsx/references/validation.md`.
