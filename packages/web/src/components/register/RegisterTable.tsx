import { ExternalLink } from 'lucide-react';
import type { TaskmasterRegisterRow } from '@/lib/api';

function relativeTime(value: string | null): string {
  if (value === null) return 'UNKNOWN';
  const elapsed = Math.max(0, Date.now() - new Date(value).getTime());
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${String(minutes)}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${String(hours)}h ago` : `${String(Math.floor(hours / 24))}d ago`;
}

export function RegisterTable({
  rows,
  neverBuilt,
}: {
  rows: TaskmasterRegisterRow[];
  neverBuilt: boolean;
}): React.ReactElement {
  if (rows.length === 0) {
    return (
      <div className="flex items-center justify-center rounded-lg border border-border py-12">
        <span className="text-sm text-text-tertiary">
          {neverBuilt
            ? 'The register has never been built.'
            : 'No adopted items match these filters.'}
        </span>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full min-w-[1100px] text-xs">
        <thead>
          <tr className="border-b border-border bg-surface-elevated text-left text-text-tertiary">
            {['Item', 'Owner', 'Status', 'Blocker', 'Next', 'Moved', 'Evidence', 'Link'].map(
              heading => (
                <th key={heading} className="px-3 py-2 font-medium">
                  {heading}
                </th>
              )
            )}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map(row => (
            <tr key={row.thread_ref} className="transition-colors hover:bg-surface-elevated">
              <td className="max-w-[240px] px-3 py-2 text-text-primary">
                {row.title ?? row.thread_ref}
              </td>
              <td className="px-3 py-2 text-text-secondary">{row.owner_login ?? 'UNKNOWN'}</td>
              <td className="px-3 py-2 text-text-secondary">
                <div>{row.state ?? 'UNKNOWN'}</div>
                <div className="mt-1 flex gap-1">
                  <span className="rounded bg-surface px-1.5 py-0.5">{row.priority}</span>
                  {row.is_blocked === 1 && (
                    <span className="rounded bg-red-500/15 px-1.5 py-0.5 text-red-400">
                      BLOCKED
                    </span>
                  )}
                </div>
              </td>
              <td className="max-w-[220px] px-3 py-2 text-text-secondary">
                {row.blocked_reason ?? 'UNKNOWN'}
              </td>
              <td className="max-w-[220px] px-3 py-2 text-text-secondary">
                {row.next_action ?? 'UNKNOWN'}
              </td>
              <td className="px-3 py-2 text-text-secondary">
                <div>{relativeTime(row.last_movement_at)}</div>
                <div className="text-text-tertiary">{row.last_movement_kind ?? 'UNKNOWN'}</div>
              </td>
              <td className="px-3 py-2 text-text-secondary">
                {relativeTime(row.evidence_observed_at)}
              </td>
              <td className="px-3 py-2">
                <a
                  href={`https://github.com/${row.repo}/issues/${String(row.issue_number)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-primary hover:text-primary/80"
                >
                  Issue <ExternalLink className="h-3 w-3" />
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
