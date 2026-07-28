# Buffr Decision Intelligence Platform
## Implementation Plan and Technical Specification

**Status:** Draft  
**Version:** 0.1  
**Primary objective:** Build a reusable, domain-agnostic decision intelligence platform that powers multiple products such as InvestmentGrid, TrendGrid, and MerchGrid.

---

## 1. Executive Summary

Buffr should be designed as a layered decision intelligence platform.

The system will provide reusable reasoning capabilities, domain-specific knowledge packs, orchestrated engines, and customer-facing products.

The main architecture is:

```text
Products / Grids
      |
      v
Engines
      |
      v
Domain Packs + Reusable Capabilities
      |
      v
Kernel
      |
      v
Models, APIs, Databases, and External Data
```

The first implementation should not attempt to build all twelve capabilities at once.

The recommended v1 should validate the architecture using:

- one shared kernel
- four reusable capabilities
- two domain packs
- two engines
- two internal workflows
- one evaluation platform

The first two workflows should be:

1. Investment Research Workflow
2. Digital Product Opportunity Workflow

The goal of v1 is to prove that both workflows can reuse the same foundational contracts without duplicating orchestration, tracing, validation, scoring, and evaluation infrastructure.

---

## 2. Product Vision

Buffr is a reusable platform for building decision-support products.

Each product helps a user:

1. collect relevant information
2. reduce noise
3. identify meaningful patterns
4. evaluate options
5. understand risks
6. make a decision
7. record the reasoning
8. review the outcome later

Example products:

```text
Buffr
|
+-- InvestmentGrid
|   +-- daily market learning
|   +-- company research
|   +-- ETF research
|   +-- decision journal
|
+-- TrendGrid
|   +-- Etsy opportunity research
|   +-- Shopify product research
|   +-- competitor analysis
|   +-- experiment tracking
|
+-- MerchGrid
|   +-- catalog health scanning
|   +-- pricing checks
|   +-- duplicate SKU detection
|   +-- listing quality checks
|
+-- Future Grids
    +-- CareerGrid
    +-- ContentGrid
    +-- ResearchGrid
```

---

## 3. Architectural Principles

### 3.1 Domain-Agnostic Core

The kernel and reusable capabilities must not contain investing-, Etsy-, or Shopify-specific rules.

Domain behavior must be injected through domain packs.

Bad:

```typescript
if (domain === "stocks") {
  calculatePERatio();
} else if (domain === "etsy") {
  calculateKeywordCompetition();
}
```

Preferred:

```typescript
const result = await scorer.execute({
  candidates,
  scorecard: domainPack.scorecard,
  constraints: domainPack.constraints,
});
```

### 3.2 Deterministic Before Generative

Use normal code whenever the answer can be calculated or validated deterministically.

Use code for:

- arithmetic
- ratios
- thresholds
- filtering
- sorting
- deduplication
- date comparisons
- fee calculations
- portfolio allocation
- score aggregation

Use models for:

- summarization
- categorization
- interpretation
- explanation
- hypothesis generation
- scenario construction
- ambiguous pattern recognition

### 3.3 Evidence-First Outputs

Every recommendation must include:

- supporting evidence
- source references
- confidence
- missing information
- warnings
- assumptions

### 3.4 Typed Intermediate Results

Every step should produce structured, inspectable output.

Avoid passing large unstructured text blobs between capabilities.

### 3.5 Evaluation as a Platform Feature

Evaluation is not a final testing step.

Every capability, engine, and product workflow must expose evaluation hooks.

### 3.6 Human-in-the-Loop Decisions

The system should support decisions, not silently execute financial trades, publish products, or modify customer stores in v1.

---

## 4. System Architecture

```text
+------------------------------------------------------------------+
|                         PRODUCT LAYER                            |
|                                                                  |
|  InvestmentGrid      TrendGrid       MerchGrid       Future Apps |
|                                                                  |
|  Dashboards, reports, journals, alerts, billing, user workflows  |
+-------------------------------+----------------------------------+
                                |
                                v
+------------------------------------------------------------------+
|                         ENGINE LAYER                             |
|                                                                  |
|  Investment Research Engine                                     |
|  Product Opportunity Engine                                     |
|  Catalog Intelligence Engine                                    |
|  Decision Learning Engine                                       |
|                                                                  |
|  Engines orchestrate capabilities and domain policies           |
+-------------------------------+----------------------------------+
                                |
                                v
+------------------------------------------------------------------+
|                DOMAIN PACK + CAPABILITY LAYER                    |
|                                                                  |
|  Capabilities:                                                   |
|  Collector, Analyzer, Comparator, Pattern Detector, Risk         |
|  Analyzer, Scorer, Recommender, Teacher, Journal, Memory         |
|                                                                  |
|  Domain Packs:                                                   |
|  Investing, Digital Products, Shopify Catalogs                   |
+-------------------------------+----------------------------------+
                                |
                                v
+------------------------------------------------------------------+
|                          KERNEL LAYER                            |
|                                                                  |
|  Model Gateway        Tool Runtime       Workflow Runtime         |
|  Structured Output    Retrieval          Memory                   |
|  Prompt Registry      Tracing            Validation               |
|  Cache                Cost Controls      Policy                   |
+-------------------------------+----------------------------------+
                                |
                                v
+------------------------------------------------------------------+
|                    DATA AND CONNECTOR LAYER                      |
|                                                                  |
|  Market APIs, SEC, ETF data, brokerage exports, Etsy research,   |
|  Shopify APIs, reviews, search trends, databases, user files     |
+------------------------------------------------------------------+
```

---

## 5. Layer Definitions

## 5.1 Kernel

The kernel defines how all agents and engines operate.

### Kernel responsibilities

- model routing
- prompt versioning
- tool execution
- retries
- timeouts
- schema validation
- structured outputs
- tracing
- token and cost tracking
- caching
- permissions
- source attribution
- memory access
- evaluation hooks

### Kernel interfaces

```typescript
export interface AgentContext {
  userId: string;
  workspaceId: string;
  traceId: string;
  domain: string;
  now: string;
  permissions: string[];
}

export interface Evidence {
  sourceId: string;
  sourceType: string;
  title?: string;
  url?: string;
  excerpt?: string;
  retrievedAt: string;
  freshness?: "live" | "recent" | "stale" | "unknown";
}

export interface AgentResult<T> {
  data: T;
  confidence: number;
  evidence: Evidence[];
  assumptions: string[];
  warnings: string[];
  traceId: string;
  promptVersion?: string;
  model?: string;
  latencyMs?: number;
  estimatedCostUsd?: number;
}

export interface Capability<TInput, TOutput> {
  name: string;
  version: string;
  execute(
    input: TInput,
    context: AgentContext
  ): Promise<AgentResult<TOutput>>;
}
```

---

## 5.2 Reusable Capabilities

The long-term architecture may contain twelve reusable capabilities.

### Target capability catalog

1. Collector
2. Summarizer
3. Comparator
4. Pattern Detector
5. Opportunity Finder
6. Risk Analyzer
7. Scorer
8. Recommender
9. Journal
10. Teacher
11. Scenario Modeler
12. Memory Manager

### Recommended v1 capability set

Build only these first:

1. Collector
2. Analyzer
3. Scorer
4. Teacher and Journal

The Analyzer may initially combine:

- summarization
- comparison
- pattern detection
- basic risk identification

These can be split into separate capabilities after repeated use cases demonstrate the need.

```text
V1

Collector
   |
   v
Analyzer
   |
   v
Scorer
   |
   v
Teacher / Journal
```

### Capability contract example

```typescript
export interface AnalysisDimension {
  id: string;
  label: string;
  description: string;
  weight?: number;
}

export interface AnalyzeInput<T> {
  subject: T;
  evidence: Evidence[];
  dimensions: AnalysisDimension[];
  instructions?: string[];
}

export interface AnalyzeOutput {
  findings: Array<{
    dimensionId: string;
    summary: string;
    positives: string[];
    negatives: string[];
    unknowns: string[];
    confidence: number;
    evidenceIds: string[];
  }>;
}
```

---

## 5.3 Domain Packs

A domain pack contains domain-specific knowledge, policies, metrics, schemas, and evaluation fixtures.

### Domain pack interface

```typescript
export interface DomainPack {
  id: string;
  version: string;
  entities: Record<string, unknown>;
  metrics: MetricDefinition[];
  scorecards: Record<string, ScorecardDefinition>;
  constraints: ConstraintDefinition[];
  sourcePolicies: SourcePolicy[];
  prompts: Record<string, string>;
  evalDatasets: string[];
}
```

### Investing domain pack

```text
Investing Domain Pack
|
+-- entity schemas
|   +-- stock
|   +-- ETF
|   +-- company
|   +-- portfolio
|
+-- metric definitions
|   +-- revenue growth
|   +-- free cash flow
|   +-- debt
|   +-- valuation
|   +-- expense ratio
|   +-- concentration
|
+-- scorecards
|   +-- business quality
|   +-- valuation
|   +-- risk
|   +-- ETF suitability
|
+-- source rules
|   +-- SEC filings preferred
|   +-- official fund documents preferred
|   +-- stale price warnings
|
+-- evaluation fixtures
    +-- known company comparisons
    +-- ratio calculations
    +-- source-grounding tests
```

### Digital products domain pack

```text
Digital Products Domain Pack
|
+-- entity schemas
|   +-- listing
|   +-- keyword
|   +-- niche
|   +-- product idea
|
+-- metric definitions
|   +-- demand
|   +-- competition
|   +-- price
|   +-- margin
|   +-- seasonality
|   +-- production complexity
|
+-- scorecards
|   +-- opportunity
|   +-- execution difficulty
|   +-- revenue potential
|   +-- saturation risk
|
+-- source rules
|   +-- marketplace listings
|   +-- search trends
|   +-- customer reviews
|
+-- evaluation fixtures
    +-- known saturated niches
    +-- known seasonal products
    +-- ranking consistency tests
```

---

## 5.4 Engines

An engine is a domain workflow composed from reusable capabilities.

### Engine interface

```typescript
export interface Engine<TInput, TOutput> {
  id: string;
  version: string;
  run(
    input: TInput,
    context: AgentContext
  ): Promise<AgentResult<TOutput>>;
}
```

### Investment Research Engine

```text
User selects a company or ETF
              |
              v
+---------------------------+
| Collector                 |
| filings, prices, holdings |
+-------------+-------------+
              |
              v
+---------------------------+
| Normalize data            |
+-------------+-------------+
              |
              v
+---------------------------+
| Analyze fundamentals      |
+-------------+-------------+
              |
              v
+---------------------------+
| Analyze risks             |
+-------------+-------------+
              |
              v
+---------------------------+
| Score dimensions          |
+-------------+-------------+
              |
              v
+---------------------------+
| Explain findings          |
+-------------+-------------+
              |
              v
+---------------------------+
| Save decision journal     |
+---------------------------+
```

### Product Opportunity Engine

```text
User selects a market or niche
              |
              v
+---------------------------+
| Collector                 |
| listings, reviews, trends |
+-------------+-------------+
              |
              v
+---------------------------+
| Normalize data            |
+-------------+-------------+
              |
              v
+---------------------------+
| Detect needs and patterns |
+-------------+-------------+
              |
              v
+---------------------------+
| Estimate competition      |
+-------------+-------------+
              |
              v
+---------------------------+
| Score opportunities       |
+-------------+-------------+
              |
              v
+---------------------------+
| Explain recommendation    |
+-------------+-------------+
              |
              v
+---------------------------+
| Save experiment journal   |
+---------------------------+
```

---

## 5.5 Products

Products package engines into focused user experiences.

### InvestmentGrid

Initial features:

- daily market lesson
- stock or ETF research
- company comparison
- investment thesis
- decision checklist
- investment journal
- thesis review

### TrendGrid

Initial features:

- daily niche research
- keyword and listing analysis
- competitor review analysis
- product opportunity score
- product hypothesis
- experiment journal
- outcome review

### MerchGrid

Initial features remain catalog-specific:

- duplicate SKU and barcode detection
- below-cost pricing checks
- compare-at price inversions
- missing alt text
- missing feed fields
- zero-inventory published products
- CSV export

MerchGrid may reuse kernel infrastructure without requiring all reasoning capabilities.

---

## 6. Repository Structure

Recommended monorepo structure:

```text
buffr/
|
+-- apps/
|   +-- investment-grid/
|   +-- trend-grid/
|   +-- merch-grid/
|   +-- admin/
|
+-- packages/
|   +-- kernel/
|   |   +-- model-gateway/
|   |   +-- tool-runtime/
|   |   +-- workflow-runtime/
|   |   +-- tracing/
|   |   +-- validation/
|   |   +-- prompts/
|   |   +-- memory/
|   |
|   +-- capabilities/
|   |   +-- collector/
|   |   +-- analyzer/
|   |   +-- scorer/
|   |   +-- teacher/
|   |   +-- journal/
|   |
|   +-- domain-packs/
|   |   +-- investing/
|   |   +-- digital-products/
|   |   +-- shopify-catalog/
|   |
|   +-- engines/
|   |   +-- investment-research/
|   |   +-- product-opportunity/
|   |   +-- catalog-intelligence/
|   |
|   +-- evals/
|   |   +-- datasets/
|   |   +-- graders/
|   |   +-- runners/
|   |   +-- reports/
|   |
|   +-- contracts/
|   +-- database/
|   +-- connectors/
|   +-- ui/
|
+-- docs/
|   +-- architecture/
|   +-- decisions/
|   +-- product-specs/
|   +-- runbooks/
|
+-- scripts/
+-- tests/
+-- package.json
+-- turbo.json
```

Recommended stack:

- TypeScript
- Node.js
- Next.js
- Postgres
- Zod
- OpenAI SDK or equivalent model abstraction
- workflow orchestration through explicit TypeScript pipelines first
- background jobs through a durable queue
- object storage for raw source artifacts
- OpenTelemetry-compatible tracing
- Vitest for unit and regression tests

Avoid introducing a complex graph orchestration framework until the workflows require branching, resumability, or long-running state.

---

## 7. Data Model

Core entities:

```text
User
Workspace
Product
Domain
EngineRun
CapabilityRun
Trace
Source
Evidence
Analysis
Scorecard
Recommendation
Decision
JournalEntry
Outcome
EvaluationCase
EvaluationRun
PromptVersion
ModelConfiguration
```

### Suggested database tables

```text
users
workspaces
workspace_members

sources
source_documents
evidence_items

engine_runs
capability_runs
traces

analyses
analysis_findings
scorecards
scores
recommendations

decisions
journal_entries
outcomes

prompt_versions
model_configs

eval_datasets
eval_cases
eval_runs
eval_results
```

### Decision journal model

```typescript
export interface DecisionJournalEntry {
  id: string;
  userId: string;
  domain: "investing" | "digital-products" | string;
  subjectType: string;
  subjectId: string;
  createdAt: string;

  decision: string;
  thesis: string;
  expectedOutcome: string;
  timeHorizon?: string;

  confidence: number;
  assumptions: string[];
  risks: string[];
  evidenceIds: string[];

  emotionalState?: string;
  status: "open" | "review-due" | "reviewed";
  reviewAt?: string;
}
```

---

## 8. Scoring System

The scoring engine must be generic.

### Generic scorecard

```typescript
export interface ScoreMetric {
  id: string;
  label: string;
  weight: number;
  direction: "higher-is-better" | "lower-is-better";
  min: number;
  max: number;
}

export interface ScorecardDefinition {
  id: string;
  version: string;
  metrics: ScoreMetric[];
  minimumEvidenceCount?: number;
  confidencePenalty?: number;
}
```

### Investment scorecard example

```text
Business Quality          25%
Financial Strength        20%
Growth Durability         15%
Valuation                 20%
Risk                      20%
```

### Digital product scorecard example

```text
Demand                    25%
Competition               20%
Margin Potential          20%
Production Difficulty     15%
Seasonality Risk          10%
Differentiation           10%
```

### Important rule

The total score must never hide uncertainty.

Display:

```text
Opportunity Score: 78 / 100
Confidence: 54%
Evidence Coverage: 7 / 12 required signals
Primary Unknown: Reliable sales volume
```

---

## 9. Evaluation Architecture

```text
                    +-----------------------+
                    | Evaluation Platform   |
                    +-----------+-----------+
                                |
          +---------------------+----------------------+
          |                     |                      |
          v                     v                      v
+----------------+   +-------------------+   +-------------------+
| Capability     |   | Engine            |   | Product           |
| evaluations    |   | evaluations       |   | outcome metrics   |
+----------------+   +-------------------+   +-------------------+
```

### 9.1 Capability evaluations

Collector:

- source coverage
- extraction accuracy
- freshness
- duplicate rate
- citation correctness

Analyzer:

- factual consistency
- required-dimension coverage
- unsupported claims
- missing-data disclosure
- risk coverage

Scorer:

- arithmetic correctness
- ranking consistency
- sensitivity to weights
- confidence calibration
- missing-data behavior

Teacher:

- conceptual correctness
- clarity
- explanation completeness
- appropriate difficulty
- actionability

Journal:

- input preservation
- retrieval accuracy
- review scheduling correctness
- outcome linkage

### 9.2 Engine evaluations

Investment engine:

- filing-based claims are grounded
- ratios match deterministic calculations
- risks are not omitted
- uncertainty is surfaced
- recommendations do not become unsupported trade instructions

Product opportunity engine:

- recurring complaints are supported by evidence
- opportunity scores are stable
- seasonality is considered
- competition is not inferred from one source
- production difficulty is realistic

### 9.3 Product metrics

InvestmentGrid:

- daily sessions completed
- research reports saved
- journal entries created
- thesis reviews completed
- user-rated clarity
- user-reported confidence calibration

TrendGrid:

- opportunities saved
- experiments launched
- product ideas rejected before execution
- research-to-launch conversion
- outcome reviews completed
- score versus actual result correlation

### 9.4 Evaluation loop

```text
Run workflow
    |
    v
Capture trace
    |
    v
Grade result
    |
    v
Classify failure
    |
    +-- prompt issue
    +-- model issue
    +-- retrieval issue
    +-- stale data
    +-- normalization issue
    +-- scoring issue
    +-- workflow issue
    +-- UX issue
    |
    v
Apply change
    |
    v
Run regression suite
    |
    v
Deploy only when quality does not regress
```

---

## 10. Eval Dataset Strategy

Create a versioned dataset for every important workflow.

### Dataset format

```typescript
export interface EvalCase<TInput, TExpected> {
  id: string;
  domain: string;
  capabilityOrEngine: string;
  input: TInput;
  expected: TExpected;
  rubric: string[];
  tags: string[];
  sourceSnapshotIds?: string[];
}
```

### Dataset categories

- happy path
- incomplete data
- conflicting sources
- stale data
- misleading trend
- sparse evidence
- extreme values
- malformed input
- model refusal
- connector failure
- prompt injection attempt
- domain boundary case

### Golden dataset sizes

Initial target:

```text
Collector               25 cases
Analyzer                40 cases
Scorer                   30 cases
Teacher                  20 cases
Investment Engine        40 cases
Opportunity Engine       40 cases
```

Expand datasets from production failures.

Every meaningful production failure should become a regression test.

---

## 11. Observability

Every engine run should produce a trace.

```text
Engine Run
|
+-- Input
+-- User and workspace
+-- Domain pack version
+-- Engine version
+-- Model configuration
+-- Prompt versions
+-- Capability runs
|   +-- inputs
|   +-- outputs
|   +-- evidence
|   +-- latency
|   +-- token usage
|   +-- cost
|   +-- validation errors
|
+-- Final output
+-- User feedback
+-- Eval result
```

Required dashboards:

- success rate
- schema failure rate
- source failure rate
- average latency
- average cost per engine
- average cost per capability
- unsupported-claim rate
- user feedback
- score distribution
- low-confidence output rate

---

## 12. Security and Safety

### Investment-specific controls

- no automatic brokerage execution in v1
- no personalized buy or sell command without clear disclaimers and user decision control
- show source timestamps
- separate factual calculations from model interpretation
- flag stale prices and stale filings
- preserve user-entered decision history
- encrypt sensitive portfolio data
- use least-privilege brokerage access if added later

### Commerce-specific controls

- no automatic product publishing in v1
- no automatic Shopify modifications in MerchGrid v1
- respect marketplace terms and API limits
- distinguish estimated demand from verified sales
- label modeled revenue estimates clearly
- maintain source provenance

---

## 13. Implementation Phases

## Phase 0: Architecture Validation

**Goal:** Prove the contracts before building product features.

Deliverables:

- monorepo
- architecture decision records
- core TypeScript contracts
- test harness
- sample investment fixture
- sample digital product fixture
- one end-to-end mocked workflow per domain

Exit criteria:

- both workflows use the same `AgentResult`
- both workflows use the same tracing contract
- both workflows use the same generic scoring engine
- no domain conditionals in the kernel

---

## Phase 1: Kernel v1

**Goal:** Build stable execution primitives.

Deliverables:

- model gateway
- structured output validation
- prompt registry
- retry and timeout policy
- tracing
- cost tracking
- capability runner
- engine runner
- evidence model
- basic cache
- test utilities

Exit criteria:

- every model call has a trace
- every capability validates output
- prompts are versioned
- failures are classified
- test runs are reproducible

---

## Phase 2: Shared Capabilities v1

**Goal:** Build the minimum reusable reasoning layer.

Deliverables:

- Collector
- Analyzer
- Generic Scorer
- Teacher
- Journal

Exit criteria:

- each capability has typed input and output
- each capability has unit tests
- each capability has a minimum eval dataset
- each capability works with both domain packs

---

## Phase 3: Domain Packs v1

**Goal:** Add specialized behavior without changing the core.

Deliverables:

### Investing pack

- company schema
- ETF schema
- financial metrics
- investment scorecard
- source priority rules
- risk taxonomy
- evaluation fixtures

### Digital products pack

- listing schema
- niche schema
- opportunity metrics
- competition scorecard
- seasonality rules
- evaluation fixtures

Exit criteria:

- adding a domain pack requires configuration, schemas, policies, and tests
- no kernel code changes are needed
- generic capabilities accept either domain pack

---

## Phase 4: Engines v1

**Goal:** Create two reusable workflows.

Deliverables:

- Investment Research Engine
- Product Opportunity Engine
- trace visualization
- engine-level evals
- snapshot tests

Exit criteria:

- both engines complete end-to-end runs
- evidence is preserved across steps
- low-confidence outputs are flagged
- deterministic calculations are independently tested
- regression suite passes

---

## Phase 5: Internal Daily Workbench

**Goal:** Create a private interface for daily use before building a public product.

Features:

```text
Daily Workbench
|
+-- Choose domain
|   +-- Investing
|   +-- Digital Products
|
+-- Run research
+-- View evidence
+-- Inspect scores
+-- Read explanation
+-- Record decision
+-- Schedule outcome review
+-- Give feedback
+-- Add failed output to eval dataset
```

Exit criteria:

- usable for a 15-minute daily research session
- outputs can be rated
- journal entries can be reviewed later
- failures can be converted into eval cases

---

## Phase 6: Productization

**Goal:** Split validated workflows into products.

### InvestmentGrid v1

- company or ETF research
- scorecard
- evidence view
- learning explanation
- decision journal

### TrendGrid v1

- niche research
- listing and review analysis
- opportunity score
- product hypothesis
- experiment journal

### MerchGrid integration

- reuse authentication
- tracing
- billing
- workspace
- evaluation infrastructure
- reporting components

Exit criteria:

- each product has a clear user and primary job
- engines remain reusable packages
- product code does not contain low-level model logic

---

## Phase 7: Capability Decomposition

Split the Analyzer only when usage proves the need.

Possible decomposition:

```text
Analyzer
|
+-- Summarizer
+-- Comparator
+-- Pattern Detector
+-- Risk Analyzer
+-- Opportunity Finder
+-- Scenario Modeler
```

Decompose when:

- prompts diverge significantly
- evaluation rubrics differ
- models need different routing
- latency optimization requires parallel steps
- one function becomes reusable independently
- failures cannot be diagnosed at the combined level

---

## Phase 8: Continuous Improvement Platform

Deliverables:

- dataset management UI
- prompt comparison
- model comparison
- experiment tracking
- regression dashboards
- human grading queue
- production feedback ingestion
- score calibration reports
- outcome correlation reports

Long-term loop:

```text
Production use
      |
      v
Collect outcomes and failures
      |
      v
Create eval cases
      |
      v
Test prompt, model, workflow, or policy changes
      |
      v
Compare against baseline
      |
      v
Deploy improved version
```

---

## 14. Recommended First Vertical Slice

Build this before expanding.

### Use case A: Stock Research

Input:

```text
Ticker: COST
Goal: Learn the business and decide whether it belongs on a watchlist
```

Output:

```text
Business summary
Key financial metrics
Strengths
Risks
Valuation context
Scorecard
Confidence
Evidence
Learning lesson
Journal prompt
```

### Use case B: Etsy Product Research

Input:

```text
Niche: Budget planner printable
Goal: Decide whether to investigate or reject the niche
```

Output:

```text
Demand signals
Competition signals
Customer complaints
Differentiation ideas
Execution difficulty
Opportunity score
Confidence
Evidence
Learning lesson
Experiment prompt
```

### Shared implementation

```text
                   Shared Kernel
                        |
                        v
                    Collector
                        |
                        v
                     Analyzer
                        |
                        v
                      Scorer
                        |
                        v
                Teacher / Journal
                   /          \
                  v            v
       Investing Domain    Product Domain
                  |            |
                  v            v
       Stock Research      Niche Research
```

The architecture is validated only if both use cases share the same execution contracts while producing domain-appropriate outputs.

---

## 15. Initial API Design

### Run an engine

```http
POST /api/engine-runs
```

```json
{
  "engineId": "investment-research",
  "domainPackVersion": "investing@0.1.0",
  "input": {
    "ticker": "COST",
    "goal": "watchlist-review"
  }
}
```

### Response

```json
{
  "runId": "run_123",
  "status": "completed",
  "result": {
    "score": 74,
    "confidence": 0.68,
    "summary": "High-quality business with valuation risk.",
    "warnings": [
      "Current valuation is above the selected historical reference range."
    ],
    "evidence": []
  }
}
```

### Submit feedback

```http
POST /api/engine-runs/:runId/feedback
```

```json
{
  "rating": 4,
  "correct": true,
  "useful": true,
  "notes": "The risk section should explain membership renewal sensitivity."
}
```

### Save a decision

```http
POST /api/decisions
```

```json
{
  "domain": "investing",
  "subjectType": "stock",
  "subjectId": "COST",
  "decision": "Add to watchlist",
  "confidence": 0.65,
  "reviewAt": "2026-10-26"
}
```

---

## 16. Development Workflow

For every new capability or engine:

```text
1. Define the job
2. Define typed input and output
3. Define deterministic components
4. Define model-dependent components
5. Define evidence requirements
6. Define failure modes
7. Create eval cases
8. Implement
9. Run eval baseline
10. Add tracing
11. Integrate into one engine
12. Test across two domains when intended to be generic
13. Deploy internally
14. Convert failures into regression cases
```

Definition of done:

- typed contracts
- unit tests
- eval cases
- trace support
- cost measurement
- latency measurement
- error handling
- source provenance
- documentation
- versioning

---

## 17. Backlog

### P0

- monorepo setup
- contracts package
- model gateway
- structured output validation
- tracing
- evidence model
- generic scorecard
- evaluation runner
- Collector v1
- Analyzer v1
- Investing pack v1
- Digital products pack v1
- Investment Engine v1
- Opportunity Engine v1
- internal workbench

### P1

- Teacher capability
- Journal capability
- outcome reviews
- prompt registry UI
- trace viewer
- eval report UI
- source freshness rules
- caching
- parallel capability execution

### P2

- Comparator
- Pattern Detector
- Risk Analyzer
- Scenario Modeler
- Memory Manager
- scheduled daily workflows
- alerting
- brokerage read-only integration
- marketplace connectors
- model routing optimization

### P3

- multi-user workspaces
- public APIs
- billing
- plugin or extension framework
- third-party domain packs
- product-specific automation
- calibrated forecasting
- outcome-based recommendation tuning

---

## 18. Risks

### Risk: Premature abstraction

Mitigation:

- build only two vertical slices
- extract shared abstractions after duplication appears
- do not split all twelve capabilities immediately

### Risk: Generic agents become vague

Mitigation:

- use strict domain packs
- require explicit dimensions and scorecards
- use typed outputs
- require evidence references

### Risk: Evals measure writing quality instead of decision quality

Mitigation:

- include deterministic graders
- include expert labels
- capture real outcomes
- measure calibration and usefulness separately

### Risk: Stale or unreliable data

Mitigation:

- source timestamps
- source priority rules
- freshness warnings
- provider redundancy for critical data

### Risk: Excessive model cost

Mitigation:

- deterministic preprocessing
- caching
- smaller models for classification
- batch collection
- model routing
- cost budgets per engine

### Risk: Too many products too early

Mitigation:

- use a private daily workbench first
- validate repeated personal use
- productize only the strongest workflow

---

## 19. Success Criteria

### Platform success

- two domains reuse the same kernel and capability contracts
- a new domain pack can be added without kernel changes
- every recommendation is traceable to evidence
- every production failure can become an eval case
- model, prompt, and domain versions are reproducible

### Investment workflow success

- daily use is practical in 10 to 20 minutes
- calculations are deterministic
- claims include evidence
- uncertainty is visible
- decisions can be reviewed against later outcomes

### Product opportunity workflow success

- research can reject weak ideas early
- recurring customer problems are evidence-backed
- opportunity scores expose assumptions
- experiments are recorded and reviewed
- outcomes improve future scoring calibration

---

## 20. Final Recommended Build Order

```text
Step 1
Contracts and architecture tests
        |
        v
Step 2
Kernel execution and tracing
        |
        v
Step 3
Collector and generic scorer
        |
        v
Step 4
Combined Analyzer
        |
        v
Step 5
Investing and digital-product domain packs
        |
        v
Step 6
Two end-to-end engines
        |
        v
Step 7
Evaluation datasets and regression runner
        |
        v
Step 8
Private daily workbench
        |
        v
Step 9
Teacher and journal
        |
        v
Step 10
Productize the workflow with the strongest repeated value
        |
        v
Step 11
Split capabilities only when evidence supports it
```

---

## 21. Core Mental Model

```text
Kernel
=
How the system operates

Capabilities
=
What reusable reasoning the system performs

Domain Packs
=
What the system knows about a field

Engines
=
How capabilities collaborate to complete a workflow

Products / Grids
=
How users experience and pay for the workflow

Evaluations
=
How quality is measured and improved continuously
```

The twelve-agent catalog should be treated as the long-term capability map, not the initial implementation checklist.

The immediate objective is to build the smallest shared platform that can successfully support two distinct decision workflows.
