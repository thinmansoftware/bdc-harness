/**
 * HTTP-facing facade for the Core-owned dispatch sender authority.
 *
 * Core owns capability issuance so the dispatch DAL never depends on Server and
 * never accepts a caller-constructed sender identity.
 * DISPATCH_PRINCIPALS_JSON remains the server-facing registry contract, while
 * token comparison remains timingSafeEqual inside the Core authority.
 */
export * from '@archon/core/db/dispatch-sender-authority';
