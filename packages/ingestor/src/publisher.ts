import { createId, publishJson, Subjects, type CommitDetected, type FilesChanged } from "@driftcube/shared";
import type { NatsConnection } from "nats";

export async function publishLocalChange(
  nc: NatsConnection,
  input: {
    repoId: string;
    rootPath: string;
    path: string;
    absolutePath: string;
    changeType: "added" | "modified" | "deleted";
    language?: string;
    provenance?: "human" | "claude" | "codex" | "cursor" | "unknown";
    telemetrySource?: string;
    telemetryEditor?: string;
    telemetrySessionId?: string;
  },
): Promise<void> {
  const commitSha = createId("local");
  const timestamp = new Date().toISOString();

  const commit: CommitDetected = {
    schemaVersion: 1,
    repoId: input.repoId,
    commitSha,
    timestamp,
    provenanceHint: input.provenance ?? "unknown",
    rootPath: input.rootPath,
  };

  const filesChanged: FilesChanged = {
    schemaVersion: 1,
    repoId: input.repoId,
    commitSha,
    rootPath: input.rootPath,
    changes: [
      {
        path: input.path,
        absolutePath: input.absolutePath,
        changeType: input.changeType,
        language: input.language,
        provenance: input.provenance,
        telemetrySource: input.telemetrySource,
        telemetryEditor: input.telemetryEditor,
        telemetrySessionId: input.telemetrySessionId,
      },
    ],
  };

  await publishJson(nc, Subjects.CommitDetected, commit);
  await publishJson(nc, Subjects.FilesChanged, filesChanged);
}
