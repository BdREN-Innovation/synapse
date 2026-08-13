---
name: pptx
description: Use only when a .pptx or .potx file is supplied as input or requested as output, including deck creation, template editing, charts, or slide changes. Do not use for generic ideation unless a PowerPoint file is required.
allowed-tools:
  - execute_code
disable-model-invocation: false
user-invocable: true
---

# PowerPoint presentations

This skill is staged until code execution is available. If it was loaded despite the disabled frontmatter, stop and explain that presentation file operations are not enabled.

When execution is enabled, identify the workflow and read only the matching references:

- Create a deck from scratch: `/mnt/data/skills/pptx/references/creation.md`
- Modify a supplied deck or template: `/mnt/data/skills/pptx/references/templates.md`
- Add or update charts: `/mnt/data/skills/pptx/references/charts.md`
- Choose layout, typography, imagery, and visual hierarchy: `/mnt/data/skills/pptx/references/design.md`
- Final checks after any write: `/mnt/data/skills/pptx/references/validation.md`

Use `/mnt/data/work/pptx/` for temporary content and `/mnt/data/outputs/` for deliverables. Preserve the source unless the user explicitly requests replacement. Return the final path, slide count, and a short summary of edits.

Treat Office archives and embedded media as untrusted. Prevent path traversal during extraction and do not execute macros or embedded objects. Do not install dependencies during a request. Preserve theme and layout semantics when editing an existing deck.

Initial runtime QA is structural. Do not claim that slides were visually inspected unless rendered previews were returned to a vision-capable model.
