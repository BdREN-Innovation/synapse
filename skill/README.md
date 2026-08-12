# Deployment Skills

Place shared deployment skills in this directory. Each skill should live in its own folder with a
`SKILL.md` file, for example:

```text
skill/
  my-shared-skill/
    SKILL.md
    references/
      notes.md
```

These skills are loaded at server startup, exposed read-only to all users with Skills enabled, and
are not persisted as Skill documents in MongoDB.

## Staged office-format skills

The `docx`, `pdf`, `pptx`, and `xlsx` packages are intentionally unavailable while the code
executor is being prepared. Their frontmatter must retain both `disable-model-invocation: true`
and `user-invocable: false` until all of the following are complete:

- the Agents endpoint exposes the `skills` and `execute_code` capabilities;
- the pilot model enables code execution and allowlists all four skill names;
- the backend can reach the code service;
- the sandbox image includes the documented Python, Node.js, LibreOffice, Poppler, and document
  utilities without request-time installation; and
- create, read, edit, validation, malformed-input, missing-dependency, and download smoke tests pass.

After changing deployment skill files, restart the backend so the registry reloads them. These
Markdown and bundled-reference changes do not require a TypeScript rebuild.
