import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const STORE_LOCK_RETRY_DELAYS_MS = [100, 250, 500, 1_000];

function isStoreLockContention(stderr) {
  return /store (?:is )?locked.*resource temporarily unavailable/i.test(stderr);
}

export class WacliError extends Error {
  constructor(message, { exitCode, stderr } = {}) {
    super(message);
    this.name = "WacliError";
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

/**
 * Thin wrapper around the wacli binary. One instance per tenant, bound to that
 * tenant's store directory so two tenants can never read each other's data.
 */
export class Wacli {
  constructor({ bin, store, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    this.bin = bin;
    this.store = store;
    this.timeoutMs = timeoutMs;
  }

  async run(args, { readOnly = true } = {}) {
    const argv = ["--store", this.store, "--json"];
    if (readOnly) argv.push("--read-only");
    argv.push(...args);

    const deadline = Date.now() + this.timeoutMs;
    let retry = 0;
    while (true) {
      try {
        const { stdout } = await execFileAsync(this.bin, argv, {
          timeout: Math.max(1, deadline - Date.now()),
          maxBuffer: MAX_OUTPUT_BYTES,
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            WACLI_STORE_DIR: this.store,
            WACLI_DEVICE_LABEL: process.env.WACLI_DEVICE_LABEL || "wacli.me",
            WACLI_DEVICE_PLATFORM: process.env.WACLI_DEVICE_PLATFORM || "DESKTOP",
          },
        });
        return stdout;
      } catch (err) {
        const stderr = (err.stderr || "").toString().trim();
        const delay = STORE_LOCK_RETRY_DELAYS_MS[retry];
        if (
          !isStoreLockContention(stderr) ||
          delay === undefined ||
          Date.now() + delay >= deadline
        ) {
          const firstLine = stderr.split("\n").filter(Boolean).pop() || err.message;
          throw new WacliError(firstLine, { exitCode: err.code, stderr });
        }

        // A transient store lock can happen while the request-scoped sync
        // process is finishing its delegate setup. Re-run only after wacli
        // failed to acquire the lock, so the command has not taken effect.
        await new Promise((resolve) => setTimeout(resolve, delay));
        retry += 1;
      }
    }
  }

  async runJson(args, options) {
    const stdout = await this.run(args, options);
    const trimmed = stdout.trim();
    if (!trimmed) return null;

    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // A few commands emit NDJSON instead of a single document.
      parsed = trimmed.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    }

    // wacli wraps every --json response in {success, data, error}; hand the
    // caller the payload and turn a failed envelope into a real error.
    if (parsed && !Array.isArray(parsed) && typeof parsed.success === "boolean") {
      if (!parsed.success) {
        const message = typeof parsed.error === "string" ? parsed.error : JSON.stringify(parsed.error);
        throw new WacliError(message || "command failed");
      }
      return parsed.data ?? null;
    }
    return parsed;
  }

  doctor() {
    return this.runJson(["doctor"]);
  }

  listChats({ limit = 25, query, unread = false } = {}) {
    const args = ["chats", "list", "--limit", String(limit)];
    if (query) args.push("--query", query);
    if (unread) args.push("--unread");
    return this.runJson(args);
  }

  listMessages({ chat, limit = 25, fromMe, after, before } = {}) {
    const args = ["messages", "list", "--limit", String(limit)];
    if (chat) args.push("--chat", chat);
    if (fromMe === true) args.push("--from-me");
    if (fromMe === false) args.push("--from-them");
    if (after) args.push("--after", after);
    if (before) args.push("--before", before);
    return this.runJson(args);
  }

  searchMessages({ query, limit = 25, chat, after, before } = {}) {
    const args = ["messages", "search", query, "--limit", String(limit)];
    if (chat) args.push("--chat", chat);
    if (after) args.push("--after", after);
    if (before) args.push("--before", before);
    return this.runJson(args);
  }

  searchContacts({ query, limit = 25 } = {}) {
    return this.runJson(["contacts", "search", query, "--limit", String(limit)]);
  }

  getChat({ chat }) {
    return this.runJson(["chats", "show", "--jid", chat]);
  }

  getMessageContext({ chat, id, before = 5, after = 5 }) {
    return this.runJson([
      "messages", "context",
      "--chat", chat,
      "--id", id,
      "--before", String(before),
      "--after", String(after),
    ]);
  }

  listStarred({ limit = 25, chat } = {}) {
    const args = ["messages", "starred", "--limit", String(limit)];
    if (chat) args.push("--chat", chat);
    return this.runJson(args);
  }

  listCalls({ limit = 25, chat, after, before } = {}) {
    const args = ["calls", "list", "--limit", String(limit)];
    if (chat) args.push("--chat", chat);
    if (after) args.push("--after", after);
    if (before) args.push("--before", before);
    return this.runJson(args);
  }

  listGroups({ limit = 25, query } = {}) {
    const args = ["groups", "list", "--limit", String(limit)];
    if (query) args.push("--query", query);
    return this.runJson(args);
  }

  getGroup({ group }) {
    return this.runJson(["groups", "info", "--jid", group]);
  }

  historyCoverage({ limit = 25, query, chat } = {}) {
    const args = ["history", "coverage", "--limit", String(limit), "--only-actionable"];
    if (query) args.push("--query", query);
    if (chat) args.push("--chat", chat);
    return this.runJson(args);
  }

  // --- live and write paths (never run with the read-only guard) -----------

  checkNumbers({ numbers }) {
    return this.runJson(["contacts", "check", ...numbers], { readOnly: false });
  }

  downloadMedia({ chat, id, outputDir }) {
    return this.runJson(
      ["media", "download", "--chat", chat, "--id", id, "--output", outputDir],
      { readOnly: false },
    );
  }

  sendText({ to, message }) {
    return this.runJson(["send", "text", "--to", to, "--message", message], { readOnly: false });
  }

  react({ to, id, reaction, sender }) {
    const args = ["send", "react", "--to", to, "--id", id, "--reaction", reaction];
    if (sender) args.push("--sender", sender);
    return this.runJson(args, { readOnly: false });
  }

  markRead({ chat }) {
    return this.runJson(["chats", "mark-read", "--chat", chat], { readOnly: false });
  }
}
