# Editing decks and templates

Inspect slide size, masters, layouts, theme fonts/colors, placeholders, notes, and existing relationships before editing. Prefer existing layouts and placeholders; they carry alignment and theme behavior that manually placed shapes do not.

For `.potx`, create a `.pptx` working copy unless the requested deliverable is itself a template. When replacing text, retain paragraph levels, runs, language, and placeholder geometry. When replacing media, update relationships without discarding crop or alternative-text metadata.

Do not delete unfamiliar masters, layouts, embedded workbooks, or notes merely because they are unused on the edited slide. Preserve slide order and hidden-slide status unless the user asks otherwise. Save a new file under `/mnt/data/outputs/`, then validate against the original using `/mnt/data/skills/pptx/references/validation.md`.
