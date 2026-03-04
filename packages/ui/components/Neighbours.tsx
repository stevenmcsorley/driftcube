export function Neighbours(props: {
  neighbours: Array<{ id: string; score: number }>;
}) {
  return (
    <div className="panel">
      <div className="eyebrow">Semantic Neighbours</div>
      <div className="stack">
        {props.neighbours.length === 0 ? <p className="muted">No neighbours available yet.</p> : null}
        {props.neighbours.map((item) => (
          <div key={item.id} className="repo-card">
            <div>{item.id}</div>
            <div className="muted">similarity {item.score.toFixed(3)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

