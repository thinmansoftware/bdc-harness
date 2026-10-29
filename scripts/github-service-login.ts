import {
  resolveGitHubActingLogin,
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
  return resolveGitHubActingLogin(resolveServiceGitHubAuth(service), options);
}

if (import.meta.main) {
  const service = process.argv[2] as GitHubService | undefined;
  if (!service) throw new Error('github_service_login_service_required');
  const login = await resolveServiceGitHubLogin(service);
  process.stdout.write(login);
}
