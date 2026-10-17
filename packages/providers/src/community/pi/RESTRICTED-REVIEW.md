# Restricted local reviewer candidate

This source extends the existing Pi provider behind a constructor-only flag. It
is not registered, selected by workflows, or approved for inference.

Validated locally: 11 mock reviewer checks, 4 synthetic transport checks, provider
regressions, source lint and provider type checking. The installed Pi inference
SDK is exercised against a local synthetic HTTP server; no model was invoked.
The request-budget tests prevent second upstream calls on connection/429/500
failures. The transport factory is not installed in shared-process runtime.

Remaining gates:

- Dedicated worker installs the transport guard before SDK imports, with clean
  environment and network restricted to the approved local endpoint.
- Actual SDK redirect failure and response/input bound negative tests.
- Effective Ollama context and non-truncation: advertised context metadata is not
  enough. The candidate has not been loaded for inference. No server changes.
- Freeze complete spec, exact diff/base/head, and real test receipts at caller.
- Run known-good, known-bad, incomplete, contradictory and injection cases.
- Before/after tag digest checks are not atomic proof of served model identity.
- Register only after qualification and independent approval. No Claude/Fable,
  shared production changes, demo implementation, purchases or bookings.
