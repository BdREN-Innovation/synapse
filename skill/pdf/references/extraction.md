# PDF extraction

Start with `pdfinfo` for page count, metadata, encryption, and page size. Use a baked-in library such as `pypdf` for metadata and page text, and `pdftotext -layout` when spatial line layout matters. Preserve page boundaries in extracted output.

For tables, first test text-based extraction with a baked-in table library. Validate column alignment and totals; ruled lines do not guarantee correct cell detection. If a page has little or no usable text, switch only that page or document to the OCR workflow.

Extract images without recompressing when possible. Record source page numbers and object order. Never execute embedded files or actions.

If the user requests a derived file, write it under `/mnt/data/outputs/`. Otherwise return a concise summary with page citations.
