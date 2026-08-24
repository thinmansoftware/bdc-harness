import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FreshnessBanner } from '@/components/register/FreshnessBanner';
import { RegisterTable } from '@/components/register/RegisterTable';
import { getTaskmasterRegister, getTaskmasterRegisterMeta } from '@/lib/api';

const PAGE_SIZE = 50;

export function RegisterPage(): React.ReactElement {
  const [priority, setPriority] = useState('');
  const [blocked, setBlocked] = useState('');
  const [owner, setOwner] = useState('');
  const [page, setPage] = useState(0);

  // These client functions consume /api/taskmaster/register and /api/taskmaster/register/meta.
  const { data: meta, isError: metaError } = useQuery({
    queryKey: ['taskmaster-register-meta'],
    queryFn: getTaskmasterRegisterMeta,
    refetchInterval: 30_000,
  });
  const {
    data: register,
    isLoading,
    isError: listError,
  } = useQuery({
    queryKey: ['taskmaster-register', { priority, blocked, owner, page }],
    queryFn: () =>
      getTaskmasterRegister({
        priority: priority || undefined,
        blocked: blocked === '' ? undefined : blocked === 'true',
        owner: owner || undefined,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      }),
    refetchInterval: 30_000,
  });

  const owners = useMemo(() => {
    const values = new Set((register?.rows ?? []).map(row => row.owner_login ?? 'UNKNOWN'));
    if (owner) values.add(owner);
    return [...values].sort();
  }, [register?.rows, owner]);
  const total = register?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const resetPage = (): void => {
    setPage(0);
  };

  return (
    <main className="h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-[1600px] space-y-4">
        <div>
          <h1 className="text-xl font-semibold text-text-primary">Taskmaster Register</h1>
          <p className="mt-1 text-sm text-text-secondary">
            Read-only view of adopted work from the committed GitHub projection.
          </p>
        </div>

        {meta && <FreshnessBanner meta={meta} />}
        {metaError && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-400">
            Register metadata is unavailable.
          </div>
        )}

        <section className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-surface p-4">
          <label className="text-xs text-text-secondary">
            <span className="mb-1 block">Priority</span>
            <select
              value={priority}
              onChange={event => {
                setPriority(event.target.value);
                resetPage();
              }}
              className="rounded-md border border-border bg-surface-elevated px-3 py-2 text-text-primary"
            >
              <option value="">All</option>
              {['P0', 'P1', 'P2', 'P3'].map(value => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-text-secondary">
            <span className="mb-1 block">Blocked</span>
            <select
              value={blocked}
              onChange={event => {
                setBlocked(event.target.value);
                resetPage();
              }}
              className="rounded-md border border-border bg-surface-elevated px-3 py-2 text-text-primary"
            >
              <option value="">Any</option>
              <option value="true">Blocked</option>
              <option value="false">Not blocked</option>
            </select>
          </label>
          <label className="text-xs text-text-secondary">
            <span className="mb-1 block">Owner</span>
            <select
              value={owner}
              onChange={event => {
                setOwner(event.target.value);
                resetPage();
              }}
              className="min-w-36 rounded-md border border-border bg-surface-elevated px-3 py-2 text-text-primary"
            >
              <option value="">All</option>
              {owners.map(value => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
        </section>

        {listError ? (
          <div className="rounded-lg border border-red-500/30 p-8 text-center text-sm text-red-400">
            Failed to load the register.
          </div>
        ) : isLoading ? (
          <div className="py-12 text-center text-sm text-text-tertiary">Loading register…</div>
        ) : (
          <RegisterTable
            rows={register?.rows ?? []}
            neverBuilt={meta?.freshness.includes('UNAVAILABLE') ?? false}
          />
        )}

        <div className="flex items-center justify-between text-xs text-text-secondary">
          <span>{String(total)} items</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={page === 0}
              onClick={() => {
                setPage(value => Math.max(0, value - 1));
              }}
              className="rounded-md border border-border px-3 py-1.5 disabled:opacity-40"
            >
              Previous
            </button>
            <span>
              Page {String(page + 1)} of {String(totalPages)}
            </span>
            <button
              type="button"
              disabled={page + 1 >= totalPages}
              onClick={() => {
                setPage(value => value + 1);
              }}
              className="rounded-md border border-border px-3 py-1.5 disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}
