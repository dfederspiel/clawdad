# What ClawDad Is

**Date:** 2026-04-07

ClawDad began with deep inspiration from [NanoClaw](https://github.com/qwibitai/nanoclaw) and the broader OpenClaw ecosystem.

It keeps what was compelling there:

- containerized agent execution
- local ownership of infrastructure
- strong isolation boundaries
- skill-driven extensibility

But ClawDad is no longer just a slimmed variant.

## Statement

**ClawDad is a container-native agent orchestration platform for building, running, and observing AI teams locally.**

It is designed around a few core ideas:

- **Agents should be inspectable.** You should be able to see what they are doing, how they are coordinated, and where time and cost are going.
- **Teams matter as much as single agents.** Delegation, fan-out, coordination, supersession, and shared work state are first-class concerns.
- **Execution should be isolated.** Agents run in containers with explicit filesystem and credential boundaries.
- **The user should stay in control.** The system should be understandable, hackable, and locally owned rather than hidden behind a hosted black box.
- **Model choice belongs to the system designer.** Over time, different agents in the same team should be able to use different providers and models.

## What ClawDad Is Not

ClawDad is not trying to be:

- a generic hosted agent SaaS
- only a chat wrapper around a single model provider
- only a collection of prompts
- only a fork that tracks upstream NanoClaw feature-for-feature

## Relationship To NanoClaw

ClawDad stands on NanoClaw's shoulders and should say so plainly.

NanoClaw provided important foundations:

- Docker/container execution patterns
- credential proxying
- agent runtime integration
- skills and operational workflows

ClawDad builds upward from there into a different product tier:

- richer multi-agent orchestration
- more explicit control-plane behavior
- stronger web UI and observability expectations
- per-agent runtime/provider direction
- internal coordination architecture beyond a shared chat transcript

## Product Direction

The clearest way to think about ClawDad is:

- **NanoClaw** gave us a strong local agent runtime foundation
- **ClawDad** is becoming the orchestration layer for serious local agent teams

That means the long-term center of gravity is not just "run one Claude agent in a container."

It is:

- coordinating many agents
- choosing the right model/provider per role
- keeping user-visible chat clean and intentional
- exposing internal execution state without losing control or safety

## Rebrand Note

The repo should present itself publicly as **ClawDad**.

That does not require renaming every internal identifier immediately. Some internal names, service IDs, image names, and MCP namespaces still reflect NanoClaw heritage and may remain temporarily for compatibility.

The important thing is that the public story is now coherent:

**ClawDad is its own product, inspired by NanoClaw, but no longer defined by being a slim fork of it.**
