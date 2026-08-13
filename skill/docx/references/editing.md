# Reading and editing Word documents

For content inspection, use a baked-in converter such as Pandoc or read paragraphs, tables, headers, and footers through an OOXML library. Do not assume visible text is stored in one XML run.

Prefer a document library for ordinary edits. Use direct OOXML editing only for features the library cannot preserve. When unpacking, extract into `/mnt/data/work/docx/`, reject entries that escape that directory, and remove symlink entries. Modify XML without pretty-printing the whole part, then rebuild the archive with its original relative paths.

Preserve styles, section properties, relationships, numbering, footnotes, headers, and embedded media. When editing `.dotx`, retain the template content type. Convert legacy `.doc` files with LibreOffice before editing and keep the original.

Save to a new file in `/mnt/data/outputs/`, then follow `/mnt/data/skills/docx/references/validation.md`.
