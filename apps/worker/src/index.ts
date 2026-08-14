import { Worker } from "bullmq";

const QUEUE_NAME = "notifications";

function redisConnection() {
  const url = process.env.REDIS_URL ?? "redis://localhost:6379";
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: Number(parsed.port ?? 6379),
    ...(parsed.password ? { password: parsed.password } : {}),
  };
}

const worker = new Worker(
  QUEUE_NAME,
  async (job) => {
    console.log(`[worker] processing job ${job.id} on queue '${QUEUE_NAME}'`, job.data);
  },
  { connection: redisConnection() },
);

console.log(`[worker] listening for jobs on queue '${QUEUE_NAME}'`);

async function shutdown() {
  await worker.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
