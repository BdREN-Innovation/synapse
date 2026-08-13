# Creating PDFs

Use a baked-in deterministic renderer suited to the content: ReportLab for programmatic layouts, or an installed HTML-to-PDF engine for CSS-driven documents. Keep source assets local and trusted.

Define page size, margins, fonts, color space, headers, footers, and page-number rules before laying out content. Embed or subset fonts when licensing permits, provide searchable text, and add document metadata. Avoid rasterizing text merely to preserve appearance.

Support accessibility where the renderer permits it: meaningful reading order, document language, headings, link text, and alternative descriptions for informative images. Generate under `/mnt/data/outputs/`, then follow `/mnt/data/skills/pdf/references/validation.md`.
