export function DriftTimeline(props: {
  metrics: Array<{ key?: string; value?: number; at?: string }>;
}) {
  return (
    <div className="panel">
      <div className="eyebrow">Drift Timeline</div>
      <table>
        <thead>
          <tr>
            <th>Timestamp</th>
            <th>Metric</th>
            <th>Value</th>
          </tr>
        </thead>
        <tbody>
          {props.metrics.slice(0, 12).map((metric, index) => (
            <tr key={`${metric.key ?? "metric"}-${index}`}>
              <td>{metric.at ? new Date(metric.at).toLocaleString() : "n/a"}</td>
              <td>{metric.key ?? "unknown"}</td>
              <td>{typeof metric.value === "number" ? metric.value.toFixed(2) : "n/a"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

