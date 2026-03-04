import { GlobalAlertStream } from "../../components/GlobalAlertStream";
import { getGlobalAlerts, getOverview } from "../../lib/api";

export default async function AlertsPage() {
  const overview = await getOverview();
  const alerts = await getGlobalAlerts({ page: 1, limit: 12 });

  return (
    <main className="stack">
      <section className="workspace-header">
        <div className="workspace-header-body">
          <div className="workspace-header-copy">
            <div className="eyebrow">Alerts</div>
            <h1>Alert Stream</h1>
            <p>Cross-repo queue management only. Use repo surfaces for isolated action and code proof.</p>
          </div>
          <div className="workspace-header-side">
            <div className="metric-strip metric-strip-dense">
              <div className="metric-tile">
                <span>Repos</span>
                <strong>{overview.stats.repoCount}</strong>
              </div>
              <div className="metric-tile">
                <span>Alerts 24h</span>
                <strong>{overview.stats.alerts24h}</strong>
              </div>
              <div className="metric-tile">
                <span>Critical 24h</span>
                <strong>{overview.stats.critical24h}</strong>
              </div>
            </div>
          </div>
        </div>
      </section>

      <GlobalAlertStream initialPage={alerts} />
    </main>
  );
}
