import { ComponentCommandCenter } from "../../../components/ComponentCommandCenter";
import { getComponent } from "../../../lib/api";

export default async function ComponentPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ repoId?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const repoId = query.repoId ?? "";
  const component = repoId ? await getComponent(repoId, id) : null;

  return <ComponentCommandCenter repoId={repoId} componentId={id} component={component} />;
}
