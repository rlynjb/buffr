# AGNTCon + MCPCon 2026 Agenda

This is a personal schedule for AGNTCon + MCPCon North America, October 22-23,
2026, prioritizing practical eval/testing fundamentals, governance, MCP,
interoperability, selected Agentic Commerce sessions, and agentic engineering
sessions relevant to Buffr and solo Shopify/Etsy agent projects.

## Legend

- Primary Eval: core eval/testing sessions to attend
- Governance / MCP Priority: priority when there is a conflict
- Commerce Priority: ecommerce-relevant session to attend
- Commerce Option conflict: useful commerce session that conflicts with a higher priority pick
- Optional Eval: useful, but skippable for now
- Optional Agentic Engineering: relevant side path
- Context: keynotes/orientation

## Thursday, Oct 22

| Time | Session | Official Track | Priority |
|---|---|---|---|
| 9:00-9:55 AM | Keynotes | Keynote Sessions | Context |
| 10:20-10:45 AM | Stop Vibe-Testing: Run Real Agent Evals | Evals & Testing | Primary Eval |
| 10:55-11:20 AM | Auth.md or A2A v1 Deep Dive | Interoperability & Standards | Governance / MCP Priority |
| 11:30-11:55 AM | What Your MCP Server Does When Nobody's Looking | MCPCon | Governance / MCP Priority |
| 12:40-1:05 PM | Building Production-Ready Agents with a Regression Test Suite | Evals & Testing | Primary Eval |
| 1:15-1:40 PM | Trustworthy Context Is Untrusted By Default | Building Reliable Agent Systems | Governance / MCP Priority |
| 3:45-4:10 PM | Cut The Noise: Building a Code Reviewer You Can Trust | Agentic Engineering | Optional Agentic Engineering |
| 4:20-4:45 PM | Universal Commerce Protocol | Agentic Commerce | Commerce Priority |
| 4:55-5:20 PM | What Production Knows: Closing the Loop Between AI Agents and the Systems They Build | Agentic Engineering | Optional Agentic Engineering |
| 5:30-5:55 PM | Beyond Pass/Fail: Measuring the Full Agent Experience | Evals & Testing | Primary Eval |
| 6:05-6:30 PM | Rethinking CI/CD Release Gates for Agent-native Software | Evals & Testing | Primary Eval |
| 7:00-8:05 PM | Testing the MCP Matrix: Metrics and Strategies for Multi-Client Evaluation | Evals & Testing | Primary Eval / MCP crossover |

## Friday, Oct 23

| Time | Session | Official Track | Priority |
|---|---|---|---|
| 9:00-10:05 AM | Keynotes | Keynote Sessions | Context |
| 10:25-10:50 AM | 1,149 Hackers Tried to Break Our AI Agent Guardrails | Interoperability & Standards | Governance / MCP Priority |
| 10:25-10:50 AM | Architecting Agentic Commerce: The Universal Commerce Protocol and Agent Payments Protocol | Agentic Commerce | Commerce Option conflict |
| 11:00-11:25 AM | Patterns for Shifting from MCP as a Basic API to MCP as Agent Integration Interface | MCPCon | Governance / MCP Priority |
| 11:35 AM-12:00 PM | When Agents Spawn Agents: Securing Recursive Delegation | Interoperability & Standards | Governance / MCP Priority |
| 12:10-1:45 PM | Workshop: Governing AI Agent Actions: MCP and Beyond | Enterprise Adoption in Practice | Governance / MCP Priority |
| 12:10-12:35 PM | Building an Agentic Eval Pipeline: Battle-Tested Lessons with EvalBench | Evals & Testing | Optional Eval conflict |
| 12:45-1:10 PM | Embedding Agentic Payments with x402, A2A and Other Emerging Protocols | Agentic Commerce | Commerce Option conflict |
| 4:00-4:25 PM | Agent Governance Lives in the OS | Open Source Tools | Governance / MCP Priority |
| 4:35-5:00 PM | Reading is Free, Spending is Not: What a Minimal Agent Learns Probing Live Ecommerce Endpoints | Agentic Commerce | Commerce Priority |
| 4:35-5:00 PM | Prove What Your Agent Did | MCPCon | Optional Governance / MCP conflict |
| 5:10-5:35 PM | Why Your Agent Is Failing: Failure Modes from 6,000+ Agent Trajectories | Evals & Testing | Primary Eval |

## Key Decision

At Friday 12:10 PM, choose `Governing AI Agent Actions: MCP and Beyond` as the
primary pick because the user wants governance/MCP/interoperability patterns
now. Keep `Building an Agentic Eval Pipeline` as the optional backup if they
decide they want deeper eval infrastructure instead.

The 12:45 PM `Embedding Agentic Payments` session also conflicts with the
governance workshop; use it only if commerce payments become more urgent than
governance patterns.

## Commerce Notes

Agentic Commerce is relevant to the user's Shopify/Etsy direction, but it is
more about agent-readable catalogs, carts, checkout, payments, proof of user
intent, and transaction boundaries than ordinary store-growth tactics.

`Universal Commerce Protocol` gives the big-picture protocol view. `Reading is
Free, Spending is Not` is the most directly relevant merchant-side talk because
it covers live ecommerce endpoints, readable catalogs, signatures, and
idempotency.

Payment-specific sessions are useful later if the user builds direct agent
payment flows. They are less urgent if Shopify/Etsy continue to handle
checkout.

## Why This Fits Buffr

- Thursday eval sessions should support a lightweight Buffr eval loop: scenario
  -> run `marketplace:review` -> inspect trace/output -> score with
  checks/rubric -> prevent regressions.
- Governance/MCP sessions map to Buffr's manual approval boundaries, evidence
  preparation, traceability, policy controls, and future agent/tool integration.
- The advanced EvalBench pipeline can be revisited later when the eval set grows
  and the project needs modular evaluators, scorers, reporters, and A/B testing
  infrastructure.
