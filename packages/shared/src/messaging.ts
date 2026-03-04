import { connect, JSONCodec, type Msg, type NatsConnection, type Subscription } from "nats";
import { createLogger } from "./logging.js";
import type { Subject } from "./events.js";

const codec = JSONCodec<unknown>();
const logger = createLogger("messaging");

export async function connectNats(url: string): Promise<NatsConnection> {
  const nc = await connect({ servers: url });
  logger.info("connected to nats", { url });
  return nc;
}

export async function publishJson<T>(nc: NatsConnection, subject: Subject, payload: T): Promise<void> {
  nc.publish(subject, codec.encode(payload));
}

export function subscribeJson<T>(
  nc: NatsConnection,
  subject: Subject,
  handler: (payload: T, msg: Msg) => Promise<void> | void,
): Subscription {
  const sub = nc.subscribe(subject);

  void (async () => {
    for await (const msg of sub) {
      const payload = codec.decode(msg.data) as T;
      try {
        await handler(payload, msg);
      } catch (error) {
        logger.error("subscription handler failed", {
          subject,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  })();

  return sub;
}

