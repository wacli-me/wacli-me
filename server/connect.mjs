// Self-service linking: run `wacli auth` per visitor, stream QR codes and
// status to the browser, and issue a token once WhatsApp confirms the pairing.
//
// Everything here is deliberately in-memory and small: a session is a running
// child process plus the last QR we saw. Nothing survives a restart, which is
// the honest trade for an alpha — a visitor who reloads mid-link starts over.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

const QR_TTL_MS = 60_000; // WhatsApp invalidates a linking code after ~a minute
const SESSION_TTL_MS = 6 * 60_000; // wacli gives up after five; leave a margin
// Bump together with the version line on /dpa, never silently.
export const DPA_VERSION = "1.0";

const MAX_ACTIVE_SESSIONS = 3; // one machine, one CPU — do not spawn a crowd

export class ConnectManager {
  constructor({ wacliBin, storesDir, tenantsFile, onLinked, followAfterLink = true }) {
    this.wacliBin = wacliBin;
    this.storesDir = storesDir;
    this.tenantsFile = tenantsFile;
    this.onLinked = onLinked || (() => {});
    this.followAfterLink = followAfterLink;
    this.sessions = new Map();
  }

  get activeCount() {
    return [...this.sessions.values()].filter((s) => s.status === "waiting").length;
  }

  start({ allowSend = false, dpa = false } = {}) {
    if (this.activeCount >= MAX_ACTIVE_SESSIONS) {
      const err = new Error("Too many people are linking right now. Try again in a minute.");
      err.code = "BUSY";
      throw err;
    }

    const id = crypto.randomBytes(9).toString("base64url");
    const store = path.join(this.storesDir, `u-${id}`);
    fs.mkdirSync(store, { recursive: true, mode: 0o700 });

    const authArgs = ["auth", "--events"];
    if (this.followAfterLink) authArgs.push("--follow");
    else authArgs.push("--idle-exit", "3s");
    authArgs.push("--store", store);

    const proc = spawn(this.wacliBin, authArgs, {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        // WhatsApp shows this string under "Linked devices" — on the account
        // owner's phone AND nowhere else. Without it wacli builds a label from
        // the host's own name, which would put our server's hostname on a
        // stranger's screen. Never let it fall back.
        WACLI_DEVICE_LABEL: process.env.WACLI_DEVICE_LABEL || "wacli.me",
        WACLI_DEVICE_PLATFORM: process.env.WACLI_DEVICE_PLATFORM || "DESKTOP",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const session = {
      id,
      store,
      allowSend: allowSend === true,
      dpa: dpa === true,
      proc,
      status: "waiting", // waiting | linked | failed | expired
      qr: null,
      qrAt: 0,
      token: null,
      error: null,
      listeners: new Set(),
      createdAt: Date.now(),
    };
    this.sessions.set(id, session);

    let buffer = "";
    proc.stderr.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) this.#handleEvent(session, line.trim());
    });

    proc.on("exit", () => {
      if (session.status === "waiting") this.#fail(session, "The linking window closed. Start again.");
    });

    session.timer = setTimeout(() => {
      if (session.status === "waiting") {
        this.#fail(session, "Timed out waiting for the scan.");
        proc.kill();
      }
    }, SESSION_TTL_MS);

    // A linked session is polled as a second opinion: the event stream is the
    // fast path, the store's own view of itself is the reliable one.
    session.poll = setInterval(() => this.#checkStore(session), 3000);

    return session;
  }

  get(id) {
    return this.sessions.get(id);
  }

  // The page starts a session on load, before the visitor has touched either
  // checkbox. Let them change their mind while the QR is still on screen: both
  // flags are only read when the pairing succeeds.
  setPermissions(session, { allowSend, dpa }) {
    if (session.status !== "waiting") return false;
    if (allowSend !== undefined) session.allowSend = allowSend === true;
    if (dpa !== undefined) session.dpa = dpa === true;
    this.#emit(session);
    return true;
  }

  // Someone opened the page and left. Give the slot back instead of holding it
  // for the full session lifetime — with auto-start, idle tabs would otherwise
  // use up MAX_ACTIVE_SESSIONS on their own.
  cancel(session) {
    if (session.status !== "waiting") return;
    session.status = "failed";
    session.error = "Linking cancelled.";
    clearTimeout(session.timer);
    clearInterval(session.poll);
    session.proc.kill();
    this.#emit(session);
    this.sessions.delete(session.id);
    fs.rmSync(session.store, { recursive: true, force: true });
  }

  snapshot(session) {
    return {
      status: session.status,
      qr: session.qr,
      expiresAt: session.qr ? session.qrAt + QR_TTL_MS : null,
      token: session.token,
      allowSend: session.allowSend,
      dpa: session.dpa,
      error: session.error,
    };
  }

  subscribe(session, fn) {
    session.listeners.add(fn);
    fn(this.snapshot(session));
    return () => session.listeners.delete(fn);
  }

  #emit(session) {
    const payload = this.snapshot(session);
    for (const fn of session.listeners) {
      try {
        fn(payload);
      } catch {
        session.listeners.delete(fn);
      }
    }
  }

  #handleEvent(session, line) {
    if (!line.startsWith("{")) return;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }

    if (event.event === "qr_code" && event.data?.code) {
      session.qr = event.data.code;
      session.qrAt = Date.now();
      this.#emit(session);
      return;
    }

    const name = String(event.event || "");
    if (/success|paired|logged_in|authenticated/i.test(name)) {
      this.#checkStore(session);
    }
  }

  #checkStore(session) {
    if (session.status !== "waiting") return;
    // whatsmeow writes the device credentials into the store as soon as the
    // pairing is accepted; that file appearing is the signal we trust.
    const db = path.join(session.store, "wacli.db");
    if (!fs.existsSync(db)) return;
    try {
      const size = fs.statSync(db).size;
      if (size < 20_000) return; // empty schema only — not paired yet
    } catch {
      return;
    }
    this.#succeed(session);
  }

  #succeed(session) {
    if (session.status !== "waiting") return;
    session.status = "linked";
    session.token = crypto.randomBytes(32).toString("hex");
    clearTimeout(session.timer);
    clearInterval(session.poll);

    const tenants = JSON.parse(fs.readFileSync(this.tenantsFile, "utf8"));
    tenants.tenants.push({
      id: `web-${session.id}`,
      token: session.token,
      store: session.store,
      allowSend: session.allowSend,
      // Article 28(9) wants the agreement in writing, and electronic form
      // counts. What makes it evidence is the timestamp and the version, so
      // record both rather than a bare boolean.
      dpa: session.dpa ? { version: DPA_VERSION, acceptedAt: new Date().toISOString() } : null,
      createdAt: new Date().toISOString(),
    });
    fs.writeFileSync(this.tenantsFile, JSON.stringify(tenants, null, 2), { mode: 0o600 });

    this.#emit(session);

    if (this.followAfterLink) {
      // Hand the store over to a supervised sync daemon, then let the short-lived
      // auth process go — otherwise history freezes at whatever linking fetched.
      setTimeout(() => {
        session.proc.kill();
        this.onLinked(session);
      }, 5_000);
    }
    setTimeout(() => this.sessions.delete(session.id), 10 * 60_000);
  }

  #fail(session, message) {
    if (session.status !== "waiting") return;
    session.status = "failed";
    session.error = message;
    clearTimeout(session.timer);
    clearInterval(session.poll);
    this.#emit(session);
    setTimeout(() => {
      this.sessions.delete(session.id);
      fs.rmSync(session.store, { recursive: true, force: true });
    }, 60_000);
  }
}

export const QR_TTL_SECONDS = QR_TTL_MS / 1000;
