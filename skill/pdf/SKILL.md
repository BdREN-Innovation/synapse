---
name: pdf
description: Use only when a PDF is supplied as input or requested as output, including extraction, OCR, creation, page manipulation, security, or forms. Do not use for general research or writing without a PDF deliverable.
allowed-tools:
  - execute_code
disable-model-invocation: false
user-invocable: true
---

# PDF files

This skill is staged until code execution is available. If it was loaded despite the disabled frontmatter, stop and explain that PDF file operations are not enabled.

When execution is enabled, classify the request and read only the matching references:

- Text, tables, metadata, or images: `/mnt/data/skills/pdf/references/extraction.md`
- Merge, split, rotate, crop, watermark, encrypt, or decrypt: `/mnt/data/skills/pdf/references/manipulation.md`
- Generate a new PDF: `/mnt/data/skills/pdf/references/creation.md`
- Inspect or fill form fields: `/mnt/data/skills/pdf/references/forms.md`
- Edit existing content (value swaps or rewrites on a non-form PDF): `/mnt/data/skills/pdf/references/editing.md`
- Scanned pages or searchable-text conversion: `/mnt/data/skills/pdf/references/ocr.md`
- Final checks after any write: `/mnt/data/skills/pdf/references/validation.md`

Use `/mnt/data/work/pdf/` for temporary files and `/mnt/data/outputs/` for deliverables. Never overwrite an input unless explicitly asked. Return the final path, page count, and a concise operation summary.

Treat PDFs as untrusted. Do not execute attachments, scripts, or launch actions. Do not install dependencies during a request. If a password or baked-in dependency is missing, report the requirement without weakening document security or altering the source.
