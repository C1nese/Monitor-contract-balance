const express = require("express");
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const app = express();
const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.join(__dirname, "data");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const MAINNET = { chainId: 1, name: "mainnet" };
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];
const ERC20_INTERFACE = new ethers.Interface(ERC20_ABI);

const DEFAULT_CONFIG = {
  rpcUrls: "https://ethereum-rpc.publicnode.com",
  rpcUrl: "https://ethereum-rpc.publicnode.com",
  tokenAddress: "0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d",
  walletAddress: "0x003Ca23Fd5F0ca87D01F6eC6CD14A8AE60c2b97D",
  thresholds: "6000000",
  threshold: "6000000",
  intervalSeconds: 5,
  notifyCooldownMinutes: 30,
  barkServer: "https://api.day.app",
  barkDeviceKey: "",
  barkGroup: "usd1-monitor",
  barkSound: "alarm",
  barkLevel: "timeSensitive",
  barkCall: false,
  barkVolume: "",
  barkIcon: "",
  barkUrl: "",
  barkClickUrl: "",
};
const FAST_RETRY_SECONDS = 10;
const RPC_PROBE_TIMEOUT_MS = 1800;
const RPC_RESELECT_INTERVAL_MS = 5 * 60 * 1000;
const SLOW_RPC_LATENCY_MS = 350;

let config = loadConfig();
let timer = null;
let monitorGeneration = 0;
let currentCheckPromise = null;
let providerCache = null;
let contractCache = null;
let tokenMetaCache = null;
let providerCacheKey = "";
let contractCacheKey = "";

const state = {
  initializedAt: new Date().toISOString(),
  isChecking: false,
  lastCheckAt: null,
  lastSuccessAt: null,
  lastError: null,
  consecutiveFailures: 0,
  nextRetryAt: null,
  connectionStatus: "idle",
  latest: null,
  lastNotificationAt: null,
  lastNotificationMessage: null,
  lastNotificationMethod: null,
  lastNotificationError: null,
  alertActive: false,
  alertTier: 0,
  deepestBreachedThreshold: null,
  activeRpcUrl: null,
  activeRpcLatencyMs: null,
  lastRpcSelectionAt: null,
  rpcCandidates: [],
  rpcCandidatesUpdatedAt: null,
  currentRpcSelectionMode: null,
};

app.use(express.json({ limit: "64kb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/status", (_req, res) => {
  res.json({
    ok: true,
    config: getPublicConfig(),
    state,
  });
});

app.post("/api/config", async (req, res) => {
  try {
    const payload = { ...req.body };
    if (payload.barkDeviceKey === "") {
      delete payload.barkDeviceKey;
    }

    const nextConfig = normalizeConfig({
      ...config,
      ...payload,
    });
    const shouldProbe = hasConnectivitySensitiveChanges(config, nextConfig);
    const snapshot = shouldProbe ? await probeConfig(nextConfig, "保存配置") : createConfigOnlySnapshot(nextConfig, "保存配置");

    config = nextConfig;
    saveConfig(config);
    resetRuntimeCaches();
    if (snapshot) {
      applySnapshot(snapshot);
    }
    restartMonitor();

    res.json({
      ok: true,
      config: getPublicConfig(),
      state,
      snapshot,
    });
  } catch (error) {
    res.status(400).json({
      ok: false,
      error: error.message,
      config: getPublicConfig(),
      state,
    });
  }
});

app.post("/api/check", async (_req, res) => {
  try {
    const snapshot = await checkBalance("手动检查");
    res.json({
      ok: true,
      config: getPublicConfig(),
      snapshot,
      state,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
      config: getPublicConfig(),
      state,
    });
  }
});

app.post("/api/test-bark", async (_req, res) => {
  try {
    const result = await sendBarkNotification({
      title: "USD1 监控测试",
      body: "这是一条来自本地监控器的 Bark 测试通知。",
      level: config.barkLevel,
    });

    state.lastNotificationAt = new Date().toISOString();
    state.lastNotificationMessage = "测试通知发送成功";
    state.lastNotificationMethod = result.method;
    state.lastNotificationError = null;

    res.json({
      ok: true,
      config: getPublicConfig(),
      result,
      state,
    });
  } catch (error) {
    state.lastNotificationError = error.message;
    res.status(500).json({
      ok: false,
      error: error.message,
      config: getPublicConfig(),
      state,
    });
  }
});

app.listen(PORT, HOST, async () => {
  ensureDataDir();
  restartMonitor();

  try {
    await checkBalance("启动检查");
  } catch (error) {
    console.error("启动检查失败:", error.message);
  }

  console.log(`USD1 监控已启动: http://${HOST}:${PORT}`);
});

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadConfig() {
  ensureDataDir();

  if (!fs.existsSync(CONFIG_FILE)) {
    return normalizeConfig(DEFAULT_CONFIG);
  }

  const raw = fs.readFileSync(CONFIG_FILE, "utf8").replace(/^\uFEFF/, "");
  return normalizeConfig({
    ...DEFAULT_CONFIG,
    ...JSON.parse(raw),
  });
}

function saveConfig(nextConfig) {
  ensureDataDir();
  fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");
}

function getPublicConfig() {
  return {
    ...config,
    barkDeviceKey: "",
    barkDeviceKeyMasked: maskSecret(config.barkDeviceKey),
    hasBarkDeviceKey: Boolean(config.barkDeviceKey),
  };
}

function maskSecret(value) {
  const secret = String(value || "");
  if (!secret) {
    return "";
  }
  if (secret.length <= 8) {
    return `${secret.slice(0, 2)}***${secret.slice(-2)}`;
  }
  return `${secret.slice(0, 4)}***${secret.slice(-4)}`;
}

function normalizeConfig(input) {
  const normalized = {
    ...DEFAULT_CONFIG,
    ...input,
  };

  const parsedRpcUrls = normalizeRpcUrls(normalized.rpcUrls || normalized.rpcUrl);
  const parsedThresholds = normalizeThresholds(normalized.thresholds || normalized.threshold);

  normalized.rpcUrls = parsedRpcUrls.join("\n");
  normalized.rpcUrl = parsedRpcUrls[0];
  normalized.thresholds = parsedThresholds.map((item) => String(item)).join("\n");
  normalized.threshold = String(parsedThresholds[0]);
  normalized.tokenAddress = ethers.getAddress(String(normalized.tokenAddress || "").trim());
  normalized.walletAddress = ethers.getAddress(String(normalized.walletAddress || "").trim());
  normalized.intervalSeconds = clampInt(normalized.intervalSeconds, 3, 86400, DEFAULT_CONFIG.intervalSeconds);
  normalized.notifyCooldownMinutes = clampInt(
    normalized.notifyCooldownMinutes,
    0,
    10080,
    DEFAULT_CONFIG.notifyCooldownMinutes
  );
  normalized.barkServer = String(normalized.barkServer || "").trim() || DEFAULT_CONFIG.barkServer;
  normalized.barkDeviceKey = String(normalized.barkDeviceKey || "").trim();
  normalized.barkGroup = String(normalized.barkGroup || DEFAULT_CONFIG.barkGroup).trim();
  normalized.barkSound = String(normalized.barkSound || DEFAULT_CONFIG.barkSound).trim();
  normalized.barkLevel = normalizeBarkLevel(normalized.barkLevel);
  normalized.barkCall = normalizeBoolean(normalized.barkCall);
  normalized.barkVolume = normalizeVolume(normalized.barkVolume);
  normalized.barkIcon = String(normalized.barkIcon || "").trim();
  normalized.barkUrl = String(normalized.barkUrl || "").trim();
  normalized.barkClickUrl = String(normalized.barkClickUrl || "").trim();

  if (!parsedRpcUrls.length) {
    throw new Error("请至少填写一个 RPC 地址。");
  }

  if (!parsedThresholds.length) {
    throw new Error("请至少填写一个报警阈值。");
  }

  return normalized;
}

function normalizeRpcUrls(value) {
  const items = String(value || "")
    .split(/[\r\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);

  return [...new Set(items)];
}

function normalizeThresholds(value) {
  const items = String(value || "")
    .split(/[\r\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item) && item > 0)
    .sort((a, b) => b - a);

  return [...new Set(items)];
}

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  if (Number.isNaN(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(parsed, min), max);
}

function normalizeBarkLevel(value) {
  const allowed = new Set(["critical", "active", "timeSensitive", "passive"]);
  const nextValue = String(value || DEFAULT_CONFIG.barkLevel).trim();
  return allowed.has(nextValue) ? nextValue : DEFAULT_CONFIG.barkLevel;
}

function normalizeBoolean(value) {
  if (typeof value === "boolean") {
    return value;
  }

  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on";
}

function normalizeVolume(value) {
  if (value === "" || value === null || value === undefined) {
    return "";
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return "";
  }

  return String(Math.min(Math.max(parsed, 0), 10));
}

function isPositiveNumberString(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0;
}

function restartMonitor() {
  monitorGeneration += 1;

  if (timer) {
    clearTimeout(timer);
    timer = null;
  }

  state.nextRetryAt = null;
  scheduleNextCheck(monitorGeneration, config.intervalSeconds * 1000);
}

function scheduleNextCheck(generation, delayMs) {
  state.nextRetryAt = new Date(Date.now() + delayMs).toISOString();
  timer = setTimeout(async () => {
    if (generation !== monitorGeneration) {
      return;
    }

    try {
      await checkBalance("定时轮询");
      state.nextRetryAt = null;
    } catch (error) {
      console.error("定时检查失败:", error.message);
    } finally {
      if (generation === monitorGeneration) {
        const nextDelayMs = state.consecutiveFailures > 0
          ? Math.min(config.intervalSeconds * 1000, FAST_RETRY_SECONDS * 1000)
          : config.intervalSeconds * 1000;
        scheduleNextCheck(generation, nextDelayMs);
      }
    }
  }, delayMs);
}

function resetRuntimeCaches() {
  providerCache = null;
  contractCache = null;
  tokenMetaCache = null;
  providerCacheKey = "";
  contractCacheKey = "";
  state.activeRpcUrl = null;
  state.activeRpcLatencyMs = null;
  state.lastRpcSelectionAt = null;
  state.rpcCandidates = [];
  state.rpcCandidatesUpdatedAt = null;
  state.currentRpcSelectionMode = null;
}

function hasConnectivitySensitiveChanges(previousConfig, nextConfig) {
  return (
    previousConfig.rpcUrls !== nextConfig.rpcUrls ||
    previousConfig.tokenAddress !== nextConfig.tokenAddress ||
    previousConfig.walletAddress !== nextConfig.walletAddress
  );
}

async function checkBalance(trigger) {
  if (currentCheckPromise) {
    return currentCheckPromise;
  }

  state.isChecking = true;
  state.lastCheckAt = new Date().toISOString();

  currentCheckPromise = (async () => {
    try {
      const snapshot = await buildSnapshotForCurrentConfig(trigger);
      const previousAlertState = {
        alertActive: state.alertActive,
        deepestBreachedThreshold: state.deepestBreachedThreshold,
      };
      applySnapshot(snapshot);
      await maybeNotify(snapshot, previousAlertState);
      return snapshot;
    } catch (error) {
      state.lastError = error.message;
      state.consecutiveFailures += 1;
      state.connectionStatus = "offline";
      resetProviderOnRpcError(error);
      throw error;
    } finally {
      state.isChecking = false;
      currentCheckPromise = null;
    }
  })();

  return currentCheckPromise;
}

async function buildSnapshotForCurrentConfig(trigger) {
  const contract = await getTokenContract();
  const activeRpcUrl = state.activeRpcUrl;
  const activeRpcLatencyMs = state.activeRpcLatencyMs;
  const tokenMeta = await getTokenMeta();
  const startedAt = Date.now();
  const rawBalance = await contract.balanceOf(config.walletAddress);
  const finishedAt = Date.now();
  const thresholds = normalizeThresholds(config.thresholds);

  return createSnapshot({
    trigger,
    symbol: tokenMeta.symbol,
    decimals: tokenMeta.decimals,
    rawBalance,
    thresholds,
    tokenAddress: config.tokenAddress,
    walletAddress: config.walletAddress,
    activeRpcUrl,
    activeRpcLatencyMs,
    checkLatencyMs: finishedAt - startedAt,
  });
}

async function probeConfig(targetConfig, trigger) {
  const rpcUrls = normalizeRpcUrls(targetConfig.rpcUrls);
  const selection = await pickFastestRpc(rpcUrls, false, {
    tokenAddress: targetConfig.tokenAddress,
    walletAddress: targetConfig.walletAddress,
  });
  const provider = createProvider(selection.selected.url);
  const contract = new ethers.Contract(targetConfig.tokenAddress, ERC20_ABI, provider);
  const [decimalsRaw, symbol, rawBalance] = await Promise.all([
    contract.decimals(),
    contract.symbol(),
    contract.balanceOf(targetConfig.walletAddress),
  ]);

  return createSnapshot({
    trigger,
    symbol,
    decimals: Number(decimalsRaw),
    rawBalance,
    thresholds: normalizeThresholds(targetConfig.thresholds),
    tokenAddress: targetConfig.tokenAddress,
    walletAddress: targetConfig.walletAddress,
    activeRpcUrl: selection.selected.url,
    activeRpcLatencyMs: selection.selected.latencyMs,
    checkLatencyMs: null,
  });
}

function createProvider(url) {
  return new ethers.JsonRpcProvider(
    url,
    MAINNET,
    {
      staticNetwork: true,
      batchMaxCount: 1,
      cacheTimeout: 250,
      polling: false,
    }
  );
}

function setActiveProvider(candidate, cacheKey, selectionMode) {
  providerCache = createProvider(candidate.url);
  providerCacheKey = cacheKey;
  state.activeRpcUrl = candidate.url;
  state.activeRpcLatencyMs = candidate.latencyMs;
  state.lastRpcSelectionAt = new Date().toISOString();
  state.currentRpcSelectionMode = selectionMode;
  contractCache = null;
  contractCacheKey = "";
}

async function getProvider() {
  const rpcUrls = normalizeRpcUrls(config.rpcUrls);
  const cacheKey = rpcUrls.join("|");

  if (!shouldReselectRpc(cacheKey)) {
    return providerCache;
  }

  const selection = await pickFastestRpc(rpcUrls, true, {
    tokenAddress: config.tokenAddress,
    walletAddress: config.walletAddress,
  });
  setActiveProvider(selection.selected, cacheKey, "fastest-first-response");

  void selection.candidatesPromise
    .then((candidates) => {
      const bestCandidate = candidates.find((item) => item.ok);
      if (!bestCandidate || providerCacheKey !== cacheKey || bestCandidate.url === state.activeRpcUrl) {
        return;
      }

      if (typeof state.activeRpcLatencyMs === "number" && bestCandidate.latencyMs >= state.activeRpcLatencyMs) {
        return;
      }

      setActiveProvider(bestCandidate, cacheKey, "promoted-final-fastest");
    })
    .catch(() => {});

  return providerCache;
}

async function getTokenContract() {
  await getProvider();
  const contractKey = `${state.activeRpcUrl}|${config.tokenAddress}`;

  if (contractCache && contractCacheKey === contractKey) {
    return contractCache;
  }

  contractCache = new ethers.Contract(config.tokenAddress, ERC20_ABI, providerCache);
  contractCacheKey = contractKey;
  tokenMetaCache = null;
  return contractCache;
}

async function getTokenMeta() {
  const contract = await getTokenContract();

  if (tokenMetaCache) {
    return tokenMetaCache;
  }

  const [decimalsRaw, symbol] = await Promise.all([contract.decimals(), contract.symbol()]);
  tokenMetaCache = {
    decimals: Number(decimalsRaw),
    symbol,
  };
  return tokenMetaCache;
}

function createSnapshot({
  trigger,
  symbol,
  decimals,
  rawBalance,
  thresholds,
  tokenAddress,
  walletAddress,
  activeRpcUrl,
  activeRpcLatencyMs,
  checkLatencyMs,
}) {
  const formattedBalance = ethers.formatUnits(rawBalance, decimals);
  const balance = Number(formattedBalance);
  const thresholdList = thresholds.length ? thresholds : [Number(DEFAULT_CONFIG.threshold)];
  const breachedThresholds = thresholdList.filter((item) => balance < item);
  const deepestBreachedThreshold = breachedThresholds.length ? breachedThresholds[breachedThresholds.length - 1] : null;
  const nextAlertThreshold = thresholdList.find((item) => balance >= item) ?? null;
  const referenceThreshold = deepestBreachedThreshold ?? nextAlertThreshold ?? thresholdList[0];
  const threshold = thresholdList[0];

  return {
    trigger,
    symbol,
    decimals,
    balance,
    rawBalanceRaw: rawBalance.toString(),
    balanceDisplay: formatNumber(balance, 4),
    thresholds: thresholdList,
    thresholdsDisplay: thresholdList.map((item) => formatNumber(item, 0)),
    breachedThresholds,
    breachedThresholdsDisplay: breachedThresholds.map((item) => formatNumber(item, 0)),
    deepestBreachedThreshold,
    deepestBreachedThresholdDisplay: deepestBreachedThreshold ? formatNumber(deepestBreachedThreshold, 0) : null,
    nextAlertThreshold,
    nextAlertThresholdDisplay: nextAlertThreshold ? formatNumber(nextAlertThreshold, 0) : null,
    referenceThreshold,
    referenceThresholdDisplay: referenceThreshold ? formatNumber(referenceThreshold, 0) : null,
    threshold,
    thresholdDisplay: formatNumber(threshold, 0),
    diff: balance - referenceThreshold,
    diffDisplay: formatSignedNumber(balance - referenceThreshold, 4),
    belowThreshold: breachedThresholds.length > 0,
    tokenAddress,
    walletAddress,
    checkedAt: new Date().toISOString(),
    checkLatencyMs,
    activeRpcUrl,
    activeRpcLatencyMs,
    etherscanUrl: `https://etherscan.io/token/${tokenAddress}?a=${walletAddress}`,
  };
}

function applySnapshot(snapshot) {
  state.latest = snapshot;
  state.lastSuccessAt = snapshot.checkedAt;
  state.lastError = null;
  state.consecutiveFailures = 0;
  state.connectionStatus = "online";
  state.alertActive = snapshot.belowThreshold;
  state.alertTier = snapshot.breachedThresholds.length;
  state.deepestBreachedThreshold = snapshot.deepestBreachedThreshold;
  state.activeRpcUrl = snapshot.activeRpcUrl;
  state.activeRpcLatencyMs = snapshot.activeRpcLatencyMs;
  if (snapshot.activeRpcUrl) {
    state.lastRpcSelectionAt = new Date().toISOString();
  }
}

function createConfigOnlySnapshot(targetConfig, trigger) {
  if (!state.latest) {
    return null;
  }

  const thresholds = normalizeThresholds(targetConfig.thresholds);
  const rawBalance = state.latest.rawBalanceRaw ? BigInt(state.latest.rawBalanceRaw) : ethers.parseUnits(String(state.latest.balance), state.latest.decimals);

  return {
    ...state.latest,
    trigger,
    ...createSnapshot({
      trigger,
      symbol: state.latest.symbol,
      decimals: state.latest.decimals,
      rawBalance,
      thresholds,
      tokenAddress: targetConfig.tokenAddress,
      walletAddress: targetConfig.walletAddress,
      activeRpcUrl: state.activeRpcUrl,
      activeRpcLatencyMs: state.activeRpcLatencyMs,
      checkLatencyMs: null,
    }),
    checkedAt: new Date().toISOString(),
  };
}

function shouldReselectRpc(cacheKey) {
  if (!providerCache || providerCacheKey !== cacheKey || !state.activeRpcUrl) {
    return true;
  }

  if (typeof state.activeRpcLatencyMs === "number" && state.activeRpcLatencyMs >= SLOW_RPC_LATENCY_MS) {
    return true;
  }

  if (!state.lastRpcSelectionAt) {
    return true;
  }

  const lastSelectionMs = Date.parse(state.lastRpcSelectionAt);
  if (!Number.isFinite(lastSelectionMs)) {
    return true;
  }

  return Date.now() - lastSelectionMs >= RPC_RESELECT_INTERVAL_MS;
}

function resetProviderOnRpcError(error) {
  const message = String(error?.message || "");
  if (/timeout|network|socket|connect|429|503|failed to fetch/i.test(message)) {
    resetRuntimeCaches();
  }
}

async function pickFastestRpc(rpcUrls, updateState, probeTarget = {}) {
  const measurements = rpcUrls.map((url) => measureRpcLatency(url, probeTarget));

  if (updateState) {
    state.rpcCandidates = rpcUrls.map((url) => ({
      url,
      latencyMs: null,
      ok: null,
      error: null,
      pending: true,
    }));
    state.rpcCandidatesUpdatedAt = new Date().toISOString();
  }

  const candidatesPromise = Promise.all(measurements).then((candidates) => {
    const sortedCandidates = sortRpcCandidates(candidates);

    if (updateState) {
      state.rpcCandidates = sortedCandidates.map((item) => ({
        url: item.url,
        latencyMs: item.ok ? item.latencyMs : null,
        ok: item.ok,
        error: item.error || null,
        pending: false,
      }));
      state.rpcCandidatesUpdatedAt = new Date().toISOString();
    }

    return sortedCandidates;
  });

  try {
    const selected = await Promise.any(
      measurements.map((task) =>
        task.then((candidate) => {
          if (!candidate.ok) {
            throw new Error(candidate.error || `${candidate.url} failed`);
          }

          return candidate;
        })
      )
    );

    void candidatesPromise.catch(() => {});

    return {
      selected,
      candidatesPromise,
    };
  } catch (_error) {
    await candidatesPromise;
    throw new Error("所有 RPC 都不可用，请检查地址或更换更快的主网节点。");
  }
}

function sortRpcCandidates(candidates) {
  return [...candidates].sort((left, right) => {
    if (left.ok !== right.ok) {
      return left.ok ? -1 : 1;
    }

    if (left.latencyMs !== right.latencyMs) {
      return left.latencyMs - right.latencyMs;
    }

    return left.url.localeCompare(right.url);
  });
}

async function measureRpcLatency(url, probeTarget = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RPC_PROBE_TIMEOUT_MS);
  const startedAt = Date.now();
  const tokenAddress = probeTarget.tokenAddress || config.tokenAddress;
  const walletAddress = probeTarget.walletAddress || config.walletAddress;
  const data = ERC20_INTERFACE.encodeFunctionData("balanceOf", [walletAddress]);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [
          {
            to: tokenAddress,
            data,
          },
          "latest",
        ],
      }),
      signal: controller.signal,
    });

    const json = await response.json();
    if (!response.ok || json.error || !json.result) {
      throw new Error(json.error?.message || `HTTP ${response.status}`);
    }

    return {
      url,
      ok: true,
      latencyMs: Date.now() - startedAt,
      error: null,
    };
  } catch (error) {
    return {
      url,
      ok: false,
      latencyMs: Number.MAX_SAFE_INTEGER,
      error: error.name === "AbortError" ? "超时" : error.message,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function maybeNotify(snapshot, previousAlertState = {}) {
  const previousAlertActive = Boolean(previousAlertState.alertActive);
  const previousDeepestBreachedThreshold = previousAlertState.deepestBreachedThreshold ?? null;
  state.alertActive = snapshot.belowThreshold;
  state.alertTier = snapshot.breachedThresholds.length;
  state.deepestBreachedThreshold = snapshot.deepestBreachedThreshold;

  if (!config.barkDeviceKey) {
    return;
  }

  const now = Date.now();
  const cooldownMs = config.notifyCooldownMinutes * 60 * 1000;
  const lastNotificationMs = state.lastNotificationAt ? Date.parse(state.lastNotificationAt) : 0;
  const cooldownPassed = !lastNotificationMs || now - lastNotificationMs >= cooldownMs;

  const crossedNewThreshold =
    snapshot.deepestBreachedThreshold !== null &&
    (previousDeepestBreachedThreshold === null || snapshot.deepestBreachedThreshold < previousDeepestBreachedThreshold);

  if (snapshot.belowThreshold && (crossedNewThreshold || (!previousAlertActive || cooldownPassed))) {
    const result = await sendBarkNotification({
      title: "USD1 余额告警",
      body: buildAlertMessage(snapshot),
      level: config.barkLevel,
    });

    state.lastNotificationAt = new Date().toISOString();
    state.lastNotificationMessage = `已发送告警，跌破 ${snapshot.deepestBreachedThresholdDisplay}`;
    state.lastNotificationMethod = result.method;
    state.lastNotificationError = null;
    return;
  }

  if (!snapshot.belowThreshold && previousAlertActive) {
    const result = await sendBarkNotification({
      title: "USD1 余额恢复",
      body: `${snapshot.symbol} 在 ${shortAddress(snapshot.walletAddress)} 的余额已恢复到 ${snapshot.balanceDisplay}，重新高于全部阈值。`,
      level: "active",
    });

    state.lastNotificationAt = new Date().toISOString();
    state.lastNotificationMessage = `已发送恢复通知，余额 ${snapshot.balanceDisplay}`;
    state.lastNotificationMethod = result.method;
    state.lastNotificationError = null;
  }
}

function buildAlertMessage(snapshot) {
  const crossedThresholds = snapshot.breachedThresholdsDisplay.join(" / ");
  const nextThresholdPart = snapshot.nextAlertThresholdDisplay
    ? `；下一档阈值 ${snapshot.nextAlertThresholdDisplay}`
    : "";

  return `${snapshot.symbol} 在 ${shortAddress(snapshot.walletAddress)} 的余额为 ${snapshot.balanceDisplay}，已跌破 ${snapshot.deepestBreachedThresholdDisplay} 阈值，共命中 ${snapshot.breachedThresholds.length} 档（${crossedThresholds}）${nextThresholdPart}。`;
}

async function sendBarkNotification({ title, body, level }) {
  if (!config.barkDeviceKey) {
    throw new Error("Bark Device Key 为空。");
  }

  const primaryUrl = buildPushUrl(config.barkServer);
  const payload = {
    device_key: config.barkDeviceKey,
    title,
    body,
    level: level || config.barkLevel,
    group: config.barkGroup,
    sound: config.barkSound || undefined,
    call: config.barkCall ? "1" : undefined,
    volume: config.barkVolume || undefined,
    icon: config.barkIcon || undefined,
    url: config.barkClickUrl || config.barkUrl || undefined,
    isArchive: "1",
  };

  try {
    const response = await fetch(primaryUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(payload),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Bark 推送失败 (${response.status}): ${text}`);
    }

    return { method: "POST /push", response: text };
  } catch (primaryError) {
    const fallbackUrl = buildLegacyBarkUrl(title, body);
    const fallbackResponse = await fetch(fallbackUrl);

    if (!fallbackResponse.ok) {
      const fallbackText = await fallbackResponse.text();
      throw new Error(
        `POST /push 失败: ${primaryError.message}; 兼容接口也失败 (${fallbackResponse.status}): ${fallbackText}`
      );
    }

    return { method: "兼容 GET", response: await fallbackResponse.text() };
  }
}

function buildPushUrl(server) {
  const base = String(server || "").trim().replace(/\/+$/, "");
  if (base.endsWith("/push")) {
    return base;
  }
  return `${base}/push`;
}

function buildLegacyBarkUrl(title, body) {
  const base = String(config.barkServer || "").trim().replace(/\/+$/, "").replace(/\/push$/, "");
  const url = new URL(
    `${base}/${encodeURIComponent(config.barkDeviceKey)}/${encodeURIComponent(title)}/${encodeURIComponent(body)}`
  );

  if (config.barkGroup) {
    url.searchParams.set("group", config.barkGroup);
  }
  if (config.barkSound) {
    url.searchParams.set("sound", config.barkSound);
  }
  if (config.barkCall) {
    url.searchParams.set("call", "1");
  }
  if (config.barkVolume) {
    url.searchParams.set("volume", config.barkVolume);
  }
  if (config.barkIcon) {
    url.searchParams.set("icon", config.barkIcon);
  }
  if (config.barkClickUrl || config.barkUrl) {
    url.searchParams.set("url", config.barkClickUrl || config.barkUrl);
  }
  url.searchParams.set("isArchive", "1");

  return url.toString();
}

function formatNumber(value, decimals) {
  return new Intl.NumberFormat("zh-CN", {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  }).format(value);
}

function formatSignedNumber(value, decimals) {
  const formatted = formatNumber(Math.abs(value), decimals);
  return value >= 0 ? `+${formatted}` : `-${formatted}`;
}

function shortAddress(address) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}
