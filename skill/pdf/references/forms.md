# PDF forms

Inspect AcroForm fields before editing. Record each field's fully qualified name, type, current value, choices, flags, page, and rectangle. Distinguish AcroForm fields from XFA; many Python libraries cannot safely update XFA forms.

Fill fields by their internal names, not their visible captions. Use valid export values for checkboxes and radio buttons. Preserve calculation order, field flags, signatures, and unrelated annotations. Updating a signed document usually invalidates its signature; warn before writing.

Regenerate appearance streams with a capable baked-in tool when required, then reopen the output to confirm values and appearances. If the form is not fillable, use annotations only with the user's agreement; do not pretend annotations are form values.

Save a new file and follow `/mnt/data/skills/pdf/references/validation.md`.
