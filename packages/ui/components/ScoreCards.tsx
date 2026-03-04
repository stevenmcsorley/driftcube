export function ScoreCards(props: {
  title: string;
  description: string;
  value: string;
}) {
  return (
    <div className="panel">
      <div className="eyebrow">{props.title}</div>
      <strong>{props.value}</strong>
      <p className="muted">{props.description}</p>
    </div>
  );
}

