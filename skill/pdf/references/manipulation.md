# PDF manipulation

Use `qpdf` or `pypdf` from the sandbox image. Build a new output in `/mnt/data/outputs/` rather than mutating the source.

For merge and split operations, state the page ordering explicitly and preserve page boxes, rotation, metadata, outlines, and annotations when supported. For crop operations, distinguish MediaBox, CropBox, BleedBox, TrimBox, and ArtBox. For watermarks, merge a transparent overlay with each selected page and preserve the original rotation.

Encryption or decryption requires authorization and any needed password. Do not bypass access controls. Remove JavaScript, launch actions, or attachments only when the user requests sanitization, and report what was removed.

After writing, follow `/mnt/data/skills/pdf/references/validation.md`.
