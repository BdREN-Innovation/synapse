# General-chat quality baseline

The repeatable fixture is [general-chat-quality-baseline.json](./general-chat-quality-baseline.json). Run it against a real provider through the normal no-agent route and store one JSON result per case. Each result should include the selected and actual model, prompt version/hash, temperature and other parameters, input/output token counts, latency, Langfuse trace ID, and rubric scores.

Responses are nondeterministic, so compare rubric scores and failure counts rather than exact strings. The leave case is the release regression: the final draft must use the supplied reason and relative date, must not repeat the clarification, and must not introduce an end date or unsupported medical claim.

## Development runtime

`default.ts` is the source of truth. The backend imports `@librechat/api` from `packages/api/dist`, so rebuild after source changes:

```sh
npm run build:api
npm run check:api-dist
```

For iterative work, run `npm run build:api:watch` in one terminal and `npm run backend:dev` in another. `check:api-dist` fails when the compiled package is missing or older than the prompt source.
