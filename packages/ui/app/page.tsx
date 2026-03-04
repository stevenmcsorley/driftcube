import { SurfaceLaunchpad } from "../components/SurfaceLaunchpad";
import { getOverview } from "../lib/api";

export default async function HomePage() {
  const overview = await getOverview();
  return <SurfaceLaunchpad initialOverview={overview} />;
}
