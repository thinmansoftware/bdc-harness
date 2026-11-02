/**
 * Dashboard status-mapping tests for WO-HARNESS-ESCALATED-RUN-STATUS-01.
 * Scenario 3: escalated renders yellow / "Escalated"; failed stays red.
 */
import { describe, expect, test } from 'bun:test';
import {
  getStatusBadgeClasses,
  getStatusDotColor,
  getStatusLabel,
  isHistoryRunStatus,
  isTerminalRunStatus,
  STATUS_DOT_COLORS,
  STATUS_LABELS,
} from './status-renderer';

describe('status-renderer escalated', () => {
  test('escalated has a yellow (warning) dot color', () => {
    expect(STATUS_DOT_COLORS.escalated).toBe('bg-warning');
    expect(getStatusDotColor('escalated')).toBe('bg-warning');
  });

  test('failed stays red/destructive', () => {
    expect(STATUS_DOT_COLORS.failed).toBe('bg-destructive');
    expect(getStatusDotColor('failed')).toBe('bg-destructive');
  });

  test('label for escalated is "Escalated"', () => {
    expect(STATUS_LABELS.escalated).toBe('Escalated');
    expect(getStatusLabel('escalated')).toBe('Escalated');
  });

  test('badge uses warning styling', () => {
    expect(getStatusBadgeClasses('escalated')).toContain('text-warning');
  });

  test('escalated is terminal and history-eligible', () => {
    expect(isTerminalRunStatus('escalated')).toBe(true);
    expect(isHistoryRunStatus('escalated')).toBe(true);
    expect(isTerminalRunStatus('failed')).toBe(true);
    expect(isTerminalRunStatus('running')).toBe(false);
  });

  // Codex finding: incomplete coverage for isTerminalStatus with escalated.
  // status-renderer exports isTerminalRunStatus; workflow-utils re-exports
  // isTerminalStatus. Both must treat escalated as terminal and distinct from failed.
  test('isTerminalRunStatus matrix covers all terminal statuses including escalated', () => {
    const terminal = ['completed', 'failed', 'escalated', 'cancelled'] as const;
    for (const s of terminal) {
      expect(isTerminalRunStatus(s)).toBe(true);
    }
    const nonTerminal = ['pending', 'running', 'paused', undefined, ''] as const;
    for (const s of nonTerminal) {
      expect(isTerminalRunStatus(s)).toBe(false);
    }
  });

  test('escalated and failed are visually distinct', () => {
    expect(getStatusDotColor('escalated')).not.toBe(getStatusDotColor('failed'));
    expect(getStatusLabel('escalated')).not.toBe(getStatusLabel('failed'));
  });
});
