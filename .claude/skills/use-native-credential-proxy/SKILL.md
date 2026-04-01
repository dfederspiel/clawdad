---
name: use-native-credential-proxy
description: "[OBSOLETE] The native credential proxy is now the default. This skill is no longer needed — credentials are managed via .env and the built-in proxy."
---

# Use Native Credential Proxy

**This skill is obsolete.** The native credential proxy is now the default credential system. OneCLI has been removed.

Credentials are stored in `.env` and injected by the built-in proxy (`src/credential-proxy.ts`). See `CLAUDE.md` > "Secrets / Credentials" or `docs/CREDENTIALS.md` for configuration details.

If someone invokes this skill, tell them:

> The native credential proxy is already active — no migration needed. To configure credentials, add `ANTHROPIC_API_KEY` (for API keys) or `ANTHROPIC_AUTH_TOKEN` (for OAuth tokens from `claude setup-token`) to `.env` and restart ClawDad.
