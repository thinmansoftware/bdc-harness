// Global test setup for bun:test
import { afterEach, afterAll } from 'bun:test';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// PRODUCTION-DB SAFETY GUARD (anchor: 2026-07-21, two production DB wipes).
//
// Inside the Archon container, getArchonHome() resolves to /.archon -- the
// SAME directory the live Archon server uses for its production archon.db.
// A WO's test suite runs inside that same container. Any test that opens the
// real (unmocked) getDatabase()/SqliteAdapter therefore opens the LIVE
// production database, and destructive test fixtures (schema resets, deletes
// against tables the app treats as append-only) wiped it twice in one day.
//
// Fix: force every test process onto an isolated, per-process ARCHON_HOME
// BEFORE any test file's imports run (this file is bunfig.toml's global
// `preload`, so it executes first). getArchonHome() (packages/paths) now
// honors ARCHON_HOME even inside Docker, so this override actually takes
// effect in the container, not just locally.
if (!process.env.ARCHON_HOME || process.env.ARCHON_HOME === 'undefined') {
  process.env.ARCHON_HOME = mkdtempSync(join(tmpdir(), 'archon-test-home-'));
}

// Clean up mocks after each test
afterEach(() => {
  // Bun uses mock.restore() for individual mocks
  // For Jest compatibility, we clear any module mocks here
});

// Restore all mocks after all tests complete
afterAll(() => {
  // Reset any global state
});
