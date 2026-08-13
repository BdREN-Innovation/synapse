# Creating Word documents

Use a baked-in OOXML library: `docx` for Node.js or `python-docx` for Python. Choose one implementation for the whole document.

Before coding, decide page size, margins, heading hierarchy, header/footer behavior, and table widths. Use named styles and built-in heading levels so navigation and tables of contents work. Build lists with numbering definitions rather than bullet characters. Put page breaks in paragraphs and represent line-level formatting with runs.

For tables, define widths consistently at table and cell level, repeat header rows when supported, and keep content within the printable width. Add alternative text to meaningful images. Embed only local, trusted image files and declare their actual media type.

Write the completed file under `/mnt/data/outputs/`. Then follow `/mnt/data/skills/docx/references/validation.md`.
