import {
  getComponents,
  getRepoActivity,
  getRepo,
  getRepoAlerts,
  getRepoEntropy,
  getRepoMemory,
} from "../../../lib/api";
import { RepoCommandCenter } from "../../../components/RepoCommandCenter";

export default async function RepoPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [repo, components, alerts, entropy, memory, activity] = await Promise.all([
    getRepo(id),
    getComponents(id),
    getRepoAlerts(id, { page: 1, limit: 6 }),
    getRepoEntropy(id),
    getRepoMemory(id),
    getRepoActivity(id, { page: 1, limit: 10 }),
  ]);

  return (
    <RepoCommandCenter
      repoId={id}
      initialRepo={repo}
      initialComponents={components}
      initialAlerts={alerts}
      initialEntropy={entropy}
      initialMemory={memory}
      initialActivity={activity}
    />
  );
}
