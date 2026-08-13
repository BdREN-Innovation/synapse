# DOCX validation

Perform structural checks before delivery:

1. Confirm the file is a readable ZIP and contains `[Content_Types].xml`, `_rels/.rels`, and `word/document.xml`.
2. Parse every XML part with external entity resolution disabled.
3. Confirm internal relationships resolve, media targets exist, and no archive entry escapes the package root.
4. Reopen the file with a second baked-in reader or convert a copy with headless LibreOffice.
5. Extract text and verify expected headings, tables, comments, or revision markers.

When an original exists, compare section count, relationship targets, styles, headers/footers, and embedded media so an edit does not silently discard unrelated content.

Initial runtime QA is structural. A PDF render may be produced for the user, but do not describe it as visually reviewed unless its page images were returned to a vision-capable model.
