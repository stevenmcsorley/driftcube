import { HomeCommandCenter } from "../../components/HomeCommandCenter";
import { getOverview } from "../../lib/api";

export default async function FleetPage() {
  const overview = await getOverview();
  return <HomeCommandCenter initialOverview={overview} />;
}
