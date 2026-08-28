# M3 Marketplace Web Research Design

Date: 2026-08-28
Status: Draft for review
Scope: Enable real external web research in Buffr's M3 module for the marketplace-visibility workflow.

## Problem

Buffr's generic workflow engine already knows how to route through M3 research, persist M3 outputs, and return to the requesting stage. The marketplace-visibility module executor currently disables that path:

- `src/workflow/routes.ts` routes to research when M2/M5/M6 expose `researchNeed`, when M4 returns `research_domain_knowledge`, when M6 has unresolved measurement rules, or when M7 requests research.
- `src/workflow/engine.ts` persists `research.requested`, moves the run to `m3_research`, appends validated M3 outputs, and emits `research.continued` or `research.returned`.
- `src/agents/marketplace-visibility/modules.ts` currently returns an unavailable M3 result, rewrites M4 `research_domain_knowledge` to `collect_more_data`, removes M5 and M6 `researchNeed`, clears M6 `unresolvedMeasurementRules`, and rewrites M7 `research` to `wait`.

The result is that marketplace-visibility runs can reach an experiment plan without doing external research even when a module identifies a useful research gap.

## Goals

Enable marketplace-visibility M3 to perform broad public web research through OpenAI's hosted `web_search` tool using the existing `@openai/agents` dependency. Research must preserve Buffr's deterministic workflow boundary: M3 answers bounded research questions and returns structured evidence; it does not decide lifecycle routing or perform marketplace edits.

The first version prioritizes authoritative platform and marketplace sources, especially Shopify and Etsy documentation, but can fall back to broader public web sources when official sources do not answer the question. It must keep citations and source provenance visible in persisted artifacts, stay bounded by cost/search controls, and avoid introducing an MCP server.

## Non-Goals

- Do not add an MCP server or remote MCP client configuration.
- Do not add private marketplace APIs, authenticated Shopify/Etsy Partner APIs, listing mutation APIs, or marketplace edit automation.
- Do not add deep-research/background runs in the first version.
- Do not add a web UI or scheduler.
- Do not let M3 choose workflow routing, approve experiments, or apply changes.
- Do not store raw web page bodies, private dashboard pages, cookies, credentials, or arbitrary HTML in run artifacts.

## Current Architecture Anchors

```
Marketplace visibility CLI
        |
        v
createMarketplaceVisibilityModuleExecutor
        |
        v
WorkflowEngine route/step loop
        |
        +--> M1 deterministic context
        +--> M2 deterministic sparse metrics
        +--> M4/M5/M6 OpenAI-backed structured modules
        +--> M3 currently unavailable/suppressed
```

Relevant current files:

- `src/cli/marketplace-visibility.ts` wires marketplace runs to `createMarketplaceVisibilityModuleExecutor` and steps through M1, M2, M4, M5, and M6 while the run is analyzing.
- `src/agents/runner.ts` wraps `@openai/agents` with `OpenAiAgentRunner`, `runStructuredModule`, structured output validation, credential stripping, and test injection through `execute`.
- `src/contracts/modules.ts` already defines `ResearchToolNameSchema`, `CitationSchema`, and `ResearchOutputSchema`, including `hosted_web_search`.
- `src/agents/research/agent.ts` already models M3 as a bounded research loop with injected `ResearchTool` callables and citation validation.
- `src/workflow/engine.ts` already persists research lifecycle events and stores M3 outputs in `moduleOutputs.m3`.
- `src/storage/runs.ts` writes `run.json`, evidence snapshots, `events.jsonl`, and `experiment-plan.json` from workflow state.
- `node_modules/@openai/agents-openai/dist/tools.d.ts` exports `webSearchTool(options?)` with `filters.allowedDomains` and `searchContextSize`.
- OpenAI's current web-search docs recommend the hosted `web_search` tool for new Responses API integrations and describe inline URL citations plus full consulted-source reporting.

## Proposed Architecture

Use a provider-specific hosted-web-search adapter behind Buffr's existing M3 port. Marketplace visibility will bind a real `hosted_web_search` research tool and stop suppressing research-routing signals. The generic workflow engine remains responsible for M3 lifecycle state; any new observability should be added through existing workflow events and artifact metadata rather than a new router.

```
M2/M4/M5/M6 output
        |
        | researchNeed / research_domain_knowledge / unresolved rules
        v
WorkflowEngine routeAfter* functions
        |
        v
research.requested -> stage: m3_research, status: researching
        |
        v
Marketplace M3 executor
        |
        +--> Research orchestrator prompt and schemas
        |
        +--> Hosted web search adapter
                 |
                 +--> @openai/agents Agent + webSearchTool(...)
                 +--> official-domain pass first
                 +--> broader-web fallback if needed
                 +--> normalized citations and provenance
        |
        v
ResearchOutput persisted in moduleOutputs.m3
        |
        v
research.returned -> original requester stage resumes
```

The first implementation should prefer reusing `src/agents/research/agent.ts` rather than creating a second research loop. Marketplace visibility can call `runResearchModule` with a real `hosted_web_search` tool and no Etsy/private tools. If the existing generic M3 loop is too general for hosted-web-search citations, the adapter should translate hosted-tool output into the existing `ResearchToolResult` contract instead of changing workflow semantics.

## Components and Interfaces

### Marketplace Research Configuration

Add a marketplace research configuration object loaded from environment with safe defaults:

- `MARKETPLACE_RESEARCH_ENABLED`: default `false` for rollout safety.
- `MARKETPLACE_RESEARCH_ALLOWED_DOMAINS`: optional comma-separated override for first-pass authoritative domains.
- `MARKETPLACE_RESEARCH_SEARCH_CONTEXT`: `low`, `medium`, or `high`, default `medium`.
- `MARKETPLACE_RESEARCH_MAX_TOOL_CALLS`: default should not exceed the engine's current M3 call cap of 3.
- `MARKETPLACE_RESEARCH_MAX_WALL_CLOCK_MS`: default should align with the current 120 second research cap.
- `MARKETPLACE_RESEARCH_MAX_ESTIMATED_COST_USD` or token budget controls when cost accounting is available from the SDK result.

The default authoritative domain set should include official marketplace/platform domains that answer policy, listing, discovery, search, ranking, install, and measurement questions:

- `shopify.dev`
- `help.shopify.com`
- `shopify.com`
- `apps.shopify.com`
- `etsy.com`
- `help.etsy.com`
- `developers.etsy.com`

Implementation may split Shopify and Etsy profiles later, but the first version can use one marketplace-authoritative set because marketplace-visibility already supports both `merchgrid_shopify_app_store` and `etsy_listing` profiles.

### Hosted Web Search Adapter

Introduce a `HostedWebSearchResearchTool` implementation of the existing M3 `ResearchTool` shape:

- `name`: `hosted_web_search`
- `call(input)`: accepts a bounded query object from M3 and returns `ResearchToolResult`.
- Internally creates or uses an OpenAI-backed agent with `webSearchTool({ searchContextSize, filters: { allowedDomains } })` for the authoritative pass.
- If the authoritative pass returns no relevant answer or too few qualifying citations, performs one broader web pass without `allowedDomains`, but only when the research request explicitly needs broader context.
- Normalizes output into Buffr citations with `source: "web"`, `title`, `url`, short excerpt or summary, and `fetchedAt`.
- Includes source provenance metadata that is not sent back as raw page text: domain, authoritative classification, search pass name, and any provider-reported consulted-source URL list that the SDK exposes.

The adapter should not execute local shell, browse authenticated sessions, follow private links, or scrape pages itself. The hosted OpenAI web-search tool is the only external research mechanism in v1.

### Agent Runner Boundary

The current `OpenAiAgentRunner` only accepts instructions, input, and an output schema. M3 web search needs tool binding and citation extraction, so v1 should add the smallest extension to the runner boundary:

Decision: extend `AgentRunInput` with optional hosted tools and model settings, then let `OpenAiAgentRunner.runWithSdk` pass `tools: [webSearchTool(...)]` into `new Agent(...)`.

This keeps OpenAI SDK interaction in one adapter and matches the current pattern where production modules depend on `AgentRunner`, not on OpenAI SDK calls scattered through feature modules. Non-research modules should see no behavior change because the new tools field is optional and unset by default.

## Routing and Gating Behavior

Marketplace visibility should stop globally suppressing research requests. Instead, it should preserve the generic engine's existing route triggers and gate only by explicit policy:

- M2: sparse or limited marketplace data may set `researchNeed` when public marketplace guidance could clarify measurement, listing discovery, or interpretation. Sparse data alone should not force research; it should create research only for a concrete external question.
- M4: `research_domain_knowledge` should route to M3 instead of being rewritten to `collect_more_data` when marketplace research is enabled.
- M5: `researchNeed` should be preserved when the hypothesis depends on external marketplace guidance, customer-language evidence, or platform-specific constraints.
- M6: `researchNeed` and non-empty `unresolvedMeasurementRules` should route to M3 when public docs can resolve measurement or test design uncertainty.
- M7: `nextAction: "research"` should route to M3 when later results need public context before the next cycle.

If `MARKETPLACE_RESEARCH_ENABLED` is false, marketplace visibility should keep current behavior for compatibility and emit an explicit event or limitation noting that research was suppressed by configuration. If enabled but no OpenAI key/model/tool support is available, the route should fail as a bounded connector/configuration error or return an unresolved M3 result, depending on whether the request is required for safe continuation.

The first version should permit only `hosted_web_search` for marketplace visibility. Etsy private tools and normalized-evidence tools can remain unbound unless the workflow already has local evidence to expose safely.

## Research Input and Output Schema

Keep the existing `ResearchOutputSchema` as the contract of record for workflow compatibility:

- `status`: `resolved`, `partly_resolved`, or `unresolved`
- `next_action`: `continue` or `stop`
- `requester`
- `question`
- `evidence`: array of citations
- `confidence`
- `limitations`
- optional `requestedLookup`

In v1, marketplace M3 should normally return `next_action: "stop"` after one hosted search pass or after an authoritative pass plus fallback pass. It should use `next_action: "continue"` only when the current result is insufficient and another allowed lookup remains inside the run limits.

Extend citation/provenance persistence carefully. The current `CitationSchema` is intentionally simple. To avoid breaking existing runs, add optional fields rather than replacing it:

- `domain`
- `sourceType`: `official_platform`, `official_marketplace`, `public_web`, or `derived`
- `retrievalMethod`: `openai_hosted_web_search`
- `searchPass`: `authoritative_domains` or `broader_web`
- `retrievedAt` or reuse `fetchedAt`

If schema churn is undesirable, persist extended provenance in workflow event data or a new M3 artifact while keeping `ResearchOutput.evidence` backwards compatible.

## Citation and Source Provenance Persistence

Persist enough information for a reviewer to understand why M3 influenced the run:

- Each cited claim in M3 output must point to a URL citation.
- `moduleOutputs.m3[]` should retain the structured research output.
- Events should include bounded metadata such as requester, return stage, search pass, number of citations, authoritative citation count, broader citation count, and failure category.
- `experiment-plan.json` should include an optional `researchRefs` or `researchContext` section when an M6 plan was shaped by M3 output. It should not duplicate long excerpts.
- `events.jsonl` should record `research.requested`, hosted-search start/completion/failure summaries, and `research.returned`.

The UI or CLI output can remain terse; the saved artifacts should carry the review evidence.

## Authoritative Sources and Broader Fallback

M3 should prefer official sources, not because non-official sources are useless, but because marketplace rules and listing guidance change and should be grounded in the platform's own docs first.

Search policy:

1. Build a search query from the requester, question, marketplace profile, product type, and known context.
2. Run an authoritative-domain search with `allowedDomains`.
3. Accept the result if it directly answers the question and includes at least one official citation.
4. Run a broader public-web fallback only when the official-source result is missing, stale, ambiguous, or insufficient for the requested decision.
5. Mark broader-source evidence lower confidence unless corroborated by official docs.

When broader search is used, M3 should clearly separate official facts from external interpretations. For example, Shopify documentation may establish App Store listing rules, while broader web sources may suggest common merchant search language. Those claims should not be merged as if they have equal provenance.

## Budget and Runtime Controls

Use layered controls:

- Workflow-level limits: keep `DEFAULT_RESEARCH_LIMITS` as the outer cap, currently 3 tool calls and 120 seconds.
- Marketplace-level configuration: cap hosted search passes, context size, and optional cost.
- SDK-level controls: use `webSearchTool({ searchContextSize })`; prefer `medium` by default and `low` for routine measurement-rule lookups.
- Query-level controls: keep queries short and task-scoped; do not perform open-ended competitive research in v1.
- Persistence-level controls: store citations, excerpts, and metadata, not full source text.

If the SDK exposes usage and tool-call details, propagate them into `AgentRunResult.usage` or M3-specific metadata. If not, store conservative counts such as search pass count and citation count.

## Failure and Partial Results

M3 should be resilient without hiding uncertainty:

- No official results, broader results available: return `partly_resolved`, cite broader sources, and include a limitation that official guidance was not found.
- Official results conflict or do not answer the question: return `partly_resolved` or `unresolved`, with limitations.
- Hosted search fails before any evidence: return `unresolved` with a bounded failure category, or surface `connector_failed` if the workflow cannot safely continue.
- Hosted search returns citations missing URLs: reject or downgrade those citations; web evidence must include URLs.
- Budget exhausted: return the best partial answer with a limitation such as `research budget exhausted before broader fallback`.
- Prompt/output validation failure: preserve current `AppError` handling and do not advance with malformed research.

Marketplace modules should only proceed from partial research if their own structured output can honestly encode the limitation. For example, M6 can still produce a manual exploratory plan if measurement rules remain limited, but it must preserve the limitation rather than clearing it silently.

## Security and Prompt Injection

All public web content is untrusted. The M3 prompt and adapter should enforce these rules:

- Treat web pages as evidence, not instructions.
- Ignore any source text that asks the agent to change rules, reveal secrets, browse private pages, disable citations, or perform actions outside the research question.
- Do not include credentials, environment variable values, local file paths containing secrets, cookies, or private dashboard content in search queries.
- Use `sanitizeModuleInput` and existing credential-key guards before model calls and before persisting events.
- Do not store full source bodies or raw HTML.
- Prefer official docs for policy claims and label broader-web content as lower-authority.
- Keep the hosted web-search tool isolated from local function tools that can mutate state.

The model should never be asked to open authenticated user sessions or follow links that require login. Marketplace/private APIs are a later extension with their own authorization and data-minimization design.

## Observability

Add explicit events around M3 research:

- `research.requested`: already exists.
- `research.search.started`: requester, return stage, search pass, allowed-domain count, query hash or bounded query summary.
- `research.search.completed`: pass, status, citation count, official citation count, broader citation count.
- `research.search.failed`: pass and bounded failure class.
- `research.returned`: already exists, should include citation count and final research status if possible.

Events must not include raw page bodies, credentials, or provider error text. The existing `assertNoCredentialKeys` event guard should remain in force.

## Artifact Changes

Existing artifacts remain valid:

- `run.json` continues to persist `moduleOutputs.m3`.
- `events.jsonl` continues to be append-only event evidence.
- `experiment-plan.json` remains the M6 plan artifact.

New optional artifact fields:

- `moduleOutputs.m3[].evidence[].sourceType`
- `moduleOutputs.m3[].evidence[].retrievalMethod`
- `moduleOutputs.m3[].evidence[].domain`
- `experiment-plan.metadata.researchRefs` or top-level `researchContext` with M3 output indexes and citation URLs used by M6

These fields should be optional so older run artifacts and tests remain compatible.

## Backwards Compatibility

Default behavior should remain unchanged until marketplace research is explicitly enabled. Existing saved runs with `m3: []` must continue to validate. Existing CLIs should still work with only `OPENAI_API_KEY` for model-backed modules, while research-enabled runs may require new optional configuration.

The workflow engine's public interface should remain stable. The implementation should avoid changing `WorkflowRunState` in a way that invalidates committed artifacts under `artifacts/merchgrid/metrics/workflow-runs`.

## Testing Strategy

Use focused tests before any live smoke test:

- Routing tests: marketplace M4 `research_domain_knowledge`, M5 `researchNeed`, M6 `researchNeed`, and M6 unresolved measurement rules route to M3 when enabled.
- Compatibility tests: research disabled preserves current route suppression and existing fixture behavior.
- Adapter tests: hosted web-search adapter converts mocked SDK results and URL annotations into `ResearchToolResult` citations.
- Authoritative/fallback tests: official-domain result suppresses fallback; insufficient official result permits one broader fallback and labels source types correctly.
- Persistence tests: `run.json`, `events.jsonl`, and `experiment-plan.json` include bounded research metadata without raw page bodies.
- Security tests: web content that contains instruction-like text is summarized as evidence and cannot alter system rules, remove citations, or request secrets.
- Failure tests: no citations, provider failure, malformed output, and budget exhaustion produce bounded unresolved or partial results.
- Contract tests: existing saved artifacts with `m3: []` still parse.

Live tests should be opt-in only, gated by environment, and should use harmless marketplace-documentation questions against official domains. No default test run should call the network.

## Rollout

1. Add configuration and tests with research disabled by default.
2. Bind `hosted_web_search` for marketplace visibility behind the feature flag.
3. Preserve research-routing signals when enabled; keep compatibility behavior when disabled.
4. Persist citation/provenance metadata and event summaries.
5. Run one opt-in live smoke against official Shopify/Etsy docs.
6. Review the first saved run artifact before enabling by default.

## Open Decisions for Implementation Review

- Whether extended citation provenance belongs directly in `CitationSchema` or in a companion M3 provenance artifact.
- Whether the first enabled profile should be only `merchgrid_shopify_app_store` or both Shopify and Etsy marketplace-visibility profiles.
- Whether a missing/failed M3 result should block M4/M5/M6 continuation for all requests or only for required measurement-rule research.

## Implementation Sequence

This is intentionally a short sequence, not the detailed implementation plan:

1. Add marketplace research configuration and feature-flag tests.
2. Add hosted-web-search adapter tests with mocked `@openai/agents` results.
3. Enable marketplace `runM3` with the adapter while preserving engine contracts.
4. Remove or gate the current research-suppression normalization.
5. Add provenance persistence and event assertions.
6. Add opt-in live smoke documentation.

## Review Checklist

- No MCP server is introduced.
- M3 remains a bounded research worker, not a router.
- Official marketplace/platform sources are preferred before broader web fallback.
- Citations and provenance are persisted without full page bodies.
- Sparse internal evidence can trigger research only through explicit M2/M4/M5/M6 signals.
- Existing runs remain valid.
- Network use remains absent from default tests.

## References

- OpenAI web search guide: `https://developers.openai.com/api/docs/guides/tools-web-search`
- OpenAI Agents SDK tools guide: `https://openai.github.io/openai-agents-js/guides/tools/`
