import { RepoManager } from "../../components/RepoManager";
import { getRepos } from "../../lib/api";

export default async function RepoManagerPage() {
  const repos = await getRepos({ includeArchived: true });
  return <RepoManager initialRepos={repos} />;
}
