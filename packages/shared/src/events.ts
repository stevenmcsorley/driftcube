export const Subjects = {
  RepoRegistered: "dc.repo.registered",
  RepoUpdated: "dc.repo.updated",
  RepoDeleted: "dc.repo.deleted",
  AgentTelemetryReported: "dc.agent.telemetry.reported",
  CommitDetected: "dc.commit.detected",
  FilesChanged: "dc.files.changed",
  SymbolsExtracted: "dc.symbols.extracted",
  GraphUpdated: "dc.graph.updated",
  EmbeddingsUpserted: "dc.embeddings.upserted",
  MetricsWritten: "dc.metrics.written",
  RefactorRefreshRequested: "dc.refactor.refresh.requested",
  RefactorSuggestionsUpdated: "dc.refactor.suggestions.updated",
  DriftEvaluated: "dc.drift.evaluated",
  AlertRaised: "dc.alert.raised",
} as const;

export type Subject = (typeof Subjects)[keyof typeof Subjects];
