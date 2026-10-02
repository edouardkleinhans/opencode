# Work order: agent-ready Home Assistant Builder CLI

Prepared 2026-10-02 for an agent working in
<https://github.com/balloob/home-assistant-build-cli>.

## Objective and baseline

Extend **hab 1.7.1** (`41edb473ebf2eab1502c3f3075a3b0c91ec0eff7`) so an
agent can discover the right operation, gather focused evidence, change exactly
the intended objects, and verify the outcome with fewer calls and less context.
Recheck upstream before implementation and preserve existing compatible behavior.

The OpenCode app separately owns its hab pin, authenticated MCP adapter, tool
profiles, model-facing guidance, local configuration index and workflow memory.
Coordinate CLI interfaces with that adapter. Follow this repository's contributor
instructions when working in the hab repository.

## Evidence and existing building blocks

- The app's previous 1.6.4 binary exposed 38 top-level entries and 269 leaf command
  paths, excluding aliases. Its full JSON schema measured 7,255,997 bytes,
  exceeding the old MCP subprocess buffer of 1 MiB. Targeted schemas also repeated
  large envelope definitions.
- Existing `schema`, `guide`, `capability probe`, JSON envelopes, list filters,
  relationship search, mutation plans, dashboard component CRUD, automation traces,
  and ESPHome structured patches are foundations to extend.
- Audit the exact 1.7.1 schema: name-based side-effect inference can classify
  `dashboard save-config`, `automation create-from-blueprint`, `scene activate`,
  `esphome config-write`, `esphome config-patch`, `esphome upload`, repair ignore
  operations and `thread set-preferred` as reads. These are not permission-safe
  classifications. Build/serial commands also need explicit classifications.
- Some `--plan` implementations return a description of execution steps before
  reading the target or fully validating input. Dashboard component updates with
  `--data`/`--file` replace the component; they are not general field merges.
- 1.7.0 fixed current-HA API compatibility for backups, action response data,
  blueprint persistence, calendar deletion, helpers and config reload completion.
  1.7.1 fixed dashboard view-path selection and badge type preservation.
- Marketplace commands require HA 2026.11+ according to upstream release notes.

## Prioritized deliverables

| Priority | Deliverable | Acceptance criteria |
| --- | --- | --- |
| P0 | Accurate command contracts | Explicitly audit every executable command's side effects, transports, required capabilities, preview support and output shape. Cover exceptions to naming conventions. Unknown classifications fail closed for policy consumers. |
| P0 | Compact discovery | Small searchable command index and targeted schemas, with shared envelope definitions referenced rather than repeated. Schema/version identity; unknown command paths fail explicitly. Include actual command paths, aliases, positional arguments, flag types/defaults/constraints and stream semantics. |
| P1 | Surgical patching | Field-level changes with unique semantic selectors for dashboards and automation/script components. Preserve unrelated fields, reject zero/multiple matches, support explicit removal and distinguish merge from replacement. |
| P1 | Meaningful plans and verified completion | Live before/after diffs, no-op detection, target resolution, input validation and freshness checks. Report saved/reloaded/verified separately. Document remaining races where HA lacks compare-and-swap. |
| P1 | Dependency/impact inspection | Extend HA relationship results with dependency direction and identifiable references. Report dynamic templates, unsupported cards and unavailable data as unknown. Filesystem scanning takes explicitly supplied configuration sources. |
| P1 | Execution explanations | Bounded automation/script trace summaries with failed steps, values, errors and timestamps; correct config-ID resolution. Distinguish absent traces from observed failures. |
| P2 | Focused queries and multi-read execution | Field projection, bounded output, stable pagination where feasible, scoped relationship depth and shared-connection reads. Return completeness, freshness and per-operation errors. |
| P2 | Idempotent reconciliation | Ensure desired registry/helper configuration, preview only differences, prevent duplicate creation on retries, and record per-resource apply/verification outcomes. |
| P2 | Observable jobs | Resumable long-running operations and deadline-bounded event observation with progress, cancellation and honest uncertain-outcome reporting. |
| P3 | Integration flows | Inspect and continue supported config/options/subentry flows using current form schemas. Support authentication handoffs, expiry, cancellation and retries without persisting secrets in transcripts. |
| P3 | Assist readiness | Inspect conversation agents, exposed entities, LLM tools and speech/pipeline dependencies; return actionable missing prerequisites with evidence. |
| P3 | Dashboard preflight | Check entity references and installed custom-card resources and provide evidence for the app's existing rendered verification loop. |

## Engineering requirements

1. Verify actual Home Assistant APIs and version capabilities. Use supported APIs
   rather than editing `.storage/` or database internals.
2. Preserve CLI and envelope compatibility; explicitly version breaking contracts.
   Typed consumers must distinguish errors, partial results and uncertain outcomes.
3. Keep previews side-effect-free. Label static preview, live validation and actual
   diff separately. Recheck freshness immediately before apply where possible.
4. Do not promise universal atomic transactions. Multi-resource changes need
   per-resource results and compensating recovery; external device actions may not
   be reversible. Never retry an uncertain mutation as though it definitely failed.
5. Redact credentials in ordinary results, plans, logs and recovery records. Reads
   that expose sensitive material need their own explicit classification.
6. Keep task-specific schemas/guides on demand. Do not expose hundreds of full
   command schemas to the model on every request.
7. Test existing fields retained, ambiguous selectors, concurrent edits, repeat
   execution, permission errors, absent capabilities, cancellation, and timeouts
   after a request may already have been applied.
8. Run integration contracts against declared supported HA versions. Measure
   output bytes, API requests and verified completion on representative workflows.

## Milestones and handoff

1. Submit the command-contract audit and proposed interfaces first. CLI names for
   new features are design proposals until implemented and documented.
2. Deliver accurate contracts and compact discovery as a small reviewable change.
3. Deliver one complete dashboard patch → diff → apply → verify workflow before
   expanding the patch engine to other resource families.
4. Implement subsequent priorities in independent, reviewable stages with tests,
   compatibility notes, examples and release notes.
5. Return a capability matrix listing supported HA versions, known gaps and
   measured improvements, plus integration guidance for the OpenCode adapter.

Representative acceptance scenarios: modify one nested card without losing its
options; explain a failed automation condition from a recorded trace; inspect
helper consumers before deletion; reconcile area/label assignments twice without
duplicate changes; detect a stale plan after a concurrent dashboard edit.
