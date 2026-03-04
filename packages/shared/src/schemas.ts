export type RepoId = string;
export type CommitSha = string;
export type SymbolId = string;
export type Severity = "info" | "warn" | "error";
export type Provenance = "human" | "claude" | "codex" | "cursor" | "unknown";
export type WatchState = "pending" | "active" | "inactive" | "blocked";
export type RefactorStatus = "proposed" | "accepted" | "applied" | "dismissed";
export type AlertStatus = "open" | "acknowledged" | "resolved";

export interface RepoRegistered {
  schemaVersion: 1;
  repoId: RepoId;
  name: string;
  kind: "local" | "remote";
  hostPath?: string;
  rootPath?: string;
  remoteUrl?: string;
  defaultBranch: string;
  watchEnabled?: boolean;
  watchState?: WatchState;
  watchError?: string;
  createdAt: string;
}

export interface RepoUpdated {
  schemaVersion: 1;
  repoId: RepoId;
  name?: string;
  kind?: "local" | "remote";
  hostPath?: string;
  rootPath?: string;
  remoteUrl?: string;
  defaultBranch?: string;
  watchEnabled?: boolean;
  watchState?: WatchState;
  watchError?: string;
  updatedAt: string;
}

export interface RepoDeleted {
  schemaVersion: 1;
  repoId: RepoId;
  name?: string;
  kind?: "local" | "remote";
  deletedAt: string;
}

export interface CommitDetected {
  schemaVersion: 1;
  repoId: RepoId;
  commitSha: CommitSha;
  parentSha?: CommitSha;
  author?: string;
  message?: string;
  timestamp: string;
  provenanceHint?: Provenance;
  rootPath?: string;
}

export interface FileChange {
  path: string;
  absolutePath?: string;
  changeType: "added" | "modified" | "deleted" | "renamed";
  oldPath?: string;
  language?: string;
  diffRef?: string;
  provenance?: Provenance;
  telemetrySource?: string;
  telemetryEditor?: string;
  telemetrySessionId?: string;
}

export interface FilesChanged {
  schemaVersion: 1;
  repoId: RepoId;
  commitSha: CommitSha;
  rootPath?: string;
  changes: FileChange[];
}

export interface ExtractedSymbol {
  symbolId: SymbolId;
  kind: "function" | "class" | "method" | "module";
  name: string;
  signature?: string;
  startLine: number;
  endLine: number;
  hash: string;
  normHash: string;
  tokensHash?: string;
  modulePath?: string;
  provenance?: Provenance;
  textRef: string;
  bodyText?: string;
  imports?: string[];
  calls?: string[];
}

export interface SymbolsExtracted {
  schemaVersion: 1;
  repoId: RepoId;
  commitSha: CommitSha;
  rootPath?: string;
  filePath: string;
  absolutePath?: string;
  language: string;
  symbols: ExtractedSymbol[];
}

export interface GraphUpdated {
  schemaVersion: 1;
  repoId: RepoId;
  commitSha: CommitSha;
  filePath: string;
  moduleName?: string;
  moduleDependencyCount?: number;
  externalDependencyCount?: number;
  graphEdgesAdded?: string[];
  graphEdgesRemoved?: string[];
  graphEdgesCurrent?: string[];
  symbols: Array<{
    symbolId: SymbolId;
    name: string;
  }>;
}

export interface EmbeddingsUpserted {
  schemaVersion: 1;
  repoId: RepoId;
  commitSha: CommitSha;
  collection: "symbols_v1" | "diff_hunks_v1" | "modules_v1";
  upserts: Array<{
    id: string;
    vectorDim: number;
    payload: Record<string, unknown>;
  }>;
}

export interface AgentTelemetryReported {
  schemaVersion: 1;
  repoId: RepoId;
  filePath: string;
  absolutePath?: string;
  provenance: Provenance;
  source: string;
  editor?: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
  observedAt: string;
}

export interface RefactorRefreshRequested {
  schemaVersion: 1;
  repoId: RepoId;
  reason: string;
  trigger?: string;
  requestedAt: string;
}

export interface RefactorSuggestionsUpdated {
  schemaVersion: 1;
  repoId: RepoId;
  total: number;
  topSuggestionId?: string;
  refreshedAt: string;
}

export interface MetricPoint {
  scope: "symbol" | "file" | "module" | "repo" | "boundary";
  key: string;
  value: number;
  subjectId?: string;
  tags?: Record<string, string>;
}

export interface MetricsWritten {
  schemaVersion: 1;
  repoId: RepoId;
  commitSha: CommitSha;
  at: string;
  metrics: MetricPoint[];
}

export interface AlertRaised {
  schemaVersion: 1;
  repoId: RepoId;
  commitSha: CommitSha;
  at: string;
  severity: Severity;
  type:
    | "SEMANTIC_DUPLICATION"
    | "COMPLEXITY_CREEP"
    | "CONTENT_HEURISTIC"
    | "ARCH_VIOLATION"
    | "ARCH_EMBED_DRIFT"
    | "ARCH_PRESSURE"
    | "ENTROPY_DRIFT"
    | "INTENT_DRIFT"
    | "VOLATILITY_ZONE";
  title: string;
  evidence: {
    filePath?: string;
    symbolId?: string;
    module?: string;
    heuristicCategory?: string;
    heuristicDrivers?: string[];
    neighbours?: Array<{ id: string; score: number }>;
    graphEdgesAdded?: string[];
    graphEdgesRemoved?: string[];
    metrics?: Record<string, number>;
    diffRef?: string;
  };
  recommendation?: string;
}

export interface RefactorSuggestion {
  id: string;
  repoId: string;
  at: string;
  scope: "module" | "file" | "symbol-cluster" | "boundary";
  target: string;
  type: "DEDUPE_CLUSTER" | "EXTRACT_MODULE" | "INVERT_BOUNDARY";
  confidence: number;
  impact: {
    entropyDelta?: number;
    pressureDelta?: number;
    duplicationDelta?: number;
    couplingDelta?: number;
  };
  simulation?: {
    method: string;
    confidence: number;
    before: {
      entropyIndex: number;
      pressureIndex: number;
      duplicationIndex: number;
      couplingIndex: number;
    };
    after: {
      entropyIndex: number;
      pressureIndex: number;
      duplicationIndex: number;
      couplingIndex: number;
    };
    assumptions: string[];
  };
  evidence: {
    topDrivers: string[];
    entities: {
      symbols?: string[];
      modules?: string[];
      files?: string[];
      edgesAdded?: string[];
      alertShas?: string[];
    };
  };
  plan: string[];
  status?: RefactorStatus;
}
