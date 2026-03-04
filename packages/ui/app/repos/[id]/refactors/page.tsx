import { RefactorSuggestionBoard } from "../../../../components/RefactorSuggestionBoard";
import { getRepo, getRepoRefactors } from "../../../../lib/api";

export default async function RepoRefactorsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [repo, refactors] = await Promise.all([
    getRepo(id),
    getRepoRefactors(id, { page: 1, limit: 6 }),
  ]);

  return (
    <RefactorSuggestionBoard
      repoId={id}
      repo={repo}
      initialPage={refactors}
    />
  );
}
