const HOTKEY_DEFAULT_PREFIX = "请将下列文本翻译成中文：";
const BATCH_DEFAULT_GLOBAL_PROMPT = `请搜索并介绍用户下面将要发送的文本。

要求：
1 优先搜索Stanford Encyclopedia of Philosophy、Wikipedia、Britannica，不要使用中文资料。最后用一篇完整的中文文章介绍。

2 结尾不要有延展问题、编辑建议等等。全篇都要与该文本相关

3 使用最常见的中文书面写法。遵循用户的记忆和默认prompt`;
const BATCH_DEFAULT_PROMPT = "请介绍：";
const LEGACY_BATCH_DEFAULT_GLOBAL_PROMPT = "接下来会逐条发送一些词条标题。请每次只围绕当前这一条进行介绍，使用中文回答，不要重复说明规则。";
const LEGACY_BATCH_DEFAULT_PROMPT = "解释下列名词的概念：";
const LEGACY_BATCH_DEFAULT_DELAY_SECONDS = 2;
const BATCH_DEFAULT_DELAY_SECONDS = 3;
const BATCH_CONVERSATION_MODE_NEW = "new";
const BATCH_CONVERSATION_MODE_CURRENT = "current";
const HOTKEY_DEFAULTS = {
  prefix1: HOTKEY_DEFAULT_PREFIX,
  prefix2: HOTKEY_DEFAULT_PREFIX,
  prefix3: HOTKEY_DEFAULT_PREFIX,
  prefix4: HOTKEY_DEFAULT_PREFIX,
  autoSend1: true,
  autoSend2: true,
  autoSend3: true,
  autoSend4: true,
  newChat1: true,
  newChat2: false,
  newChat3: false,
  newChat4: false
};
const BATCH_CONFIG_DEFAULTS = {
  batchGlobalPrompt: BATCH_DEFAULT_GLOBAL_PROMPT,
  batchPrompt: BATCH_DEFAULT_PROMPT,
  batchInputs: "",
  batchConversationMode: BATCH_CONVERSATION_MODE_NEW,
  batchIgnoreHeading1: false,
  batchIgnoreHeading2: true,
  batchDelaySeconds: BATCH_DEFAULT_DELAY_SECONDS,
  batchDirectoryName: "",
  optionsActivePage: "batch"
};
const BATCH_STATE_KEY = "batchRunState";
const CHAT_EXPORT_STATE_KEY = "chatExportRunState";
const BATCH_STATE_DEFAULT = {
  running: false,
  batchId: "",
  total: 0,
  completed: 0,
  failed: 0,
  skipped: 0,
  currentIndex: 0,
  currentText: "",
  message: "等待任务开始。",
  startedAt: "",
  finishedAt: "",
  logs: [],
  failedItems: []
};
const CHAT_EXPORT_STATE_DEFAULT = {
  running: false,
  exportId: "",
  total: 0,
  completed: 0,
  failed: 0,
  currentIndex: 0,
  currentText: "",
  message: "等待任务开始。",
  startedAt: "",
  finishedAt: "",
  logs: []
};
const DIRECTORY_DB_NAME = "batch-export-db";
const DIRECTORY_STORE_NAME = "handles";
const DIRECTORY_HANDLE_KEY = "output-directory";
const GROUPS = [1, 2, 3, 4];
const HOTKEY_RECOMMENDED_KEYS = {
  1: "Alt+Shift+W",
  2: "Ctrl+Shift+1",
  3: "Ctrl+Shift+2",
  4: "Ctrl+Shift+3"
};

let batchSaveTimer = null;
let startPending = false;
let stopPending = false;
let exportPending = false;
let exportStopPending = false;
let chatExportRequestToken = 0;
let currentBatchState = { ...BATCH_STATE_DEFAULT };
let currentChatExportState = { ...CHAT_EXPORT_STATE_DEFAULT };
let currentBatchDirectoryName = "";

function getSync(defaults) {
  return new Promise((resolve) => chrome.storage.sync.get(defaults, (items) => resolve(items)));
}

function getLocal(defaults) {
  return new Promise((resolve) => chrome.storage.local.get(defaults, (items) => resolve(items)));
}

function setLocal(items) {
  return new Promise((resolve) => chrome.storage.local.set(items, resolve));
}

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        const rawMessage = chrome.runtime.lastError.message || "";
        if (/message port closed before a response was received|receiving end does not exist/i.test(rawMessage)) {
          reject(new Error("扩展后台还没有更新，请在扩展管理页重新加载插件，再刷新当前设置页后重试。"));
          return;
        }
        reject(new Error(rawMessage));
        return;
      }
      resolve(response);
    });
  });
}

function openDirectoryDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DIRECTORY_DB_NAME, 1);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DIRECTORY_STORE_NAME)) {
        db.createObjectStore(DIRECTORY_STORE_NAME);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("目录数据库打开失败。"));
  });
}

async function saveDirectoryHandle(handle) {
  const db = await openDirectoryDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DIRECTORY_STORE_NAME, "readwrite");
    tx.objectStore(DIRECTORY_STORE_NAME).put(handle, DIRECTORY_HANDLE_KEY);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error || new Error("目录句柄保存失败。"));
    };
  });
}

async function getDirectoryHandle() {
  const db = await openDirectoryDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DIRECTORY_STORE_NAME, "readonly");
    const request = tx.objectStore(DIRECTORY_STORE_NAME).get(DIRECTORY_HANDLE_KEY);
    request.onsuccess = () => {
      db.close();
      resolve(request.result || null);
    };
    request.onerror = () => {
      db.close();
      reject(request.error || new Error("目录句柄读取失败。"));
    };
  });
}

async function clearDirectoryHandle() {
  const db = await openDirectoryDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DIRECTORY_STORE_NAME, "readwrite");
    tx.objectStore(DIRECTORY_STORE_NAME).delete(DIRECTORY_HANDLE_KEY);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error || new Error("目录句柄清理失败。"));
    };
  });
}

function createBatchState(state) {
  const next = { ...BATCH_STATE_DEFAULT, ...(state || {}) };
  next.logs = Array.isArray(next.logs) ? next.logs.slice(-60) : [];
  next.failedItems = Array.isArray(next.failedItems) ? next.failedItems.slice(-100) : [];
  return next;
}

async function ensureDirectoryWritable() {
  const handle = await getDirectoryHandle();
  if (!handle) {
    currentBatchDirectoryName = "";
    renderBatchDirectoryText();
    throw new Error("保存目录不存在，请重新选择目录。");
  }

  if (typeof handle.queryPermission === "function") {
    let permission = await handle.queryPermission({ mode: "readwrite" });
    if (permission !== "granted" && typeof handle.requestPermission === "function") {
      permission = await handle.requestPermission({ mode: "readwrite" });
    }
    if (permission !== "granted") {
      throw new Error("保存目录没有写入权限，请重新选择目录。");
    }
  }

  const handleName = handle.name || "";
  if (handleName && handleName !== currentBatchDirectoryName) {
    currentBatchDirectoryName = handleName;
    renderBatchDirectoryText();
  }

  return handle;
}

function createChatExportState(state) {
  const next = { ...CHAT_EXPORT_STATE_DEFAULT, ...(state || {}) };
  next.logs = Array.isArray(next.logs) ? next.logs.slice(-60) : [];
  return next;
}

function flashTip(id) {
  const tip = document.getElementById(id);
  if (!tip) return;
  tip.style.display = "inline";
  clearTimeout(tip.__timerId);
  tip.__timerId = setTimeout(() => {
    tip.style.display = "none";
  }, 1200);
}

function updateBatchActionButtons() {
  const startButton = document.getElementById("batchStart");
  const stopButton = document.getElementById("batchStop");
  const clearButton = document.getElementById("batchClearInputs");
  if (!startButton || !stopButton || !clearButton) return;
  startButton.disabled = startPending || currentBatchState.running;
  stopButton.disabled = stopPending || !currentBatchState.running;
  clearButton.disabled = startPending || stopPending || currentBatchState.running;
}

function updateChatExportActionButtons() {
  const exportButton = document.getElementById("exportCurrentChat");
  const exportStopButton = document.getElementById("exportStop");
  if (exportButton) {
    exportButton.disabled = exportPending || exportStopPending || currentChatExportState.running;
  }
  if (exportStopButton) {
    exportStopButton.disabled = exportStopPending || (!currentChatExportState.running && !exportPending);
  }
}

function normalizeBatchDelaySeconds(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return BATCH_DEFAULT_DELAY_SECONDS;
  if (parsed < 0) return 0;
  if (parsed > 60) return 60;
  return Math.round(parsed * 10) / 10;
}

function normalizeBatchConversationMode(value, legacyBatchNewChat = true) {
  if (value === BATCH_CONVERSATION_MODE_CURRENT) return BATCH_CONVERSATION_MODE_CURRENT;
  if (value === BATCH_CONVERSATION_MODE_NEW) return BATCH_CONVERSATION_MODE_NEW;
  return legacyBatchNewChat === false ? BATCH_CONVERSATION_MODE_CURRENT : BATCH_CONVERSATION_MODE_NEW;
}

function getSelectedBatchConversationMode() {
  const select = document.getElementById("batchConversationMode");
  return normalizeBatchConversationMode(select && select.value);
}

function setBatchConversationMode(mode) {
  const normalized = normalizeBatchConversationMode(mode);
  const select = document.getElementById("batchConversationMode");
  if (select) select.value = normalized;
}

function getToggleButtonState(id) {
  const button = document.getElementById(id);
  return Boolean(button && button.dataset.active === "true");
}

function setToggleButtonState(id, active) {
  const button = document.getElementById(id);
  if (!button) return;
  const enabled = Boolean(active);
  button.dataset.active = enabled ? "true" : "false";
  button.classList.toggle("is-active", enabled);
  button.setAttribute("aria-pressed", enabled ? "true" : "false");
}

function shouldIgnoreBatchLine(line, ignoreHeading1, ignoreHeading2) {
  const text = stripBatchTreePrefix(line);
  if (!text) return true;
  if (ignoreHeading2 && /^(?:\d+[._])+\d+\b/u.test(text)) return true;
  if (ignoreHeading1 && /^\d+\.\s*/u.test(text)) return true;
  return false;
}

function stripBatchTreePrefix(line) {
  return String(line || "")
    .replace(/^[\s│┃|]*(?:[├└┝┞┟┠┡┢┣┕┖┗][─━\-—–]+\s*)?/u, "")
    .trim();
}

function extractBatchInputText(value) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  if (!value || typeof value !== "object") return "";

  for (const key of ["text", "title", "name", "value", "label"]) {
    const text = extractBatchInputText(value[key]);
    if (text) return text;
  }

  return "";
}

function inferBatchTreeDepth(rawLine, titleText) {
  const source = String(rawLine || "");
  const prefixMatch = source.match(/^[\s│┃|]*(?:[├└┝┞┟┠┡┢┣┕┖┗][─━\-—–]+\s*)?/u);
  const prefix = prefixMatch ? prefixMatch[0] : "";
  const pipeDepth = (prefix.match(/[│┃|]/g) || []).length;
  const branchDepth = /[├└┝┞┟┠┡┢┣┕┖┗]/u.test(prefix) ? 1 : 0;
  const treeDepth = pipeDepth + branchDepth;
  if (treeDepth > 0) return treeDepth;

  const text = String(titleText || "").trim();
  const numbering = text.match(/^(\d+(?:[._]\d+)*)\b/u);
  if (!numbering) return 0;
  return Math.max(0, numbering[1].split(/[._]/).length - 1);
}

function parseBatchTreeItems(rawText) {
  const stack = [];
  const items = [];

  for (const rawLine of String(rawText || "").split(/\r?\n/)) {
    const trimmed = String(rawLine || "").trim();
    if (!trimmed) continue;

    const markerIndex = trimmed.indexOf("◆");
    const hasMarker = markerIndex >= 0;
    const stripped = stripBatchTreePrefix(rawLine);
    const textForDepth = hasMarker ? stripped.slice(0, stripped.indexOf("◆")).trim() : stripped;
    const depth = inferBatchTreeDepth(rawLine, textForDepth || stripped);

    if (hasMarker) {
      const text = stripped.slice(stripped.indexOf("◆") + 1).trim();
      if (!text) continue;
      items.push({
        text,
        directoryPath: stack.filter(Boolean)
      });
      continue;
    }

    const heading = stripped.trim();
    if (!heading) continue;
    stack[depth] = heading;
    stack.length = depth + 1;
  }

  return items;
}

function parseBatchItems(rawText, ignoreHeading1, ignoreHeading2) {
  if (String(rawText || "").includes("◆")) {
    return parseBatchTreeItems(rawText);
  }

  return String(rawText || "")
    .split(/\r?\n/)
    .map((item) => extractBatchInputText(item))
    .filter((item) => item && !shouldIgnoreBatchLine(item, ignoreHeading1, ignoreHeading2));
}

function renderHotkeyGroups() {
  const container = document.getElementById("groups");
  container.replaceChildren();

  for (const index of GROUPS) {
    const suggestedKey = HOTKEY_RECOMMENDED_KEYS[index] || "";
    const group = document.createElement("div");
    group.className = "group";

    const titleRow = document.createElement("div");
    titleRow.className = "row";
    const title = document.createElement("strong");
    title.textContent = `预设 ${index}`;
    titleRow.appendChild(title);

    const meta = document.createElement("div");
    meta.className = "preset-meta";
    const shortcutChip = document.createElement("span");
    shortcutChip.className = "meta-chip";
    shortcutChip.textContent = `默认快捷键：${suggestedKey}`;
    const usageChip = document.createElement("span");
    usageChip.className = "meta-chip";
    usageChip.textContent = "使用方式：选中文本后按下快捷键";
    meta.append(shortcutChip, usageChip);

    const promptRow = document.createElement("div");
    promptRow.className = "row";
    const promptLabel = document.createElement("label");
    promptLabel.htmlFor = `prefix${index}`;
    promptLabel.textContent = "Prompt";
    const promptInput = document.createElement("textarea");
    promptInput.id = `prefix${index}`;
    promptInput.className = "hotkey-prompt";
    promptInput.placeholder = HOTKEY_DEFAULT_PREFIX;
    promptRow.append(promptLabel, promptInput);

    const inlineRow = document.createElement("div");
    inlineRow.className = "row inline";

    const autoSendLabel = document.createElement("label");
    autoSendLabel.className = "toggle-label option-box";
    const autoSendText = document.createElement("span");
    autoSendText.textContent = "完成后自动发送";
    const autoSendInput = document.createElement("input");
    autoSendInput.type = "checkbox";
    autoSendInput.id = `autoSend${index}`;
    autoSendLabel.append(autoSendText, autoSendInput);

    const newChatLabel = document.createElement("label");
    newChatLabel.className = "toggle-label option-box";
    const newChatText = document.createElement("span");
    newChatText.textContent = "新建会话页";
    const newChatInput = document.createElement("input");
    newChatInput.type = "checkbox";
    newChatInput.id = `newChat${index}`;
    newChatLabel.append(newChatText, newChatInput);

    inlineRow.append(autoSendLabel, newChatLabel);
    group.append(titleRow, meta, promptRow, inlineRow);
    container.appendChild(group);
  }
}

function getShortcutSettingsUrl() {
  const userAgent = navigator.userAgent || "";
  if (/Edg\//i.test(userAgent)) {
    return "edge://extensions/shortcuts";
  }
  return "chrome://extensions/shortcuts";
}

function openShortcutSettingsPage() {
  const url = getShortcutSettingsUrl();
  if (chrome?.tabs?.create) {
    chrome.tabs.create({ url });
    return;
  }
  window.open(url, "_blank", "noopener");
}

function setActivePage(page) {
  const nextPage = ["batch", "hotkeys", "export"].includes(page) ? page : "batch";

  document.querySelectorAll("[data-page]").forEach((button) => {
    const active = button.dataset.page === nextPage;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
  });

  document.querySelectorAll(".page").forEach((section) => {
    const active = section.id === `page-${nextPage}`;
    section.classList.toggle("is-active", active);
  });

  chrome.storage.local.set({ optionsActivePage: nextPage });
}

function formatTime(isoText) {
  if (!isoText) return "";
  const value = new Date(isoText);
  if (Number.isNaN(value.getTime())) return "";
  return value.toLocaleString("zh-CN", { hour12: false });
}

function extractFailedTitleFromLog(message) {
  const text = String(message || "");
  const match = text.match(/失败：(.+?)(?:。.+)?$/);
  return match ? match[1].trim() : "";
}

function formatFailedBatchItemForRetry(item) {
  const title = item && item.text
    ? String(item.text).trim()
    : extractFailedTitleFromLog(item && item.reason ? item.reason : "");
  if (!title) return "";

  const directoryPath = Array.isArray(item && item.directoryPath)
    ? item.directoryPath.map((part) => String(part || "").trim()).filter(Boolean)
    : [];
  if (!directoryPath.length) return `◆ ${title}`;

  const lines = directoryPath.map((part, index) => (
    index === 0 ? part : `${"│   ".repeat(index - 1)}├── ${part}`
  ));
  lines.push(`${"│   ".repeat(Math.max(0, directoryPath.length - 1))}├── ◆ ${title}`);
  return lines.join("\n");
}

function renderBatchDirectoryText() {
  const hasDirectory = Boolean(currentBatchDirectoryName);
  [
    { buttonId: "pickBatchDirectory", textId: "batchDirectoryText" },
    { buttonId: "pickExportDirectory", textId: "exportDirectoryText" }
  ].forEach(({ buttonId, textId }) => {
    const button = document.getElementById(buttonId);
    const element = document.getElementById(textId);
    if (!element) return;
    if (button) {
      button.classList.toggle("is-required", !hasDirectory);
    }
    element.textContent = hasDirectory ? currentBatchDirectoryName : "必选";
    element.title = hasDirectory ? currentBatchDirectoryName : "请选择目录";
    element.classList.toggle("required-hint", !hasDirectory);
  });
}

function renderBatchState(state) {
  currentBatchState = createBatchState(state);
  updateBatchActionButtons();

  const summary = [];
  if (currentBatchState.running) {
    summary.push(`任务执行中，共 ${currentBatchState.total} 条`);
  } else if (currentBatchState.total) {
    summary.push(`任务已结束，共 ${currentBatchState.total} 条`);
  } else {
    summary.push("当前没有批量任务。");
  }

  if (currentBatchState.total) {
    const resultParts = [`成功 ${currentBatchState.completed} 条`];
    if (currentBatchState.skipped) {
      resultParts.push(`跳过 ${currentBatchState.skipped} 条`);
    }
    resultParts.push(`失败 ${currentBatchState.failed} 条`);
    summary.push(resultParts.join("，"));
  }

  const startedAt = formatTime(currentBatchState.startedAt);
  const finishedAt = formatTime(currentBatchState.finishedAt);
  if (startedAt) summary.push(`开始时间：${startedAt}`);
  if (finishedAt) summary.push(`结束时间：${finishedAt}`);

  document.getElementById("batchSummary").textContent = summary.join("，");

  const lines = [];
  lines.push(currentBatchState.message || "等待任务开始。");
  if (currentBatchState.total) {
    lines.push(`当前进度：${currentBatchState.currentIndex}/${currentBatchState.total}`);
  }
  if (currentBatchState.currentText) {
    lines.push(`当前文本：${currentBatchState.currentText}`);
  }
  document.getElementById("batchStatus").textContent = lines.join("\n");

  const failureGroup = document.getElementById("batchFailureGroup");
  const failureBox = document.getElementById("batchFailureBox");
  if (failureGroup && failureBox) {
    let failedItems = Array.isArray(currentBatchState.failedItems) ? currentBatchState.failedItems : [];
    if (!failedItems.length && currentBatchState.failed) {
      failedItems = (currentBatchState.logs || [])
        .filter((item) => item && (item.level === "error" || String(item.message || "").includes("失败")))
        .map((item) => ({
          time: item.time,
          index: 0,
          total: 0,
          text: extractFailedTitleFromLog(item.message || ""),
          directoryPath: [],
          reason: item.message || "未记录原因"
        }));
    }
    const failedTitles = failedItems
      .map((item) => formatFailedBatchItemForRetry(item))
      .filter(Boolean);
    if (failedTitles.length) {
      failureGroup.hidden = false;
      failureBox.textContent = failedTitles.join("\n");
    } else {
      failureGroup.hidden = true;
      failureBox.textContent = "";
    }
  }

  const logs = document.getElementById("batchLogs");
  logs.replaceChildren();
  const items = currentBatchState.logs.length ? currentBatchState.logs.slice().reverse() : [];
  for (const item of items) {
    const li = document.createElement("li");
    li.className = "log-item";
    const timeText = formatTime(item.time);
    if (timeText && item.level === "success" && String(item.message || "").includes("已保存：")) {
      li.textContent = `${item.message} ${timeText}`;
    } else {
      li.textContent = timeText ? `［${timeText}］${item.message}` : item.message;
    }
    logs.appendChild(li);
  }
}

function renderChatExportState(state) {
  currentChatExportState = createChatExportState(state);
  updateChatExportActionButtons();

  const summary = [];
  if (currentChatExportState.running) {
    summary.push(`导出执行中，共 ${currentChatExportState.total || 0} 组问答`);
  } else if (currentChatExportState.total) {
    summary.push(`导出已结束，共 ${currentChatExportState.total} 组问答`);
  } else {
    summary.push("当前没有导出任务。");
  }

  if (currentChatExportState.total) {
    summary.push(`成功 ${currentChatExportState.completed} 组，失败 ${currentChatExportState.failed} 组`);
  }

  const startedAt = formatTime(currentChatExportState.startedAt);
  const finishedAt = formatTime(currentChatExportState.finishedAt);
  if (startedAt) summary.push(`开始时间：${startedAt}`);
  if (finishedAt) summary.push(`结束时间：${finishedAt}`);

  document.getElementById("exportSummary").textContent = summary.join("，");

  const lines = [];
  lines.push(currentChatExportState.message || "等待任务开始。");
  if (currentChatExportState.total) {
    const savedCount = Math.min(
      currentChatExportState.total,
      currentChatExportState.completed + currentChatExportState.failed
    );
    lines.push(`保存进度：${savedCount}/${currentChatExportState.total}`);
  }
  if (currentChatExportState.currentText) {
    lines.push(`当前问题：${currentChatExportState.currentText}`);
  }
  document.getElementById("exportStatus").textContent = lines.join("\n");

  const logs = document.getElementById("exportLogs");
  logs.replaceChildren();
  const items = currentChatExportState.logs.length ? currentChatExportState.logs.slice().reverse() : [];
  for (const item of items) {
    const li = document.createElement("li");
    li.className = "log-item";
    const timeText = formatTime(item.time);
    li.textContent = timeText ? `［${timeText}］${item.message}` : item.message;
    logs.appendChild(li);
  }
}

function getBatchRetryText(state) {
  const failedItems = Array.isArray(state && state.failedItems)
    ? state.failedItems
    : [];
  const retryLines = failedItems
    .map((item) => formatFailedBatchItemForRetry(item))
    .filter(Boolean);

  if (retryLines.length) {
    return retryLines.join("\n");
  }

  if (!state || !state.failed || !Array.isArray(state.logs)) {
    return "";
  }

  return state.logs
    .filter((item) => item && (item.level === "error" || String(item.message || "").includes("失败")))
    .map((item) => formatFailedBatchItemForRetry({ reason: item.message }))
    .filter(Boolean)
    .join("\n");
}

function renderBatchRetryBox(state) {
  const group = document.getElementById("batchRetryGroup");
  const box = document.getElementById("batchRetryBox");
  if (!group || !box) return;

  const text = getBatchRetryText(state);
  group.hidden = !text;
  box.textContent = text;
}

const renderBatchStateBase = renderBatchState;
renderBatchState = function renderBatchStateWithRetryBox(state) {
  renderBatchStateBase(state);
  renderBatchRetryBox(currentBatchState);
};

async function forceStopBatchState(message = "任务已停止。") {
  const finishedAt = new Date().toISOString();
  const nextState = createBatchState({
    ...currentBatchState,
    running: false,
    batchId: "",
    message,
    finishedAt,
    logs: (currentBatchState.logs || []).concat({
      time: finishedAt,
      level: "info",
      message
    }).slice(-60)
  });
  await setLocal({ [BATCH_STATE_KEY]: nextState });
  renderBatchState(nextState);
  return nextState;
}

async function forceResetChatExportState() {
  const nextState = createChatExportState();
  await setLocal({ [CHAT_EXPORT_STATE_KEY]: nextState });
  renderChatExportState(nextState);
  return nextState;
}

async function loadHotkeySettings() {
  const config = await getSync(HOTKEY_DEFAULTS);
  for (const key of Object.keys(HOTKEY_DEFAULTS)) {
    const element = document.getElementById(key);
    if (!element) continue;
    if (typeof HOTKEY_DEFAULTS[key] === "boolean") {
      element.checked = Boolean(config[key]);
    } else {
      element.value = config[key] || HOTKEY_DEFAULTS[key];
    }
  }
}

function saveHotkeySettings() {
  const data = {};
  for (const key of Object.keys(HOTKEY_DEFAULTS)) {
    const element = document.getElementById(key);
    if (!element) continue;
    if (typeof HOTKEY_DEFAULTS[key] === "boolean") {
      data[key] = Boolean(element.checked);
    } else {
      data[key] = element.value || HOTKEY_DEFAULTS[key];
    }
  }

  chrome.storage.sync.set(data, () => flashTip("saved"));
}

async function persistBatchConfig(showTip = false) {
  const delayInput = document.getElementById("batchDelaySeconds");
  const delaySeconds = normalizeBatchDelaySeconds(delayInput.value);
  delayInput.value = String(delaySeconds);
  const payload = {
    batchGlobalPrompt: document.getElementById("batchGlobalPrompt").value,
    batchPrompt: document.getElementById("batchPrompt").value,
    batchInputs: document.getElementById("batchInputs").value,
    batchConversationMode: getSelectedBatchConversationMode(),
    batchIgnoreHeading1: getToggleButtonState("batchIgnoreHeading1"),
    batchIgnoreHeading2: getToggleButtonState("batchIgnoreHeading2"),
    batchDelaySeconds: delaySeconds,
    batchDirectoryName: currentBatchDirectoryName
  };
  await setLocal(payload);
  if (showTip) flashTip("batchSaved");
}

function scheduleBatchConfigSave() {
  clearTimeout(batchSaveTimer);
  batchSaveTimer = setTimeout(() => {
    persistBatchConfig(false).catch(() => {});
  }, 300);
}

async function loadBatchConfig() {
  const config = await getLocal(BATCH_CONFIG_DEFAULTS);
  const batchGlobalPrompt = !config.batchGlobalPrompt || config.batchGlobalPrompt === LEGACY_BATCH_DEFAULT_GLOBAL_PROMPT
    ? BATCH_DEFAULT_GLOBAL_PROMPT
    : config.batchGlobalPrompt;
  const batchConversationMode = normalizeBatchConversationMode(config.batchConversationMode, config.batchNewChat);
  const batchIgnoreHeading1 = config.batchIgnoreHeading1 === true;
  const batchIgnoreHeading2 = config.batchIgnoreHeading2 !== false;
  const batchPrompt = !config.batchPrompt || config.batchPrompt === LEGACY_BATCH_DEFAULT_PROMPT
    ? BATCH_CONFIG_DEFAULTS.batchPrompt
    : config.batchPrompt;
  const batchDelaySeconds = config.batchDelaySeconds == null || Number(config.batchDelaySeconds) === LEGACY_BATCH_DEFAULT_DELAY_SECONDS
    ? BATCH_DEFAULT_DELAY_SECONDS
    : normalizeBatchDelaySeconds(config.batchDelaySeconds);
  document.getElementById("batchGlobalPrompt").value = batchGlobalPrompt;
  document.getElementById("batchPrompt").value = batchPrompt;
  document.getElementById("batchInputs").value = config.batchInputs || "";
  setBatchConversationMode(batchConversationMode);
  setToggleButtonState("batchIgnoreHeading1", batchIgnoreHeading1);
  setToggleButtonState("batchIgnoreHeading2", batchIgnoreHeading2);
  document.getElementById("batchDelaySeconds").value = String(batchDelaySeconds);
  currentBatchDirectoryName = config.batchDirectoryName || "";
  renderBatchDirectoryText();
  setActivePage(["batch", "hotkeys", "export"].includes(config.optionsActivePage) ? config.optionsActivePage : "batch");

  if (
    batchGlobalPrompt !== config.batchGlobalPrompt ||
    batchConversationMode !== config.batchConversationMode ||
    batchIgnoreHeading1 !== Boolean(config.batchIgnoreHeading1) ||
    batchIgnoreHeading2 !== (config.batchIgnoreHeading2 !== false) ||
    batchPrompt !== config.batchPrompt ||
    batchDelaySeconds !== Number(config.batchDelaySeconds)
  ) {
    await setLocal({
      batchGlobalPrompt,
      batchConversationMode,
      batchIgnoreHeading1,
      batchIgnoreHeading2,
      batchPrompt,
      batchDelaySeconds
    });
  }
}

async function loadBatchState() {
  try {
    const response = await sendRuntimeMessage({ type: "GET_BATCH_STATE" });
    if (response && response.ok) {
      renderBatchState(response.state);
      return;
    }
  } catch {}

  const localItems = await getLocal({ [BATCH_STATE_KEY]: BATCH_STATE_DEFAULT });
  renderBatchState(localItems[BATCH_STATE_KEY]);
}

async function loadChatExportState() {
  try {
    const response = await sendRuntimeMessage({ type: "GET_CHAT_EXPORT_STATE" });
    if (response && response.ok) {
      renderChatExportState(response.state);
      return;
    }
  } catch {}

  const localItems = await getLocal({ [CHAT_EXPORT_STATE_KEY]: CHAT_EXPORT_STATE_DEFAULT });
  renderChatExportState(localItems[CHAT_EXPORT_STATE_KEY]);
}

async function pickBatchDirectory() {
  if (typeof window.showDirectoryPicker !== "function") {
    const message = "当前浏览器环境不支持目录选择功能。";
    renderBatchState({
      ...currentBatchState,
      message
    });
    renderChatExportState({
      ...currentChatExportState,
      message
    });
    return;
  }

  try {
    const handle = await window.showDirectoryPicker({ mode: "readwrite" });
    if (typeof handle.requestPermission === "function") {
      const permission = await handle.requestPermission({ mode: "readwrite" });
      if (permission !== "granted") {
        const message = "目录写入权限没有授权。";
        renderBatchState({
          ...currentBatchState,
          message
        });
        renderChatExportState({
          ...currentChatExportState,
          message
        });
        return;
      }
    }

    await saveDirectoryHandle(handle);
    currentBatchDirectoryName = handle.name || "";
    renderBatchDirectoryText();
    await persistBatchConfig(true);
  } catch (error) {
    if (error && error.name === "AbortError") return;
    const message = error && error.message ? error.message : "目录选择失败。";
    renderBatchState({
      ...currentBatchState,
      message
    });
    renderChatExportState({
      ...currentChatExportState,
      message
    });
  }
}

async function startBatch() {
  if (startPending) return;

  const conversationMode = getSelectedBatchConversationMode();
  const ignoreHeading1 = getToggleButtonState("batchIgnoreHeading1");
  const ignoreHeading2 = getToggleButtonState("batchIgnoreHeading2");
  const globalPrompt = document.getElementById("batchGlobalPrompt").value.trim();
  const prompt = document.getElementById("batchPrompt").value.trim();
  const delaySeconds = normalizeBatchDelaySeconds(document.getElementById("batchDelaySeconds").value);
  const items = parseBatchItems(document.getElementById("batchInputs").value, ignoreHeading1, ignoreHeading2);

  if (!items.length) {
    renderBatchState({
      ...currentBatchState,
      message: "没有可处理的文本，请检查标题忽略选项。"
    });
    setActivePage("batch");
    return;
  }

  if (!currentBatchDirectoryName) {
    renderBatchState({
      ...currentBatchState,
      message: "请先选择目录。"
    });
    setActivePage("batch");
    return;
  }

  startPending = true;
  updateBatchActionButtons();

  try {
    await ensureDirectoryWritable();
    await persistBatchConfig(true);
    const response = await sendRuntimeMessage({
      type: "START_BATCH_EXPORT",
      payload: {
        globalPrompt,
        prompt,
        items,
        newChat: conversationMode === BATCH_CONVERSATION_MODE_NEW,
        delaySeconds,
        directoryName: currentBatchDirectoryName
      }
    });

    if (!response || !response.ok) {
      renderBatchState({
        ...currentBatchState,
        message: response && response.error ? response.error : "批量任务启动失败。"
      });
      return;
    }

    if (response.state) renderBatchState(response.state);
    setActivePage("batch");
  } catch (error) {
    renderBatchState({
      ...currentBatchState,
      message: error && error.message ? error.message : "批量任务启动失败。"
    });
  } finally {
    startPending = false;
    updateBatchActionButtons();
  }
}

async function startChatExport() {
  if (exportPending) return;
  const requestToken = ++chatExportRequestToken;

  if (!currentBatchDirectoryName) {
    renderChatExportState({
      ...currentChatExportState,
      message: "请先选择目录。"
    });
    setActivePage("export");
    return;
  }

  exportPending = true;
  updateChatExportActionButtons();

  try {
    await ensureDirectoryWritable();
    const response = await sendRuntimeMessage({
      type: "START_CHAT_EXPORT",
      payload: {
        directoryName: currentBatchDirectoryName
      }
    });
    if (requestToken !== chatExportRequestToken) return;

    if (!response || !response.ok) {
      renderChatExportState({
        ...currentChatExportState,
        message: response && response.error ? response.error : "当前对话导出启动失败。"
      });
      return;
    }

    if (response.state) renderChatExportState(response.state);
    setActivePage("export");
  } catch (error) {
    if (requestToken !== chatExportRequestToken) return;
    renderChatExportState({
      ...currentChatExportState,
      message: error && error.message ? error.message : "当前对话导出启动失败。"
    });
  } finally {
    if (requestToken === chatExportRequestToken) {
      exportPending = false;
      updateChatExportActionButtons();
    }
  }
}

async function stopChatExport() {
  if (exportStopPending || (!currentChatExportState.running && !exportPending)) return;

  chatExportRequestToken += 1;
  exportPending = false;
  exportStopPending = true;
  updateChatExportActionButtons();

  try {
    const response = await sendRuntimeMessage({ type: "STOP_CHAT_EXPORT" });
    if (!response || !response.ok) {
      await forceResetChatExportState();
      return;
    }

    if (response.state) {
      renderChatExportState(response.state);
    } else {
      await forceResetChatExportState();
    }
  } catch {
    await forceResetChatExportState();
  } finally {
    exportStopPending = false;
    updateChatExportActionButtons();
  }
}

async function stopBatch() {
  if (stopPending || !currentBatchState.running) return;

  stopPending = true;
  updateBatchActionButtons();

  try {
    const response = await sendRuntimeMessage({ type: "STOP_BATCH_EXPORT" });
    if (!response || !response.ok) {
      await forceStopBatchState("任务已停止。");
      return;
    }

    if (response.state) {
      renderBatchState(response.state);
    }
  } catch (error) {
    await forceStopBatchState("任务已停止。");
  } finally {
    stopPending = false;
    updateBatchActionButtons();
  }
}

async function clearBatchInputs() {
  if (currentBatchState.running) return;

  const inputs = document.getElementById("batchInputs");
  inputs.value = "";
  await persistBatchConfig(true);
  await setLocal({ [BATCH_STATE_KEY]: BATCH_STATE_DEFAULT });
  renderBatchState(BATCH_STATE_DEFAULT);
  inputs.focus();
}

function bindTabEvents() {
  document.querySelectorAll("[data-page]").forEach((button) => {
    button.addEventListener("click", () => setActivePage(button.dataset.page));
  });
}

function bindBatchEvents() {
  const globalPrompt = document.getElementById("batchGlobalPrompt");
  const prompt = document.getElementById("batchPrompt");
  const inputs = document.getElementById("batchInputs");
  const conversationMode = document.getElementById("batchConversationMode");
  const ignoreHeading1 = document.getElementById("batchIgnoreHeading1");
  const ignoreHeading2 = document.getElementById("batchIgnoreHeading2");
  const delaySeconds = document.getElementById("batchDelaySeconds");

  globalPrompt.addEventListener("input", scheduleBatchConfigSave);
  prompt.addEventListener("input", scheduleBatchConfigSave);
  inputs.addEventListener("input", scheduleBatchConfigSave);
  delaySeconds.addEventListener("input", scheduleBatchConfigSave);
  conversationMode.addEventListener("change", () => persistBatchConfig(true));
  ignoreHeading1.addEventListener("click", () => {
    setToggleButtonState("batchIgnoreHeading1", !getToggleButtonState("batchIgnoreHeading1"));
    persistBatchConfig(true).catch(() => {});
  });
  ignoreHeading2.addEventListener("click", () => {
    setToggleButtonState("batchIgnoreHeading2", !getToggleButtonState("batchIgnoreHeading2"));
    persistBatchConfig(true).catch(() => {});
  });
  globalPrompt.addEventListener("change", () => persistBatchConfig(true));
  prompt.addEventListener("change", () => persistBatchConfig(true));
  inputs.addEventListener("change", () => persistBatchConfig(true));
  delaySeconds.addEventListener("change", () => persistBatchConfig(true));
  document.getElementById("batchStart").addEventListener("click", startBatch);
  document.getElementById("batchStop").addEventListener("click", stopBatch);
  document.getElementById("batchClearInputs").addEventListener("click", () => {
    clearBatchInputs().catch(() => {});
  });
  document.getElementById("pickBatchDirectory").addEventListener("click", pickBatchDirectory);
}

function bindExportEvents() {
  document.getElementById("pickExportDirectory").addEventListener("click", pickBatchDirectory);
  document.getElementById("exportCurrentChat").addEventListener("click", () => {
    startChatExport().catch(() => {});
  });
  document.getElementById("exportStop").addEventListener("click", () => {
    stopChatExport().catch(() => {});
  });
}

function bindRuntimeEvents() {
  chrome.runtime.onMessage.addListener((message) => {
    if (!message) return;
    if (message.type === "BATCH_STATE_UPDATED") {
      renderBatchState(message.state);
      return;
    }
    if (message.type === "CHAT_EXPORT_STATE_UPDATED") {
      renderChatExportState(message.state);
    }
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  renderHotkeyGroups();
  bindTabEvents();
  bindBatchEvents();
  bindExportEvents();
  bindRuntimeEvents();
  document.getElementById("save").addEventListener("click", saveHotkeySettings);
  document.getElementById("openShortcutSettings").addEventListener("click", openShortcutSettingsPage);

  await Promise.all([
    loadHotkeySettings(),
    loadBatchConfig(),
    loadBatchState(),
    loadChatExportState()
  ]);
});
