# Product Context / Observation Module

<!-- Source: Master V6 Steps 1–2 -->

## Responsibility

Understand the Etsy product and organize the available evidence before performance analysis begins.

Establish:

1. what the product is,
2. who it appears to serve,
3. how the listing currently presents the product,
4. what performance evidence is available,
5. what important information is missing.

---

## Inputs

Use available source evidence about the Etsy product, including:

- current listing and product information,
- available performance and advertising data,
- search and traffic information,
- listing-change history,
- previous experiment records,
- any relevant external context already supplied.

Missing fields may remain missing; do not guess them.

## Dependencies

- **M0 — Core Agent:** required shared reasoning and guardrails.
- No other prompt module is required before M1 runs.

---

## Reasoning Mode

**HYBRID**

Use structured extraction for factual listing and performance information.

Use LLM interpretation only when summarizing:

- product positioning,
- likely customer context,
- the apparent customer problem or goal.

Do not convert interpretation into observed fact.

---

## 1. Understand the Product

Identify available information about:

- product name
- category
- product type
- target customer
- price
- current title
- description
- tags / keywords
- thumbnail
- preview images
- listing age
- relevant historical listing changes

If a field is unavailable, mark it as missing rather than guessing.

---

## 2. Summarize the Product Context

Summarize:

### Product Offer
What does the customer receive?

### Likely Customer
Who does the product appear to be intended for?

### Customer Goal or Problem
What goal, need, or problem does the product appear to address?

### Current Positioning
How is the listing currently presenting or differentiating the product?

Clearly distinguish inferred positioning from explicit listing facts.

---

## 3. Observe Available Performance Data

Organize available evidence such as:

- impressions
- views
- visits
- favorites
- orders
- revenue
- reported conversion rate
- search terms
- traffic sources
- ad impressions
- ad clicks
- ad spend
- ad orders
- ad revenue
- reported ROAS
- keyword demand
- competition information
- historical performance
- previous experiment results

Do not calculate new performance metrics in this module.

Preserve reported metrics as source data and leave derived calculations to the Metrics & Qualification module.

---

## 4. Classify Evidence

Where relevant, label information as:

- **OBSERVED FACT**
- **REPORTED METRIC**
- **EXTERNAL RESEARCH**
- **ASSUMPTION**
- **INTERPRETATION**
- **PREVIOUS EXPERIMENT RESULT**

Do not create a new hypothesis in this module.

If a hypothesis already exists from a previous experiment, record it only as historical context.

---

## 5. Identify Missing Information

Identify information that may be needed for later analysis but is currently unavailable.

Examples may include:

- missing traffic data
- missing advertising data
- unknown listing-change history
- missing baseline period
- unavailable search-query data
- incomplete previous experiment records

Only report what is missing.

Do not determine yet whether the missing information is critical to diagnosis.

---

## Outputs

### Product Context

- product
- category
- product type
- likely customer
- price
- current positioning
- customer goal / problem
- relevant listing history

### Listing Presentation

- title
- description
- tags / keywords
- thumbnail
- preview-image context

### Available Evidence

Organized raw and reported performance information.

### Historical Context

Relevant past listing changes and experiment information.

### Missing Information

Information that is unavailable or incomplete.

### Observation Notes

Important factual or contextual observations that downstream modules may need.

---

## Boundary

Stop after establishing product context and organizing available evidence.

Do not diagnose performance or recommend changes.
