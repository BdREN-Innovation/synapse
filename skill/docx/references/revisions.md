# Revisions and comments

Tracked changes and comments require coordinated OOXML parts and relationships. Work on a copy and use direct XML only when the available document library cannot represent the requested feature.

For tracked changes, wrap insertions and deletions with revision elements carrying unique IDs, author, and UTC timestamp. Deleted text uses the deletion-text element. Paragraph-mark deletion is separate from deleting its visible runs; preserve schema ordering inside paragraph and run properties.

For comments, keep comment IDs unique and update the comments part, package content types, document relationships, and range/reference markers in the document. Replies also require the platform-specific extended comment metadata. A comment without matching anchors may exist in the package but remain invisible.

To accept revisions, use a baked-in office converter on a copy and verify the accepted document no longer contains revision markup. Pay special attention to deleted list paragraphs and paragraph joins.

Always follow `/mnt/data/skills/docx/references/validation.md` and compare against the original when revisions were requested.
