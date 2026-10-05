var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var accounts_exports = {};
__export(accounts_exports, {
  WORKBUDDY_AUTH_FILE_ENV: () => WORKBUDDY_AUTH_FILE_ENV,
  WORKBUDDY_LIVE_FILENAME: () => WORKBUDDY_LIVE_FILENAME,
  WorkBuddyAccountPool: () => WorkBuddyAccountPool,
  candidateAuthDirs: () => candidateAuthDirs,
  defaultDesktopAuthDirs: () => defaultDesktopAuthDirs,
  parseWorkBuddyAuth: () => parseWorkBuddyAuth,
  workbuddyAccountId: () => workbuddyAccountId
});
module.exports = __toCommonJS(accounts_exports);
var import_node_crypto = require("node:crypto");
var import_promises = require("node:fs/promises");
var import_node_os = require("node:os");
var import_node_path = require("node:path");
var import_upstream = require("./upstream");
var import_at_rest = require("./at-rest");
const WORKBUDDY_LIVE_FILENAME = "workbuddy-desktop.info";
const WORKBUDDY_AUTH_FILE_ENV = "WORKBUDDY_AUTH_FILE";
function nonEmptyEnv(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : void 0;
}
function defaultDesktopAuthDirs(platform = process.platform, home = (0, import_node_os.homedir)(), env = process.env) {
  if (platform === "darwin") {
    return [(0, import_node_path.join)(home, "Library", "Application Support", "CodeBuddyExtension", "Data", "Public", "auth")];
  }
  if (platform === "win32") {
    const local = nonEmptyEnv(env["LOCALAPPDATA"]) ?? (0, import_node_path.join)(home, "AppData", "Local");
    const roaming = nonEmptyEnv(env["APPDATA"]) ?? (0, import_node_path.join)(home, "AppData", "Roaming");
    return [
      (0, import_node_path.join)(local, "CodeBuddyExtension", "Data", "Public", "auth"),
      (0, import_node_path.join)(roaming, "CodeBuddyExtension", "Data", "Public", "auth")
    ];
  }
  if (platform === "linux") {
    const config = nonEmptyEnv(env["XDG_CONFIG_HOME"]) ?? (0, import_node_path.join)(home, ".config");
    return [(0, import_node_path.join)(config, "CodeBuddyExtension", "Data", "Public", "auth")];
  }
  return [];
}
function expiryToMs(value) {
  if (value <= 0) return 0;
  return value > 1e12 ? value : value * 1e3;
}
function optionalString(value) {
  return typeof value === "string" && value !== "" ? value : void 0;
}
function parseWorkBuddyAuth(text, sourcePath, decrypt) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return void 0;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return void 0;
  const document = parsed;
  let auth;
  let identity;
  if (typeof document["auth"] === "object" && document["auth"] !== null) {
    auth = document["auth"];
    identity = typeof document["account"] === "object" && document["account"] !== null ? document["account"] : {};
  } else {
    auth = document;
    identity = document;
  }
  const accessField = decryptableString(auth["accessToken"], decrypt);
  const accessToken = accessField.value;
  if (accessToken === "") return void 0;
  const refreshExpiresAtMs = typeof auth["refreshExpiresAt"] === "number" ? expiryToMs(auth["refreshExpiresAt"]) : void 0;
  if (refreshExpiresAtMs !== void 0 && refreshExpiresAtMs > 0 && refreshExpiresAtMs < Date.now()) {
    return void 0;
  }
  const lastRefreshAtMs = typeof auth["lastRefreshTime"] === "number" ? expiryToMs(auth["lastRefreshTime"]) : void 0;
  const nickname = optionalString(decryptableString(identity["nickname"], decrypt).value);
  return {
    accessToken,
    refreshToken: decryptableString(auth["refreshToken"], decrypt).value,
    expiresAtMs: typeof auth["expiresAt"] === "number" ? expiryToMs(auth["expiresAt"]) : 0,
    ...refreshExpiresAtMs === void 0 ? {} : { refreshExpiresAtMs },
    ...lastRefreshAtMs === void 0 ? {} : { lastRefreshAtMs },
    ...nickname === void 0 ? {} : { nickname },
    ...optionalString(identity["uin"]) === void 0 ? {} : { uin: optionalString(identity["uin"]) },
    ...optionalString(identity["uid"]) === void 0 ? {} : { uid: optionalString(identity["uid"]) },
    ...optionalString(identity["enterpriseId"]) === void 0 ? {} : { enterpriseId: optionalString(identity["enterpriseId"]) },
    domain: typeof auth["domain"] === "string" ? auth["domain"] : "",
    sourcePath
  };
}
function decryptableString(value, decrypt) {
  if (typeof value === "string") return { value, encrypted: false, failed: false };
  if ((0, import_at_rest.isEncryptedFieldWrapper)(value)) {
    if (decrypt === void 0) return { value: "", encrypted: true, failed: true };
    try {
      return { value: decrypt(value), encrypted: true, failed: false };
    } catch {
      return { value: "", encrypted: true, failed: true };
    }
  }
  return { value: "", encrypted: false, failed: false };
}
function isLiveAuthFile(path) {
  return (0, import_node_path.basename)(path) === WORKBUDDY_LIVE_FILENAME;
}
function compareFreshness(a, b) {
  const aLive = isLiveAuthFile(a.sourcePath) ? 1 : 0;
  const bLive = isLiveAuthFile(b.sourcePath) ? 1 : 0;
  if (aLive !== bLive) return bLive - aLive;
  const aIssued = a.lastRefreshAtMs ?? 0;
  const bIssued = b.lastRefreshAtMs ?? 0;
  if (aIssued !== bIssued) return bIssued - aIssued;
  return b.expiresAtMs - a.expiresAtMs;
}
function isFresher(candidate, incumbent) {
  return compareFreshness(candidate, incumbent) < 0;
}
function workbuddyAccountId(credential) {
  const stable = credential.uin ?? credential.uid ?? credential.nickname ?? "unknown";
  return (0, import_node_crypto.createHash)("sha256").update(`workbuddy\0${stable}`).digest("hex").slice(0, 16);
}
function accountLabel(credential) {
  const name = credential.nickname ?? "WorkBuddy";
  const discriminator = (credential.uid ?? credential.uin ?? "").slice(0, 8);
  return discriminator === "" ? name : `${name}#${discriminator}`;
}
async function authFilesIn(dir) {
  let entries;
  try {
    entries = await (0, import_promises.readdir)(dir);
  } catch {
    return [];
  }
  const files = entries.filter((name) => name.endsWith(".info"));
  files.sort((a, b) => a < b ? 1 : a > b ? -1 : 0);
  return files.map((name) => (0, import_node_path.join)(dir, name));
}
async function readCredential(path) {
  let text;
  try {
    text = await (0, import_promises.readFile)(path, "utf8");
  } catch {
    return void 0;
  }
  const decrypt = text.includes('"$wbEncrypted"') ? await (0, import_at_rest.encryptedFieldOpener)() : void 0;
  return parseWorkBuddyAuth(text, path, decrypt);
}
function candidateAuthDirs(env = process.env) {
  const dirs = [];
  const override = nonEmptyEnv(env[WORKBUDDY_AUTH_FILE_ENV]);
  if (override !== void 0) {
    dirs.push(override.toLowerCase().endsWith(".info") ? (0, import_node_path.resolve)(override, "..") : override);
  }
  dirs.push(...defaultDesktopAuthDirs(process.env["DSH_TEST_PLATFORM"]));
  return dirs;
}
class WorkBuddyAccountPool {
  logger;
  authDirs;
  cooldownMs;
  client;
  refreshMarginMs;
  accounts = [];
  distribution;
  /** Cursor for round-robin mode; unused under priority distribution. */
  cursor = 0;
  lastScanAtMs = 0;
  preferredId;
  refreshInflight = /* @__PURE__ */ new Map();
  constructor(options = {}) {
    this.logger = options.logger;
    this.authDirs = options.authDirs ?? candidateAuthDirs();
    this.cooldownMs = options.cooldownMs ?? 6e4;
    this.client = options.client;
    this.refreshMarginMs = options.refreshMarginMs ?? 5 * 60 * 1e3;
    this.distribution = options.distribution ?? "priority";
  }
  /**
   * Re-apply configuration that only affects discovery and cooldown policy,
   * without rebuilding the pool. A later `scan()` uses the new auth dirs and
   * cooldown window; existing accounts keep their in-memory state.
   */
  applyConfig(options) {
    if (options.authDirs !== void 0 && options.authDirs.length > 0) {
      this.authDirs = options.authDirs;
    }
    if (options.cooldownMs !== void 0 && options.cooldownMs >= 1e3) {
      this.cooldownMs = options.cooldownMs;
    }
    if (options.distribution !== void 0) {
      this.distribution = options.distribution;
    }
  }
  /** Rescan the auth directories and merge newly discovered accounts. */
  async scan() {
    const found = [];
    for (const dir of this.authDirs) {
      for (const file of await authFilesIn(dir)) {
        const credential = await readCredential(file);
        if (credential !== void 0) found.push(credential);
      }
    }
    const byId = /* @__PURE__ */ new Map();
    for (const account of this.accounts) byId.set(account.id, account);
    for (const credential of found) {
      const id = workbuddyAccountId(credential);
      const existing = byId.get(id);
      if (existing === void 0) {
        byId.set(id, {
          id,
          label: accountLabel(credential),
          credential,
          cooldownUntilMs: 0,
          modelCooldowns: {},
          rateLimitHits: 0
        });
        continue;
      }
      if (isFresher(credential, existing.credential)) {
        byId.set(id, { ...existing, credential, label: accountLabel(credential) });
      }
    }
    const ordered = [...byId.values()];
    ordered.sort((a, b) => compareFreshness(a.credential, b.credential));
    this.accounts = ordered;
    this.lastScanAtMs = Date.now();
    return this.accounts;
  }
  /** All accounts, cooldown state included. */
  list(region) {
    if (region === void 0) return this.accounts;
    return this.accounts.filter((account) => (0, import_upstream.regionOf)(account.credential.domain) === region);
    return this.accounts;
  }
  /**
   * Accounts currently eligible to serve a request.
   *
   * With a `modelId`, an account is eligible when it is not account-wide cooled
   * AND that model is not cooling on it — so a 429 on `hy4-preview` only keeps
   * that model out while `hy3` on the same account stays usable. Without a
   * model id the legacy account-wide check applies (callers that cannot name a
   * model, e.g. CLI diagnostics).
   */
  available(now, modelId, region) {
    return this.accounts.filter((account) => {
      if (account.cooldownUntilMs > now) return false;
      if (modelId !== void 0 && (account.modelCooldowns[modelId] ?? 0) > now) return false;
      if (region !== void 0 && (0, import_upstream.regionOf)(account.credential.domain) !== region) return false;
      return true;
    });
  }
  /**
   * Pick the account to serve a request.
   *
   * Two distributions, chosen by the `distribution` setting:
   *
   * - **priority** (default, and what the card ships with): one account serves
   *   every request until it is rate-limited, then the next in order takes over.
   *   Credits drain one account at a time, and a cooling account returns to the
   *   head of the queue the moment its window resets — it was never consumed, so
   *   it resumes straight away.
   * - **round-robin**: consecutive requests rotate through the pool so spend
   *   spreads evenly across every account.
   *
   * In both modes an explicit user selection (`prefer`) heads the list, a
   * cooling account is skipped for that model only, and an unrecognised setting
   * falls back to priority.
   *
   * Scans on first use, and rescans when every known account is cooling down: a
   * fresh desktop login is the usual way out of an exhausted pool.
   */
  async acquire(modelId, region) {
    if (this.accounts.length === 0) await this.scan();
    let pool = this.available(Date.now(), modelId, region);
    if (pool.length === 0) {
      await this.scan();
      pool = this.available(Date.now(), modelId, region);
    }
    if (pool.length === 0) return void 0;
    if (this.preferredId !== void 0) {
      const preferredIndex = pool.findIndex((account2) => account2.id === this.preferredId);
      if (preferredIndex > 0) {
        const [preferred] = pool.splice(preferredIndex, 1);
        if (preferred !== void 0) pool = [preferred, ...pool];
      }
    }
    const index = this.distribution === "round-robin" ? this.cursor % pool.length : 0;
    const account = pool[index];
    if (account === void 0) return void 0;
    if (this.distribution === "round-robin") {
      this.cursor = (index + 1) % pool.length;
    }
    await this.ensureFresh(account);
    return account;
  }
  /** Pin the account the plugin card should prefer; tokens stay out of settings. */
  /** How the pool currently spreads requests. Shown on the card. */
  currentDistribution() {
    return this.distribution;
  }
  prefer(accountId) {
    this.preferredId = accountId;
  }
  /** Best-effort refresh of one account after a session-dead upstream answer. */
  async refreshAccount(accountId) {
    const account = this.accounts.find((item) => item.id === accountId);
    if (account === void 0) return;
    await this.ensureFresh(account);
  }
  /**
   * Refresh the account's access token when it is within the margin (or already
   * expired), in-flight de-duped per account. A failed refresh keeps the
   * existing token when it has not yet expired, so an unreachable refresh
   * endpoint never takes down a working session.
   */
  async ensureFresh(account) {
    if (this.client === void 0) return;
    const credential = account.credential;
    const expiring = credential.expiresAtMs <= 0 || credential.expiresAtMs <= Date.now() + this.refreshMarginMs;
    if (!expiring) return;
    const existing = this.refreshInflight.get(account.id);
    if (existing !== void 0) {
      await existing;
      return;
    }
    const run = (async () => {
      if (credential.refreshToken === "") {
        if (credential.expiresAtMs > Date.now() + 3e4) return;
        this.logger?.warn(`dsh-workbuddy-xdpool: ${account.label} token expired with no refresh token; sign in again`);
        return;
      }
      try {
        const outcome = await this.client.refreshToken(credential);
        account.credential = {
          ...credential,
          accessToken: outcome.accessToken,
          ...outcome.refreshToken === void 0 ? {} : { refreshToken: outcome.refreshToken },
          expiresAtMs: outcome.expiresInSec !== void 0 ? Date.now() + outcome.expiresInSec * 1e3 : credential.expiresAtMs,
          ...outcome.domain === void 0 || outcome.domain === "" ? {} : { domain: outcome.domain }
        };
        this.logger?.info?.(`dsh-workbuddy-xdpool: refreshed token for ${account.label}`);
      } catch (error) {
        if (credential.expiresAtMs > Date.now() + 3e4) {
          this.logger?.warn?.(`dsh-workbuddy-xdpool: token refresh failed but token still valid for ${account.label}`, error);
        } else {
          this.logger?.error?.(`dsh-workbuddy-xdpool: token refresh failed and token expired for ${account.label}`, error);
        }
      }
    })();
    this.refreshInflight.set(account.id, run);
    try {
      await run;
    } finally {
      this.refreshInflight.delete(account.id);
    }
  }
  /**
   * Mark an account (or one of its models) rate-limited.
   *
   * With `modelId`, only that model on the account is cooled — the account's
   * other models stay in rotation, matching the upstream's per-model rate
   * limit ("可切换其他模型继续使用"). Without a model id the whole account is
   * cooled, which callers should reserve for limits that truly span every model.
   */
  penalize(accountId, resetAtMs, modelId) {
    const account = this.accounts.find((item) => item.id === accountId);
    if (account === void 0) return;
    account.rateLimitHits += 1;
    const until = resetAtMs ?? Date.now() + this.cooldownMs;
    if (modelId !== void 0 && modelId !== "") {
      account.modelCooldowns[modelId] = Math.max(account.modelCooldowns[modelId] ?? 0, until);
      this.logger?.warn(
        `dsh-workbuddy-xdpool: ${account.label} rate-limited on model ${modelId}; cooling that model until ${new Date(until).toISOString()}`
      );
      return;
    }
    account.cooldownUntilMs = Math.max(account.cooldownUntilMs, until);
    this.logger?.warn(
      `dsh-workbuddy-xdpool: account ${account.label} rate-limited; cooling until ${new Date(until).toISOString()}`
    );
  }
  /** Clear all cooldowns (account-wide and per-model), e.g. from a reset command. */
  resetCooldowns() {
    for (const account of this.accounts) {
      account.cooldownUntilMs = 0;
      account.modelCooldowns = {};
      account.rateLimitHits = 0;
    }
  }
  /** Diagnostics snapshot. Account-wide cooling count (per-model cooling excluded:
   *  the account as a whole stays usable when only one model is limited). */
  status() {
    const now = Date.now();
    return {
      count: this.accounts.length,
      cooling: this.accounts.filter((account) => account.cooldownUntilMs > now).length,
      lastScanAtMs: this.lastScanAtMs
    };
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  WORKBUDDY_AUTH_FILE_ENV,
  WORKBUDDY_LIVE_FILENAME,
  WorkBuddyAccountPool,
  candidateAuthDirs,
  defaultDesktopAuthDirs,
  parseWorkBuddyAuth,
  workbuddyAccountId
});
