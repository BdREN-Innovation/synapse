# OCR for scanned PDFs

Confirm OCR is necessary by checking several representative pages for extractable text. Use baked-in `ocrmypdf` with the correct document language, deskewing, and rotation detection. Keep the original image layer and add a searchable text layer unless the user requests another result.

Do not force OCR over good existing text without reason. Mixed PDFs may need selective handling. Record pages that failed, were skipped, or produced unusually low-confidence text. For handwriting or uncommon scripts, state the expected limitations.

Write the searchable copy under `/mnt/data/outputs/`, compare its page count and dimensions with the source, sample extracted text, and follow `/mnt/data/skills/pdf/references/validation.md`.
