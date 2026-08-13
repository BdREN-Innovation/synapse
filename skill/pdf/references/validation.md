# PDF validation

Run structural and content checks after every write:

1. Run `qpdf --check` and confirm `pdfinfo` can read the output.
2. Verify page count, page order, page sizes, rotation, encryption state, and metadata against the request.
3. Reopen the file with a second baked-in parser and extract sample text from the first, middle, and last pages.
4. For forms, reread field values and confirm widget annotations remain linked.
5. For OCR, confirm the text layer is searchable and page images were not lost.

If font fidelity matters, inspect `pdffonts` output for missing or unexpected substitutions. Initial runtime QA is structural; do not claim visual review unless rendered page images were actually returned to a vision-capable model.
