import { spawn } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const POLL_MS = 300;
const single = process.argv[2];

const APP_DEFS = [
  { name: "api", dir: "apps/api" },
  { name: "worker", dir: "apps/worker" },
];

function tsupBin(appDir) {
  return path.join(appDir, "node_modules/.bin/tsup");
}

function collectMtimes(dir, map) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      collectMtimes(p, map);
    } else if (entry.isFile() && /\.(ts|tsx|mjs|cjs)$/.test(entry.name)) {
      map.set(p, statSync(p).mtimeMs);
    }
  }
}

function runApp(app) {
  const appDir = path.join(root, app.dir);
  const srcDir = path.join(appDir, "src");
  let runChild = null;
  let building = false;
  let mtimes = new Map();

  function build() {
    return new Promise((resolve) => {
      console.log(`[${app.name}] building…`);
      const p = spawn(tsupBin(appDir), ["src/index.ts", "--format", "esm", "--clean"], {
        cwd: appDir,
        stdio: "inherit",
        env: { ...process.env, FORCE_COLOR: "1" },
      });
      p.on("exit", (code) => resolve(code ?? 1));
    });
  }

  async function rebuild() {
    if (building) return;
    building = true;
    const code = await build();
    if (code !== 0) {
      building = false;
      console.error(`[${app.name}] build failed (${code}); keeping previous process running.`);
      return;
    }
    const baseline = new Map();
    collectMtimes(srcDir, baseline);
    mtimes = baseline;
    building = false;
    if (runChild) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 2000);
        runChild.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        runChild.kill("SIGTERM");
      });
      runChild = null;
    }
    startRun();
  }

  function startRun() {
    console.log(
      `[${app.name}] starting ${path.relative(appDir, path.join(appDir, "dist/index.js"))}…`,
    );
    runChild = spawn("node", ["dist/index.js"], {
      cwd: appDir,
      stdio: "inherit",
      env: { ...process.env },
    });
    runChild.on("exit", (code) => {
      runChild = null;
      console.error(`[${app.name}] process exited (code ${code}).`);
    });
  }

  async function checkForChanges() {
    if (building) return;
    const next = new Map();
    collectMtimes(srcDir, next);
    if (next.size !== mtimes.size) return rebuild();
    for (const [p, ms] of next) {
      if (mtimes.get(p) !== ms) return rebuild();
    }
  }

  return {
    name: app.name,
    async init() {
      mtimes = new Map();
      collectMtimes(srcDir, mtimes);
      const code = await build();
      if (code !== 0) process.exit(code);
      startRun();
      setInterval(checkForChanges, POLL_MS);
    },
    stop() {
      if (runChild) runChild.kill("SIGTERM");
    },
  };
}

const defs = single ? APP_DEFS.filter((a) => a.name === single) : APP_DEFS;
const apps = defs.map(runApp);

if (apps.length === 0) {
  console.error(`[dev] unknown app '${single}'. Use 'api' or 'worker'.`);
  process.exit(1);
}

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const app of apps) app.stop();
  setTimeout(() => process.exit(0), 200);
}

process.on("SIGINT", () => shutdown());
process.on("SIGTERM", () => shutdown());

for (const app of apps) app.init();
