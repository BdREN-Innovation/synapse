# PDF editing

PDF has no reflow model, so "editing" means one of three distinct operations. Classify the request before writing any code; do not default to the heaviest option.

**Form fields present.** If `pdfinfo`/`pypdf` show an AcroForm, this is not an editing task — follow `/mnt/data/skills/pdf/references/forms.md` instead.

**Isolated value swap on a text-based PDF** (a name, date, price, or short label on an otherwise-static layout). Use PyMuPDF (`fitz`):

1. Locate the target string with `page.search_for(...)` to get its exact bounding box.
2. Redact that box (`page.add_redact_annot` + `page.apply_redactions()`), which removes the underlying glyphs, not just paints over them.
3. Insert the replacement with `page.insert_text(...)` at the same origin, matching font family, size, and color as closely as the baked-in font set allows.
4. Only do this when the replacement is close in length to the original and the page uses a standard, subsettable font. Long replacements will overlap neighboring content; do not attempt to reflow around them.

This is a precise, per-instance operation. Do not use it for more than a handful of isolated changes on the same page — past that, the risk of visual collision outweighs the benefit and the conversion route below is more reliable.

**Content rewrite or restructuring** (reword paragraphs, add/remove sections, change layout). PDF cannot do this in place. Convert to a reflowable format, edit there, convert back:

1. Convert with `pdf2docx` or headless LibreOffice (`soffice --headless --convert-to docx`) into `/mnt/data/work/pdf/`.
2. Edit the resulting `.docx` following `/mnt/data/skills/docx/references/editing.md` — load with `python-docx` and mutate in place, never regenerate from scratch.
3. Convert back with headless LibreOffice (`soffice --headless --convert-to pdf`).
4. This round trip is lossy: exact fonts, spacing, and complex layouts (multi-column, floating images, tables with merged cells) can shift. State plainly which round trip was used and what may have drifted — do not present the result as a faithful in-place edit.

**Scanned or image-only pages.** Route through `/mnt/data/skills/pdf/references/ocr.md` first to obtain extractable text, then apply the appropriate case above.

Never overwrite the input; write results under `/mnt/data/outputs/`. After any edit, follow `/mnt/data/skills/pdf/references/validation.md`, and for the conversion round trip specifically, diff the page count and sample text between the original and the reconverted file before returning it.
