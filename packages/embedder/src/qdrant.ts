import { QdrantClient } from "@qdrant/js-client-rest";

const collections = ["symbols_v1", "diff_hunks_v1", "modules_v1", "repo_signatures_v1", "boundary_signatures_v1"] as const;

export function createQdrantClient(): QdrantClient {
  return new QdrantClient({ url: process.env.QDRANT_URL ?? "http://127.0.0.1:6333" });
}

export async function ensureCollections(client: QdrantClient, vectorSize: number): Promise<void> {
  const existing = new Set((await client.getCollections()).collections.map((entry) => entry.name));

  for (const name of collections) {
    if (!existing.has(name)) {
      await client.createCollection(name, {
        vectors: {
          size: vectorSize,
          distance: "Cosine",
        },
      });
    }

    for (const field of ["repoId", "module", "language", "kind", "provenance", "role", "scope", "sourceModule", "targetModule", "pattern"]) {
      try {
        await client.createPayloadIndex(name, {
          field_name: field,
          field_schema: "keyword",
        });
      } catch {
        // Qdrant returns an error when the index already exists.
      }
    }
  }
}
