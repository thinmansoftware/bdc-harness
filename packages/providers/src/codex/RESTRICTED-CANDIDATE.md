# Tee-time restricted provider source candidate

This constructor path is intentionally unregistered. No route, workflow, registry,
or production configuration selects it. Demo work remains on hold.

Each restricted provider instance belongs to exactly one dedicated worker/run.
Never cache it globally or share it between jobs. Its fixed cwd is /workspace;
its binary, model, environment and named permission policy are constructor-owned.
Both global auth helpers and every provider fallback are excluded.

Thread ownership is recorded at thread.started, even if that turn later fails.
It means created by this instance, not completed successfully. A new instance or
process cannot resume an old thread; durable run ownership is a separate contract.

Before any registration or model call: qualify immutable empty /workspace/.codex
and /workspace/.agents mounts; clean system/ancestor and owned home configuration;
empty effective MCP/plugin/skill catalogs; no hook/notify execution; hostile
configuration and mutation attempts; account-managed settings after authentication.
Repeat on the exact worker image and every initial/resumed invocation. Fixed flags
alone are not inspection evidence. These runtime admission gates remain unresolved.

Non-model tests cover SDK serialization, no inherited synthetic secret, rejected
configuration, foreign resume, auth stop, subprocess retry, missing rollout and rate
limit. Actual SDK capture uses a local compiled fixture, never a model service.
