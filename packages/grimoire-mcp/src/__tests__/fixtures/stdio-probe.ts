// Test probe: loads a real stdio entry point FIRST (as `bun <entry>` would),
// then lets a dependency log at the default level and prints one JSON document.
// The caller asserts stdout holds only that document and the log went to stderr.
const entry = process.argv[2] === 'mcp' ? '../../mcp-server' : '../../cli';
await import(entry);
const { createLogger } = await import('@archon/paths');
createLogger('db.connection').info({ probe: true }, 'db.connection_sqlite_selected');
console.log(JSON.stringify({ probe: 'ok' }));

export {};
