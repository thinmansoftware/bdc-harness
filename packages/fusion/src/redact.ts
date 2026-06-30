/**
 * redact.ts -- Secret boundary enforcement for Cauldron Fusion v0.1
 *
 * Strips known secret patterns from diff text before any content is sent to a
 * model. Returns both the cleaned string and a findings list for synthesis.
 *
 * Pattern set (v0.1 minimum):
 *   - sk-[A-Za-z0-9]{20,}           OpenAI / generic API keys
 *   - sk-or-[A-Za-z0-9-]{20,}       OpenRouter-prefixed keys
 *   - eyJ...                         JWT tokens (header.payload.signature)
 *   - ghp_[A-Za-z0-9]{36}           GitHub Personal Access Tokens
 *   - AKIA[0-9A-Z]{16}              AWS Access Key IDs
 */

import type { RedactResult } from './types.js';

const REDACTED_MARKER = '[REDACTED SECRET]';

interface SecretPattern {
  name: string;
  regex: RegExp;
}

const SECRET_PATTERNS: SecretPattern[] = [
  // OpenRouter-prefix variant first (more specific, must come before generic sk-)
  {
    name: 'OpenRouter API key (sk-or-)',
    regex: /sk-or-[A-Za-z0-9-]{20,}/g,
  },
  {
    name: 'OpenAI/generic API key (sk-)',
    regex: /sk-[A-Za-z0-9]{20,}/g,
  },
  {
    name: 'JWT token',
    regex: /eyJ[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+/g,
  },
  {
    name: 'GitHub Personal Access Token (ghp_)',
    regex: /ghp_[A-Za-z0-9]{36}/g,
  },
  {
    name: 'AWS Access Key ID (AKIA)',
    regex: /AKIA[0-9A-Z]{16}/g,
  },
];

/**
 * redactSecrets -- strip secret patterns from input and report findings.
 *
 * Each match is replaced with [REDACTED SECRET]. The findings array contains
 * one human-readable entry per distinct match found.
 */
export function redactSecrets(input: string): RedactResult {
  let redacted = input;
  const findings: string[] = [];

  for (const pattern of SECRET_PATTERNS) {
    // Reset lastIndex for global regex each call
    pattern.regex.lastIndex = 0;
    const matches = redacted.match(pattern.regex);
    if (matches) {
      for (const match of matches) {
        // Record a finding with a safe excerpt (first 8 chars + ...)
        const preview = match.slice(0, 8) + '...';
        findings.push(`REDACTED SECRET -- ${pattern.name}: ${preview}`);
      }
      // Replace all matches in one pass
      pattern.regex.lastIndex = 0;
      redacted = redacted.replace(pattern.regex, REDACTED_MARKER);
    }
  }

  return { redacted, findings };
}
