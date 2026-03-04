#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

wait_for_postgres() {
  echo "[driftcube] waiting for postgres readiness"
  local retries=60

  for ((i=1; i<=retries; i++)); do
    if docker compose exec -T timescale pg_isready \
      -U "${POSTGRES_USER:-postgres}" \
      -d "${POSTGRES_DB:-driftcube}" >/dev/null 2>&1; then
      echo "[driftcube] postgres is ready"
      return 0
    fi

    sleep 2
  done

  echo "[driftcube] postgres did not become ready in time" >&2
  return 1
}

wait_for_neo4j() {
  echo "[driftcube] waiting for neo4j readiness"
  local neo4j_auth="${NEO4J_AUTH:-neo4j/password}"
  local password="${neo4j_auth#*/}"
  local retries=60

  for ((i=1; i<=retries; i++)); do
    if docker compose exec -T neo4j cypher-shell \
      -u neo4j \
      -p "$password" \
      "RETURN 1;" >/dev/null 2>&1; then
      echo "[driftcube] neo4j is ready"
      return 0
    fi

    sleep 2
  done

  echo "[driftcube] neo4j did not become ready in time" >&2
  return 1
}

echo "[driftcube] installing workspace dependencies"
npm install

echo "[driftcube] starting infra"
docker compose up -d nats timescale neo4j qdrant minio

wait_for_postgres

echo "[driftcube] applying postgres migrations"
for file in migrations/timescale/*.sql; do
  docker compose exec -T timescale psql \
    -U "${POSTGRES_USER:-postgres}" \
    -d "${POSTGRES_DB:-driftcube}" \
    < "$file"
done

wait_for_neo4j

echo "[driftcube] applying neo4j migrations"
neo4j_auth="${NEO4J_AUTH:-neo4j/password}"
neo4j_password="${neo4j_auth#*/}"
for file in migrations/neo4j/*.cypher; do
  docker compose exec -T neo4j cypher-shell \
    -u neo4j \
    -p "$neo4j_password" \
    < "$file"
done

echo "[driftcube] migrations finished"
echo "[driftcube] start services with docker compose up api ui ingestor parser graph embedder metrics drift-engine"
