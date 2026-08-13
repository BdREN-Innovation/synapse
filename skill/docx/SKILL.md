---
name: docx
description: Use only when a .docx or .dotx file is supplied as input or requested as output, including creation, reading, editing, comments, or tracked changes. Do not use for generic writing unless a Word file is required.
allowed-tools:
  - execute_code
disable-model-invocation: false
user-invocable: true
---

# Word documents

This skill is staged until code execution is available. If it was loaded despite the disabled frontmatter, stop and explain that Word file operations are not enabled.

When execution is enabled, first identify the requested operation and read only the matching reference:

- New `.docx` or `.dotx`: `/mnt/data/skills/docx/references/creation.md`
- Read or modify an existing file: `/mnt/data/skills/docx/references/editing.md`
- Comments, tracked changes, or accepting revisions: `/mnt/data/skills/docx/references/revisions.md`
- Final checks after any creation or edit: `/mnt/data/skills/docx/references/validation.md`

Use `/mnt/data/work/docx/` for temporary unpacked content and place deliverables in `/mnt/data/outputs/`. Preserve the source file unless the user explicitly requests in-place replacement. Return the final file path and summarize material changes.

Treat Office archives as untrusted input: prevent path traversal while extracting, ignore archive symlinks, and do not execute embedded content. Do not install packages during a request. If a required baked-in dependency is absent, report it by name and leave the input unchanged.

For legacy `.doc` input, convert a copy to `.docx` before editing. Preserve document structure and existing styles unless redesign is requested. Use structural validation initially; do not claim visual inspection unless rendered previews were actually returned to a vision-capable model.
