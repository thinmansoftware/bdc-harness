# Taskmaster approval event ingestion

Piece 1 accepts only queued Dispatch events addressed to taskmaster whose
sender_principal_id exactly equals TASKMASTER_APPROVAL_PRODUCER_PRINCIPAL.
The value must be the authenticated principal of the existing PC relay credential,
verified by the operator from Dispatch authentication records. There is no default
and no fallback to the display sender or the JSON body. Missing configuration
fails closed by skipping approval ingestion while existing expectation supervision continues.
Cancelled, claimed, done, failed, legacy unauthenticated and other-producer rows
cannot create breaches or resolve expectations. The existing consumer retains
queued history for deterministic replay; no receipt policy changes are introduced.

Configure the existing producer only through the normal runtime authorization path.
This source repair provisions no credentials and makes no runtime changes.
Taskmaster never approves prompts. Relay text remains subject to the common
spend/send/deploy scan, including decoded JSON text.
