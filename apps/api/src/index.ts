import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { logger } from "hono/logger";

const app = new Hono();

app.use("*", logger());

app.get("/", (c) => c.json({ service: "notifitra-api", version: "0.1.0" }));

app.get("/health", (c) => c.json({ status: "ok" }));

const port = Number(process.env.PORT ?? 3000);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`notifitra-api listening on http://localhost:${info.port}`);
});

// trigger
