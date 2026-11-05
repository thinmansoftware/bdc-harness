// Side-effect module. It MUST be the first import of every stdio entry point
// (mcp-server.ts, cli.ts): ES modules evaluate imports in order, so this runs
// before @archon/paths builds its root logger. Without it, dependency logs
// (database selection, required-context lookups) land on stdout and corrupt
// the MCP JSON-RPC stream and `card --json` output.
process.env.ARCHON_LOG_STDERR = '1';

export {};
