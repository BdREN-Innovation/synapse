# Env-controlled In-Response Follow-up Prompts

## Summary

Generate three concise follow-up prompts in the same model completion as the assistant answer. The entire feature is controlled by one environment boolean and is disabled by default.

## Implementation Changes

- Add `FOLLOW_UP_PROMPTS=false` to environment configuration and documentation.
- Parse the value with the existing boolean-config helper; only explicit truthy values enable the feature.
- When disabled, preserve current request, response, persistence, and UI behavior with zero additional prompt/token overhead.
- When enabled, append a compact system/developer instruction to eligible model requests requiring structured output:
  - `answer: string`
  - `follow_up_prompts: string[]`
- Stream only `answer`; validate and persist exactly three concise, unique follow-up prompts on the completed assistant message.
- Render persisted prompts as accessible buttons below assistant replies. Clicking auto-sends the selected prompt with the clicked reply as `parentMessageId`.
- Skip prompts for temporary, aborted, failed, malformed, or unsupported structured-output responses. Never make a second model request or retry solely for prompts.
- Add a per-user opt-out only when `FOLLOW_UP_PROMPTS=true`; the environment variable remains the hard global kill switch.

## Token and Deployment Controls

- No extra LLM call, queue, polling, cache, or database migration.
- Limit each generated prompt and the total structured-output allowance.
- Deploy with `FOLLOW_UP_PROMPTS=false`.
- Enable only after validating one compatible pilot model; disable instantly by setting the variable to `false` and restarting/redeploying the backend.
- Track aggregate generation, validation failure, display, click-through, latency, and token-delta metrics without logging prompt text.

## Test Plan

- Environment parsing: absent, false, true, malformed, and case variants.
- Disabled mode: verify no request augmentation, persisted prompts, or UI rendering.
- Enabled mode: structured parsing, streaming answer extraction, prompt validation, persistence/reload/share, auto-send, branch parent linkage, and keyboard accessibility.
- Failure cases: temporary, aborted, error, malformed structured output, unsupported model, and duplicate click.
- End-to-end pilot and load tests comparing latency and token overhead with the flag on versus off.

## Assumptions

- `FOLLOW_UP_PROMPTS=false` is the deployment default and global source of truth.
- Follow-ups are produced in the same completion request, not by a separate model call.
- Three prompts are shown and clicking always auto-sends.
