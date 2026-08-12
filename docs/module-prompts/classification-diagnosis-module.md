# Classification & Diagnosis Module

<!-- Source: Master V6 Steps 6–8 -->

## Responsibility

Interpret qualified product-performance evidence to determine:

1. what appears to be working,
2. which performance path is the primary constraint,
3. the single strongest supported bottleneck,
4. the strongest competing explanation,
5. the confidence in the diagnosis,
6. whether the workflow should proceed, research, or collect more data.

---

## Reasoning Mode

**HYBRID / PROBABILISTIC**

Use validated metrics, baseline comparisons, and research findings as deterministic evidence.

Use LLM judgment to:

- interpret patterns across the funnel,
- compare plausible performance paths,
- identify the most likely bottleneck,
- assess competing explanations,
- determine confidence.

Ground all diagnostic reasoning in available evidence.

---

## 1. Identify What Went Well

Identify meaningful positive signals supported by qualified evidence.

Possible signals may include:

- increasing qualified traffic,
- improving CTR,
- improving favorite rate,
- improving conversion,
- increasing revenue,
- stronger revenue per view,
- improving advertising efficiency,
- successful search terms,
- successful previous experiments.

Explain why each positive signal matters.

Do not classify a metric as strong based only on its absolute value.

---

## 2. Classify the Primary Performance Path

Choose exactly **ONE**:

- **DISCOVERY**
- **CLICK-THROUGH**
- **INTEREST**
- **CONVERSION**
- **PROFITABILITY**
- **INSUFFICIENT DATA**

Use the customer funnel:

**Search Demand → Impression → Click / View → Interest / Favorite → Purchase → Revenue / Profit**

If several weaknesses exist, select the path most likely to materially constrain downstream performance.

### DISCOVERY

Primary question:

**Are enough qualified buyers seeing the listing?**

Possible evidence may include:

- declining impressions,
- weak organic traffic,
- low search visibility,
- weak keyword demand,
- excessive competition.

Relevant factors may include:

- marketplace demand,
- keywords,
- tags,
- title relevance,
- competition,
- seasonality,
- organic visibility.

### CLICK-THROUGH

Primary question:

**Are buyers seeing the listing but choosing not to open it?**

Possible evidence may include:

- stable or growing impressions,
- weak clicks,
- declining CTR,
- ad impressions without corresponding clicks.

Relevant factors may include:

- thumbnail,
- title,
- search-result relevance,
- first visual impression,
- differentiation,
- positioning.

### INTEREST

Primary question:

**Are buyers opening the listing but failing to demonstrate meaningful interest?**

Possible evidence may include:

- sufficient views,
- weak or declining favorite activity,
- weak engagement,
- visitors failing to progress toward stronger purchase intent.

Relevant factors may include:

- product appeal,
- product-market fit,
- design,
- relevance,
- positioning,
- target customer,
- value proposition.

### CONVERSION

Primary question:

**Are interested buyers failing to purchase?**

Possible evidence may include:

- healthy views,
- meaningful favorite activity,
- weak orders relative to traffic,
- declining conversion,
- ad clicks without purchases.

Relevant factors may include:

- price,
- perceived value,
- product previews,
- product clarity,
- description,
- trust,
- purchase friction,
- clarity about what the customer receives.

### PROFITABILITY

Primary question:

**Is the product selling but producing weak financial performance?**

Possible evidence may include:

- acceptable order volume,
- acceptable conversion,
- weak revenue per visitor,
- poor ROAS,
- rising acquisition cost,
- inadequate pricing.

Relevant factors may include:

- pricing,
- bundles,
- average order value,
- advertising efficiency,
- revenue per visitor,
- product economics.

### INSUFFICIENT DATA

Choose when the available evidence does not support a reliable primary-path classification.

Possible causes may include:

- low traffic,
- too few orders,
- missing metrics,
- conflicting evidence,
- invalid comparison periods,
- unresolved domain questions,
- insufficient observation duration.

Identify what evidence is missing or unreliable.

---

## 3. Diagnose the Primary Bottleneck

Within the selected performance path, identify the **single strongest supported bottleneck**.

The bottleneck should be specific enough to support a later hypothesis.

Separate:

- observed facts,
- calculated or qualified evidence,
- external research,
- assumptions,
- interpretations.

Do not present an interpretation as a fact.

---

## 4. Identify the Strongest Competing Explanation

Identify the most plausible alternative explanation for the same performance pattern.

Explain:

- why it is plausible,
- what evidence supports it,
- why the primary diagnosis currently has stronger support.

If the evidence does not meaningfully distinguish between the explanations, lower confidence or choose **COLLECT MORE DATA**.

---

## 5. Assign Confidence

Choose:

- **LOW**
- **MODERATE**
- **HIGH**

Base confidence on factors such as:

- quality of the underlying data,
- strength of baseline comparisons,
- consistency across metrics,
- unresolved missing information,
- quality of supporting research,
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

### COLLECT MORE DATA

Use when additional product evidence is required before a defensible diagnosis can be made.

---

## Output

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

Evidence supporting the diagnosis, clearly separated by type where useful.

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

### Diagnostic Notes

Important uncertainty or context that the next module should receive.

---

## Boundary

Stop after selecting the primary performance path and diagnosing the strongest supported bottleneck.

Do not create the experiment or recommend the product revision.
