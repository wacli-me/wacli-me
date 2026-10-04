// A supervised sync process either stays connected continuously or is started
// for MCP tool calls and stopped shortly after the last request.

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";

const RESTART_DELAY_MS = 10_000;
const MAX_BACKOFF_MS = 5 * 60_000;
const REQUEST_READY_TIMEOUT_MS = 90_000;
// wacli 0.18.2 opens this socket only after it has acquired the store and
// finished its post-connect setup; offline_sync_completed may arrive earlier.
const SEND_DELEGATE_SOCKET = ".send.sock";
const SEND_DELEGATE_POLL_MS = 25;

export class SyncManager {
  constructor({ wacliBin, logDir, mode = "on-request", idleMs = 5_000 }) {
    this.wacliBin = wacliBin;
    this.logDir = logDir;
    this.mode = mode === "on-request" ? "on-request" : "continuous";
    this.idleMs = Number.isFinite(idleMs) ? Math.max(0, idleMs) : 5_000;
    this.running = new Map(); // store path -> process/session state
    this.requestTails = new Map(); // store path -> serialized MCP tool requests
  }

  ensure(store) {
    if (this.mode === "on-request" || this.running.has(store)) return;
    if (!fs.existsSync(store)) return;
    this.#spawn(store, RESTART_DELAY_MS);
  }

  /** Start a quiet session for a tool request and return a release callback. */
  async acquireForRequest(store) {
    const releaseSlot = await this.#acquireRequestSlot(store);
    if (this.mode !== "on-request") return releaseSlot;
    let entry = null;
    let requestCounted = false;

    try {
      if (!fs.existsSync(store)) throw new Error("WhatsApp account store is missing.");

      entry = this.running.get(store);
      if (!entry) {
        entry = this.#newRequestEntry(store);
        this.running.set(store, entry);
        this.#spawn(store, RESTART_DELAY_MS, entry);
      }

      if (entry.idleTimer) {
        clearTimeout(entry.idleTimer);
        entry.idleTimer = null;
      }
      entry.activeRequests += 1;
      requestCounted = true;

      // Wait until wacli has replayed the offline backlog so this request sees
      // the newest local mirror. The replay event can arrive before wacli has
      // finished its post-connect setup, so also wait for its send delegate
      // socket before allowing a command to run against the locked store.
      await entry.ready;
      await this.#waitForSendDelegate(store, entry);
    } catch (err) {
      if (entry && requestCounted) this.#releaseRequest(store, entry, true);
      else if (entry && this.running.get(store) === entry) this.stop(store);
      releaseSlot();
      throw err;
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#releaseRequest(store, entry);
      releaseSlot();
    };
  }

  /** Start a daemon for every store named in the tenant file. */
  ensureAll(tenants) {
    if (this.mode === "on-request") return;
    for (const tenant of tenants) this.ensure(tenant.store);
  }

  stop(store) {
    const entry = this.running.get(store);
    if (!entry) return;
    entry.stopping = true;
    clearTimeout(entry.restart);
    clearTimeout(entry.idleTimer);
    entry.rejectReady?.(new Error("WhatsApp sync was stopped."));
    entry.proc?.kill();
    this.running.delete(store);
  }

  stopAll() {
    for (const store of [...this.running.keys()]) this.stop(store);
  }

  status() {
    return [...this.running.entries()].map(([store, entry]) => ({
      store,
      pid: entry.proc?.pid ?? null,
      alive: Boolean(entry.proc && entry.proc.exitCode === null),
    }));
  }

  #newRequestEntry(store) {
    let resolve;
    let reject;
    const entry = {
      proc: null,
      backoff: RESTART_DELAY_MS,
      stopping: false,
      activeRequests: 0,
      idleTimer: null,
      readyState: "pending",
      eventBuffers: { stdout: "", stderr: "" },
      ready: new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      }),
    };
    entry.resolveReady = () => {
      if (entry.readyState !== "pending") return;
      entry.readyState = "ready";
      clearTimeout(entry.readyTimer);
      resolve();
    };
    entry.rejectReady = (err) => {
      if (entry.readyState !== "pending") return;
      entry.readyState = "failed";
      clearTimeout(entry.readyTimer);
      reject(err);
    };
    entry.readyTimer = setTimeout(
      () => entry.rejectReady(new Error("Timed out waiting for WhatsApp sync.")),
      REQUEST_READY_TIMEOUT_MS,
    );
    return entry;
  }

  async #acquireRequestSlot(store) {
    const previous = this.requestTails.get(store) || Promise.resolve();
    let unlock;
    const current = new Promise((resolve) => {
      unlock = resolve;
    });
    const tail = previous.catch(() => {}).then(() => current);
    this.requestTails.set(store, tail);
    await previous.catch(() => {});

    let released = false;
    return () => {
      if (released) return;
      released = true;
      unlock();
      if (this.requestTails.get(store) === tail) this.requestTails.delete(store);
    };
  }

  async #waitForSendDelegate(store, entry) {
    const socket = path.join(store, SEND_DELEGATE_SOCKET);
    const deadline = Date.now() + REQUEST_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.running.get(store) !== entry || entry.stopping || entry.proc?.exitCode !== null) {
        throw new Error("WhatsApp sync exited before its send handler was ready.");
      }
      try {
        const info = fs.lstatSync(socket);
        if (info.isSocket() && (await this.#canConnectToSocket(socket))) return;
      } catch {
        // The delegate starts after connection and app-state setup.
      }
      await new Promise((resolve) => setTimeout(resolve, SEND_DELEGATE_POLL_MS));
    }
    throw new Error("Timed out waiting for WhatsApp send handler.");
  }

  #canConnectToSocket(socket) {
    return new Promise((resolve) => {
      const client = net.createConnection(socket);
      let settled = false;
      const finish = (connected) => {
        if (settled) return;
        settled = true;
        client.destroy();
        resolve(connected);
      };
      client.once("connect", () => finish(true));
      client.once("error", () => finish(false));
      client.setTimeout(SEND_DELEGATE_POLL_MS, () => finish(false));
    });
  }

  #releaseRequest(store, entry, immediate = false) {
    entry.activeRequests = Math.max(0, entry.activeRequests - 1);
    if (entry.activeRequests !== 0 || this.running.get(store) !== entry) return;

    if (immediate || this.idleMs === 0) {
      this.stop(store);
      return;
    }

    clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      if (entry.activeRequests === 0 && this.running.get(store) === entry) this.stop(store);
    }, this.idleMs);
    entry.idleTimer.unref?.();
  }

  #spawn(store, backoff, requestEntry = null) {
    const requestScoped = this.mode === "on-request";
    const name = store.split("/").pop();
    const log = fs.openSync(`${this.logDir}/sync-${name}.log`, "a");
    const args = ["--store", store];
    if (requestScoped) args.push("--events");
    args.push("sync", "--follow", "--presence-mode", "quiet", "--max-db-size", "2GB");

    const proc = spawn(this.wacliBin, args, {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        WACLI_DEVICE_LABEL: process.env.WACLI_DEVICE_LABEL || "wacli.me",
        WACLI_DEVICE_PLATFORM: process.env.WACLI_DEVICE_PLATFORM || "DESKTOP",
      },
      stdio: requestScoped ? ["ignore", "pipe", "pipe"] : ["ignore", log, log],
    });

    const entry = requestEntry || { proc: null, backoff, stopping: false };
    entry.proc = proc;
    entry.backoff = backoff;
    entry.stopping = false;
    this.running.set(store, entry);
    console.log(`[sync] started for ${name} (pid ${proc.pid}, ${this.mode})`);

    let logClosed = false;
    const closeLog = () => {
      if (logClosed) return;
      logClosed = true;
      fs.closeSync(log);
    };

    if (requestScoped) {
      const capture = (stream, key) => {
        stream.on("data", (chunk) => {
          fs.writeSync(log, chunk);
          let buffered = entry.eventBuffers[key] + chunk.toString("utf8");
          const lines = buffered.split(/\r?\n/);
          entry.eventBuffers[key] = lines.pop() || "";
          for (const line of lines) {
            if (line.includes("offline_sync_completed")) entry.resolveReady();
            if (line.includes("logged_out")) {
              entry.rejectReady(new Error("WhatsApp linked session is no longer authenticated."));
            }
          }
        });
      };
      capture(proc.stdout, "stdout");
      capture(proc.stderr, "stderr");
    }

    proc.on("error", (err) => {
      closeLog();
      entry.rejectReady?.(new Error("Could not start WhatsApp sync."));
      if (this.running.get(store) === entry) this.running.delete(store);
      console.error(`[sync] ${name} failed to start: ${err.message}`);
    });

    proc.on("close", (code) => {
      closeLog();
      if (entry.stopping) return;

      if (requestScoped) {
        entry.rejectReady(new Error("WhatsApp sync exited before it was ready."));
        if (this.running.get(store) === entry) this.running.delete(store);
        console.log(`[sync] ${name} exited (${code}) during request-scoped sync`);
        return;
      }

      // A session that was unlinked on the phone exits immediately and forever;
      // backing off keeps that from becoming a spawn loop.
      const next = Math.min(entry.backoff * 2, MAX_BACKOFF_MS);
      console.log(`[sync] ${name} exited (${code}) — retrying in ${entry.backoff / 1000}s`);
      entry.restart = setTimeout(() => {
        if (this.running.get(store) !== entry) return;
        this.running.delete(store);
        this.#spawn(store, next);
      }, entry.backoff);
    });
  }
}
