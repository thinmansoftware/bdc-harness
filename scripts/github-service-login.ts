import {
  buildAppJwt,
  resolveServiceGitHubAuth,
  type GitHubService,
} from '../packages/core/src/github/service-identity';

// Print the acting GitHub login for a given GitHubService, never a token.
//   Usage: bun scripts/github-service-login.ts <service>
//
// A PAT identity names itself via GET /user. An App installation token cannot
// call GET /user (403), so an App identity is named via GET /app with an App JWT
// -- that returns the App's slug and the acting login is "<slug>[bot]". A held
// ('none') identity cannot act, so this exits non-zero.
//
// The open-pr-if-needed lane node calls this to refuse opening a PR when the
// acting login is the reviewer identity (thinman-overseer[bot]); see
// WO-HARNESS-OPEN-PR-REFUSES-REVIEWER-AUTHOR-01.
export async function resolveServiceGitHubLogin(
  service: GitHubService,
  options: { fetch?: typeof fetch; apiBaseUrl?: string } = {}
): Promise<string> {
  const identity = resolveServiceGitHubAuth(service);
  const doFetch = options.fetch ?? fetch;
  const apiBaseUrl = options.apiBaseUrl ?? 'https://api.github.com';

  if (identity.kind === 'none') {
    throw new Error('github_login_identity_held');
  }

  if (identity.kind === 'pat') {
    const response = await doFetch(`${apiBaseUrl}/user`, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${identity.token}`,
        'user-agent': 'bdc-harness-service-auth',
        'x-github-api-version': '2022-11-28',
      },
    });
    if (!response.ok) throw new Error(`github_login_user_failed:${response.status}`);
    const body = (await response.json()) as { login?: unknown };
    if (typeof body.login !== 'string' || body.login.length === 0) {
      throw new Error('github_login_user_failed:invalid_response');
    }
    return body.login;
  }

  // identity.kind === 'app'
  const jwt = buildAppJwt(identity);
  const response = await doFetch(`${apiBaseUrl}/app`, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${jwt}`,
      'user-agent': 'bdc-harness-service-auth',
      'x-github-api-version': '2022-11-28',
    },
  });
  if (!response.ok) throw new Error(`github_login_app_failed:${response.status}`);
  const body = (await response.json()) as { slug?: unknown };
  if (typeof body.slug !== 'string' || body.slug.length === 0) {
    throw new Error('github_login_app_failed:invalid_response');
  }
  return `${body.slug}[bot]`;
}

if (import.meta.main) {
  const service = process.argv[2] as GitHubService | undefined;
  if (!service) throw new Error('github_service_login_service_required');
  const login = await resolveServiceGitHubLogin(service);
  process.stdout.write(login);
}
