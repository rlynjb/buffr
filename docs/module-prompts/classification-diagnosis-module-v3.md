# Classification & Diagnosis Module

<!-- Source: Master V6 Steps 6–8 -->

## Responsibility

Interpret qualified product-performance evidence to determine:

1. what appears to be working,
2. the primary performance path,
3. the single strongest supported bottleneck,
4. the strongest competing explanation,
5. confidence in the diagnosis,
6. whether to proceed, research, or collect more data.

---

## Inputs

Use:

- product context, listing presentation, and evidence provenance from **M1 — Product Context / Observation**,
- calculated metrics, baseline comparison, comparison validity, and metric qualification from **M2 — Metrics & Qualification**,
- findings from **M3 — Domain Research** when research was required.

Treat M1 and M2 outputs as upstream evidence for this diagnostic pass.

Do not recalculate metrics, select a new baseline, or re-qualify comparison periods.

## Dependencies

- **M0 — Core Agent:** required shared reasoning and guardrails.
- **M1 — Product Context / Observation:** required product and evidence context.
- **M2 — Metrics & Qualification:** required qualified performance evidence.
- **M3 — Domain Research:** conditional/callable when domain knowledge is required for diagnosis.

## Reasoning Mode

**HYBRID / PROBABILISTIC**

Use qualified upstream evidence as the factual basis.

Use LLM judgment to:

- interpret patterns across the funnel,
- compare plausible performance paths,
- identify the most likely bottleneck,
- assess competing explanations,
- determine diagnostic confidence.

Ground interpretations in qualified evidence.

---

## 1. Identify What Went Well

Identify meaningful positive signals supported by qualified evidence.

Possible signals may include:

- improving qualified traffic,
- improving CTR,
- improving favorite rate,
- improving conversion,
- increasing revenue,
- stronger revenue per view,
- improving advertising efficiency,
- successful search terms,
- successful previous experiments.

Explain why each positive signal matters.

Do not call a metric strong based only on its absolute value.

---

## 2. Classify the Primary Performance Path

Choose exactly **ONE**:

- **DISCOVERY**
- **CLICK-THROUGH**
- **INTEREST**
- **CONVERSION**
- **PROFITABILITY**
- **INSUFFICIENT DATA**

Use the funnel:

**Search Demand → Impression → Click / View → Interest / Favorite → Purchase → Revenue / Profit**

If several weaknesses exist, select the path most likely to materially constrain downstream performance.

### DISCOVERY

Primary question:

**Are enough qualified buyers seeing the listing?**

Relevant evidence may include qualified impressions, organic traffic, search visibility, demand, competition, and visibility-related context.

### CLICK-THROUGH

Primary question:

**Are buyers seeing the listing but choosing not to open it?**

Relevant evidence may include impressions, clicks, CTR, search-result relevance, thumbnail, title, and positioning.

### INTEREST

Primary question:

**Are buyers opening the listing but failing to demonstrate meaningful interest?**

Relevant evidence may include views, favorite activity, engagement, product appeal, positioning, target customer, and value proposition.

### CONVERSION

Primary question:

**Are interested buyers failing to purchase?**

Relevant evidence may include views, favorite activity, orders, conversion, ad clicks, price, perceived value, previews, clarity, trust, and purchase friction.

### PROFITABILITY

Primary question:

**Is the product selling but producing weak financial performance?**

Relevant evidence may include order volume, conversion, revenue efficiency, ROAS, pricing, bundles, average order value, acquisition cost, and product economics.

### INSUFFICIENT DATA

Choose when the qualified upstream evidence does not support a reliable primary-path classification.

Identify the specific evidence gap or unresolved uncertainty.

---

## 3. Diagnose the Primary Bottleneck

Within the selected performance path, identify the **single strongest supported bottleneck**.

Make the bottleneck specific enough to support a later hypothesis.

Preserve upstream evidence provenance and clearly separate evidence from diagnostic interpretation.

---

## 4. Identify the Strongest Competing Explanation

Identify the most plausible alternative explanation for the same performance pattern.

Explain:

- why it is plausible,
- what evidence supports it,
- why the primary diagnosis currently has stronger support.

If the evidence does not meaningfully distinguish between explanations, lower confidence or choose **COLLECT MORE DATA**.

---

## 5. Assign Confidence

Choose:

- **LOW**
- **MODERATE**
- **HIGH**

Base confidence on:

- upstream evidence quality,
- baseline and comparison quality,
- consistency across qualified metrics,
- unresolved information,
- relevant research quality,
- strength of competing explanations.

Confidence reflects evidence quality, not certainty of wording.

---

## 6. Determine the Diagnostic Decision

Choose exactly one:

- **PROCEED TO HYPOTHESIS**
- **RESEARCH DOMAIN KNOWLEDGE**
- **COLLECT MORE DATA**

### PROCEED TO HYPOTHESIS

Use when the evidence supports a sufficiently clear primary bottleneck.

### RESEARCH DOMAIN KNOWLEDGE

Use when an important external or domain-specific uncertainty prevents reliable diagnosis.

Formulate the specific research question needed by the Domain Research module.

### COLLECT MORE DATA

Use when additional product evidence is required before a defensible diagnosis can be made.

---

## Outputs

### What Went Well

Evidence-supported positive signals.

### Selected Performance Path

- DISCOVERY
- CLICK-THROUGH
- INTEREST
- CONVERSION
- PROFITABILITY
- INSUFFICIENT DATA

### Primary Bottleneck

The single strongest supported performance constraint.

### Evidence

The qualified evidence supporting the diagnosis.

### Competing Explanation

The strongest plausible alternative.

### Confidence

- LOW
- MODERATE
- HIGH

### Decision

- PROCEED TO HYPOTHESIS
- RESEARCH DOMAIN KNOWLEDGE
- COLLECT MORE DATA

### Research Question

Include only when the decision is **RESEARCH DOMAIN KNOWLEDGE**.

### Diagnostic Notes

Important uncertainty or context the next module should receive.

---

## Boundary

Stop after selecting the primary performance path and diagnosing the strongest supported bottleneck.

Do not design the experiment or recommend the product revision.
