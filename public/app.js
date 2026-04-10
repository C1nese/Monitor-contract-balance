const statusElements = {
  statusCard: document.getElementById("status-card"),
  pill: document.getElementById("status-pill"),
  balance: document.getElementById("balance-value"),
  thresholdLabel: document.getElementById("threshold-label"),
  threshold: document.getElementById("threshold-value"),
  diffLabel: document.getElementById("diff-label"),
  diff: document.getElementById("diff-value"),
  interval: document.getElementById("interval-value"),
  checkedAt: document.getElementById("checked-at"),
  successAt: document.getElementById("success-at"),
  notifyAt: document.getElementById("notify-at"),
  notifyMessage: document.getElementById("notify-message"),
  errorMessage: document.getElementById("error-message"),
  etherscan: document.getElementById("etherscan-link"),
  alarmMessage: document.getElementById("alarm-message"),
  alarmButton: document.getElementById("alarm-toggle-btn"),
  alarmSoundType: document.getElementById("alarm-sound-type"),
  alarmVolume: document.getElementById("alarm-volume"),
  alarmTestButton: document.getElementById("alarm-test-btn"),
  desktopNotifyButton: document.getElementById("desktop-notify-btn"),
  desktopNotifyMessage: document.getElementById("desktop-notify-message"),
  rpcUrl: document.getElementById("rpc-current"),
  rpcCandidates: document.getElementById("rpc-candidates"),
  rpcLatency: document.getElementById("rpc-latency"),
  checkLatency: document.getElementById("check-latency"),
  thresholdsList: document.getElementById("thresholds-list"),
  barkKeyHint: document.getElementById("bark-device-key-hint"),
};

const configForm = document.getElementById("config-form");
const barkForm = document.getElementById("bark-form");
const saveResult = document.getElementById("save-result");
const barkResult = document.getElementById("bark-result");
const checkNowBtn = document.getElementById("check-now-btn");
const testBarkBtn = document.getElementById("test-bark-btn");

const FIELD_IDS = [
  "rpcUrls",
  "tokenAddress",
  "walletAddress",
  "thresholds",
  "intervalSeconds",
  "notifyCooldownMinutes",
  "barkServer",
  "barkDeviceKey",
  "barkGroup",
  "barkSound",
  "barkCall",
  "barkVolume",
  "barkLevel",
  "barkIcon",
  "barkUrl",
  "barkClickUrl",
];

const audioState = {
  enabled: localStorage.getItem("browserAlarmEnabled") === "true",
  playing: false,
  context: null,
  gainNode: null,
  compressor: null,
  cleanupTimer: null,
  resumeTimer: null,
  soundType: localStorage.getItem("browserAlarmSoundType") || "siren",
  masterVolume: Number(localStorage.getItem("browserAlarmVolume") || "85"),
};

const uiState = {
  baseTitle: document.title,
  titleTimer: null,
  titleAltText: "",
  lastAlertActive: false,
  lastDeepestThreshold: null,
  lastConnectionStatus: "idle",
  refreshTimer: null,
  refreshDelayMs: 5000,
};

let lastKnownData = null;

async function init() {
  statusElements.alarmSoundType.value = audioState.soundType;
  statusElements.alarmVolume.value = String(audioState.masterVolume);
  updateAlarmUi();
  updateDesktopNotificationUi();
  await safeRefreshStatus();
}

async function safeRefreshStatus() {
  try {
    await refreshStatus();
  } catch (error) {
    renderConnectionError(error);
  } finally {
    scheduleStatusRefresh();
  }
}

function scheduleStatusRefresh() {
  if (uiState.refreshTimer) {
    clearTimeout(uiState.refreshTimer);
  }

  uiState.refreshTimer = window.setTimeout(() => {
    safeRefreshStatus();
  }, uiState.refreshDelayMs);
}

async function refreshStatus() {
  const response = await fetch("/api/status", { cache: "no-store" });
  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(data.error || "获取状态失败。");
  }

  lastKnownData = data;
  fillForms(data.config);
  renderStatus(data);
}

function fillForms(config) {
  for (const fieldId of FIELD_IDS) {
    const element = document.getElementById(fieldId);
    if (!element || document.activeElement === element) {
      continue;
    }

    const value = config[fieldId] ?? "";
    if (element.tagName === "SELECT") {
      element.value = String(value);
    } else if (fieldId !== "barkDeviceKey") {
      element.value = value;
    }
  }

  const barkKeyInput = document.getElementById("barkDeviceKey");
  if (barkKeyInput && document.activeElement !== barkKeyInput) {
    barkKeyInput.value = "";
    barkKeyInput.placeholder = config.hasBarkDeviceKey
      ? "已保存 Device Key，如需替换再输入新的"
      : "用于推送到手机";
  }

  statusElements.barkKeyHint.textContent = config.hasBarkDeviceKey
    ? `当前已保存：${config.barkDeviceKeyMasked}`
    : "当前尚未保存 Device Key";
}

function renderStatus(data) {
  const config = data.config || getCurrentConfigFromForm();
  const state = data.state || {};
  const latest = state.latest || null;

  uiState.refreshDelayMs = getRefreshDelayMs(config.intervalSeconds);

  statusElements.interval.textContent = `${config.intervalSeconds || "-"} 秒`;
  statusElements.checkedAt.textContent = formatTime(state.lastCheckAt);
  statusElements.successAt.textContent = formatTime(state.lastSuccessAt);
  statusElements.notifyAt.textContent = formatTime(state.lastNotificationAt);
  statusElements.notifyMessage.textContent = state.lastNotificationError || state.lastNotificationMessage || "-";
  statusElements.errorMessage.textContent = buildErrorMessage(state);
  statusElements.rpcUrl.textContent = state.activeRpcUrl || "尚未选择";
  statusElements.rpcCandidates.textContent = formatRpcCandidates(state.rpcCandidates);
  statusElements.rpcLatency.textContent =
    typeof state.activeRpcLatencyMs === "number" ? `${state.activeRpcLatencyMs} ms` : "-";
  statusElements.checkLatency.textContent =
    latest && typeof latest.checkLatencyMs === "number" ? `${latest.checkLatencyMs} ms` : "-";
  statusElements.thresholdsList.textContent =
    formatThresholdsFromArray(latest?.thresholds) || formatThresholds(config.thresholds || config.threshold);

  if (!latest) {
    statusElements.balance.textContent = "-";
    statusElements.thresholdLabel.textContent = "下一档阈值";
    statusElements.threshold.textContent = formatPrimaryThreshold(config.thresholds || config.threshold);
    statusElements.diffLabel.textContent = "高于阈值";
    statusElements.diff.textContent = "-";

    if (state.connectionStatus === "offline") {
      applyStatusMode("offline", "离线重连中");
    } else if (state.isChecking) {
      applyStatusMode("neutral", "检查中");
    } else {
      applyStatusMode("neutral", "暂无数据");
    }

    stopBrowserAlarm();
    syncTitleFlash(state, latest);
    updateAlarmUi();
    updateDesktopNotificationUi();
    updateTransitionState(state, latest);
    return;
  }

  statusElements.balance.textContent = `${latest.balanceDisplay} ${latest.symbol}`;
  statusElements.etherscan.href = latest.etherscanUrl;

  if (latest.belowThreshold) {
    statusElements.thresholdLabel.textContent = "当前已跌破";
    statusElements.threshold.textContent = `${latest.deepestBreachedThresholdDisplay} ${latest.symbol}`;
    statusElements.diffLabel.textContent = "低于阈值";
    statusElements.diff.textContent = `${latest.diffDisplay.replace("-", "")} ${latest.symbol}`;
  } else {
    statusElements.thresholdLabel.textContent = "下一档阈值";
    statusElements.threshold.textContent = `${latest.nextAlertThresholdDisplay || latest.thresholdDisplay} ${latest.symbol}`;
    statusElements.diffLabel.textContent = "高于阈值";
    statusElements.diff.textContent = `${latest.diffDisplay.replace("+", "")} ${latest.symbol}`;
  }

  if (state.connectionStatus === "offline") {
    applyStatusMode("offline", "离线重连中");
    stopBrowserAlarm();
  } else if (latest.belowThreshold) {
    applyStatusMode("alert", `已跌破 ${state.alertTier || latest.breachedThresholds.length} 档`);
    startBrowserAlarm();
  } else {
    applyStatusMode("ok", "正常");
    stopBrowserAlarm();
  }

  handleDesktopNotifications(state, latest);
  syncTitleFlash(state, latest);
  updateAlarmUi();
  updateDesktopNotificationUi();
  updateTransitionState(state, latest);
}

function renderConnectionError(error) {
  const fallbackConfig = getCurrentConfigFromForm();
  uiState.refreshDelayMs = getRefreshDelayMs(fallbackConfig.intervalSeconds);
  applyStatusMode("neutral", "连接失败");
  statusElements.balance.textContent = "-";
  statusElements.thresholdLabel.textContent = "下一档阈值";
  statusElements.threshold.textContent = formatPrimaryThreshold(fallbackConfig.thresholds);
  statusElements.diffLabel.textContent = "高于阈值";
  statusElements.diff.textContent = "-";
  statusElements.interval.textContent = `${fallbackConfig.intervalSeconds || "-"} 秒`;
  statusElements.errorMessage.textContent = `无法连接本地服务：${error.message}。页面会继续自动重试。`;
  statusElements.rpcUrl.textContent = "-";
  statusElements.rpcCandidates.textContent = "-";
  statusElements.rpcLatency.textContent = "-";
  statusElements.checkLatency.textContent = "-";
  statusElements.thresholdsList.textContent = formatThresholds(fallbackConfig.thresholds);
  statusElements.notifyMessage.textContent = lastKnownData?.state?.lastNotificationError || lastKnownData?.state?.lastNotificationMessage || "-";
  statusElements.notifyAt.textContent = formatTime(lastKnownData?.state?.lastNotificationAt);
  stopBrowserAlarm();
  stopTitleFlash();
  updateAlarmUi();
  updateDesktopNotificationUi();
}

function applyStatusMode(mode, label) {
  const pillMode = mode === "offline" ? "neutral" : mode;
  statusElements.pill.className = `pill ${pillMode}`;
  statusElements.pill.textContent = label;
  statusElements.statusCard.classList.toggle("is-alert", mode === "alert");
  statusElements.statusCard.classList.toggle("is-offline", mode === "offline");
}

function buildErrorMessage(state) {
  if (!state?.lastError) {
    return "-";
  }

  if (state.connectionStatus === "offline" && state.nextRetryAt) {
    return `${state.lastError}。下次自动重试：${formatTime(state.nextRetryAt)}`;
  }

  return state.lastError;
}

function updateTransitionState(state, latest) {
  uiState.lastConnectionStatus = state.connectionStatus || "idle";
  uiState.lastAlertActive = Boolean(latest?.belowThreshold) && state.connectionStatus !== "offline";
  uiState.lastDeepestThreshold = latest?.deepestBreachedThreshold ?? null;
}

function handleDesktopNotifications(state, latest) {
  if (!canUseDesktopNotifications()) {
    return;
  }

  if (state.connectionStatus === "offline" && uiState.lastConnectionStatus !== "offline") {
    showDesktopNotification("USD1 监控离线重连中", "本地监控仍在自动重试，网络恢复后会继续监听。", "usd1-offline");
    return;
  }

  if (state.connectionStatus === "offline") {
    return;
  }

  if (uiState.lastConnectionStatus === "offline") {
    showDesktopNotification("USD1 监控已恢复在线", "链路已经恢复，监控重新开始工作。", "usd1-online");
  }

  if (latest?.belowThreshold && (!uiState.lastAlertActive || latest.deepestBreachedThreshold !== uiState.lastDeepestThreshold)) {
    showDesktopNotification(
      "USD1 余额告警",
      `当前余额 ${latest.balanceDisplay} ${latest.symbol}，已跌破 ${latest.deepestBreachedThresholdDisplay}。`,
      `usd1-alert-${latest.deepestBreachedThreshold}`
    );
    return;
  }

  if (!latest?.belowThreshold && uiState.lastAlertActive) {
    showDesktopNotification(
      "USD1 余额恢复",
      `当前余额 ${latest.balanceDisplay} ${latest.symbol}，已经重新高于全部阈值。`,
      "usd1-recovery"
    );
  }
}

function syncTitleFlash(state, latest) {
  if (state.connectionStatus === "offline") {
    startTitleFlash("【离线】监控正在重连");
    return;
  }

  if (latest?.belowThreshold) {
    startTitleFlash(`【告警】已跌破 ${latest.deepestBreachedThresholdDisplay}`);
    return;
  }

  stopTitleFlash();
}

function startTitleFlash(text) {
  if (uiState.titleAltText === text && uiState.titleTimer) {
    return;
  }

  stopTitleFlash();
  uiState.titleAltText = text;
  let flipped = false;
  document.title = text;
  uiState.titleTimer = window.setInterval(() => {
    flipped = !flipped;
    document.title = flipped ? text : uiState.baseTitle;
  }, 900);
}

function stopTitleFlash() {
  if (uiState.titleTimer) {
    clearInterval(uiState.titleTimer);
    uiState.titleTimer = null;
  }

  uiState.titleAltText = "";
  document.title = uiState.baseTitle;
}

function getRefreshDelayMs(intervalSeconds) {
  const intervalMs = Math.max(Number(intervalSeconds || 5) * 1000, 3000);
  return Math.min(intervalMs, 30000);
}

function getCurrentConfigFromForm() {
  const payload = collectFormData(configForm, [
    "rpcUrls",
    "tokenAddress",
    "walletAddress",
    "thresholds",
    "intervalSeconds",
    "notifyCooldownMinutes",
  ]);

  return {
    ...payload,
    barkServer: document.getElementById("barkServer")?.value || "",
    barkDeviceKey: document.getElementById("barkDeviceKey")?.value || "",
    barkGroup: document.getElementById("barkGroup")?.value || "",
    barkSound: document.getElementById("barkSound")?.value || "",
    barkCall: document.getElementById("barkCall")?.value || "false",
    barkVolume: document.getElementById("barkVolume")?.value || "",
    barkLevel: document.getElementById("barkLevel")?.value || "timeSensitive",
    barkIcon: document.getElementById("barkIcon")?.value || "",
    barkUrl: document.getElementById("barkUrl")?.value || "",
    barkClickUrl: document.getElementById("barkClickUrl")?.value || "",
  };
}

configForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  saveResult.textContent = "保存中...";

  try {
    const payload = collectFormData(configForm, [
      "rpcUrls",
      "tokenAddress",
      "walletAddress",
      "thresholds",
      "intervalSeconds",
      "notifyCooldownMinutes",
    ]);
    const data = await postJson("/api/config", payload);
    lastKnownData = data;
    renderStatus(data);
    saveResult.textContent = "监控配置已保存。";
  } catch (error) {
    saveResult.textContent = error.message;
  }
});

barkForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  barkResult.textContent = "保存中...";

  try {
    const payload = collectFormData(barkForm, [
      "barkServer",
      "barkDeviceKey",
      "barkGroup",
      "barkSound",
      "barkCall",
      "barkVolume",
      "barkLevel",
      "barkIcon",
      "barkUrl",
      "barkClickUrl",
    ]);

    if (!payload.barkDeviceKey) {
      delete payload.barkDeviceKey;
    }

    const data = await postJson("/api/config", payload);
    lastKnownData = data;
    renderStatus(data);
    barkResult.textContent = "Bark 配置已保存。";
  } catch (error) {
    barkResult.textContent = error.message;
  }
});

checkNowBtn.addEventListener("click", async () => {
  checkNowBtn.disabled = true;
  checkNowBtn.textContent = "检查中...";

  try {
    const data = await postJson("/api/check", {});
    lastKnownData = data;
    renderStatus(data);
  } catch (error) {
    alert(error.message);
  } finally {
    checkNowBtn.disabled = false;
    checkNowBtn.textContent = "立即检查";
  }
});

testBarkBtn.addEventListener("click", async () => {
  testBarkBtn.disabled = true;
  testBarkBtn.textContent = "发送中...";

  try {
    const data = await postJson("/api/test-bark", {});
    lastKnownData = data;
    renderStatus(data);
    barkResult.textContent = "测试通知已发送。";
  } catch (error) {
    barkResult.textContent = error.message;
  } finally {
    testBarkBtn.disabled = false;
    testBarkBtn.textContent = "测试 Bark";
  }
});

statusElements.alarmButton.addEventListener("click", async () => {
  if (!audioState.enabled) {
    try {
      await enableBrowserAlarm();
    } catch (error) {
      statusElements.alarmMessage.textContent = `浏览器音频解锁失败：${error.message}`;
      return;
    }
  } else {
    disableBrowserAlarm();
  }

  updateAlarmUi();
});

statusElements.desktopNotifyButton.addEventListener("click", async () => {
  try {
    await enableDesktopNotifications();
  } catch (error) {
    statusElements.desktopNotifyMessage.textContent = error.message;
    updateDesktopNotificationUi();
  }
});

statusElements.alarmVolume.addEventListener("input", () => {
  audioState.masterVolume = Number(statusElements.alarmVolume.value);
  localStorage.setItem("browserAlarmVolume", String(audioState.masterVolume));
  applyAlarmVolume();
  updateAlarmUi();
});

statusElements.alarmSoundType.addEventListener("change", () => {
  audioState.soundType = statusElements.alarmSoundType.value;
  localStorage.setItem("browserAlarmSoundType", audioState.soundType);
  updateAlarmUi();
});

statusElements.alarmTestButton.addEventListener("click", async () => {
  try {
    await ensureAudioContext();
    statusElements.alarmMessage.textContent = `正在测试“${getSoundTypeLabel(audioState.soundType)}”报警声。`;
    playTestAlarm();
  } catch (error) {
    statusElements.alarmMessage.textContent = `浏览器音频解锁失败：${error.message}`;
  }
});

function collectFormData(form, keys) {
  const formData = new FormData(form);
  const payload = {};

  for (const key of keys) {
    payload[key] = formData.get(key);
  }

  return payload;
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(data.error || "请求失败。");
  }

  return data;
}

function formatTime(value) {
  if (!value) {
    return "-";
  }

  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function formatPrimaryThreshold(value) {
  const items = parseThresholdValues(value);
  return items.length ? items[0].toLocaleString("zh-CN") : "-";
}

function formatThresholds(value) {
  const items = parseThresholdValues(value);
  return items.length ? items.map((item) => item.toLocaleString("zh-CN")).join(" / ") : "-";
}

function formatThresholdsFromArray(values) {
  if (!Array.isArray(values) || !values.length) {
    return "";
  }

  return values.map((item) => Number(item).toLocaleString("zh-CN")).join(" / ");
}

function parseThresholdValues(value) {
  return String(value || "")
    .split(/[\r\n,]+/)
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item) && item > 0)
    .sort((a, b) => b - a);
}

function formatRpcCandidates(candidates) {
  if (!Array.isArray(candidates) || !candidates.length) {
    return "-";
  }

  return candidates
    .map((item) => {
      if (item.pending) {
        return `${item.url} [测速中]`;
      }

      if (item.ok) {
        return `${item.url} [${item.latencyMs} ms]`;
      }

      return `${item.url} [失败：${item.error || "未知错误"}]`;
    })
    .join(" | ");
}

function canUseDesktopNotifications() {
  return "Notification" in window && Notification.permission === "granted";
}

async function enableDesktopNotifications() {
  if (!("Notification" in window)) {
    throw new Error("当前浏览器不支持桌面通知。");
  }

  if (Notification.permission === "granted") {
    updateDesktopNotificationUi();
    return;
  }

  const permission = await Notification.requestPermission();
  updateDesktopNotificationUi();

  if (permission !== "granted") {
    throw new Error("桌面通知未开启，请在浏览器提示里允许通知。");
  }
}

function showDesktopNotification(title, body, tag) {
  if (!canUseDesktopNotifications()) {
    return;
  }

  const notification = new Notification(title, {
    body,
    tag,
    renotify: true,
    silent: false,
  });

  setTimeout(() => notification.close(), 12000);
}

function updateDesktopNotificationUi() {
  if (!("Notification" in window)) {
    statusElements.desktopNotifyButton.disabled = true;
    statusElements.desktopNotifyButton.textContent = "当前浏览器不支持通知";
    statusElements.desktopNotifyMessage.textContent = "这个浏览器不支持桌面通知，建议至少保留 Bark 和浏览器报警声。";
    return;
  }

  if (Notification.permission === "granted") {
    statusElements.desktopNotifyButton.disabled = false;
    statusElements.desktopNotifyButton.textContent = "桌面通知已开启";
    statusElements.desktopNotifyMessage.textContent = "桌面通知已开启。余额跌破新阈值、恢复正常或监控离线重连时都会弹出提醒。";
    return;
  }

  if (Notification.permission === "denied") {
    statusElements.desktopNotifyButton.disabled = true;
    statusElements.desktopNotifyButton.textContent = "桌面通知被阻止";
    statusElements.desktopNotifyMessage.textContent = "浏览器已经阻止通知，需要在地址栏或浏览器设置里手动放开。";
    return;
  }

  statusElements.desktopNotifyButton.disabled = false;
  statusElements.desktopNotifyButton.textContent = "启用桌面通知";
  statusElements.desktopNotifyMessage.textContent = "建议一并开启。页面切到后台时，会更容易第一时间看到告警。";
}

async function enableBrowserAlarm() {
  audioState.enabled = true;
  localStorage.setItem("browserAlarmEnabled", "true");
  await ensureAudioContext();
  await playUnlockTone();
}

function disableBrowserAlarm() {
  audioState.enabled = false;
  localStorage.setItem("browserAlarmEnabled", "false");
  stopBrowserAlarm();
}

async function ensureAudioContext() {
  if (!audioState.context) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      throw new Error("当前浏览器不支持 AudioContext。");
    }

    audioState.context = new AudioContextClass();
    audioState.compressor = audioState.context.createDynamicsCompressor();
    audioState.compressor.threshold.value = -14;
    audioState.compressor.knee.value = 18;
    audioState.compressor.ratio.value = 10;
    audioState.compressor.attack.value = 0.003;
    audioState.compressor.release.value = 0.18;
    audioState.gainNode = audioState.context.createGain();
    audioState.gainNode.connect(audioState.compressor);
    audioState.compressor.connect(audioState.context.destination);
    applyAlarmVolume();
  }

  if (audioState.context.state === "suspended") {
    await audioState.context.resume();
  }
}

async function playUnlockTone() {
  await ensureAudioContext();
  playPattern([
    { frequency: 1180, duration: 0.1, offset: 0, style: "beeper" },
    { frequency: 1580, duration: 0.14, offset: 0.14, style: "beeper" },
  ]);
}

function playTestAlarm() {
  playPattern(getAlarmPattern(audioState.soundType).notes);
}

async function startBrowserAlarm() {
  if (!audioState.enabled || audioState.playing) {
    return;
  }

  try {
    await ensureAudioContext();
  } catch (_error) {
    statusElements.alarmMessage.textContent = "请先点击一次“启用浏览器报警声”，浏览器才允许自动发声。";
    return;
  }

  audioState.playing = true;
  runAlarmLoop();
}

function stopBrowserAlarm() {
  audioState.playing = false;

  if (audioState.cleanupTimer) {
    clearTimeout(audioState.cleanupTimer);
    audioState.cleanupTimer = null;
  }

  if (audioState.resumeTimer) {
    clearTimeout(audioState.resumeTimer);
    audioState.resumeTimer = null;
  }
}

function runAlarmLoop() {
  if (!audioState.playing) {
    return;
  }

  const pattern = getAlarmPattern(audioState.soundType);
  playPattern(pattern.notes);

  audioState.cleanupTimer = setTimeout(() => {
    if (!audioState.playing) {
      return;
    }

    audioState.resumeTimer = setTimeout(runAlarmLoop, pattern.repeatDelayMs);
  }, pattern.totalDurationMs);
}

function playPattern(notes) {
  for (const note of notes) {
    playTone(note);
  }
}

function playTone(note) {
  if (!audioState.context || !audioState.gainNode) {
    return;
  }

  const oscillatorA = audioState.context.createOscillator();
  const oscillatorB = audioState.context.createOscillator();
  const envelope = audioState.context.createGain();
  const style = note.style || "siren";
  const start = audioState.context.currentTime + note.offset;
  const end = start + note.duration;

  configureOscillators(style, oscillatorA, oscillatorB, note.frequency, start, end);
  configureEnvelope(style, envelope, start, end, note.duration);

  oscillatorA.connect(envelope);
  oscillatorB.connect(envelope);
  envelope.connect(audioState.gainNode);
  oscillatorA.start(start);
  oscillatorB.start(start);
  oscillatorA.stop(end + 0.03);
  oscillatorB.stop(end + 0.03);
}

function configureOscillators(style, oscillatorA, oscillatorB, frequency, start, end) {
  if (style === "beeper") {
    oscillatorA.type = "square";
    oscillatorB.type = "square";
    oscillatorA.frequency.setValueAtTime(frequency, start);
    oscillatorB.frequency.setValueAtTime(frequency * 2, start);
    return;
  }

  if (style === "ring") {
    oscillatorA.type = "triangle";
    oscillatorB.type = "sine";
    oscillatorA.frequency.setValueAtTime(frequency, start);
    oscillatorB.frequency.setValueAtTime(frequency * 1.25, start);
    oscillatorA.frequency.linearRampToValueAtTime(frequency * 1.03, end);
    oscillatorB.frequency.linearRampToValueAtTime(frequency * 1.3, end);
    return;
  }

  if (style === "pulse") {
    oscillatorA.type = "square";
    oscillatorB.type = "triangle";
    oscillatorA.frequency.setValueAtTime(frequency, start);
    oscillatorB.frequency.setValueAtTime(frequency * 0.5, start);
    return;
  }

  if (style === "piercing") {
    oscillatorA.type = "sawtooth";
    oscillatorB.type = "square";
    oscillatorA.frequency.setValueAtTime(frequency, start);
    oscillatorB.frequency.setValueAtTime(frequency * 1.8, start);
    oscillatorA.frequency.linearRampToValueAtTime(frequency * 1.08, end);
    oscillatorB.frequency.linearRampToValueAtTime(frequency * 1.72, end);
    return;
  }

  oscillatorA.type = "square";
  oscillatorB.type = "triangle";
  oscillatorA.frequency.setValueAtTime(frequency, start);
  oscillatorB.frequency.setValueAtTime(frequency * 1.5, start);
  oscillatorA.frequency.linearRampToValueAtTime(frequency * 0.92, end);
  oscillatorB.frequency.linearRampToValueAtTime(frequency * 1.38, end);
}

function configureEnvelope(style, envelope, start, end, durationSeconds) {
  if (style === "pulse") {
    envelope.gain.setValueAtTime(0.0001, start);
    envelope.gain.linearRampToValueAtTime(1.0, start + 0.01);
    envelope.gain.linearRampToValueAtTime(0.3, start + durationSeconds * 0.4);
    envelope.gain.linearRampToValueAtTime(1.0, start + durationSeconds * 0.7);
    envelope.gain.exponentialRampToValueAtTime(0.0001, end);
    return;
  }

  if (style === "ring") {
    envelope.gain.setValueAtTime(0.0001, start);
    envelope.gain.exponentialRampToValueAtTime(0.88, start + 0.015);
    envelope.gain.exponentialRampToValueAtTime(0.4, start + durationSeconds * 0.45);
    envelope.gain.exponentialRampToValueAtTime(0.0001, end);
    return;
  }

  if (style === "piercing") {
    envelope.gain.setValueAtTime(0.0001, start);
    envelope.gain.exponentialRampToValueAtTime(1.1, start + 0.008);
    envelope.gain.exponentialRampToValueAtTime(0.0001, end);
    return;
  }

  envelope.gain.setValueAtTime(0.0001, start);
  envelope.gain.exponentialRampToValueAtTime(1.0, start + 0.012);
  envelope.gain.exponentialRampToValueAtTime(0.0001, end);
}

function getAlarmPattern(type) {
  const styles = {
    siren: {
      notes: [
        { frequency: 1640, duration: 0.18, offset: 0, style: "siren" },
        { frequency: 1640, duration: 0.18, offset: 0.22, style: "siren" },
        { frequency: 1260, duration: 0.22, offset: 0.48, style: "siren" },
        { frequency: 1840, duration: 0.24, offset: 0.82, style: "siren" },
      ],
      repeatDelayMs: 520,
      totalDurationMs: 980,
    },
    beeper: {
      notes: [
        { frequency: 1500, duration: 0.12, offset: 0, style: "beeper" },
        { frequency: 1500, duration: 0.12, offset: 0.16, style: "beeper" },
        { frequency: 1500, duration: 0.12, offset: 0.32, style: "beeper" },
        { frequency: 980, duration: 0.18, offset: 0.56, style: "beeper" },
      ],
      repeatDelayMs: 480,
      totalDurationMs: 820,
    },
    ring: {
      notes: [
        { frequency: 980, duration: 0.22, offset: 0, style: "ring" },
        { frequency: 1220, duration: 0.22, offset: 0.28, style: "ring" },
        { frequency: 980, duration: 0.22, offset: 0.66, style: "ring" },
      ],
      repeatDelayMs: 620,
      totalDurationMs: 930,
    },
    pulse: {
      notes: [
        { frequency: 880, duration: 0.24, offset: 0, style: "pulse" },
        { frequency: 880, duration: 0.24, offset: 0.3, style: "pulse" },
        { frequency: 740, duration: 0.28, offset: 0.64, style: "pulse" },
      ],
      repeatDelayMs: 560,
      totalDurationMs: 940,
    },
    piercing: {
      notes: [
        { frequency: 2200, duration: 0.16, offset: 0, style: "piercing" },
        { frequency: 2100, duration: 0.16, offset: 0.2, style: "piercing" },
        { frequency: 2400, duration: 0.2, offset: 0.46, style: "piercing" },
        { frequency: 1900, duration: 0.16, offset: 0.76, style: "piercing" },
      ],
      repeatDelayMs: 420,
      totalDurationMs: 940,
    },
  };

  return styles[type] || styles.siren;
}

function getSoundTypeLabel(type) {
  const labels = {
    siren: "警笛声",
    beeper: "蜂鸣器",
    ring: "电话铃",
    pulse: "脉冲警报",
    piercing: "尖锐高频",
  };

  return labels[type] || "警笛声";
}

function applyAlarmVolume() {
  if (!audioState.gainNode || !audioState.context) {
    return;
  }

  const normalized = Math.min(Math.max(audioState.masterVolume, 20), 100) / 100;
  audioState.gainNode.gain.setValueAtTime(0.16 + normalized * 0.5, audioState.context.currentTime);
}

function updateAlarmUi() {
  if (!audioState.enabled) {
    statusElements.alarmButton.textContent = "启用浏览器报警声";
    statusElements.alarmMessage.textContent =
      "浏览器会拦截自动播放声音，所以每个浏览器第一次使用时都需要先点一次启用按钮。";
    return;
  }

  statusElements.alarmButton.textContent = "关闭浏览器报警声";
  statusElements.alarmMessage.textContent = audioState.playing
    ? `当前余额低于阈值，正在播放“${getSoundTypeLabel(audioState.soundType)}”。`
    : `浏览器报警声已就绪，当前类型“${getSoundTypeLabel(audioState.soundType)}”，强度 ${audioState.masterVolume}%。`;
}

init().catch((error) => {
  console.error(error);
  alert(error.message);
});
