function resolveApiBase(): string {
  if (typeof window !== "undefined") {
    return process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:48080";
  }

  return process.env.API_INTERNAL_BASE
    ?? process.env.NEXT_PUBLIC_API_BASE
    ?? "http://localhost:48080";
}

async function fetchJson<T>(path: string): Promise<T | null> {
  try {
    const response = await fetch(`${resolveApiBase()}${path}`, {
      cache: "no-store",
    });

    if (!response.ok) {
      return null;
    }

    return response.json() as Promise<T>;
  } catch {
    return null;
  }
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${resolveApiBase()}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `request failed with status ${response.status}`);
  }

  return response.json() as Promise<T>;
}

async function deleteJson<T>(path: string): Promise<T> {
  const response = await fetch(`${resolveApiBase()}${path}`, {
    method: "DELETE",
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `request failed with status ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export interface RepoSummary {
  repoId: string;
  name: string;
  kind: string;
  hostPath?: string | null;
  rootPath?: string | null;
  remoteUrl?: string | null;
  defaultBranch: string;
  watchEnabled?: boolean;
  watchState?: string | null;
  watchError?: string | null;
  entropyIndex?: number | null;
  pressureIndex?: number | null;
  activity24h?: number;
  analyzableEvents24h?: number;
  analyzedEvents24h?: number;
  unsupportedEvents24h?: number;
  analysisCoveragePercent?: number | null;
  archivedAt?: string | null;
  createdAt: string;
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
  status?: "proposed" | "accepted" | "applied" | "dismissed";
  linkedToAlert?: boolean;
}

export interface AlertSummary {
  id: string;
  repoId?: string;
  at: string;
  severity: string;
  status?: "open" | "acknowledged" | "resolved";
  type: string;
  title: string;
  sha?: string;
  evidence?: {
    filePath?: string;
    module?: string;
    symbolId?: string;
    heuristicCategory?: string;
    heuristicDrivers?: string[];
    metrics?: Record<string, number>;
    [key: string]: unknown;
  };
}

export interface AlertDetail {
  alert: AlertSummary & {
    recommendation?: string | null;
    acknowledgedAt?: string | null;
    acknowledgedBy?: string | null;
    resolvedAt?: string | null;
    resolvedBy?: string | null;
    statusUpdatedAt?: string | null;
  };
  preview: {
    available: boolean;
    filePath: string | null;
    absolutePath: string | null;
    totalLines: number;
    previewStart: number;
    previewEnd: number;
    lines: Array<{
      number: number;
      text: string;
      highlight: boolean;
    }>;
    reason?: string;
  };
  diff: {
    available: boolean;
    filePath: string | null;
    lines: Array<{
      kind: "context" | "add" | "remove" | "meta";
      text: string;
    }>;
    reason?: string;
  };
  activityHistory: RepoActivityItem[];
  relatedAlerts: AlertSummary[];
  relatedRefactors: RefactorSuggestion[];
  comments: Array<{
    id: string;
    repoId: string;
    alertId: string;
    kind: "note" | "fix" | "improvement";
    author: string;
    body: string;
    createdAt: string;
  }>;
}

export interface AlertPage {
  items: AlertSummary[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface SurfaceReport {
  scope: "repo" | "component";
  repoId: string;
  componentId?: string;
  generatedAt: string;
  timeframe: string;
  summary: Record<string, unknown>;
  charts: {
    trend: Array<Record<string, unknown>>;
    modules?: Array<Record<string, unknown>>;
    coverage?: Array<Record<string, unknown>>;
  };
  alerts: {
    total: number;
    byStatus: Record<string, number>;
    top: AlertSummary[];
  };
  notes: string[];
}

export interface RepoActivityItem {
  eventId: string;
  repoId: string;
  repoName?: string;
  commitSha: string;
  at: string;
  absolutePath?: string | null;
  filePath: string;
  language?: string | null;
  changeType: "added" | "modified" | "deleted" | "renamed";
  parserStatus: "pending" | "analyzed" | "unsupported" | "no_symbols";
  symbolCount: number;
  alertCount: number;
  provenance?: "human" | "claude" | "codex" | "cursor" | "unknown" | null;
  telemetrySource?: string | null;
  telemetryEditor?: string | null;
  telemetrySessionId?: string | null;
  note?: string | null;
  updatedAt: string;
}

export interface RepoActivityPage {
  items: RepoActivityItem[];
  languageCoverage: Array<{
    language: string;
    totalEvents: number;
    watchedOnlyEvents: number;
    fullPipelineEvents: number;
    analyzedEvents: number;
    coveragePercent: number;
  }>;
  total: number;
  page: number;
  pageSize: number;
  mode?: "all" | "full" | "watched";
  totalPages: number;
}

export interface RefactorPage {
  items: RefactorSuggestion[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface OverviewRepo extends RepoSummary {
  componentCount: number;
  latestSeverity?: string | null;
  latestAlertAt?: string | null;
  alertCount: number;
}

export interface RepoEntropyData {
  repoId: string;
  current: {
    entropyIndex: number;
    posture: string;
  };
  contributors: {
    dependency: number;
    duplication: number;
    complexity: number;
    change: number;
    architecture: number;
  };
  trend: Array<{
    at: string;
    entropyIndex: number;
  }>;
  modules: Array<{
    moduleId: string;
    entropyIndex: number;
    aiRisk: number;
    lastSeen: string;
  }>;
  generatedAt: string;
}

export interface MemoryFrame {
  sha: string;
  at: string;
  strategy?: string;
  signature: Record<string, unknown>;
  health: {
    entropyIndex: number;
    pressureIndex: number;
    duplicationEntropy: number;
    architectureEntropy: number;
  };
  graph: {
    archViolations: number;
    moduleCount: number;
    boundaryCount: number;
    moduleDependencyCount: number;
    externalDependencyCount: number;
  };
  complexity: {
    avgCyclomatic: number;
    maxCyclomatic: number;
  };
  semantic: {
    aiEditRatio: number;
    duplicationAlerts: number;
    symbolCount: number;
  };
  volatility: {
    churn24h: number;
    volatilityAlerts: number;
  };
}

export interface RepoMemoryData {
  repoId: string;
  current: MemoryFrame | null;
  baseline: MemoryFrame | null;
  delta: {
    entropyIndex: number;
    pressureIndex: number;
    avgCyclomatic: number;
    aiEditRatio: number;
    duplicationAlerts: number;
    archViolations: number;
    churn24h: number;
  } | null;
  modules: Array<{
    moduleId: string;
    current: MemoryFrame | null;
    baseline: MemoryFrame | null;
    delta: {
      entropyIndex: number;
      pressureIndex: number;
      avgCyclomatic: number;
      aiEditRatio: number;
      duplicationAlerts: number;
      archViolations: number;
      churn24h: number;
    } | null;
    posture: "stable" | "warming" | "pressured" | "critical";
  }>;
  timeline: Array<{
    sha: string;
    at: string;
    entropyIndex: number;
    pressureIndex: number;
    archViolations: number;
    aiEditRatio: number;
    incidentCount: number;
  }>;
  incidents: Array<{
    incidentId: string;
    type: string;
    scope: string;
    subjectId: string;
    status: string;
    severity: string;
    openedAt: string;
    closedAt: string | null;
    openedAlertTitle: string | null;
    latestAlertTitle: string | null;
    resolution: Record<string, unknown>;
    frames: {
      opened: MemoryFrame | null;
      latest: MemoryFrame | null;
      recovered: MemoryFrame | null;
    };
    deltas: {
      openedToLatest: {
        entropyIndex: number;
        pressureIndex: number;
        avgCyclomatic: number;
        aiEditRatio: number;
        duplicationAlerts: number;
        archViolations: number;
        churn24h: number;
      } | null;
      openedToRecovered: {
        entropyIndex: number;
        pressureIndex: number;
        avgCyclomatic: number;
        aiEditRatio: number;
        duplicationAlerts: number;
        archViolations: number;
        churn24h: number;
      } | null;
    };
  }>;
  generatedAt: string;
}

export interface SimilarModuleMatch {
  repoId: string;
  moduleId: string;
  moduleKey: string;
  role: string;
  score: number;
  drivers: string[];
  metrics: {
    pressureIndex: number;
    codeEntropyIndex: number;
    moduleDependencyCount: number;
    aiEditRatio: number;
  };
  fixes: Array<{
    type: string;
    confidence: number;
    target: string;
    impact: Record<string, unknown>;
    status: string;
  }>;
  outcomes: SimilarOutcome[];
}

export interface SimilarModuleData {
  repoId: string;
  componentId: string;
  role: string;
  items: SimilarModuleMatch[];
}

export interface SimilarOutcome {
  repoId: string;
  incidentType: string;
  subjectId: string;
  closedAt: string;
  deltaEntropy: number;
  deltaPressure: number;
  resolutionReason: string;
  fixType: string | null;
  fixTarget: string | null;
  fixConfidence: number;
  fixStatus: string;
}

export interface SimilarRepoMatch {
  repoId: string;
  name: string;
  score: number;
  drivers: string[];
  metrics: {
    pressureIndex: number;
    codeEntropyIndex: number;
    componentCount: number;
    incidentCount: number;
    alertCount: number;
  };
  pattern: string;
  dominantSignals: string[];
  fixes: Array<{
    type: string;
    confidence: number;
    target: string;
    impact: Record<string, unknown>;
    status: string;
  }>;
  outcomes: SimilarOutcome[];
}

export interface SimilarRepoData {
  repoId: string;
  items: SimilarRepoMatch[];
}

export interface SimilarBoundaryMatch {
  repoId: string;
  boundaryId: string;
  sourceModule: string;
  targetModule: string;
  score: number;
  drivers: string[];
  metrics: {
    pressureIndex: number;
    sourcePressureIndex: number;
    sourceEntropyIndex: number;
    archViolationCount: number;
  };
  fixes: Array<{
    type: string;
    confidence: number;
    target: string;
    impact: Record<string, unknown>;
    status: string;
  }>;
  outcomes: SimilarOutcome[];
}

export interface SimilarBoundaryData {
  repoId: string;
  boundaryId: string | null;
  items: SimilarBoundaryMatch[];
}

export interface OverviewData {
  stats: {
    repoCount: number;
    alerts24h: number;
    critical24h: number;
    signals24h: number;
    avgEntropy: number;
    maxEntropy: number;
    avgPressure: number;
    maxPressure: number;
    avgCoverage: number;
    activity24h: number;
    watchedOnly24h: number;
  };
  repos: OverviewRepo[];
  recentAlerts: AlertSummary[];
  recentActivity: RepoActivityItem[];
  languageCoverage: Array<{
    language: string;
    totalEvents: number;
    watchedOnlyEvents: number;
    fullPipelineEvents: number;
    analyzedEvents: number;
    coveragePercent: number;
  }>;
  languageWatchTrends: Array<{
    language: string;
    totalWatchedOnlyEvents: number;
    totalEvents: number;
    points: Array<{
      at: string;
      watchedOnlyEvents: number;
      totalEvents: number;
      fullPipelineEvents: number;
      watchedOnlyPercent: number;
    }>;
  }>;
  patterns: Array<{
    label: string;
    repoCount: number;
    avgEntropy: number;
    avgPressure: number;
    dominantSignals: string[];
    repos: Array<{
      repoId: string;
      name: string;
    }>;
  }>;
  generatedAt: string;
}

export async function getRepos(input?: {
  includeArchived?: boolean;
}): Promise<RepoSummary[]> {
  const query = new URLSearchParams();
  if (input?.includeArchived) {
    query.set("includeArchived", "true");
  }
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  return (await fetchJson<RepoSummary[]>(`/repos${suffix}`)) ?? [];
}

export async function getOverview(): Promise<OverviewData> {
  return (await fetchJson<OverviewData>("/overview")) ?? {
    stats: {
      repoCount: 0,
      alerts24h: 0,
      critical24h: 0,
      signals24h: 0,
      avgEntropy: 0,
      maxEntropy: 0,
      avgPressure: 0,
      maxPressure: 0,
      avgCoverage: 0,
      activity24h: 0,
      watchedOnly24h: 0,
    },
    repos: [],
    recentAlerts: [],
    recentActivity: [],
    languageCoverage: [],
    languageWatchTrends: [],
    patterns: [],
    generatedAt: new Date().toISOString(),
  };
}

export async function getRepo(repoId: string): Promise<RepoSummary | null> {
  return fetchJson<RepoSummary>(`/repos/${repoId}`);
}

export async function getRepoRefactors(repoId: string, input?: {
  page?: number;
  limit?: number;
  type?: string;
  status?: string;
}): Promise<RefactorPage> {
  const query = new URLSearchParams();
  if (input?.page) query.set("page", String(input.page));
  if (input?.limit) query.set("limit", String(input.limit));
  if (input?.type) query.set("type", input.type);
  if (input?.status) query.set("status", input.status);
  const suffix = query.size > 0 ? `?${query.toString()}` : "";

  return (await fetchJson<RefactorPage>(`/repos/${repoId}/refactors${suffix}`)) ?? {
    items: [],
    total: 0,
    page: input?.page ?? 1,
    pageSize: input?.limit ?? 8,
    totalPages: 1,
  };
}

export async function generateRepoRefactors(repoId: string): Promise<{
  repoId: string;
  generatedAt: string;
  total: number;
  items: RefactorSuggestion[];
  queued?: boolean;
}> {
  return postJson(`/repos/${repoId}/refactors/generate`, {});
}

export async function updateRepoRefactorStatus(
  repoId: string,
  refactorId: string,
  status: "proposed" | "accepted" | "applied" | "dismissed",
): Promise<{
  item: RefactorSuggestion;
  rank: number;
  updatedAt: string;
}> {
  const response = await fetch(`${resolveApiBase()}/repos/${repoId}/refactors/${refactorId}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ status }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `request failed with status ${response.status}`);
  }

  return response.json() as Promise<{
    item: RefactorSuggestion;
    rank: number;
    updatedAt: string;
  }>;
}

export async function getComponents(repoId: string): Promise<Array<Record<string, unknown>>> {
  return (await fetchJson<Array<Record<string, unknown>>>(`/repos/${repoId}/components`)) ?? [];
}

export async function getRepoEntropy(repoId: string): Promise<RepoEntropyData> {
  return (await fetchJson<RepoEntropyData>(`/repos/${repoId}/entropy`)) ?? {
    repoId,
    current: {
      entropyIndex: 0,
      posture: "stable",
    },
    contributors: {
      dependency: 0,
      duplication: 0,
      complexity: 0,
      change: 0,
      architecture: 0,
    },
    trend: [],
    modules: [],
    generatedAt: new Date().toISOString(),
  };
}

export async function getRepoMemory(repoId: string): Promise<RepoMemoryData> {
  return (await fetchJson<RepoMemoryData>(`/repos/${repoId}/memory`)) ?? {
    repoId,
    current: null,
    baseline: null,
    delta: null,
    modules: [],
    timeline: [],
    incidents: [],
    generatedAt: new Date().toISOString(),
  };
}

export async function getRepoActivity(repoId: string, input?: {
  page?: number;
  limit?: number;
  mode?: "all" | "full" | "watched";
  parserStatus?: "pending" | "analyzed" | "unsupported" | "no_symbols";
}): Promise<RepoActivityPage> {
  const query = new URLSearchParams();
  if (input?.page) query.set("page", String(input.page));
  if (input?.limit) query.set("limit", String(input.limit));
  if (input?.mode) query.set("mode", input.mode);
  if (input?.parserStatus) query.set("parserStatus", input.parserStatus);
  const suffix = query.size > 0 ? `?${query.toString()}` : "";

  return (await fetchJson<RepoActivityPage>(`/repos/${repoId}/activity${suffix}`)) ?? {
    items: [],
    languageCoverage: [],
    total: 0,
    page: input?.page ?? 1,
    pageSize: input?.limit ?? 12,
    mode: input?.mode ?? "all",
    totalPages: 1,
  };
}

export async function getSimilarModules(repoId: string, componentId: string, limit = 5): Promise<SimilarModuleData> {
  return (await fetchJson<SimilarModuleData>(
    `/repos/${repoId}/components/${encodeURIComponent(componentId)}/similar?limit=${limit}`,
  )) ?? {
    repoId,
    componentId,
    role: "",
    items: [],
  };
}

export async function getSimilarRepos(repoId: string, limit = 5): Promise<SimilarRepoData> {
  return (await fetchJson<SimilarRepoData>(`/repos/${repoId}/similar?limit=${limit}`)) ?? {
    repoId,
    items: [],
  };
}

export async function getSimilarBoundaries(repoId: string, limit = 5, boundaryId?: string): Promise<SimilarBoundaryData> {
  const query = new URLSearchParams();
  query.set("limit", String(limit));
  if (boundaryId) {
    query.set("boundaryId", boundaryId);
  }

  return (await fetchJson<SimilarBoundaryData>(`/repos/${repoId}/boundaries/similar?${query.toString()}`)) ?? {
    repoId,
    boundaryId: boundaryId ?? null,
    items: [],
  };
}

export function openRepoMemoryStream(
  repoId: string,
  handlers: {
    onRefresh: (payload: Record<string, unknown>) => void;
    onError?: () => void;
  },
): EventSource | null {
  if (typeof window === "undefined") {
    return null;
  }

  const stream = new EventSource(`${resolveApiBase()}/repos/${encodeURIComponent(repoId)}/memory/events`);
  stream.addEventListener("memory.refresh", (event) => {
    try {
      handlers.onRefresh(JSON.parse((event as MessageEvent<string>).data));
    } catch {
      handlers.onRefresh({});
    }
  });
  stream.onerror = () => {
    handlers.onError?.();
  };
  return stream;
}

export function openRepoManagerStream(
  handlers: {
    onRefresh: (payload: Record<string, unknown>) => void;
    onError?: () => void;
  },
): EventSource | null {
  if (typeof window === "undefined") {
    return null;
  }

  const stream = new EventSource(`${resolveApiBase()}/repos/events`);
  stream.addEventListener("repos.refresh", (event) => {
    try {
      handlers.onRefresh(JSON.parse((event as MessageEvent<string>).data));
    } catch {
      handlers.onRefresh({});
    }
  });
  stream.onerror = () => {
    handlers.onError?.();
  };
  return stream;
}

export function openOverviewStream(
  handlers: {
    onRefresh: (payload: Record<string, unknown>) => void;
    onError?: () => void;
  },
): EventSource | null {
  if (typeof window === "undefined") {
    return null;
  }

  const stream = new EventSource(`${resolveApiBase()}/overview/events`);
  stream.addEventListener("overview.refresh", (event) => {
    try {
      handlers.onRefresh(JSON.parse((event as MessageEvent<string>).data));
    } catch {
      handlers.onRefresh({});
    }
  });
  stream.onerror = () => {
    handlers.onError?.();
  };
  return stream;
}

export async function getComponent(repoId: string, componentId: string): Promise<Record<string, unknown> | null> {
  return fetchJson<Record<string, unknown>>(`/repos/${repoId}/components/${componentId}`);
}

export async function getRepoAlerts(repoId: string, input?: {
  page?: number;
  limit?: number;
  type?: string;
  severity?: string;
  status?: "open" | "acknowledged" | "resolved";
  heuristicCategory?: string;
}): Promise<AlertPage> {
  const query = new URLSearchParams();
  if (input?.page) query.set("page", String(input.page));
  if (input?.limit) query.set("limit", String(input.limit));
  if (input?.type) query.set("type", input.type);
  if (input?.severity) query.set("severity", input.severity);
  if (input?.status) query.set("status", input.status);
  if (input?.heuristicCategory) query.set("heuristicCategory", input.heuristicCategory);
  const suffix = query.size > 0 ? `?${query.toString()}` : "";

  return (await fetchJson<AlertPage>(`/repos/${repoId}/alerts${suffix}`)) ?? {
    items: [],
    total: 0,
    page: input?.page ?? 1,
    pageSize: input?.limit ?? 8,
    totalPages: 1,
  };
}

export async function getRepoAlertDetail(repoId: string, alertId: string): Promise<AlertDetail | null> {
  return fetchJson<AlertDetail>(`/repos/${repoId}/alerts/${encodeURIComponent(alertId)}`);
}

export async function updateAlertStatus(
  repoId: string,
  alertId: string,
  input: {
    status: "open" | "acknowledged" | "resolved";
    actor?: string;
    note?: string;
  },
): Promise<{ item: AlertDetail["alert"]; updatedAt: string }> {
  const response = await fetch(`${resolveApiBase()}/repos/${repoId}/alerts/${encodeURIComponent(alertId)}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `request failed with status ${response.status}`);
  }

  return response.json() as Promise<{ item: AlertDetail["alert"]; updatedAt: string }>;
}

export async function createAlertComment(
  repoId: string,
  alertId: string,
  input: {
    kind: "note" | "fix" | "improvement";
    author: string;
    body: string;
  },
): Promise<{
  item: AlertDetail["comments"][number];
}> {
  return postJson(`/repos/${repoId}/alerts/${encodeURIComponent(alertId)}/comments`, input);
}

export async function linkAlertRefactor(
  repoId: string,
  alertId: string,
  input: {
    refactorId: string;
    linkedBy?: string;
  },
): Promise<{
  linked: boolean;
  refactorId: string;
  alertId: string;
}> {
  return postJson(`/repos/${repoId}/alerts/${encodeURIComponent(alertId)}/link-refactor`, input);
}

export async function getGlobalAlerts(input?: {
  page?: number;
  limit?: number;
  repoId?: string;
  type?: string;
  severity?: string;
  status?: "open" | "acknowledged" | "resolved";
  heuristicCategory?: string;
}): Promise<AlertPage> {
  const query = new URLSearchParams();
  if (input?.page) query.set("page", String(input.page));
  if (input?.limit) query.set("limit", String(input.limit));
  if (input?.repoId) query.set("repoId", input.repoId);
  if (input?.type) query.set("type", input.type);
  if (input?.severity) query.set("severity", input.severity);
  if (input?.status) query.set("status", input.status);
  if (input?.heuristicCategory) query.set("heuristicCategory", input.heuristicCategory);
  const suffix = query.size > 0 ? `?${query.toString()}` : "";

  return (await fetchJson<AlertPage>(`/alerts${suffix}`)) ?? {
    items: [],
    total: 0,
    page: input?.page ?? 1,
    pageSize: input?.limit ?? 12,
    totalPages: 1,
  };
}

export async function getCommit(repoId: string, sha: string): Promise<Record<string, unknown> | null> {
  return fetchJson<Record<string, unknown>>(`/repos/${repoId}/commits/${sha}`);
}

export async function createRepo(input: {
  name: string;
  kind: "local" | "remote";
  hostPath?: string;
  rootPath?: string;
  remoteUrl?: string;
  defaultBranch?: string;
  watchEnabled?: boolean;
}): Promise<RepoSummary> {
  return postJson<RepoSummary>("/repos", input);
}

export async function updateRepo(repoId: string, input: {
  name?: string;
  hostPath?: string;
  rootPath?: string;
  remoteUrl?: string;
  defaultBranch?: string;
  watchEnabled?: boolean;
}): Promise<RepoSummary> {
  const response = await fetch(`${resolveApiBase()}/repos/${repoId}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `request failed with status ${response.status}`);
  }

  return response.json() as Promise<RepoSummary>;
}

export async function deleteRepo(repoId: string): Promise<{ ok: boolean; repoId: string; deletedAt: string }> {
  return deleteJson(`/repos/${repoId}`);
}

export async function archiveRepo(repoId: string): Promise<RepoSummary> {
  return postJson(`/repos/${repoId}/archive`, {});
}

export async function restoreRepo(repoId: string): Promise<RepoSummary> {
  return postJson(`/repos/${repoId}/restore`, {});
}

export async function getRepoSurfaceReport(repoId: string, timeframe = "12"): Promise<SurfaceReport | null> {
  return fetchJson<SurfaceReport>(`/repos/${repoId}/report?timeframe=${encodeURIComponent(timeframe)}`);
}

export async function getComponentSurfaceReport(repoId: string, componentId: string, timeframe = "12"): Promise<SurfaceReport | null> {
  return fetchJson<SurfaceReport>(
    `/repos/${repoId}/components/${encodeURIComponent(componentId)}/report?timeframe=${encodeURIComponent(timeframe)}`,
  );
}
