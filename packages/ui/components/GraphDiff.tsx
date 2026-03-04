export function GraphDiff(props: {
  addedEdges: string[];
  removedEdges: string[];
}) {
  return (
    <div className="panel">
      <div className="eyebrow">Graph Delta</div>
      <div className="stack">
        {props.addedEdges.length === 0 && props.removedEdges.length === 0 ? <p className="muted">No graph-edge changes recorded yet.</p> : null}
        {props.addedEdges.length > 0 ? <div className="eyebrow">Added</div> : null}
        {props.addedEdges.map((edge) => (
          <div key={`added-${edge}`} className="pill pill-added">{edge}</div>
        ))}
        {props.removedEdges.length > 0 ? <div className="eyebrow">Removed</div> : null}
        {props.removedEdges.map((edge) => (
          <div key={`removed-${edge}`} className="pill pill-removed">{edge}</div>
        ))}
      </div>
    </div>
  );
}
