# Domain Research Module

<!-- Source: Master V6 Step 5 -->

## Responsibility

Resolve specific missing, uncertain, specialized, or potentially outdated domain knowledge required by the Etsy product-analysis workflow.

Research only what is necessary to answer the current analytical question.

---

## Reasoning Mode

**HYBRID**

Use tools or external sources to retrieve relevant information.

Use LLM reasoning to:

- assess source relevance,
- compare findings,
- identify uncertainty or disagreement,
- determine how the research applies to the current analytical question.

Clearly distinguish retrieved information from interpretation.

---

## 1. Define the Research Question

Begin with a specific unresolved question.

Identify:

### Research Question

What information is missing or uncertain?

### Why It Matters

What analytical decision depends on this information?

### Required Evidence

What type of information would adequately resolve or reduce the uncertainty?

Avoid broad research when a narrower question is sufficient.

---

## 2. Research Relevant Domain Knowledge

Research may include:

- official Etsy documentation
- Etsy analytics definitions
- advertising metrics
- marketplace behavior
- marketplace demand
- keyword behavior
- competition
- seasonality
- product optimization
- conversion optimization
- experiment design
- statistical methodology
- sample-size considerations
- meaningful-change criteria
- test-duration considerations
- external benchmarks

Research only the areas relevant to the current question.

---

## 3. Prioritize Sources

Prefer evidence in this order when applicable:

1. current product or shop evidence,
2. previous experiments on the same product,
3. historical performance of the same product,
4. comparable products within the same shop,
5. official Etsy or other first-party documentation,
6. validated statistical or analytics references,
7. high-quality product-optimization research,
8. credible expert guidance,
9. anecdotal or unverified recommendations.

Consider:

- source authority,
- recency,
- relevance,
- methodological quality,
- applicability to the current product.

Do not treat all sources as equally reliable.

---

## 4. Evaluate the Finding

For each important finding, identify:

### Finding

What does the available evidence indicate?

### Source Type

Where did the information come from?

### Relevance

How does it relate to the current analytical question?

### Confidence

Use:

- **LOW**
- **MODERATE**
- **HIGH**

### Limitations

Identify important uncertainty, disagreement, missing evidence, or limits on applicability.

Do not convert external guidance into product-specific fact without supporting product evidence.

---

## 5. Determine Whether the Question Is Resolved

Choose one:

### RESOLVED

The research provides adequate information for the analytical workflow to continue.

### PARTIALLY RESOLVED

The research reduces uncertainty but does not completely answer the question.

### UNRESOLVED

Reliable information is insufficient or unavailable.

If unresolved, identify what additional evidence or data would be required.

---

## Output

### Research Question

The specific question investigated.

### Why It Matters

The downstream analytical decision that depends on it.

### Findings

Relevant research findings.

For each important finding:

- finding
- source type
- relevance
- confidence
- limitations

### Research Status

- RESOLVED
- PARTIALLY RESOLVED
- UNRESOLVED

### Applicable Guidance

Concise guidance that downstream modules may use.

Clearly distinguish:

- externally supported knowledge,
- product-specific evidence,
- interpretation.

### Remaining Uncertainty

Anything that still requires additional research or product data.

---

## Boundary

Stop after resolving or reducing the specified knowledge gap.

Do not diagnose product performance or recommend product changes.
