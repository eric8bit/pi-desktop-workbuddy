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
var upstream_exports = {};
__export(upstream_exports, {
  WorkBuddyUpstreamClient: () => WorkBuddyUpstreamClient,
  classifyUpstreamError: () => classifyUpstreamError,
  parseCreditMultiplier: () => parseCreditMultiplier,
  parseRateLimitReset: () => parseRateLimitReset,
  parseReasoning: () => parseReasoning,
  parseUpstreamModel: () => parseUpstreamModel,
  regionOf: () => regionOf
});
module.exports = __toCommonJS(upstream_exports);
const CN_CHAT_BASE = "https://copilot.tencent.com";
const CN_BILLING_BASE = "https://www.codebuddy.cn";
const GLOBAL_BASE = "https://www.workbuddy.ai";
const CLIENT_UA = "CLI/2.63.2 CodeBuddy/2.63.2";
const DESKTOP_UA = "WorkBuddy/5.5.2";
const MODELS_CATALOG_PATH = "/v2/enterprises/personal/models";
const GLOBAL_CONFIG_PATH = "/v3/config";
const JSON_TIMEOUT_MS = 1e4;
const ERROR_BODY_LIMIT = 4096;
const HARD_CREDIT_MARKERS = [
  "insufficient credit",
  "no credit",
  "credit exhausted",
  "out of credit",
  "quota exceeded",
  "quota exhaust",
  "payment required",
  "credit not enough",
  "not enough credit",
  "\u79EF\u5206\u4E0D\u8DB3",
  "\u989D\u5EA6\u4E0D\u8DB3",
  "\u4F59\u989D\u4E0D\u8DB3",
  "\u79EF\u5206\u7528\u5B8C",
  "\u989D\u5EA6\u7528\u5C3D",
  "\u6CA1\u6709\u79EF\u5206"
];
const SESSION_DEAD_MARKERS = ["Offline user session not found", "12153"];
const GLOBAL_HOSTS = ["workbuddy.ai", "workbuddy.cc", "codebuddy.ai"];
function regionOf(domain) {
  const lowered = domain.trim().toLowerCase();
  for (const host of GLOBAL_HOSTS) {
    if (lowered === host || lowered.endsWith(`.${host}`)) return "global";
  }
  return "cn";
}
function globalBase(credential) {
  const lowered = credential.domain.trim().toLowerCase();
  if (lowered === "codebuddy.ai" || lowered.endsWith(".codebuddy.ai")) return "https://www.codebuddy.ai";
  return GLOBAL_BASE;
}
function chatBase(credential) {
  return regionOf(credential.domain) === "global" ? globalBase(credential) : CN_CHAT_BASE;
}
function billingBase(credential) {
  return regionOf(credential.domain) === "global" ? globalBase(credential) : CN_BILLING_BASE;
}
function originReferer(credential) {
  return regionOf(credential.domain) === "global" ? globalBase(credential) : CN_BILLING_BASE;
}
function commonHeaders(credential) {
  return {
    "Accept": "application/json, text/plain, */*",
    "X-Requested-With": "XMLHttpRequest",
    "Origin": originReferer(credential),
    "Referer": `${originReferer(credential)}/`,
    "User-Agent": CLIENT_UA
  };
}
function chatHeaders(credential) {
  const headers = {
    ...commonHeaders(credential),
    "Content-Type": "application/json",
    "Authorization": `Bearer ${credential.accessToken}`,
    ...credential.uid === "" || credential.uid === void 0 ? { "X-No-User-Id": "1" } : { "X-User-Id": credential.uid },
    ...credential.enterpriseId === void 0 || credential.enterpriseId === "" ? { "X-No-Enterprise-Id": "1" } : { "X-Enterprise-Id": credential.enterpriseId },
    ...credential.domain === "" ? { "X-No-Department-Info": "1" } : { "X-Domain": credential.domain },
    "X-Product": "SaaS"
  };
  return headers;
}
function refreshHeaders(credential) {
  const headers = {
    ...commonHeaders(credential),
    "X-Refresh-Token": credential.refreshToken,
    "X-Auth-Refresh-Source": "workbuddy"
  };
  if (credential.enterpriseId !== void 0 && credential.enterpriseId !== "") {
    headers["X-Enterprise-Id"] = credential.enterpriseId;
  }
  return headers;
}
function billingHeaders(credential) {
  const headers = {
    "Authorization": `Bearer ${credential.accessToken}`,
    "Accept": "application/json",
    "Content-Type": "application/json"
  };
  if (credential.uid !== "" && credential.uid !== void 0) headers["X-User-Id"] = credential.uid;
  if (credential.enterpriseId !== void 0 && credential.enterpriseId !== "") {
    headers["X-Enterprise-Id"] = credential.enterpriseId;
    headers["X-Tenant-Id"] = credential.enterpriseId;
  }
  if (credential.domain !== "") headers["X-Domain"] = credential.domain;
  return headers;
}
function isGatewayHtmlRejection(status, text) {
  if (status !== 401 && status !== 403) return false;
  const head = text.slice(0, 512).toLowerCase();
  return head.includes("<html") || head.includes("openresty") || head.includes("apisix");
}
async function readEnvelope(response) {
  const text = await response.text();
  if (isGatewayHtmlRejection(response.status, text)) {
    throw new Error(
      "the WorkBuddy gateway rejected this credential (http 401). This usually means the account is using a stale sign-in the upstream no longer accepts: sign in again in the WorkBuddy desktop app, then pick the account on the plugin card. Run `dsh-workbuddy-xdpool doctor` to list every credential found."
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`workbuddy upstream returned non-JSON (http ${response.status}): ${text.slice(0, 160)}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`workbuddy upstream returned an unexpected document (http ${response.status})`);
  }
  const document = parsed;
  return {
    code: typeof document["code"] === "number" ? document["code"] : 0,
    msg: typeof document["msg"] === "string" ? document["msg"] : "",
    data: "data" in document ? document["data"] : void 0
  };
}
function envelopeError(status, envelope) {
  const kind = classifyUpstreamError(status, envelope.msg);
  return new Error(`workbuddy upstream ${kind} (http ${status}): ${envelope.msg.slice(0, 160)}`);
}
function classifyUpstreamError(status, body) {
  if (status === 402) return "hard_credit";
  const lower = body.toLowerCase();
  for (const marker of HARD_CREDIT_MARKERS) {
    if (lower.includes(marker.toLowerCase()) || body.includes(marker)) return "hard_credit";
  }
  for (const marker of SESSION_DEAD_MARKERS) {
    if (body.includes(marker)) return "session_dead";
  }
  if (status === 429) return "soft_rate";
  if (body.includes("soft_rate") || body.includes('"code":6004') || body.includes("\u9891\u7387\u9650\u5236")) {
    return "soft_rate";
  }
  if (status === 404) return "not_found";
  if (status >= 500) return "server";
  return "client";
}
function parseRateLimitReset(body) {
  const epochMs = /"(?:resetAt|reset_at|resetTime|reset_time)"\s*:\s*(\d{13})/.exec(body);
  if (epochMs !== null) return Number(epochMs[1]);
  const localized = /将在\s*([0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}:[0-9]{2})/.exec(body);
  if (localized !== null) {
    const parsed = Date.parse(localized[1].replace(" ", "T"));
    if (!Number.isNaN(parsed)) return parsed;
  }
  return void 0;
}
function parseCreditMultiplier(value) {
  if (typeof value !== "string") return void 0;
  const match = /x\s*([0-9]*\.?[0-9]+)/iu.exec(value);
  if (match === null) return void 0;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : void 0;
}
const SINGULAR_EFFORT_LADDER = ["low", "medium", "high", "xhigh", "max"];
function isSingularEffortForm(raw) {
  return typeof raw["effort"] === "string" && !Array.isArray(raw["supportedEfforts"]) && typeof raw["defaultEffort"] !== "string" && typeof raw["canDisableThinking"] !== "boolean";
}
function singularEffortLadder(raw) {
  const effort = typeof raw["effort"] === "string" ? raw["effort"] : void 0;
  if (effort === void 0) return void 0;
  return SINGULAR_EFFORT_LADDER.includes(effort) ? [...SINGULAR_EFFORT_LADDER] : [effort];
}
function parseReasoning(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
  const raw = value;
  const singularForm = isSingularEffortForm(raw);
  const effort = typeof raw["effort"] === "string" ? raw["effort"] : void 0;
  const supportedEfforts = Array.isArray(raw["supportedEfforts"]) ? raw["supportedEfforts"].filter((entry) => typeof entry === "string") : singularEffortLadder(raw);
  const defaultEffort = typeof raw["defaultEffort"] === "string" ? raw["defaultEffort"] : effort;
  const canDisableThinking = typeof raw["canDisableThinking"] === "boolean" ? raw["canDisableThinking"] : singularForm ? true : void 0;
  if (supportedEfforts === void 0 && defaultEffort === void 0 && canDisableThinking === void 0) {
    return void 0;
  }
  return {
    ...supportedEfforts === void 0 || supportedEfforts.length === 0 ? {} : { supportedEfforts },
    ...defaultEffort === void 0 ? {} : { defaultEffort },
    ...canDisableThinking === void 0 ? {} : { canDisableThinking }
  };
}
function parseUpstreamModel(value) {
  if (typeof value !== "object" || value === null) return void 0;
  const raw = value;
  const id = typeof raw["id"] === "string" ? raw["id"] : "";
  if (id === "" || raw["disabled"] === true) return void 0;
  const input = typeof raw["maxInputTokens"] === "number" ? raw["maxInputTokens"] : 0;
  const output = typeof raw["maxOutputTokens"] === "number" ? raw["maxOutputTokens"] : 0;
  if (input <= 0 || output <= 0) return void 0;
  const name = typeof raw["name"] === "string" && raw["name"] !== "" ? raw["name"] : id;
  const descriptionZh = typeof raw["descriptionZh"] === "string" && raw["descriptionZh"] !== "" ? raw["descriptionZh"] : void 0;
  const descriptionEn = typeof raw["descriptionEn"] === "string" && raw["descriptionEn"] !== "" ? raw["descriptionEn"] : void 0;
  const creditMultiplier = parseCreditMultiplier(raw["credits"]);
  const reasoning = parseReasoning(raw["reasoning"]);
  const supportsToolCall = typeof raw["supportsToolCall"] === "boolean" ? raw["supportsToolCall"] : void 0;
  const supportsImages = typeof raw["supportsImages"] === "boolean" ? raw["supportsImages"] : void 0;
  return {
    id,
    name,
    contextWindow: input,
    maxTokens: output,
    ...creditMultiplier === void 0 ? {} : { creditMultiplier },
    ...reasoning === void 0 ? {} : { reasoning },
    ...descriptionZh === void 0 ? {} : { descriptionZh },
    ...descriptionEn === void 0 ? {} : { descriptionEn },
    ...supportsToolCall === void 0 ? {} : { supportsToolCall },
    ...supportsImages === void 0 ? {} : { supportsImages }
  };
}
class WorkBuddyUpstreamClient {
  fetchImpl;
  clientVersion;
  constructor(options = {}) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.clientVersion = options.clientVersion ?? "2.0.4";
  }
  /**
   * Normalize an OpenAI chat-completions body for the WorkBuddy upstream:
   * force `stream: true` (the upstream rejects non-streaming), convert the
   * DSH `developer` role into `system` (upstream rejects `developer` with
   * business code 11128), and flatten `tool_choice` into its string form.
   */
  prepareChatBody(raw) {
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return raw;
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) return raw;
    const obj = body;
    obj["stream"] = true;
    delete obj["stream_options"];
    if (Array.isArray(obj["messages"])) {
      for (const value of obj["messages"]) {
        if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
        const message = value;
        if (message["role"] === "developer") message["role"] = "system";
      }
    }
    const choice = obj["tool_choice"];
    if (typeof choice === "string") {
      if (choice.trim().toLowerCase() === "none") {
        delete obj["tool_choice"];
        delete obj["tools"];
        delete obj["functions"];
      }
    } else if (typeof choice === "object" && choice !== null && !Array.isArray(choice)) {
      const wrapped = choice;
      const type = typeof wrapped["type"] === "string" ? wrapped["type"].trim().toLowerCase() : "";
      if (type === "none") {
        delete obj["tool_choice"];
        delete obj["tools"];
        delete obj["functions"];
      } else if (type === "auto" || type === "required") {
        obj["tool_choice"] = type;
      } else if (type === "function") {
        const fn = typeof wrapped["function"] === "object" && wrapped["function"] !== null ? wrapped["function"] : void 0;
        let name = typeof fn?.["name"] === "string" ? fn["name"] : "";
        if (name === "" && typeof wrapped["name"] === "string") name = wrapped["name"];
        obj["tool_choice"] = name.trim() !== "" ? name.trim() : "auto";
      } else {
        delete obj["tool_choice"];
      }
    }
    return JSON.stringify(obj);
  }
  /** Forward one chat completion. Never throws for upstream failures. */
  async chatStream(credential, prepared, signal) {
    let response;
    try {
      response = await this.fetchImpl(`${chatBase(credential)}/v2/chat/completions`, {
        method: "POST",
        headers: chatHeaders(credential),
        body: prepared,
        ...signal === void 0 ? {} : { signal }
      });
    } catch (error) {
      return { ok: false, kind: "server", status: 0, message: `transport error: ${String(error)}` };
    }
    if (response.ok) return { ok: true, response };
    const text = (await response.text().catch(() => "")).slice(0, ERROR_BODY_LIMIT);
    return {
      ok: false,
      kind: classifyUpstreamError(response.status, text),
      status: response.status,
      message: text
    };
  }
  /** POST the token-refresh endpoint; the caller merges the outcome. */
  async refreshToken(credential) {
    const response = await this.fetchImpl(`${chatBase(credential)}/v2/plugin/auth/token/refresh`, {
      method: "POST",
      headers: refreshHeaders(credential),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
    });
    const envelope = await readEnvelope(response);
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
    const data = typeof envelope.data === "object" && envelope.data !== null ? envelope.data : {};
    const accessToken = typeof data["accessToken"] === "string" ? data["accessToken"] : "";
    if (accessToken === "") {
      throw new Error("workbuddy token refresh returned no accessToken; sign in again in the WorkBuddy app");
    }
    const outcome = { accessToken };
    if (typeof data["refreshToken"] === "string" && data["refreshToken"] !== "") outcome.refreshToken = data["refreshToken"];
    if (typeof data["expiresIn"] === "number" && data["expiresIn"] > 0) outcome.expiresInSec = data["expiresIn"];
    if (typeof data["domain"] === "string" && data["domain"] !== "") outcome.domain = data["domain"];
    return outcome;
  }
  /**
   * Fetch the model catalog, keeping the `cli` agent's models only.
   *
   * The two gateways are read differently, because they answer differently:
   *
   * - **CN** serves the roster at `/v2/enterprises/personal/models` and expects
   *   the CLI client spelling.
   * - **Global** serves it as part of the product config at `/v3/config`, and
   *   only to the DESKTOP client channel. Asking the global host with the CLI UA
   *   yields a truncated roster, and the CN path answers HTTP 500 there — which
   *   is what left the international provider on its static fallback.
   *
   * Both documents share the `{ models, agents }` entry shape, so the parsing
   * below is common to the two branches.
   */
  async fetchModels(credential, signal) {
    const global = regionOf(credential.domain) === "global";
    const url = global ? `${globalBase(credential)}${GLOBAL_CONFIG_PATH}` : `${chatBase(credential)}${MODELS_CATALOG_PATH}`;
    const headers = global ? {
      "Authorization": `Bearer ${credential.accessToken}`,
      "Accept": "application/json",
      ...credential.uid === void 0 || credential.uid === "" ? {} : { "X-User-Id": credential.uid },
      ...credential.domain === "" ? {} : { "X-Domain": credential.domain },
      "X-Product": "SaaS",
      "X-Requested-With": "XMLHttpRequest",
      "Connection": "close",
      "User-Agent": DESKTOP_UA
    } : {
      "Authorization": `Bearer ${credential.accessToken}`,
      "Accept": "application/json",
      "Origin": originReferer(credential),
      "Referer": `${originReferer(credential)}/`,
      "User-Agent": CLIENT_UA
    };
    if (!global && credential.enterpriseId !== void 0 && credential.enterpriseId !== "") {
      headers["X-Enterprise-Id"] = credential.enterpriseId;
    }
    const response = await this.fetchImpl(url, {
      headers,
      ...signal === void 0 ? {} : { signal }
    });
    const envelope = await readEnvelope(response);
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
    const data = typeof envelope.data === "object" && envelope.data !== null ? envelope.data : {};
    const rawModels = Array.isArray(data["models"]) ? data["models"] : [];
    const agents = Array.isArray(data["agents"]) ? data["agents"] : [];
    let cliIds;
    for (const agent of agents) {
      if (typeof agent === "object" && agent !== null) {
        const wrapped = agent;
        if (wrapped["name"] === "cli" && Array.isArray(wrapped["models"])) {
          cliIds = wrapped["models"].filter((id) => typeof id === "string");
          break;
        }
      }
    }
    const byId = /* @__PURE__ */ new Map();
    for (const model of rawModels) {
      const parsed = parseUpstreamModel(model);
      if (parsed !== void 0) byId.set(parsed.id, parsed);
    }
    const ids = cliIds !== void 0 && cliIds.length > 0 ? cliIds : [...byId.keys()];
    const models = ids.map((id) => byId.get(id)).filter((model) => model !== void 0);
    if (models.length === 0) throw new Error("workbuddy model catalog resolved to an empty list");
    return models;
  }
  /** Read-only credits query, aggregated by package. Does not consume credits. */
  async fetchCredits(credential) {
    const now = /* @__PURE__ */ new Date();
    const fmt = (date) => {
      const p = (n) => n.toString().padStart(2, "0");
      return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
    };
    const response = await this.fetchImpl(`${billingBase(credential)}/v2/billing/meter/get-user-resource`, {
      method: "POST",
      headers: billingHeaders(credential),
      body: JSON.stringify({
        PageNumber: 1,
        PageSize: 100,
        ProductCode: "p_tcaca",
        Status: [0, 3],
        PackageEndTimeRangeBegin: fmt(now),
        PackageEndTimeRangeEnd: fmt(new Date(now.getTime() + 365 * 101 * 24 * 3600 * 1e3))
      }),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
    });
    const envelope = await readEnvelope(response);
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
    const wrapper = typeof envelope.data === "object" && envelope.data !== null ? envelope.data : {};
    const data = typeof wrapper["Response"] === "object" && wrapper["Response"] !== null ? wrapper["Response"] : {};
    const inner = typeof data["Data"] === "object" && data["Data"] !== null ? data["Data"] : {};
    const rawAccounts = Array.isArray(inner["Accounts"]) ? inner["Accounts"] : [];
    let total = 0;
    let nearestExpiryMs;
    let expiringSoon = 0;
    const SOON_MS = 3 * 24 * 60 * 60 * 1e3;
    const parseDate = (raw) => {
      if (typeof raw === "number" && raw > 1e12) return raw;
      if (typeof raw === "string" && raw !== "") {
        const parsed = Date.parse(raw);
        if (!Number.isNaN(parsed)) return parsed;
      }
      return void 0;
    };
    const packages = [];
    for (const raw of rawAccounts) {
      if (typeof raw !== "object" || raw === null) continue;
      const account = raw;
      const num = (key) => typeof account[key] === "number" ? account[key] : 0;
      const monthly = num("CapacityType") === 4;
      const size = monthly ? num("CycleCapacitySize") : num("CapacitySize");
      const remain = monthly ? num("CycleCapacityRemain") : num("CapacityRemain");
      const capped = remain < 0 ? 0 : remain;
      const cycleEndMs = parseDate(account["CycleEndTime"]);
      const expiresAtMs = monthly ? void 0 : parseDate(account["ExpiredTime"]) ?? cycleEndMs;
      const refreshAtMs = monthly ? cycleEndMs === void 0 ? void 0 : cycleEndMs + 1e3 : void 0;
      if (!monthly && (capped <= 0 || expiresAtMs !== void 0 && expiresAtMs <= Date.now())) continue;
      total += capped;
      if (expiresAtMs !== void 0) {
        if (nearestExpiryMs === void 0 || expiresAtMs < nearestExpiryMs) nearestExpiryMs = expiresAtMs;
        if (expiresAtMs - Date.now() <= SOON_MS) expiringSoon += capped;
      }
      packages.push({
        packageName: typeof account["PackageName"] === "string" ? account["PackageName"] : "(unnamed)",
        remain: capped,
        size,
        monthly,
        ...refreshAtMs === void 0 ? {} : { refreshAtMs },
        ...expiresAtMs === void 0 ? {} : { expiresAtMs }
      });
    }
    return { total, packages, expiringSoon, ...nearestExpiryMs === void 0 ? {} : { nearestExpiryMs } };
  }
  /** Query today's check-in status without changing account state. */
  async fetchCheckinStatus(credential) {
    const response = await this.fetchImpl(`${billingBase(credential)}/v2/billing/meter/checkin-activity-status`, {
      method: "POST",
      headers: billingHeaders(credential),
      body: "{}",
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
    });
    const envelope = await readEnvelope(response);
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
    const data = typeof envelope.data === "object" && envelope.data !== null ? envelope.data : {};
    const num = (key) => typeof data[key] === "number" ? data[key] : 0;
    return {
      active: data["active"] === true,
      todayCheckedIn: data["today_checked_in"] === true,
      streakDays: num("streak_days"),
      dailyCredit: num("daily_credit"),
      todayCredit: num("today_credit"),
      isStreakDay: data["is_streak_day"] === true,
      nextStreakDay: num("next_streak_day"),
      streakBonusDays: num("streak_bonus_days"),
      streakBonusCredit: num("streak_bonus_credit"),
      ...typeof data["claim_button_text"] === "string" && data["claim_button_text"] !== "" ? { claimButtonText: data["claim_button_text"] } : {}
    };
  }
  /** Claim today's check-in reward. The browser route guards this mutation. */
  async claimDailyCheckin(credential) {
    const response = await this.fetchImpl(`${billingBase(credential)}/v2/billing/meter/daily-checkin`, {
      method: "POST",
      headers: billingHeaders(credential),
      body: "{}",
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
    });
    const envelope = await readEnvelope(response);
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
    const data = typeof envelope.data === "object" && envelope.data !== null ? envelope.data : {};
    const numberField = (key) => typeof data[key] === "number" ? data[key] : 0;
    return {
      credit: numberField("credit"),
      streakDays: numberField("streak_days"),
      isStreakDay: data["is_streak_day"] === true
    };
  }
  /** Legacy thin wrapper kept for `status`/`doctor`: returns raw envelope data. */
  async credits(credential) {
    try {
      const data = await this.fetchCredits(credential);
      return { ok: true, data };
    } catch (error) {
      return { ok: false, message: String(error) };
    }
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  WorkBuddyUpstreamClient,
  classifyUpstreamError,
  parseCreditMultiplier,
  parseRateLimitReset,
  parseReasoning,
  parseUpstreamModel,
  regionOf
});
