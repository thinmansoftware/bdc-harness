export const OPS_INBOX_LABEL = 'ops-inbox';
export const OPS_INBOX_TITLE = 'OPS INBOX -- daily digest (do not close)';

export interface OpsInboxIssue { number: number }
export interface OpsInboxGithub {
  findOpenIssue(repo: string, label: string): Promise<OpsInboxIssue | null>;
  createLabel(repo: string, label: string): Promise<void>;
  createIssue(repo: string, input: { title: string; labels: string[] }): Promise<OpsInboxIssue>;
  listComments(repo: string, issue: number): Promise<{ id: number; body: string }[]>;
  createComment(repo: string, issue: number, body: string): Promise<void>;
  updateComment(repo: string, comment: number, body: string): Promise<void>;
}

const pendingIssues = new Map<string, Promise<OpsInboxIssue>>();

export async function ensureOpsInboxIssue(
  github: OpsInboxGithub,
  repo = process.env.OPS_INBOX_REPO ?? 'thinmansoftware/bdc-xo'
): Promise<OpsInboxIssue> {
  const active = pendingIssues.get(repo);
  if (active) return active;
  const promise = (async () => {
    const found = await github.findOpenIssue(repo, OPS_INBOX_LABEL);
    if (found) return found;
    await github.createLabel(repo, OPS_INBOX_LABEL);
    return github.createIssue(repo, { title: OPS_INBOX_TITLE, labels: [OPS_INBOX_LABEL] });
  })();
  pendingIssues.set(repo, promise);
  try { return await promise; } finally { pendingIssues.delete(repo); }
}

function replaceSection(body: string, key: string, markdown: string): string {
  const open = `<!-- section:${key} -->`;
  const close = `<!-- /section:${key} -->`;
  const section = `${open}\n${markdown.trim()}\n${close}`;
  const start = body.indexOf(open);
  const end = start < 0 ? -1 : body.indexOf(close, start);
  if (start >= 0 && end >= 0) return `${body.slice(0, start)}${section}${body.slice(end + close.length)}`;
  return `${body.trim()}\n\n${section}\n`;
}

export async function upsertDigestSections(
  github: OpsInboxGithub,
  dateUtc: string,
  sections: Record<string, string>,
  repo = process.env.OPS_INBOX_REPO ?? 'thinmansoftware/bdc-xo'
): Promise<void> {
  const issue = await ensureOpsInboxIssue(github, repo);
  const marker = `<!-- ops-inbox-digest:${dateUtc} -->`;
  const comments = await github.listComments(repo, issue.number);
  const existing = comments.find(comment => comment.body.includes(marker));
  let body = existing?.body ?? `${marker}\n\n# Ops inbox digest - ${dateUtc}\n`;
  for (const [key, markdown] of Object.entries(sections)) body = replaceSection(body, key, markdown);
  if (existing) await github.updateComment(repo, existing.id, body);
  else await github.createComment(repo, issue.number, body);
}

export async function upsertDigestSection(
  github: OpsInboxGithub,
  dateUtc: string,
  sectionKey: string,
  markdown: string,
  repo?: string
): Promise<void> {
  return upsertDigestSections(github, dateUtc, { [sectionKey]: markdown }, repo);
}
