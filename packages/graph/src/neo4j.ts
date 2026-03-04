import neo4j from "neo4j-driver";

export function createNeo4jDriver(): neo4j.Driver {
  const url = process.env.NEO4J_URL ?? "bolt://127.0.0.1:7687";
  const auth = process.env.NEO4J_AUTH ?? "neo4j/password";
  const [username, password] = auth.split("/", 2);
  return neo4j.driver(url, neo4j.auth.basic(username ?? "neo4j", password ?? "password"));
}

