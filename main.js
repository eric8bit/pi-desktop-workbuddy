"use strict";

/**
 * pi-desktop-workbuddy - PI-Desktop plugin entry.
 *
 * PI-Desktop port of `dsh-workbuddy-xdpool` (MIT). Same behaviour as the
 * original, rewritten against the PI-Desktop plugin host:
 *
 *   1. discover EVERY WorkBuddy desktop sign-in on this machine (read-only),
 *   2. serve each gateway (domestic / international) from its own loopback
 *      OpenAI-compatible endpoint,
 *   3. publish those endpoints as two providers in this plugin's own manifest
 *      (`contributes.providers`) - the only provider channel the host exposes,
 *   4. rotate to the next account whenever the upstream answers 429.
 *
 * The host spawns plugins in a Node utility process with a stripped
 * environment, so every path is rebuilt from the home directory rather than
 * from %LOCALAPPDATA%/APPDATA% (see lib/accounts.js).
 *
 * Upstream traffic uses the platform `fetch` in that process rather than the
 * host's `net.fetch` bridge: the bridge buffers a response into text, and the
 * provider contract needs the upstream SSE body relayed as it arrives. Nothing
 * leaves this machine except to WorkBuddy's own endpoints.
 */

const path = require("node:path");
const fs = require("node:fs");
const net = require("node:net");

const { WorkBuddyAccountPool } = require("./lib/accounts");
const {
  WorkBuddyCatalog,
  applyOverride,
  displayName,
  hasOverride,
} = require("./lib/catalog");
const { createWorkBuddyShim } = require("./lib/shim");
const { WorkBuddyUpstreamClient } = require("./lib/upstream");

const PLUGIN_ID = "local.pi-desktop-workbuddy";
/** The id this plugin used before it was renamed; only the migration reads it. */
const PREVIOUS_PLUGIN_ID = "local.pi-workbuddy-xdpool";
const PLUGIN_VERSION = "0.1.0";

/** The one background service the manifest declares. */
const SERVICE_ID = "provider-host";

const COMMAND_OPEN = "xdpool.open";
const COMMAND_RESCAN = "xdpool.rescan";
const COMMAND_RESET = "xdpool.resetCooldowns";
const COMMAND_DOCTOR = "xdpool.doctor";
const COMMAND_CHECKIN = "xdpool.checkin";

/** The two gateways, matching the provider ids written into the manifest. */
const REGIONS = ["cn", "global"];
const PROVIDER_ID_BY_REGION = { cn: "xdpool-cn", global: "xdpool-global" };
const PROVIDER_NAME_BY_REGION = {
  cn: "pi-desktop-workbuddy（国内版）",
  global: "pi-desktop-workbuddy（国际版）",
};
/**
 * Preferred loopback port, one per gateway.
 *
 * The host reads a provider's base URL from the manifest BEFORE the plugin
 * process starts, so the published row is only correct if the endpoint comes
 * back on the same port every run - an ephemeral port would leave the row
 * pointing at nothing. They sit outside the range the single-account connector
 * uses (41811/41812, 41821/41822) so both plugins can be installed at once.
 *
 * These are the *preferred* ports and the only ones ever published: a run that
 * cannot reclaim its port still declares it, because the manifest has to
 * describe the address the NEXT run will bind.
 */
const REGION_PORTS = { cn: 41831, global: 41841 };

/**
 * How hard one run tries to reclaim its preferred port.
 *
 * A busy preferred port is almost always the previous instance still exiting,
 * which is a wait of milliseconds rather than a permanent condition. Giving up
 * instantly made a run fall back to a spare port and publish it, which
 * stranded the host on an address nothing listens on.
 */
const PORT_RESERVE_ATTEMPTS = 6;
const PORT_RESERVE_INTERVAL_MS = 250;

/** Levels the host's thinking picker accepts, in the order it shows them. */
const HOST_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Bounds the host's manifest validator enforces. */
const MAX_MODELS = 64;
const CONSERVATIVE_CONTEXT_WINDOW = 128000;
const DEFAULT_MAX_TOKENS = 32000;
const DEFAULT_REFRESH_MINUTES = 30;
const MIN_REFRESH_MINUTES = 5;
/** Used until a shim binds: the host rejects a provider with no base URL. */
const PLACEHOLDER_BASE_URL = "http://127.0.0.1:1/v1";

/**
 * How long one account's billing answers (credits, check-in) are reused.
 *
 * Opening the panel used to await both calls for every account before it could
 * render anything; they are now cached and refreshed behind the first paint.
 */
const PROBE_TTL_MS = 60000;
/** Bound on one model-catalog request, so a stalled host cannot stall a load. */
const MODELS_TIMEOUT_MS = 20000;

let settings = {};
let dataPath = "";
/** The package root, so the declaration can rewrite this plugin's manifest. */
let packageRoot = "";
/** True once the declaration changed; the host re-reads it on the next load. */
let pendingHostReload = false;

/** One runtime per gateway: its shim and catalog. */
const runtimes = new Map();

/** Shared upstream client and account pool, built in onLoad. */
const core = { client: null, pool: null };

/** Handle for the one deferred refresh, so a burst of opens coalesces. */
let refreshTimer = null;
/** The background refresh in flight, so two passes never overlap. */
let refreshInflight = null;
/** The host settings listener, kept so onUnload can detach it. */
let settingsChangedHandler = null;

function messageOf(error) {
  return error && error.message ? String(error.message) : String(error);
}

function log(level, message) {
  try {
    console.log("[xdpool] " + level + ": " + message);
  } catch {
    /* logging must never break a request */
  }
}

function regionOfKey(value) {
  return value === "global" ? "global" : "cn";
}

// ---------------------------------------------------------------- settings

/**
 * Take over the settings file written under this plugin's former id.
 *
 * The host derives the plugin data directory from the plugin id, so renaming
 * the plugin would otherwise start it with an empty settings file and the model
 * selection, per-model reasoning levels and usage mode the user had saved would
 * look lost.
 *
 * Only the settings file is carried over, and only when this id has none of its
 * own: a normal load never reads the old directory, and a second load is a
 * no-op. The old copy stays in place rather than being moved, so reverting the
 * rename would still find it.
 */
function adoptPreviousDataDir() {
  if (dataPath === "") return;
  const own = path.join(dataPath, "settings.json");
  if (fs.existsSync(own)) return;
  const previous = path.join(path.dirname(dataPath), PREVIOUS_PLUGIN_ID);
  const source = path.join(previous, "settings.json");
  if (!fs.existsSync(source)) return;
  try {
    fs.mkdirSync(dataPath, { recursive: true });
    fs.copyFileSync(source, own);
    log("info", "carried settings over from the previous plugin id");
  } catch (error) {
    log("warn", "could not carry settings over from the previous id: " + messageOf(error));
  }
}

async function loadSettings() {
  try {
    return (await pi.plugin.getSettings()) || {};
  } catch {
    return {};
  }
}

/**
 * Persist a partial settings patch.
 *
 * Returns false instead of throwing so a request path can never be broken by a
 * rejected write, but the caller still learns that nothing was stored.
 */
async function saveSettings(patch) {
  try {
    await pi.plugin.setSettings(patch);
    settings = { ...settings, ...patch };
    return true;
  } catch (error) {
    log("warn", "could not save settings: " + messageOf(error));
    return false;
  }
}

/**
 * Apply a settings payload the host pushed at this process.
 *
 * The host validates and stores first, then announces the merged document, so a
 * selection edited in the host's own settings UI reaches the running plugin
 * here instead of only after a reload. The selection is re-applied and the
 * declaration republished straight away, because a narrower model list has to
 * reach the picker or the user still sees the models they just disabled.
 */
function onHostSettingsChanged(next) {
  if (next === null || typeof next !== "object" || Array.isArray(next)) return false;
  settings = { ...settings, ...next };
  applySettingsToCore();
  syncDeclaration();
  probeCache.clear();
  scheduleRefresh("settings");
  return true;
}

/** Subscribe to the host's settings event, tolerating a host without it. */
function subscribeToHostSettings() {
  settingsChangedHandler = (next) => {
    try {
      if (onHostSettingsChanged(next)) log("info", "settings changed in the host UI; selection re-applied");
    } catch (error) {
      log("warn", "applying host settings failed: " + messageOf(error));
    }
  };
  try {
    if (pi.events && typeof pi.events.on === "function") {
      pi.events.on("plugin:settingsChanged", settingsChangedHandler);
      return true;
    }
  } catch (error) {
    log("warn", "could not subscribe to settings changes: " + messageOf(error));
  }
  settingsChangedHandler = null;
  return false;
}

function refreshMinutes() {
  const value = Number(settings.catalogRefreshMinutes);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_REFRESH_MINUTES;
  return Math.max(MIN_REFRESH_MINUTES, Math.min(24 * 60, Math.round(value)));
}

function cooldownMs() {
  const value = Number(settings.cooldownSeconds);
  if (!Number.isFinite(value) || value <= 0) return 60000;
  return Math.max(1000, Math.min(24 * 60 * 60 * 1000, Math.round(value * 1000)));
}

/**
 * How the pool spreads requests.
 *
 * Pool-wide, exactly as in the original: `priority` drains one account before
 * moving on, `round-robin` splits the spend. The pool is shared by both
 * gateways, so this cannot be a per-gateway switch.
 */
function distributionSetting() {
  return settings.distribution === "round-robin" ? "round-robin" : "priority";
}

/**
 * The saved model selection for one gateway.
 *
 * The original kept a single selection for the whole pool; the port keys it per
 * gateway so the two picker groups can be filtered independently. Absent means
 * "everything enabled" - an unconfigured install must never show an empty list.
 */
function selectionFor(region) {
  const all = settings.modelSelection && typeof settings.modelSelection === "object" ? settings.modelSelection : {};
  return normalizeSelection(all[regionOfKey(region)]);
}

/**
 * Fold a stored selection into the shape the rest of the plugin reads.
 *
 * `overrides` is the only per-model shape written now, but a settings file from
 * an earlier version stores the same two edits as `imageModelIds` and
 * `contextBudgets`. Both are read and folded in, so upgrading never silently
 * discards edits the user already made.
 */
function normalizeSelection(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out = {};
  if (Array.isArray(value.enabledModelIds)) out.enabledModelIds = value.enabledModelIds;
  const overrides = {};
  if (value.overrides && typeof value.overrides === "object" && !Array.isArray(value.overrides)) {
    for (const [id, entry] of Object.entries(value.overrides)) {
      if (typeof id === "string" && id !== "" && entry && typeof entry === "object" && !Array.isArray(entry)) {
        overrides[id] = { ...entry };
      }
    }
  }
  for (const id of Array.isArray(value.imageModelIds) ? value.imageModelIds : []) {
    if (typeof id === "string" && id !== "") {
      overrides[id] = { ...(overrides[id] || {}), supportsImages: true };
    }
  }
  const budgets = value.contextBudgets && typeof value.contextBudgets === "object" ? value.contextBudgets : {};
  for (const [id, budget] of Object.entries(budgets)) {
    if (typeof id === "string" && id !== "" && typeof budget === "number" && budget > 0) {
      overrides[id] = { ...(overrides[id] || {}), contextWindow: budget };
    }
  }
  if (Object.keys(overrides).length > 0) out.overrides = overrides;
  return out;
}

/**
 * The selection actually applied to one gateway's catalog.
 *
 * A stored selection can name models the live roster no longer carries (the
 * upstream renames and retires models). Applying that verbatim would filter
 * every model out: the picker group would vanish, the panel would show nothing
 * enabled, and no save could be made to look like it took effect. When none of
 * the saved ids exist any more, the selection is treated as unset so the group
 * stays usable, and `selectionStale` tells the panel to say why.
 *
 * Takes the catalog explicitly rather than looking it up in `runtimes`: it is
 * called while a runtime is still being constructed, before it is registered.
 */
function effectiveSelectionFor(region, catalog) {
  const selection = selectionFor(region);
  const enabled = selection.enabledModelIds;
  if (!Array.isArray(enabled) || enabled.length === 0) return selection;
  if (!catalog) return selection;
  const known = new Set(catalog.current().map((model) => model.id));
  if (enabled.some((id) => known.has(id))) return selection;
  return {};
}

/** True when a gateway's stored selection no longer matches its live roster. */
function selectionStale(region, catalog) {
  const enabled = selectionFor(region).enabledModelIds;
  if (!Array.isArray(enabled) || enabled.length === 0) return false;
  if (!catalog) return false;
  const known = new Set(catalog.current().map((model) => model.id));
  return !enabled.some((id) => known.has(id));
}

/**
 * Apply the user's selection to one gateway's catalog, after checking it
 * against the roster that gateway actually has.
 *
 * Called when settings change, when a runtime is built, and after the roster is
 * (re)read, because a selection is only meaningful relative to the current
 * catalog: a re-read can retire every id a saved selection names.
 */
function applyEffectiveSelection(region, runtime) {
  const target = runtime ?? runtimes.get(regionOfKey(region));
  if (!target) return;
  target.catalog.applySelection(effectiveSelectionFor(region, target.catalog));
  if (selectionStale(region, target.catalog)) {
    target.lastWarning = "the saved model selection no longer matches the live model list; showing every model";
  }
}

// ------------------------------------------------------------------ network

/** The port one gateway prefers, and the only address it ever publishes. */
function preferredPort(region) {
  const port = REGION_PORTS[region];
  return typeof port === "number" ? port : 0;
}

/** A pause, for the retry loop below. */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Try to bind one specific port once.
 *
 * Resolves the port on success and 0 on failure, so the caller can decide
 * whether to wait and try again instead of moving on immediately.
 */
function tryPort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => {
      try {
        server.close();
      } catch {
        /* already gone */
      }
      resolve(0);
    });
    server.listen(port, "127.0.0.1", () => {
      const bound = server.address().port;
      server.close(() => resolve(bound));
    });
  });
}

/**
 * Ask the OS for one of the gateway's preferred ports.
 *
 * Each candidate is retried a few times before the next one is considered: a
 * port that is busy for a quarter of a second is the previous instance
 * shutting down, not a port this plugin has lost. Falling back on the first
 * refusal is what published a spare port and left the host on an address
 * nothing listens on.
 *
 * Resolves 0 when every candidate stays taken, which makes the shim fall back
 * to an ephemeral port: the models still work for this session, and the
 * declaration keeps naming the preferred port so the next run is correct.
 */
function reservePort(candidates) {
  const wanted = (Array.isArray(candidates) ? candidates : []).filter(
    (port) => typeof port === "number" && port > 0,
  );
  return (async () => {
    for (const port of wanted) {
      for (let attempt = 0; attempt < PORT_RESERVE_ATTEMPTS; attempt += 1) {
        const bound = await tryPort(port);
        if (bound !== 0) return bound;
        if (attempt < PORT_RESERVE_ATTEMPTS - 1) await delay(PORT_RESERVE_INTERVAL_MS);
      }
    }
    return 0;
  })();
}

// -------------------------------------------------------------- declaration

/** Thinking levels the picker may offer for one model, in host order. */
function thinkingLevelsFor(model) {
  const declared = Array.isArray(model.supportedEfforts)
    ? model.supportedEfforts.filter((level) => HOST_THINKING_LEVELS.includes(level))
    : [];
  if (declared.length === 0) return ["off"];
  // Only a declared set is a choice; "off" is offered only when the upstream
  // says thinking can be switched off. Otherwise the lowest declared level is
  // the floor and an invented "off" would promise a control that does nothing.
  const wanted = model.canDisableThinking === true ? ["off", ...declared] : declared;
  return HOST_THINKING_LEVELS.filter((level) => wanted.includes(level));
}

/** Model label as the picker shows it: name plus the upstream cost suffix. */
function modelDisplayName(model) {
  const label = model.name || model.id;
  if (typeof model.multiplier !== "number" || !Number.isFinite(model.multiplier)) return label;
  return label + " · x" + model.multiplier.toFixed(2);
}

/**
 * The label the picker shows.
 *
 * An alias the user typed is used verbatim: it is a name, not a catalog row, so
 * appending a cost suffix to it would edit the user's own text back. Without an
 * alias the catalog name keeps its suffix, which is the existing behaviour.
 */
function modelLabel(model) {
  const alias = typeof model.alias === "string" ? model.alias.trim() : "";
  return alias === "" ? modelDisplayName(model) : alias;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.round(number);
}

/** The models one gateway publishes, after the user's selection is applied. */
function declarationModels(region) {
  const catalog = runtimes.get(region)?.catalog;
  if (!catalog) return [];
  const models = [];
  const seen = new Set();
  for (const model of catalog.visible()) {
    const id = String(model.id || "").trim();
    if (id === "" || id.length > 256 || seen.has(id)) continue;
    seen.add(id);
    const thinkingLevels = thinkingLevelsFor(model);
    const entry = {
      id,
      name: modelLabel(model),
      contextWindow: positiveInteger(model.contextWindow, CONSERVATIVE_CONTEXT_WINDOW),
      maxTokens: positiveInteger(model.maxOutputTokens, DEFAULT_MAX_TOKENS),
      supportsImages: model.supportsImages === true,
      ...thinkingLevels.length > 1 ? { thinkingLevels } : {},
    };
    // A default that is not one of the offered levels is dropped rather than
    // published: the host stores it verbatim and the picker would then open on
    // a level it does not list.
    if (typeof model.defaultThinkingLevel === "string"
      && thinkingLevels.includes(model.defaultThinkingLevel)) {
      entry.defaultThinkingLevel = model.defaultThinkingLevel;
    }
    models.push(entry);
    if (models.length >= MAX_MODELS) break;
  }
  return models;
}

/**
 * One provider declaration, as the manifest carries it.
 *
 * The base URL is the gateway's PREFERRED port, never the port this run
 * happened to bind. The host reads the manifest before the plugin process
 * starts, so a declaration that echoed the live binding would be one run
 * stale: after a fallback run it would publish a spare port, and the host
 * keeps that address until something makes it re-read the manifest. Naming
 * the preferred port keeps the declaration describing the next run, which is
 * the only run the host can act on. `statusDocument` reports the mismatch
 * loudly when a run really did end up elsewhere.
 */
function descriptorFor(region) {
  const runtime = runtimes.get(region);
  const preferred = preferredPort(region);
  const baseUrl = preferred > 0
    ? "http://127.0.0.1:" + preferred + "/v1"
    : runtime?.baseUrl || PLACEHOLDER_BASE_URL;
  return {
    id: PROVIDER_ID_BY_REGION[region],
    name: PROVIDER_NAME_BY_REGION[region],
    baseUrl,
    apiStyle: "chat_completions",
    authKind: "none",
    models: declarationModels(region),
  };
}

/**
 * Write the current provider declaration into this plugin's own manifest.
 *
 * The host reads `contributes.providers` from the package manifest when the
 * plugin loads, and that is the only way a plugin can put a provider into the
 * model list. This is a local edit inside the plugin's own package; nothing
 * outside it is touched, and it only happens when the declaration changed.
 */
function writeDeclaration(descriptors) {
  if (packageRoot === "") return { ok: false, error: "the plugin package path is unknown" };
  const manifestPath = path.join(packageRoot, "manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    return { ok: false, error: "manifest.json could not be read: " + messageOf(error) };
  }
  const previous = JSON.stringify((manifest.contributes && manifest.contributes.providers) || []);
  const next = JSON.stringify(descriptors);
  if (previous === next) return { ok: true, changed: false, path: manifestPath };
  manifest.contributes = manifest.contributes || {};
  manifest.contributes.providers = descriptors;
  const temporary = manifestPath + ".tmp";
  try {
    fs.writeFileSync(temporary, JSON.stringify(manifest, null, 2) + "\n", "utf8");
    fs.renameSync(temporary, manifestPath);
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      /* nothing to clean up */
    }
    return { ok: false, error: "manifest.json could not be written: " + messageOf(error) };
  }
  pendingHostReload = true;
  return { ok: true, changed: true, path: manifestPath };
}

/** Result of the last declaration write, for the panel footer. */
const runtimeState = { write: { ok: true, changed: false, path: "" } };

/**
 * Cache for the auxiliary per-account probes (credits, check-in).
 *
 * Keyed by account id. A panel open reads this cache and schedules the upstream
 * calls behind it, instead of blocking the first paint on 2 calls per account.
 */
const probeCache = new Map();

/**
 * Publish every gateway that is actually usable.
 *
 * The host rejects a provider declaration with an empty model list AND rejects
 * the whole manifest with it, which would take the plugin down. A gateway that
 * is signed out, unreachable or still starting is therefore left out; the host
 * removes the provider row of a plugin that no longer declares it, which is
 * also how a signed-out edition disappears from the picker.
 */
function syncDeclaration() {
  const publishable = REGIONS.filter((region) => {
    const runtime = runtimes.get(region);
    return runtime && runtime.signedIn && declarationModels(region).length > 0;
  });
  // A run in which nothing connected must not erase a declaration an earlier
  // successful run wrote: a transient failure would otherwise strip a model
  // list the user is already using.
  if (publishable.length === 0) {
    const skipped = {
      ok: true,
      changed: false,
      skipped: "no gateway is connected yet; the declaration is left as it was",
      path: runtimeState.write.path,
    };
    runtimeState.write = skipped;
    return skipped;
  }
  const result = writeDeclaration(publishable.map(descriptorFor));
  runtimeState.write = result;
  return result;
}

// ------------------------------------------------------------------ runtime

/**
 * Create one gateway's runtime: its own catalog and its own loopback endpoint.
 *
 * Each gateway is scoped to its own account slice of the pool, so a CN request
 * can never be served by a global account and vice versa - the two gateways are
 * not interchangeable - and a failing gateway cannot take the other one down.
 */
async function createRuntime(region) {
  const runtime = {
    region,
    baseUrl: PLACEHOLDER_BASE_URL,
    catalog: new WorkBuddyCatalog(),
    signedIn: false,
    account: null,
    lastError: "",
    lastWarning: "",
    portFallback: false,
    connectedAtMs: 0,
    connecting: null,
    timer: null,
    catalogFetchedAtMs: 0,
  };
  applyEffectiveSelection(region, runtime);
  // The preferred port is reserved before the listener is created, so a run
  // that can have it does have it - which is what keeps the address in the
  // manifest true.
  const preferred = preferredPort(region);
  const bound = await reservePort(preferred > 0 ? [preferred] : []);
  // A port of 0 hands the shim an ephemeral port: the gateway still works this
  // session, but it is no longer the address the manifest names, so the state
  // is recorded rather than hidden.
  runtime.portFallback = bound === 0;
  if (runtime.portFallback) {
    log("warn", "[" + region + "] preferred port " + preferred + " is held by another process; " +
      "serving this session on an ephemeral port");
  }
  runtime.shim = createWorkBuddyShim({
    pool: core.pool,
    client: core.client,
    catalog: runtime.catalog,
    region,
    port: bound,
    logger: {
      info: (message) => log("info", "[" + region + "] " + message),
      warn: (message) => log("warn", "[" + region + "] " + message),
      error: (message) => log("error", "[" + region + "] " + message),
    },
  });
  await runtime.shim.ready;
  runtime.baseUrl = runtime.shim.baseUrl() + "/v1";
  return runtime;
}

function stopRuntime(runtime) {
  if (runtime.timer) {
    clearInterval(runtime.timer);
    runtime.timer = null;
  }
  if (runtime.shim) runtime.shim.close().catch(() => {});
  runtime.signedIn = false;
}

/**
 * Bring one gateway online: seed its catalog from that gateway's own account.
 *
 * The catalog is per gateway because the two do not advertise the same roster;
 * seeding both from one account showed a CN list on the international
 * provider. A gateway with no account keeps its static fallback, which is what
 * keeps its model list non-empty (and therefore publishable) before any
 * upstream call succeeds.
 */
async function connect(runtime, force) {
  runtime.lastError = "";
  runtime.lastWarning = "";
  const account = core.pool.list(runtime.region)[0];
  if (account === undefined) {
    runtime.signedIn = false;
    runtime.account = null;
    runtime.lastError = "no " + runtime.region + " WorkBuddy sign-in found";
    // Mark this gateway as settled even though nothing was fetched: a gateway
    // with no account can never become "fresh" on its own, and without this the
    // panel would poll to its attempt cap every time it opens for a pool that
    // is legitimately empty on one side.
    runtime.catalogFetchedAtMs = Date.now();
    return false;
  }
  runtime.signedIn = true;
  runtime.account = {
    label: account.label,
    nickname: account.credential.nickname,
    domain: account.credential.domain,
    expiresAtMs: account.credential.expiresAtMs,
  };
  // The roster is only re-read when it is actually stale. Re-fetching it on
  // every connect is a large part of why opening the panel felt slow, and the
  // list does not move minute to minute; `xd.rescan` and the timer force it.
  if (force === true || !catalogFresh(runtime)) {
    try {
      const models = await core.client.fetchModels(
        account.credential,
        AbortSignal.timeout(MODELS_TIMEOUT_MS),
      );
      runtime.catalog.updateFromUpstream(models);
      runtime.catalogFetchedAtMs = Date.now();
    } catch (error) {
      runtime.lastWarning = "model list failed: " + messageOf(error);
      // Keep the previous roster (or the static fallback) but still honour the
      // saved selection, so this gateway's endpoint keeps publishing exactly
      // the models the user chose even while the upstream is unreachable.
      runtime.catalogFetchedAtMs = Date.now();
    }
  }
  // Re-check the saved selection against the roster now in force: a re-read may
  // have retired ids it names, and a failure leaves the previous roster up.
  applyEffectiveSelection(runtime.region, runtime);
  runtime.connectedAtMs = Date.now();
  if (runtime.timer === null) {
    runtime.timer = setInterval(() => {
      refreshRuntime(runtime, "timer", true).catch((error) => log("warn", "scheduled refresh failed: " + messageOf(error)));
    }, refreshMinutes() * 60 * 1000);
  }
  return true;
}

/** True while one gateway's model roster is still inside its refresh window. */
function catalogFresh(runtime) {
  if (runtime.catalogFetchedAtMs === 0) return false;
  return Date.now() - runtime.catalogFetchedAtMs < refreshMinutes() * 60 * 1000;
}

/**
 * Whether the panel should come back for a refreshed document.
 *
 * True while a pass is running (its result has not been rendered yet) and while
 * anything it would fill in is missing or stale: a stale model roster, or
 * billing probes that are cold or past their TTL. Scheduling is de-duplicated
 * separately in `scheduleRefresh`, so reporting an in-flight pass here is safe
 * and is what keeps the poll alive until the numbers actually land.
 */
function refreshNeeded() {
  if (refreshInflight !== null) return true;
  for (const runtime of runtimes.values()) {
    if (runtime.connecting) return true;
    if (!catalogFresh(runtime)) return true;
  }
  return probesStale();
}

/** True while any pool account's cached billing answers are missing or old. */
function probesStale() {
  const now = Date.now();
  for (const account of core.pool.list()) {
    const cached = probeCache.get(account.id);
    if (cached === undefined || now - cached.atMs >= PROBE_TTL_MS) return true;
  }
  return false;
}

/**
 * Run a refresh behind the current turn, at most one at a time.
 *
 * Deferring it to the next tick is what keeps a panel open cheap: the caller
 * answers from cache first and the detection lands behind the rendered page.
 * This is the *background* flavour, so it respects each gateway's refresh
 * window instead of forcing a roster fetch that load already did.
 */
function scheduleRefresh(reason) {
  if (refreshTimer !== null || refreshInflight !== null) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    refreshAll(reason, false).catch((error) => log("warn", "background refresh failed: " + messageOf(error)));
  }, 0);
  if (typeof refreshTimer.unref === "function") refreshTimer.unref();
}

async function refreshRuntime(runtime, reason, force) {
  if (runtime.connecting) return runtime.connecting;
  runtime.connecting = (async () => {
    try {
      const ok = await connect(runtime, force === true);
      return { ok, reason };
    } finally {
      runtime.connecting = null;
    }
  })();
  return runtime.connecting;
}

/**
 * Re-read settings, re-apply them, re-seed every gateway's catalog, then
 * republish. `force` decides whether each gateway's roster is refetched even
 * inside its refresh window: `true` for a user-invoked pass, `false` for the
 * background one that follows a panel open.
 *
 * Concurrent passes are collapsed: the background pass would otherwise
 * duplicate the work of the pass a Refresh click just started.
 */
async function refreshAll(reason, force) {
  const wantForce = force === true;
  // Collapse onto an in-flight pass, but never let a background pass satisfy a
  // forced one: a Refresh click must still refetch the rosters.
  if (refreshInflight !== null) {
    const current = refreshInflight;
    if (!wantForce || current.force) return await current.promise;
    await current.promise.catch(() => {});
  }
  const run = async () => {
    settings = await loadSettings();
    applySettingsToCore();
    for (const runtime of runtimes.values()) {
      await refreshRuntime(runtime, reason, wantForce);
    }
    syncDeclaration();
    return await statusDocument({ allowNetwork: true });
  };
  const entry = { force: wantForce, promise: null };
  entry.promise = run();
  refreshInflight = entry;
  try {
    return await entry.promise;
  } finally {
    if (refreshInflight === entry) refreshInflight = null;
  }
}

/** Push the settings that affect discovery, cooldown and the picker. */
function applySettingsToCore() {
  const authFile = typeof settings.authFile === "string" ? settings.authFile.trim() : "";
  core.pool.applyConfig({
    ...authFile === "" ? {} : { authDirs: [path.dirname(authFile)] },
    cooldownMs: cooldownMs(),
    distribution: distributionSetting(),
  });
  for (const region of REGIONS) {
    applyEffectiveSelection(region);
  }
}

// ------------------------------------------------------------------- status

/** Redact token-shaped content before it crosses to the panel. */
function safeMessage(error) {
  return messageOf(error)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[redacted token]")
    .replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, "$1[redacted]")
    .slice(0, 500);
}

/**
 * One account's credits and check-in, served from cache while it is fresh.
 *
 * `allowNetwork: false` never waits on the upstream: a cold entry reports
 * `pending` so the panel can say it is still reading, and the caller refreshes
 * behind the first paint.
 */
async function accountProbe(account, allowNetwork) {
  const cached = probeCache.get(account.id);
  if (allowNetwork !== true) {
    return cached === undefined ? { pending: true } : cached.value;
  }
  if (cached !== undefined && Date.now() - cached.atMs < PROBE_TTL_MS) return cached.value;
  const value = {};
  const [creditsResult, checkinResult] = await Promise.allSettled([
    core.client.fetchCredits(account.credential),
    core.client.fetchCheckinStatus(account.credential),
  ]);
  if (creditsResult.status === 'fulfilled') {
    const credits = creditsResult.value;
    value.credits = {
      ...credits.total === undefined ? {} : { total: credits.total },
      packages: (credits.packages || []).map((pack) => ({
        packageName: pack.packageName,
        ...pack.remain === undefined ? {} : { remain: pack.remain },
        ...pack.size === undefined ? {} : { size: pack.size },
        ...pack.monthly === undefined ? {} : { monthly: pack.monthly },
        ...pack.cycleRefreshMs === undefined ? {} : { cycleRefreshMs: pack.cycleRefreshMs },
        ...pack.expiresAtMs === undefined ? {} : { expiresAtMs: pack.expiresAtMs },
      })),
      ...credits.expiringSoon === undefined ? {} : { expiringSoon: credits.expiringSoon },
      ...credits.nearestExpiryMs === undefined ? {} : { nearestExpiryMs: credits.nearestExpiryMs },
    };
  } else {
    value.creditsError = safeMessage(creditsResult.reason);
  }
  if (checkinResult.status === 'fulfilled') {
    const checkin = checkinResult.value;
    value.checkin = {
      active: checkin.active,
      todayCheckedIn: checkin.todayCheckedIn,
      streakDays: checkin.streakDays,
      dailyCredit: checkin.dailyCredit,
      todayCredit: checkin.todayCredit,
      isStreakDay: checkin.isStreakDay,
      nextStreakDay: checkin.nextStreakDay,
      streakBonusCredit: checkin.streakBonusCredit,
    };
  } else {
    value.checkinError = safeMessage(checkinResult.reason);
  }
  probeCache.set(account.id, { atMs: Date.now(), value });
  return value;
}

async function statusDocument(options) {
  // `allowNetwork: false` answers from the caches only, so a panel open paints
  // immediately; the caller schedules the real refresh behind it.
  const allowNetwork = options?.allowNetwork === true;
  const now = Date.now();
  const accounts = [];
  const models = [];
  const selectionByRegion = {};
  /** region -> the account `pool.acquire` would pick next, for the "next up" row. */
  const runtimeNextUpId = new Map();
  /** Gateways whose stored selection names models the roster no longer has. */
  const staleSelectionRegions = [];

  for (const region of REGIONS) {
    // Report the selection actually in force, not the raw stored one: if the
    // stored ids no longer exist upstream, the panel would otherwise open with
    // every model shown as disabled while the plugin is really serving all of
    // them.
    selectionByRegion[region] = effectiveSelectionFor(region, runtimes.get(region)?.catalog);
    if (selectionStale(region, runtimes.get(region)?.catalog)) staleSelectionRegions.push(region);
    // "Next up" is the first account in discovery order that is not cooling,
    // which is what `pool.acquire` hands the very next request under the
    // priority distribution the pool ships with.
    const nextUp = core.pool.list(region).find((account) => account.cooldownUntilMs <= now);
    runtimeNextUpId.set(region, nextUp === undefined ? undefined : nextUp.id);

    for (const account of core.pool.list(region)) {
      const cooling = account.cooldownUntilMs > now;
      const modelCooldowns = Object.entries(account.modelCooldowns)
        .filter(([, until]) => until > now)
        .sort((a, b) => a[1] - b[1])
        .map(([modelId, until]) => ({ modelId, until: new Date(until).toISOString() }));
      const row = {
        id: account.id,
        label: account.label,
        ...account.credential.nickname === undefined ? {} : { nickname: account.credential.nickname },
        region,
        domain: account.credential.domain,
        ...account.credential.expiresAtMs === 0
          ? {}
          : { expiresAt: new Date(account.credential.expiresAtMs).toISOString() },
        cooling,
        ...cooling ? { cooldownUntil: new Date(account.cooldownUntilMs).toISOString() } : {},
        ...modelCooldowns.length === 0 ? {} : { modelCooldowns },
        rateLimitHits: account.rateLimitHits,
        active: runtimeNextUpId.get(region) === account.id,
      };
      // Credits and check-in are auxiliary: a failing query degrades to an
      // error field instead of failing the whole document, and a cold cache on
      // the fast path renders as "still reading" rather than a stall.
      if (!cooling) {
        const probe = await accountProbe(account, allowNetwork);
        if (probe.pending === true) {
          row.probePending = true;
        } else {
          if (probe.credits !== undefined) row.credits = probe.credits;
          if (probe.creditsError !== undefined) row.creditsError = probe.creditsError;
          if (probe.checkin !== undefined) row.checkin = probe.checkin;
          if (probe.checkinError !== undefined) row.checkinError = probe.checkinError;
        }
      }
      accounts.push(row);
    }

    const catalog = runtimes.get(region)?.catalog;
    if (catalog) {
      const selection = selectionFor(region);
      const enabled = selection.enabledModelIds;
      const overrides = selection.overrides || {};
      for (const model of catalog.current()) {
        const override = overrides[model.id];
        const effective = applyOverride(model, override);
        const levels = thinkingLevelsFor(effective);
        models.push({
          id: model.id,
          // The catalog name and the user's alias travel separately: the editor
          // shows the alias in its own field and the catalog name as that
          // field's placeholder, so an empty alias must not read as a rename.
          name: model.name,
          ...effective.alias === undefined ? {} : { alias: effective.alias },
          region,
          ...model.multiplier === undefined ? {} : { multiplier: model.multiplier },
          ...model.tags === undefined ? {} : { tags: model.tags },
          supportsImages: effective.supportsImages,
          contextWindow: effective.contextWindow,
          maxOutputTokens: effective.maxOutputTokens,
          // The catalog's own numbers, so the editor can offer a reset and mark
          // a field the user has changed.
          nativeContextWindow: model.contextWindow,
          nativeMaxOutputTokens: model.maxOutputTokens,
          nativeSupportsImages: model.supportsImages,
          nativeThinkingLevels: model.supportedEfforts === undefined || model.supportedEfforts.length === 0
            ? []
            : [...model.supportedEfforts],
          thinkingLevels: levels,
          ...effective.defaultThinkingLevel === undefined
            ? {}
            : { defaultThinkingLevel: effective.defaultThinkingLevel },
          advanced: hasOverride(override),
          enabled: enabled === undefined || enabled.includes(model.id),
        });
      }
    }
  }

  // Both gateways are always offered, mirroring how the plugin registers its
  // two providers. An empty gateway reads as "no account signed in here yet",
  // which is information the user wants, rather than a tab that only appears
  // after they have already done the work.
  const withAccounts = REGIONS.filter((region) => core.pool.list(region).length > 0);
  return {
    ok: accounts.some((account) => !account.cooling),
    regions: [...REGIONS],
    regionsWithAccounts: withAccounts,
    enabled: settings.enabled !== false,
    pluginVersion: pluginVersion(),
    distribution: distributionSetting(),
    declaration: runtimeState.write,
    declaration: runtimeState.write,
    hostReloadRequired: pendingHostReload,
    // Kept separate from `hostReloadRequired`: that flag tracks a declaration
    // the host has not picked up yet, this one tracks an address the host is
    // actively failing to reach.
    addressDrift: addressDrift(),
    portFallback: REGIONS.some((region) => runtimes.get(region)?.portFallback === true),
    shim: shimInfo("cn"),
    refreshMinutes: refreshMinutes(),
    accounts,
    models,
    selectionByRegion,
    staleSelectionRegions,
    updatedAt: Date.now(),
  };
}

function pluginVersion() {
  try {
    const own = pi.plugin.getManifest();
    if (own && typeof own.version === "string" && own.version !== "") return own.version;
  } catch {
    /* the host may not expose the manifest in every context */
  }
  return PLUGIN_VERSION;
}

/** The loopback origin of one gateway, or a not-running marker. */
function shimInfo(region) {
  const runtime = runtimes.get(region);
  try {
    if (!runtime || !runtime.shim) return { running: false };
    const port = runtime.shim.port();
    if (port === 0) return { running: false };
    return { running: true, baseUrl: runtime.shim.baseUrl() + "/v1" };
  } catch {
    return { running: false };
  }
}

/** True when this plugin's manifest still declares that gateway's provider. */
/** The baseUrl this plugin's manifest currently publishes for one gateway. */
function declaredBaseUrl(region) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "manifest.json"), "utf8"));
    const providers = (manifest.contributes && manifest.contributes.providers) || [];
    const entry = providers.find((provider) => provider.id === PROVIDER_ID_BY_REGION[region]);
    return entry === undefined || typeof entry.baseUrl !== "string" ? undefined : entry.baseUrl;
  } catch {
    return undefined;
  }
}

function manifestDeclares(region) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "manifest.json"), "utf8"));
    const providers = (manifest.contributes && manifest.contributes.providers) || [];
    return providers.some((provider) => provider.id === PROVIDER_ID_BY_REGION[region]);
  } catch {
    return false;
  }
}

/**
 * True when the address the manifest publishes is not the address this run
 * bound.
 *
 * That state is exactly `net::ERR_CONNECTION_REFUSED`: the host caches the
 * published address per provider row and only re-reads the manifest on
 * startup, on enable/disable, or on an uninstall (ADR 0259 §9). Detecting it
 * lets the panel name the fix - turn the plugin off and on again, or restart
 * the app - instead of leaving the user with a silent connection failure.
 *
 * A run that fell back to an ephemeral port counts as drift even though the
 * declaration still names the preferred port, because until the plugin is
 * reloaded nothing answers on the published address.
 */
function addressDrift() {
  for (const region of REGIONS) {
    if (runtimes.get(region)?.portFallback === true) return true;
    const published = declaredBaseUrl(region);
    const bound = shimInfo(region).baseUrl;
    if (published === undefined || bound === undefined) continue;
    if (published !== bound) return true;
  }
  return false;
}


/** A readable report of everything that has to hold for a chat to reach upstream. */
async function doctor() {
  const status = await statusDocument({ allowNetwork: true });
  const findings = [];
  const push = (id, ok, detail) => findings.push({ id, ok, detail });

  push("plugin-enabled", status.enabled, status.enabled ? "enabled" : "disabled in plugin settings");
  push(
    "accounts",
    status.accounts.length > 0,
    status.accounts.length === 0
      ? "no WorkBuddy sign-in found; sign in to the desktop app, then detect accounts again"
      : status.accounts.length + " account(s): " + status.accounts.map((account) => account.label).join(", "),
  );
  const healthy = status.accounts.filter((account) => !account.cooling).length;
  push("rotation", healthy > 0, healthy + " of " + status.accounts.length + " account(s) can serve a request now");

  for (const region of REGIONS) {
    const runtime = runtimes.get(region);
    const label = PROVIDER_NAME_BY_REGION[region];
    const info = shimInfo(region);
    const regionModels = status.models.filter((model) => model.region === region);
    const declared = manifestDeclares(region);
    push(label + ": endpoint", info.running, info.running ? "listening on " + info.baseUrl : "not listening");
    push(label + ": models", regionModels.length > 0, regionModels.length + " model(s) in the catalog");
    push(
      label + ": declared",
      declared,
      declared
        ? "published in this plugin's manifest"
        : runtime?.lastError || runtime?.lastWarning || "this gateway is not published yet",
    );
  }

  // A provider row is written from the manifest the host read at enable time.
  // The host keeps using that address until it next re-reads the manifest -
  // startup, enable/disable, or an uninstall (ADR 0259 §9) - which is exactly
  // what makes requests fail with ERR_CONNECTION_REFUSED when the address the
  // manifest names is not the one this run bound. Comparing the two turns that
  // silent failure into a named finding with the one action that clears it.
  for (const region of REGIONS) {
    const runtime = runtimes.get(region);
    const published = declaredBaseUrl(region);
    const bound = runtime?.baseUrl;
    if (published === undefined || bound === undefined) continue;
    const fallback = runtime?.portFallback === true;
    if (published === bound && !fallback) {
      push(
        PROVIDER_NAME_BY_REGION[region] + ": published address",
        true,
        "matches the endpoint this gateway bound (" + bound + ")",
      );
      continue;
    }
    const detail = fallback
      ? "port " + preferredPort(region) + " is held by another process, so this session serves " +
        bound + " - free that port (usually a leftover plugin process), then turn this plugin " +
        "off and on again"
      : "the manifest publishes " + published + " but this gateway is on " + bound +
        " - turn this plugin off and on (or restart PI-Desktop) so the host re-reads the manifest";
    push(PROVIDER_NAME_BY_REGION[region] + ": published address", false, detail);
  }

  push(
    "declaration-written",
    runtimeState.write.ok === true,
    runtimeState.write.ok !== true
      ? String(runtimeState.write.error)
      : runtimeState.write.changed
        ? "the model list was just updated at " + String(runtimeState.write.path) + " (the host discovers it from this gateway's /v1/models)"
        : String(runtimeState.write.skipped || "up to date at " + String(runtimeState.write.path)),
  );

  const ok = findings.every((finding) => finding.ok);
  const report = [
    "pi-desktop-workbuddy doctor",
    new Date().toISOString(),
    "overall: " + (ok ? "PASS" : "FAIL"),
    "",
    ...findings.map((finding) => (finding.ok ? "PASS  " : "FAIL  ") + finding.id + " - " + finding.detail),
    "",
  ].join("\n");
  let file = "";
  if (dataPath !== "") {
    try {
      file = path.join(dataPath, "doctor.txt");
      fs.writeFileSync(file, report, "utf8");
    } catch {
      file = "";
    }
  }
  return { ok, findings, report, file, status };
}

// -------------------------------------------------------------------- panel

function panelError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Validate an untrusted selection payload.
 *
 * Returns undefined for anything malformed so nothing partial is written. An
 * empty array is meaningful (`enabledModelIds: []` disables every model, which
 * the panel refuses to save) so it is preserved rather than treated as absent.
 */
function parseSelection(body) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const out = {};
  const enabled = body.enabledModelIds;
  if (enabled !== undefined) {
    if (!Array.isArray(enabled)) return undefined;
    const ids = [];
    for (const entry of enabled) {
      if (typeof entry !== "string" || entry === "") return undefined;
      ids.push(entry);
    }
    out.enabledModelIds = ids;
  }
  const overrides = body.overrides;
  if (overrides !== undefined) {
    if (typeof overrides !== "object" || overrides === null || Array.isArray(overrides)) return undefined;
    const map = {};
    for (const [id, raw] of Object.entries(overrides)) {
      if (typeof id !== "string" || id === "") return undefined;
      const parsed = parseOverride(raw);
      if (parsed === undefined) return undefined;
      // A field left at its catalog value is stored as absent, so the settings
      // file records only what the user actually changed.
      if (Object.keys(parsed).length > 0) map[id] = parsed;
    }
    out.overrides = map;
  }
  return out;
}

/**
 * Validate one model's override.
 *
 * Every field is optional, and a value that is present must be usable: the host
 * rejects a zero window, and a thinking level outside the host's ladder would be
 * dropped there anyway. Rejecting here means the panel reports a failure instead
 * of a save that quietly did nothing.
 */
function parseOverride(raw) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const out = {};
  if (raw.alias !== undefined) {
    if (typeof raw.alias !== "string") return undefined;
    const alias = raw.alias.trim();
    if (alias.length > 120) return undefined;
    out.alias = alias;
  }
  for (const key of ["contextWindow", "maxOutputTokens"]) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return undefined;
    out[key] = value;
  }
  if (raw.supportsImages !== undefined) {
    if (typeof raw.supportsImages !== "boolean") return undefined;
    out.supportsImages = raw.supportsImages;
  }
  if (raw.thinkingLevels !== undefined) {
    if (!Array.isArray(raw.thinkingLevels)) return undefined;
    const levels = [];
    for (const level of raw.thinkingLevels) {
      if (typeof level !== "string" || !HOST_THINKING_LEVELS.includes(level)) return undefined;
      if (!levels.includes(level)) levels.push(level);
    }
    if (levels.length > 0) out.thinkingLevels = levels;
  }
  if (raw.defaultThinkingLevel !== undefined) {
    if (typeof raw.defaultThinkingLevel !== "string") return undefined;
    if (!HOST_THINKING_LEVELS.includes(raw.defaultThinkingLevel)) return undefined;
    out.defaultThinkingLevel = raw.defaultThinkingLevel;
  }
  return out;
}

async function onPanelInvoke(channel, payload) {
  switch (channel) {
    /**
     * Opening the panel.
     *
     * The old implementation ran the whole detection pass inline - a model
     * roster fetch per gateway plus two billing calls per account - before it
     * could answer, so the panel stayed blank for seconds every time it opened.
     * Now the cached document is returned immediately and the detection runs
     * behind it; `refreshing` tells the panel to ask again shortly. `wait: true`
     * (the Refresh button) still resolves on a fully refreshed document.
     */
    case "xd.state": {
      if (payload?.wait === true) {
        const refreshed = await refreshAll("panel");
        return { ...refreshed, refreshing: false };
      }
      const document = await statusDocument({ allowNetwork: false });
      const refreshing = refreshNeeded();
      if (refreshing) scheduleRefresh("panel");
      return { ...document, refreshing };
    }

    /**
     * "Detect accounts again": a deliberate, user-invoked re-read, so every
     * gateway's roster is refetched even inside its refresh window.
     */
    case "xd.rescan":
      await core.pool.scan();
      for (const runtime of runtimes.values()) await refreshRuntime(runtime, "rescan", true);
      syncDeclaration();
      return await statusDocument({ allowNetwork: true });

    case "xd.resetCooldowns":
      core.pool.resetCooldowns();
      return await statusDocument({ allowNetwork: false });

    // The only mutating channel that spends anything. Guarded by an explicit
    // accountId and a pre-claim status re-check, so a double click or a stale
    // panel can never collect a reward twice.
    case "xd.checkin": {
      const accountId = typeof payload?.accountId === "string" ? payload.accountId : "";
      if (accountId === "") throw panelError("accountId is required", "INVALID");
      const account = core.pool.list().find((item) => item.id === accountId);
      if (account === undefined) throw panelError("unknown account", "NOT_FOUND");
      const before = await core.client.fetchCheckinStatus(account.credential);
      if (before.todayCheckedIn) {
        probeCache.delete(accountId);
        return {
          state: await statusDocument({ allowNetwork: true }),
          result: { credit: 0, streakDays: before.streakDays, isStreakDay: before.isStreakDay },
        };
      }
      if (!before.active) throw panelError("check-in is not available for this account", "INACTIVE");
      const claim = await core.client.claimDailyCheckin(account.credential);
      // The claim changed this account's balance, so its cached probe is stale.
      probeCache.delete(accountId);
      return { state: await statusDocument({ allowNetwork: true }), result: claim };
    }

    /**
     * Save the model selection for one gateway.
     *
     * The write result is checked rather than assumed: reporting success while
     * nothing was stored is exactly how "saving does nothing" presents itself.
     * The selection is applied to the catalog and republished before answering,
     * so the panel reflects what will be in force from now on.
     */
    case "xd.saveModels": {
      const region = regionOfKey(payload?.region);
      const selection = parseSelection(payload?.selection);
      if (selection === undefined) throw panelError("invalid selection payload", "INVALID");
      const all = { ...(settings.modelSelection || {}) };
      all[region] = selection;
      const stored = await saveSettings({ modelSelection: all });
      if (stored !== true) {
        throw panelError("the selection could not be written to the plugin settings file", "SAVE_FAILED");
      }
      applyEffectiveSelection(region);
      syncDeclaration();
      return await statusDocument({ allowNetwork: false });
    }

    case "xd.distribution": {
      const next = payload?.distribution === "round-robin" ? "round-robin" : "priority";
      const stored = await saveSettings({ distribution: next });
      if (stored !== true) {
        throw panelError("the usage mode could not be written to the plugin settings file", "SAVE_FAILED");
      }
      core.pool.applyConfig({ distribution: next });
      return await statusDocument({ allowNetwork: false });
    }

    case "xd.doctor":
      return await doctor();

    default:
      throw panelError("unsupported panel channel: " + String(channel), "UNSUPPORTED");
  }
}

// ---------------------------------------------------------------- lifecycle

async function registerCommands() {
  const register = async (id, title, keywords, run) => {
    try {
      await pi.commands.register({ id, title, category: "Productivity", keywords, run });
    } catch (error) {
      log("warn", "could not register command " + id + ": " + messageOf(error));
    }
  };
  await register(COMMAND_OPEN, "pi-desktop-workbuddy: Open Panel", ["workbuddy", "pool", "池", "模型"], async () => {
    await pi.ui.openPanel();
  });
  await register(COMMAND_RESCAN, "pi-desktop-workbuddy: Detect Accounts Again", ["workbuddy", "rescan", "重新检测"], async () => {
    const accounts = await core.pool.scan();
    // Forced, because the user asked for a fresh look: this is the one place a
    // roster refetch must not be skipped by the refresh window.
    for (const runtime of runtimes.values()) await refreshRuntime(runtime, "command", true);
    syncDeclaration();
    await pi.ui.showToast("pi-desktop-workbuddy - " + accounts.length + " account(s) in the pool", "info");
  });
  await register(COMMAND_RESET, "pi-desktop-workbuddy: Clear All Cooldowns", ["workbuddy", "cooldown", "清除冷却"], async () => {
    core.pool.resetCooldowns();
    await pi.ui.showToast("pi-desktop-workbuddy - all cooldowns cleared", "info");
  });
  await register(COMMAND_DOCTOR, "pi-desktop-workbuddy: Run Connection Check", ["workbuddy", "doctor", "诊断"], async () => {
    const result = await doctor();
    await pi.ui.showToast(
      result.ok ? "pi-desktop-workbuddy check passed" : "pi-desktop-workbuddy check found problems - see the panel",
      result.ok ? "info" : "warn",
    );
  });
  await register(COMMAND_CHECKIN, "pi-desktop-workbuddy: Daily Check-in (All Accounts)", ["workbuddy", "checkin", "签到"], async () => {
    let claimed = 0;
    for (const account of core.pool.list()) {
      try {
        const before = await core.client.fetchCheckinStatus(account.credential);
        if (!before.active || before.todayCheckedIn) continue;
        await core.client.claimDailyCheckin(account.credential);
        claimed += 1;
      } catch (error) {
        log("warn", "check-in failed for " + account.label + ": " + messageOf(error));
      }
    }
    await pi.ui.showToast("pi-desktop-workbuddy - checked in " + claimed + " account(s)", "info");
  });
}

/**
 * Bring the declaration up to date BEFORE the host can act on it.
 *
 * The host validates a plugin's manifest and only then spawns its process, so
 * anything written during onLoad is visible on the NEXT load. Publishing at the
 * earliest point the plugin runs means a restart is always enough, and the
 * panel says so when the declaration could not be written.
 *
 * Note this is the only place the roster is fetched during load: opening the
 * panel no longer triggers detection of its own.
 */
async function publishDeclarationEarly() {
  settings = await loadSettings();
  if (settings.enabled === false) return;
  applySettingsToCore();
  await core.pool.scan();
  for (const region of REGIONS) {
    if (!runtimes.has(region)) runtimes.set(region, await createRuntime(region));
  }
  for (const runtime of runtimes.values()) {
    try {
      await connect(runtime, true);
    } catch (error) {
      runtime.lastError = messageOf(error);
      log("warn", runtime.region + " failed to start during load: " + runtime.lastError);
    }
  }
  const written = syncDeclaration();
  if (written.ok !== true) log("warn", "declaration not written: " + String(written.error));
  else if (written.changed === true) log("info", "declaration updated at load time; " + String(written.path));
}

async function onServiceStart() {
  settings = await loadSettings();
  if (settings.enabled === false) {
    log("info", "plugin disabled in settings; the provider host stays down");
    return;
  }
  applySettingsToCore();
  for (const region of REGIONS) {
    if (!runtimes.has(region)) runtimes.set(region, await createRuntime(region));
  }
  for (const runtime of runtimes.values()) {
    try {
      // Skipped when onLoad already seeded a fresh roster moments ago; the
      // per-gateway timer takes over from there.
      await connect(runtime, !catalogFresh(runtime));
    } catch (error) {
      runtime.lastError = messageOf(error);
      log("warn", runtime.region + " failed to start: " + runtime.lastError);
    }
  }
  syncDeclaration();
  // Warm the auxiliary per-account caches now, so the first panel open can
  // answer from cache instead of waiting on billing detection.
  scheduleRefresh("service-start");
}

async function onServiceStop() {
  for (const runtime of runtimes.values()) stopRuntime(runtime);
}

async function onLoad() {
  settings = await loadSettings();
  try {
    packageRoot = __dirname;
  } catch {
    packageRoot = "";
  }
  try {
    dataPath = await pi.plugin.getDataPath();
  } catch (error) {
    dataPath = "";
    log("warn", "no plugin data path: " + messageOf(error));
  }
  adoptPreviousDataDir();
  // The client is built first because the pool refreshes tokens through it.
  core.client = new WorkBuddyUpstreamClient();
  core.pool = new WorkBuddyAccountPool({
    client: core.client,
    cooldownMs: cooldownMs(),
    distribution: distributionSetting(),
    logger: {
      info: (message) => log("info", message),
      warn: (message) => log("warn", message),
      error: (message) => log("error", message),
    },
  });
  await registerCommands();
  pi.services.register({ id: SERVICE_ID, start: onServiceStart, stop: onServiceStop });
  // The host pushes a settings document whenever the user edits this plugin in
  // its own settings UI. Without this listener those edits only took effect
  // after a full plugin reload.
  subscribeToHostSettings();
  await publishDeclarationEarly();
}

async function onUnload() {
  if (refreshTimer !== null) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  // Publish the current declaration one last time. The host reads the manifest
  // when it next loads the plugin, so writing here means a selection changed in
  // the host's settings UI reaches the picker on the very next enable instead
  // of needing a second round.
  try {
    syncDeclaration();
  } catch (error) {
    log("warn", "could not publish the declaration during unload: " + messageOf(error));
  }
  for (const runtime of runtimes.values()) stopRuntime(runtime);
  runtimes.clear();
  probeCache.clear();
  try {
    if (pi.events && typeof pi.events.off === "function" && settingsChangedHandler !== null) {
      pi.events.off("plugin:settingsChanged", settingsChangedHandler);
    }
  } catch (error) {
    log("warn", "could not unsubscribe from settings changes: " + messageOf(error));
  }
  settingsChangedHandler = null;
  try {
    await pi.commands.unregister(COMMAND_OPEN);
    await pi.commands.unregister(COMMAND_RESCAN);
    await pi.commands.unregister(COMMAND_RESET);
    await pi.commands.unregister(COMMAND_DOCTOR);
    await pi.commands.unregister(COMMAND_CHECKIN);
  } catch (error) {
    log("warn", "unregistering commands failed: " + messageOf(error));
  }
}

module.exports = {
  PLUGIN_ID,
  PLUGIN_VERSION,
  thinkingLevelsFor,
  modelDisplayName,
  descriptorFor,
  declarationModels,
  writeDeclaration,
  reservePort,
  preferredPort,
  addressDrift,
  messageOf,
  onLoad,
  onUnload,
  onServiceStart,
  onServiceStop,
  onPanelInvoke,
  statusDocument,
  doctor,
  saveSettings,
  catalogFresh,
  refreshNeeded,
  scheduleRefresh,
  onHostSettingsChanged,
  subscribeToHostSettings,
  shimInfo,
  selectionFor,
  probeCache,
};
