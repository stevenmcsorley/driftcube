import type { FastifyReply, FastifyRequest } from "fastify";

const expectedToken = process.env.API_TOKEN ?? "driftcube-dev-token";

export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if ((process.env.AUTH_DISABLED ?? "true") === "true") {
    return;
  }

  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    await reply.code(401).send({ error: "missing bearer token" });
    return;
  }

  if (header.slice("Bearer ".length) !== expectedToken) {
    await reply.code(403).send({ error: "invalid bearer token" });
  }
}

