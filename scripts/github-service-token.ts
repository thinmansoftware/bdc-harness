import {
  getServiceGitHubToken,
  resolveServiceGitHubAuth,
  type GitHubService,
} from '../packages/core/src/github/service-identity';

const service = process.argv[2] as GitHubService | undefined;
if (!service) throw new Error('github_service_token_service_required');
const identity = resolveServiceGitHubAuth(service);
process.stdout.write(await getServiceGitHubToken(identity));
