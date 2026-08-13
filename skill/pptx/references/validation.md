# PPTX validation

Perform these checks after every write:

1. Confirm the file is a valid ZIP with presentation, content-type, and relationship parts.
2. Parse XML safely and confirm every internal relationship target exists.
3. Reopen the deck with a second baked-in library and verify slide count, order, size, titles, notes, and hidden state.
4. Extract all text and search for missing content, placeholder copy, and unexpected empty slides.
5. For charts, verify chart parts, embedded workbooks, series formulas, caches, and relationships.
6. Convert a copy with headless LibreOffice to catch packaging or renderer failures.

When editing a template, compare masters, layouts, themes, media, notes, and embedded objects with the original. Initial QA cannot certify overlap, clipping, or alignment. State that limitation unless rendered slide images were returned to a vision-capable model.
