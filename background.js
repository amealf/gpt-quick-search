const CHAT_HOME = "https://chatgpt.com/";
const EXECUTION_URL_PATTERNS = [
  "https://chatgpt.com/*",
  "https://chat.openai.com/*",
  "https://gemini.google.com/*"
];
const INJECT_WORLD = "ISOLATED";
chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

const DEFAULT_PREFIX = "请将下列文本翻译成中文：";
const HOTKEY_DEFAULTS = {
  prefix1: DEFAULT_PREFIX,
  prefix2: DEFAULT_PREFIX,
  prefix3: DEFAULT_PREFIX,
  prefix4: DEFAULT_PREFIX,
  autoSend1: true,
  autoSend2: true,
  autoSend3: true,
  autoSend4: true,
  newChat1: true,
  newChat2: false,
  newChat3: false,
  newChat4: false
};
const BATCH_DEFAULT_GLOBAL_PROMPT = `请搜索并介绍用户下面将要发送的文本。

要求：
1 优先搜索Stanford Encyclopedia of Philosophy、Wikipedia、Britannica，不要使用中文资料。最后用一篇完整的中文文章介绍。

2 结尾不要有延展问题、编辑建议等等。全篇都要与该文本相关

3 使用最常见的中文书面写法。遵循用户的记忆和默认prompt`;
const BATCH_DEFAULT_PROMPT = "请介绍：";
const LEGACY_BATCH_DEFAULT_GLOBAL_PROMPT = "接下来会逐条发送一些词条标题。请每次只围绕当前这一条进行介绍，使用中文回答，不要重复说明规则。";
const LEGACY_BATCH_DEFAULT_PROMPT = "解释下列名词的概念：";
const BATCH_CONFIG_DEFAULTS = {
  batchGlobalPrompt: BATCH_DEFAULT_GLOBAL_PROMPT,
  batchPrompt: BATCH_DEFAULT_PROMPT
};
const BATCH_STATE_KEY = "batchRunState";
const CHAT_EXPORT_STATE_KEY = "chatExportRunState";
const DIRECTORY_DB_NAME = "batch-export-db";
const DIRECTORY_STORE_NAME = "handles";
const DIRECTORY_HANDLE_KEY = "output-directory";
const EMPTY_BATCH_STATE = {
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
  failedItems: [],
  delaySeconds: 3,
  directoryName: ""
};
const EMPTY_CHAT_EXPORT_STATE = {
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
  logs: [],
  directoryName: ""
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function getSync(defaults) {
  return new Promise((resolve) => chrome.storage.sync.get(defaults, (items) => resolve(items)));
}

function getLocal(defaults) {
  return new Promise((resolve) => chrome.storage.local.get(defaults, (items) => resolve(items)));
}

function setLocal(items) {
  return new Promise((resolve) => chrome.storage.local.set(items, resolve));
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

async function getOutputDirectoryHandle() {
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

function createBatchState(state) {
  const next = { ...EMPTY_BATCH_STATE, ...(state || {}) };
  next.logs = Array.isArray(next.logs) ? next.logs.slice(-60) : [];
  next.failedItems = Array.isArray(next.failedItems) ? next.failedItems.slice(-100) : [];
  return next;
}

function isRetryableBatchItemError(reason) {
  const text = String(reason || "");
  if (!text) return true;
  return !(
    text.includes("保存目录") ||
    text.includes("写入权限") ||
    text.includes("读取权限") ||
    text.includes("NotAllowedError") ||
    text.includes("NotFoundError") ||
    text.includes("SecurityError")
  );
}

function createChatExportState(state) {
  const next = { ...EMPTY_CHAT_EXPORT_STATE, ...(state || {}) };
  next.logs = Array.isArray(next.logs) ? next.logs.slice(-60) : [];
  return next;
}

function isCurrentBatchMessage(currentState, batchId) {
  return Boolean(batchId) && currentState.batchId === batchId;
}

function isCurrentChatExportMessage(currentState, exportId) {
  return Boolean(exportId) && currentState.exportId === exportId;
}

async function getBatchState() {
  const items = await getLocal({ [BATCH_STATE_KEY]: EMPTY_BATCH_STATE });
  return createBatchState(items[BATCH_STATE_KEY]);
}

async function getChatExportState() {
  const items = await getLocal({ [CHAT_EXPORT_STATE_KEY]: EMPTY_CHAT_EXPORT_STATE });
  return createChatExportState(items[CHAT_EXPORT_STATE_KEY]);
}

async function broadcastBatchState(state) {
  try {
    await chrome.runtime.sendMessage({ type: "BATCH_STATE_UPDATED", state });
  } catch {}
}

async function broadcastChatExportState(state) {
  try {
    await chrome.runtime.sendMessage({ type: "CHAT_EXPORT_STATE_UPDATED", state });
  } catch {}
}

async function saveBatchState(nextState) {
  const state = createBatchState(nextState);
  await setLocal({ [BATCH_STATE_KEY]: state });
  await broadcastBatchState(state);
  return state;
}

async function saveChatExportState(nextState) {
  const state = createChatExportState(nextState);
  await setLocal({ [CHAT_EXPORT_STATE_KEY]: state });
  await broadcastChatExportState(state);
  return state;
}

async function handleChatExportProgress(payload) {
  const current = await getChatExportState();
  if (!isCurrentChatExportMessage(current, payload?.exportId)) {
    return current;
  }

  const nextState = { ...current };
  if (typeof payload?.message === "string" && payload.message.trim()) {
    nextState.message = payload.message;
  }
  if (typeof payload?.currentText === "string") {
    nextState.currentText = payload.currentText;
  }
  if (Number.isFinite(Number(payload?.currentIndex))) {
    nextState.currentIndex = Math.max(0, Number(payload.currentIndex));
  }
  if (Number.isFinite(Number(payload?.total))) {
    nextState.total = Math.max(0, Number(payload.total));
  }
  if (typeof payload?.logMessage === "string" && payload.logMessage.trim()) {
    nextState.logs = current.logs.concat({
      time: new Date().toISOString(),
      level: payload?.level === "error" ? "error" : "info",
      message: payload.logMessage
    }).slice(-60);
  }

  return saveChatExportState(nextState);
}

async function handleStopChatExport() {
  const current = await getChatExportState();
  const exportId = current.exportId;
  const resetState = await saveChatExportState({
    ...EMPTY_CHAT_EXPORT_STATE
  });

  if (exportId) {
    (async () => {
      try {
        const chatTab = await findChatTab();
        if (chatTab && chatTab.id) {
          await sendMessageToChatTabSafely(chatTab.id, "EXT_STOP_CHAT_EXPORT", {
            exportId
          });
        }
      } catch {}
    })();
  }

  return { ok: true, state: resetState };
}

async function updateBatchState(patch) {
  const current = await getBatchState();
  return saveBatchState({ ...current, ...(patch || {}) });
}

async function appendBatchLog(message, level = "info") {
  const current = await getBatchState();
  const logs = current.logs.concat({
    time: new Date().toISOString(),
    level,
    message
  }).slice(-60);
  return saveBatchState({ ...current, logs });
}

async function appendBatchLogIfCurrent(batchId, message, level = "info") {
  const current = await getBatchState();
  if (!isCurrentBatchMessage(current, batchId)) {
    return current;
  }

  const logs = current.logs.concat({
    time: new Date().toISOString(),
    level,
    message
  }).slice(-60);

  return saveBatchState({ ...current, logs });
}

async function getHotkeySettings() {
  return getSync(HOTKEY_DEFAULTS);
}

async function getSelectedTextOnActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || !tab.id) return "";
  if (typeof tab.url === "string" && tab.url.startsWith(`chrome-extension://${chrome.runtime.id}/`)) {
    return "";
  }
  if (typeof tab.url !== "string" || !EXECUTION_URL_PATTERNS.some((pattern) => {
    const prefix = pattern.replace(/\*$/, "");
    return tab.url.startsWith(prefix);
  })) {
    return "";
  }

  const [{ result: selectedText = "" } = {}] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: INJECT_WORLD,
    func: () => {
      const selection = window.getSelection?.();
      let text = selection && selection.toString ? selection.toString() : "";

      if (!text && document.activeElement) {
        const element = document.activeElement;
        const isTextInput = element.tagName === "TEXTAREA" ||
          (element.tagName === "INPUT" && ["text", "search", "url", "email", "tel", "password"].includes(element.type));

        if (isTextInput && typeof element.selectionStart === "number" && typeof element.selectionEnd === "number") {
          text = element.value.substring(element.selectionStart, element.selectionEnd);
        }
      }

      return text || "";
    }
  });

  return selectedText || "";
}

async function findChatTab() {
  const tabs = await chrome.tabs.query({ url: ["https://chatgpt.com/*", "https://chat.openai.com/*"] });
  if (!tabs.length) return null;
  const activeTab = tabs.find((tab) => tab.active);
  return activeTab || tabs[0];
}

async function waitForTabComplete(tabId, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();

    function cleanup(listener, timerId) {
      chrome.tabs.onUpdated.removeListener(listener);
      clearInterval(timerId);
    }

    function listener(updatedTabId, info) {
      if (updatedTabId !== tabId || info.status !== "complete") return;
      cleanup(listener, timerId);
      resolve();
    }

    chrome.tabs.onUpdated.addListener(listener);

    const timerId = setInterval(async () => {
      if (Date.now() - startedAt > timeoutMs) {
        cleanup(listener, timerId);
        reject(new Error("页面加载超时。"));
        return;
      }

      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.status === "complete") {
          cleanup(listener, timerId);
          resolve();
        }
      } catch {}
    }, 300);
  });
}

async function bringToFront(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.tabs.update(tabId, { active: true });
  } catch {}
}

async function ensureChatTab(newChat) {
  if (newChat) {
    const existing = await findChatTab();
    if (existing) {
      await chrome.tabs.update(existing.id, { url: CHAT_HOME, active: true });
      await waitForTabComplete(existing.id);
      return existing;
    }

    const created = await chrome.tabs.create({ url: CHAT_HOME, active: true });
    await waitForTabComplete(created.id);
    return created;
  }

  const existing = await findChatTab();
  if (existing) return existing;

  const created = await chrome.tabs.create({ url: CHAT_HOME, active: true });
  await waitForTabComplete(created.id);
  return created;
}

function sendMessageToChatTab(tabId, type, payload) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { type, payload }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (response && response.ok) {
        resolve(response);
        return;
      }
      reject(new Error(response && response.error ? response.error : "内容脚本没有正确响应。"));
    });
  });
}

function isMissingReceiverError(error) {
  const message = String(error && error.message ? error.message : error || "");
  return /Receiving end does not exist/i.test(message) || /Could not establish connection/i.test(message);
}

async function ensureChatContentScript(tabId) {
  await waitForTabComplete(tabId);
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["chatgpt_content.js"]
  });
  await sleep(120);
}

async function sendMessageToChatTabSafely(tabId, type, payload) {
  let lastError = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await sendMessageToChatTab(tabId, type, payload);
    } catch (error) {
      lastError = error;
      if (!isMissingReceiverError(error)) {
        throw error;
      }

      await ensureChatContentScript(tabId);
    }
  }

  throw lastError || new Error("内容脚本连接失败。");
}

function composePromptText(prefix, text) {
  const cleanPrefix = typeof prefix === "string" ? prefix.trimEnd() : "";
  const cleanText = typeof text === "string" ? text : "";
  if (!cleanPrefix) return cleanText;
  return `${cleanPrefix}\n${cleanText}`;
}

function normalizePromptText(text) {
  return String(text || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function escapeRegExp(text) {
  return String(text || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripLeadingPrompt(text, prompt) {
  const normalizedText = normalizePromptText(text);
  const normalizedPrompt = normalizePromptText(prompt);
  if (!normalizedText || !normalizedPrompt) {
    return normalizedText;
  }

  const promptPattern = new RegExp(`^${escapeRegExp(normalizedPrompt)}(?:\\s*\\n+|\\s+)`, "i");
  if (promptPattern.test(normalizedText)) {
    return normalizedText.replace(promptPattern, "").trim();
  }

  return normalizedText;
}

function isGlobalPromptQuestion(text, prompt) {
  const normalizedText = normalizePromptText(text);
  const normalizedPrompt = normalizePromptText(prompt);
  return Boolean(normalizedText && normalizedPrompt && normalizedText === normalizedPrompt);
}

async function getBatchPromptConfig() {
  const items = await getSync(BATCH_CONFIG_DEFAULTS);
  return {
    globalPrompts: [
      items.batchGlobalPrompt,
      BATCH_DEFAULT_GLOBAL_PROMPT,
      LEGACY_BATCH_DEFAULT_GLOBAL_PROMPT
    ].map(normalizePromptText).filter(Boolean),
    messagePrompts: [
      items.batchPrompt,
      BATCH_DEFAULT_PROMPT,
      LEGACY_BATCH_DEFAULT_PROMPT
    ].map(normalizePromptText).filter(Boolean)
  };
}

function sanitizeExportedQuestion(question, config) {
  let normalizedQuestion = normalizePromptText(question);
  if (!normalizedQuestion) {
    return "";
  }

  if (config.globalPrompts.some((prompt) => isGlobalPromptQuestion(normalizedQuestion, prompt))) {
    return "";
  }

  for (const prompt of config.messagePrompts) {
    normalizedQuestion = stripLeadingPrompt(normalizedQuestion, prompt);
  }

  return normalizePromptText(normalizedQuestion);
}

const EXPORT_TOOL_PAYLOAD_KEYS = new Set([
  "search_query",
  "image_query",
  "open",
  "click",
  "find",
  "screenshot",
  "finance",
  "weather",
  "sports",
  "time",
  "response_length"
]);

function stripCitationArtifacts(text) {
  return String(text || "")
    .replace(/\s*[\uE000-\uF8FF]*cite[\uE000-\uF8FF]*(?:turn\d+(?:search|view|open|click|find|image|finance|weather|sports|time)\d+[\uE000-\uF8FF]*)+[\uE000-\uF8FF]*\s*/giu, " ")
    .replace(/\s*NciteÖturn\d+(?:search|view|open|click|find|image|finance|weather|sports|time)\d+(?:Öturn\d+(?:search|view|open|click|find|image|finance|weather|sports|time)\d+)*\s*/giu, " ")
    .replace(/[ \t]{2,}/g, " ");
}

function isLikelyToolPayloadBlock(block) {
  const normalized = String(block || "").trim();
  if (!normalized) {
    return false;
  }

  const looksLikeToolPayloadText =
    /"(?:search_query|image_query|open|click|find|screenshot|finance|weather|sports|time|response_length)"\s*:/i.test(normalized) &&
    /turn\d+(?:search|view|open|click|find|image|finance|weather|sports|time)\d+/i.test(normalized);

  if (looksLikeToolPayloadText) {
    return true;
  }

  if (!(normalized.startsWith("{") && normalized.endsWith("}"))) {
    return false;
  }

  try {
    const parsed = JSON.parse(normalized);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return false;
    }

    const keys = Object.keys(parsed);
    return Boolean(keys.length) && keys.every((key) => EXPORT_TOOL_PAYLOAD_KEYS.has(key));
  } catch {
    return false;
  }
}

function isLikelyReasoningArtifactBlock(block) {
  const normalized = String(block || "")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized || normalized.length > 220) {
    return false;
  }

  return /^(我先|先核对|然后对照|重点会放在|已经确认到|接下来|先看|我会先|I(?:'ll| will) first|Next, I(?:'ll| will)|I found|I've found|I've confirmed)/i.test(normalized) ||
    /(关键线索|核对|对照|整理|确认到|重点会放在|接下来|I(?:'ll| will) first|I found a key clue|I've confirmed)/i.test(normalized);
}

function extractLeadingJsonObject(text) {
  const normalized = String(text || "").trimStart();
  if (!normalized.startsWith("{")) {
    return "";
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return normalized.slice(0, index + 1);
      }
    }
  }

  return "";
}

function stripLeadingToolPayload(text) {
  let normalized = String(text || "").replace(/\r\n?/g, "\n").trim();

  while (normalized) {
    const leadingJson = extractLeadingJsonObject(normalized);
    if (!leadingJson || !isLikelyToolPayloadBlock(leadingJson)) {
      break;
    }

    normalized = normalized.slice(leadingJson.length).replace(/^\s+/, "");
  }

  return normalized.trim();
}

function stripToolArtifactBlocks(text) {
  const normalizedText = stripLeadingToolPayload(String(text || "").replace(/\r\n?/g, "\n"));
  const blocks = normalizedText
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean);

  if (!blocks.length) {
    return "";
  }

  const removedIndexes = new Set();
  for (let index = 0; index < blocks.length; index += 1) {
    if (!isLikelyToolPayloadBlock(blocks[index])) {
      continue;
    }

    removedIndexes.add(index);
    if (index > 0 && isLikelyReasoningArtifactBlock(blocks[index - 1])) {
      removedIndexes.add(index - 1);
    }
    if (index + 1 < blocks.length && isLikelyReasoningArtifactBlock(blocks[index + 1])) {
      removedIndexes.add(index + 1);
    }
  }

  return blocks
    .filter((_, index) => !removedIndexes.has(index))
    .join("\n\n")
    .trim();
}

function stripMarkdownLinksForSignal(text) {
  return String(text || "")
    .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
    .replace(/\[[^\]]*]\(https?:\/\/[^)]+\)/gi, " ")
    .replace(/https?:\/\/[^\s)]+/gi, " ");
}

function isReferenceOnlyMarkdownLine(line) {
  const normalized = String(line || "").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return false;
  }
  if (/^参考链接$/u.test(normalized)) {
    return true;
  }

  const withoutLinks = stripMarkdownLinksForSignal(normalized)
    .replace(/^[-*]\s*/, "")
    .replace(/[()[\]\s,.;:，。；：、]+/g, "")
    .trim();
  return !withoutLinks;
}

function isSourceArtifactLine(line) {
  const normalized = String(line || "").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return false;
  }
  if (/^参考链接$/u.test(normalized)) {
    return true;
  }
  if (/^[-*]\s*\[[^\]]+]\(https?:\/\/[^)]+\)\s*$/i.test(normalized)) {
    return true;
  }

  const sourceLikeWords = normalized.match(/\b(?:Stanford Encyclopedia of Philosophy|Encyclopedia Britannica|Britannica|Wikipedia|Internet Archive|Sources?|History of Economic Thought|dokumen\.pub|JSTOR|Project Gutenberg|Gutenberg)\b/gi) || [];
  const plusCount = (normalized.match(/\+\d+/g) || []).length;
  const urlCount = (normalized.match(/https?:\/\//gi) || []).length;
  return plusCount >= 2 || urlCount >= 2 || (sourceLikeWords.length >= 2 && plusCount >= 1);
}

function isSourceSummaryArtifactLine(line) {
  const normalized = String(line || "").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return false;
  }

  const sourceLikeWords = normalized.match(/\b(?:Stanford Encyclopedia of Philosophy|Encyclopedia Britannica|Britannica|Wikipedia|Internet Archive|Sources?|History of Economic Thought|dokumen\.pub|JSTOR|Project Gutenberg|Gutenberg)\b/gi) || [];
  const plusCount = (normalized.match(/\+\d+/g) || []).length;
  const urlCount = (normalized.match(/https?:\/\//gi) || []).length;
  return plusCount >= 2 || urlCount >= 2 || (sourceLikeWords.length >= 2 && plusCount >= 1);
}

function stripSourceSummaryArtifactLines(text) {
  return String(text || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((line) => !isSourceSummaryArtifactLine(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function hasAnswerBodyText(text) {
  const bodyCandidate = String(text || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((line) => {
      const normalized = String(line || "").replace(/\s+/g, " ").trim();
      return normalized &&
        !isReferenceOnlyMarkdownLine(normalized) &&
        !isSourceArtifactLine(normalized) &&
        !/^Thought for\b/i.test(normalized) &&
        !/^思考/.test(normalized) &&
        !/^Sources$/i.test(normalized);
    })
    .join("\n");

  const signal = stripMarkdownLinksForSignal(bodyCandidate)
    .replace(/[`*_#>\-|()[\]{}.,;:!?，。！？、；：（）【】《》“”‘’·]/g, " ")
    .replace(/\s+/g, "");
  return signal.length >= 20 && /[\p{L}\p{N}]/u.test(signal);
}

function sanitizeExportedAnswer(answer) {
  const withoutCitations = stripCitationArtifacts(answer);
  const withoutToolArtifacts = stripToolArtifactBlocks(withoutCitations);
  const withoutSourceArtifacts = stripSourceSummaryArtifactLines(withoutToolArtifacts);
  const cleaned = withoutSourceArtifacts
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return hasAnswerBodyText(cleaned) ? cleaned : "";
}

function sanitizeExportedChatPairs(pairs, config) {
  const sanitizedPairs = [];

  for (const pair of Array.isArray(pairs) ? pairs : []) {
    const question = sanitizeExportedQuestion(pair?.question, config);
    const answer = sanitizeExportedAnswer(pair?.answer);
    if (!question || !answer) {
      continue;
    }

    sanitizedPairs.push({
      question,
      answer
    });
  }

  return sanitizedPairs;
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

function sanitizeBatchInputText(text) {
  return extractBatchInputText(text)
    .replace(/(\d)\.(?=\d)/g, "$1_")
    .replace(/[◆◇]/g, " ")
    .replace(/[│┃┆┇┊┋├┝┞┟┠┡┢┣└┕┖┗┘┙┚┛─━╴╵╶╷╸╹╺╻╼╽╾╿]+/g, " ")
    .replace(/^[\s|\\/]+/g, " ")
    .replace(/\.(md|txt|markdown|rtf|doc|docx|pdf)\b/gi, " ")
    .replace(/[\\/:*?"<>|`~!@#$%^&*()+=[\]{};,.''，。！？、；：（）【】《》“”‘’·\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.+$/, "");
}

function formatMarkdownBody(answer) {
  return String(answer || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function buildMarkdownContent(text, answer) {
  const title = sanitizeBatchInputText(text) || "chatgpt-回答";
  const body = formatMarkdownBody(answer);

  if (!body) {
    return `# ${title}\n`;
  }

  return `# ${title}\n\n${body}\n`;
}

function buildTermIndexContent(terms) {
  const normalized = Array.isArray(terms)
    ? terms.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  const lines = normalized.map((item, index) => `${index + 1}. ${item}`);
  if (!lines.length) {
    return "# 对话导出-词条清单\n";
  }
  return `# 对话导出-词条清单\n\n${lines.join("\n\n")}\n`;
}

function createFilenameBase(text) {
  const sanitized = sanitizeBatchInputText(text);

  return (sanitized || "chatgpt-回答").slice(0, 120);
}

function normalizeDirectoryPath(directoryPath) {
  if (!Array.isArray(directoryPath)) return [];
  return directoryPath
    .map((item) => createFilenameBase(item))
    .filter(Boolean)
    .slice(0, 20);
}

function normalizeBatchItem(item) {
  if (item && typeof item === "object") {
    const text = sanitizeBatchInputText(item);
    if (!text) return null;
    return {
      text,
      directoryPath: normalizeDirectoryPath(item.directoryPath)
    };
  }

  const text = sanitizeBatchInputText(item);
  if (!text) return null;
  return { text, directoryPath: [] };
}

function normalizeExistingMarkdownBase(filename) {
  const baseName = String(filename || "")
    .replace(/\.md$/i, "")
    .replace(/\s+\(\d+\)$/u, "")
    .trim();
  return createFilenameBase(baseName);
}

function createBatchDuplicateKey(text, directoryPath = []) {
  const pathKey = normalizeDirectoryPath(directoryPath)
    .map((item) => item.toLowerCase())
    .join("/");
  const fileKey = createFilenameBase(text)
    .replace(/(\d)[\s_]+(?=\d)/g, "$1_")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return `${pathKey}::${fileKey}`;
}

function createBatchGlobalDuplicateKey(text) {
  const fileKey = createFilenameBase(text)
    .replace(/(\d)[\s_]+(?=\d)/g, "$1_")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return `::${fileKey}`;
}

async function listExistingMarkdownBaseNames(directoryHandle, directoryPath = []) {
  const names = new Set();
  if (!directoryHandle || typeof directoryHandle.values !== "function") {
    return names;
  }

  for await (const entry of directoryHandle.values()) {
    if (!entry) {
      continue;
    }
    if (entry.kind === "directory") {
      const childNames = await listExistingMarkdownBaseNames(entry, directoryPath.concat(entry.name || ""));
      for (const childName of childNames) {
        names.add(childName);
      }
      continue;
    }
    if (entry.kind === "file" && /\.md$/i.test(entry.name || "")) {
      const baseName = normalizeExistingMarkdownBase(entry.name);
      const scopedKey = createBatchDuplicateKey(baseName, directoryPath);
      const globalKey = createBatchGlobalDuplicateKey(baseName);
      if (scopedKey) {
        names.add(scopedKey);
      }
      if (globalKey) {
        names.add(globalKey);
      }
    }
  }

  return names;
}

async function getReadableOutputDirectoryHandle() {
  const directoryHandle = await getOutputDirectoryHandle();
  if (!directoryHandle) {
    throw new Error("保存目录不存在，请重新选择目录。");
  }

  if (typeof directoryHandle.queryPermission === "function") {
    const permission = await directoryHandle.queryPermission({ mode: "read" });
    if (permission !== "granted") {
      throw new Error("保存目录没有读取权限，请重新选择目录。");
    }
  }

  return directoryHandle;
}

function splitBatchItemsByExistingFiles(items, existingBaseNames) {
  const pendingItems = [];
  const pendingIndexes = [];
  const skippedItems = [];

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const scopedKey = createBatchDuplicateKey(item.text, item.directoryPath);
    const globalKey = createBatchGlobalDuplicateKey(item.text);
    if (existingBaseNames.has(scopedKey) || existingBaseNames.has(globalKey)) {
      skippedItems.push(item.text);
      continue;
    }
    pendingItems.push(item);
    pendingIndexes.push(index + 1);
  }

  return { pendingItems, pendingIndexes, skippedItems };
}

async function createUniqueFileHandle(directoryHandle, baseName) {
  for (let index = 0; index < 1000; index += 1) {
    const filename = index === 0 ? `${baseName}.md` : `${baseName} (${index + 1}).md`;
    try {
      await directoryHandle.getFileHandle(filename);
    } catch (error) {
      if (error && error.name === "NotFoundError") {
        const fileHandle = await directoryHandle.getFileHandle(filename, { create: true });
        return fileHandle;
      }
      throw error;
    }
  }

  throw new Error("目录中存在过多同名文件。");
}

async function getNestedDirectoryHandle(rootHandle, directoryPath) {
  let currentHandle = rootHandle;
  for (const folderName of normalizeDirectoryPath(directoryPath)) {
    currentHandle = await currentHandle.getDirectoryHandle(folderName, { create: true });
  }
  return currentHandle;
}

async function writeMarkdownFileToDirectory(text, content, directoryPath = []) {
  const directoryHandle = await getOutputDirectoryHandle();
  if (!directoryHandle) {
    throw new Error("保存目录不存在，请重新选择目录。");
  }

  if (typeof directoryHandle.queryPermission === "function") {
    const permission = await directoryHandle.queryPermission({ mode: "readwrite" });
    if (permission !== "granted") {
      throw new Error("保存目录没有写入权限，请重新选择目录。");
    }
  }

  const baseName = createFilenameBase(text);
  const targetDirectoryHandle = await getNestedDirectoryHandle(directoryHandle, directoryPath);
  const fileHandle = await createUniqueFileHandle(targetDirectoryHandle, baseName);
  const writable = await fileHandle.createWritable();
  await writable.write(content);
  await writable.close();

  const pathText = normalizeDirectoryPath(directoryPath).join("\\");
  return {
    locationText: pathText
      ? `已选目录：${directoryHandle.name ? `${directoryHandle.name}\\${pathText}` : pathText}`
      : directoryHandle.name ? `已选目录：${directoryHandle.name}` : "已选目录",
    filename: fileHandle.name
  };
}

async function saveMarkdownResult(text, content, directoryPath = []) {
  const result = await writeMarkdownFileToDirectory(text, content, directoryPath);
  return {
    savedBy: "directory",
    locationText: result.locationText,
    filename: result.filename
  };
}

async function handleHotkeyCommand(command) {
  const selectedText = await getSelectedTextOnActiveTab();
  if (!selectedText.trim()) return;

  const settings = await getHotkeySettings();
  const configMap = {
    send_to_gpt_1: { prefix: settings.prefix1, autoSend: Boolean(settings.autoSend1), newChat: Boolean(settings.newChat1) },
    send_to_gpt_2: { prefix: settings.prefix2, autoSend: Boolean(settings.autoSend2), newChat: Boolean(settings.newChat2) },
    send_to_gpt_3: { prefix: settings.prefix3, autoSend: Boolean(settings.autoSend3), newChat: Boolean(settings.newChat3) },
    send_to_gpt_4: { prefix: settings.prefix4, autoSend: Boolean(settings.autoSend4), newChat: Boolean(settings.newChat4) }
  };

  const config = configMap[command];
  if (!config) return;

  const payload = {
    text: selectedText,
    prefix: config.prefix,
    autoSend: config.autoSend,
    newChat: config.newChat
  };

  const chatTab = await ensureChatTab(config.newChat);
  await bringToFront(chatTab.id);
  await sendMessageToChatTabSafely(chatTab.id, "EXT_SEND_TO_GPT", payload);
}

async function handleStartBatch(payload) {
  const globalPrompt = typeof payload?.globalPrompt === "string" ? payload.globalPrompt : "";
  const prompt = typeof payload?.prompt === "string" ? payload.prompt : "";
  const items = Array.isArray(payload?.items)
    ? payload.items.map((item) => normalizeBatchItem(item)).filter(Boolean)
    : [];
  const newChat = payload?.newChat !== false;
  const delaySeconds = Number.isFinite(Number(payload?.delaySeconds))
    ? Math.min(60, Math.max(0, Number(payload.delaySeconds)))
    : 3;
  const directoryName = typeof payload?.directoryName === "string" ? payload.directoryName : "";
  const currentState = await getBatchState();
  const batchId = crypto.randomUUID();

  if (!items.length) {
    return { ok: false, error: "请输入至少一条待处理文本。" };
  }

  if (!directoryName) {
    return { ok: false, error: "请先选择目录。" };
  }

  if (currentState.running) {
    return { ok: false, error: "已有批量任务正在执行中。", state: currentState };
  }

  let pendingItems = items;
  let pendingIndexes = items.map((_, index) => index + 1);
  let skippedItems = [];
  try {
    const directoryHandle = await getReadableOutputDirectoryHandle();
    const existingBaseNames = await listExistingMarkdownBaseNames(directoryHandle);
    ({ pendingItems, pendingIndexes, skippedItems } = splitBatchItemsByExistingFiles(items, existingBaseNames));
  } catch (error) {
    return { ok: false, error: error && error.message ? error.message : String(error) };
  }

  const startedAt = new Date().toISOString();
  const skippedLogs = skippedItems.length
    ? [{
      time: startedAt,
      level: "info",
      message: `已跳过 ${skippedItems.length} 条已存在标题：${skippedItems.join("；")}`
    }]
    : [];
  const initialState = {
    running: Boolean(pendingItems.length),
    batchId: pendingItems.length ? batchId : "",
    total: items.length,
    completed: 0,
    failed: 0,
    skipped: skippedItems.length,
    currentIndex: skippedItems.length,
    currentText: "",
    message: pendingItems.length
      ? "正在打开 ChatGPT 页面……"
      : "所有标题都已经保存过，本次没有发送新消息。",
    startedAt,
    finishedAt: pendingItems.length ? "" : startedAt,
    delaySeconds,
    directoryName,
    failedItems: [],
    logs: [
      {
        time: startedAt,
        level: "info",
        message: `批量任务已开始，共 ${items.length} 条。`
      },
      ...skippedLogs
    ]
  };

  await saveBatchState(initialState);
  if (!pendingItems.length) {
    return { ok: true, state: initialState };
  }

  (async () => {
    try {
      const chatTab = await ensureChatTab(newChat);
      await bringToFront(chatTab.id);
      await sendMessageToChatTabSafely(chatTab.id, "EXT_START_BATCH_EXPORT", {
        batchId,
        globalPrompt,
        prompt,
        items: pendingItems,
        itemIndexes: pendingIndexes,
        totalCount: items.length,
        completedOffset: skippedItems.length,
        newChat,
        delaySeconds
      });

      await appendBatchLogIfCurrent(batchId, "ChatGPT 页面已接收批量任务。");
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      const current = await getBatchState();
      if (!isCurrentBatchMessage(current, batchId)) {
        return;
      }

      await saveBatchState({
        ...current,
        running: false,
        batchId: "",
        message,
        finishedAt: new Date().toISOString(),
        logs: current.logs.concat({
          time: new Date().toISOString(),
          level: "error",
          message
        }).slice(-60)
      });
    }
  })();

  return { ok: true, state: initialState };
}

async function handleStartChatExport(payload) {
  const directoryName = typeof payload?.directoryName === "string" ? payload.directoryName : "";
  const currentState = await getChatExportState();
  const exportId = crypto.randomUUID();

  if (!directoryName) {
    return { ok: false, error: "请先选择目录。" };
  }

  if (currentState.running) {
    return { ok: false, error: "当前已有对话导出任务正在执行中。", state: currentState };
  }

  const startedAt = new Date().toISOString();
  const initialState = {
    running: true,
    exportId,
    total: 0,
    completed: 0,
    failed: 0,
    currentIndex: 0,
    currentText: "",
    message: "正在读取当前对话……",
    startedAt,
    finishedAt: "",
    directoryName,
    logs: [{
      time: startedAt,
      level: "info",
      message: "当前对话导出已开始。"
    }]
  };

  await saveChatExportState(initialState);

  (async () => {
    try {
      const chatTab = await findChatTab();
      if (!chatTab || !chatTab.id) {
        throw new Error("没有找到已打开的 ChatGPT 对话页面。");
      }

      const response = await sendMessageToChatTabSafely(chatTab.id, "EXT_EXPORT_CURRENT_CONVERSATION", {
        exportId
      });
      const batchPromptConfig = await getBatchPromptConfig();
      const pairs = sanitizeExportedChatPairs(response?.pairs, batchPromptConfig);
      const terms = pairs.map((pair) => pair.question).filter(Boolean);
      if (!pairs.length) {
        throw new Error(response && response.error ? response.error : "当前对话没有可导出的问答内容。");
      }

      let runningState = await getChatExportState();
      if (!isCurrentChatExportMessage(runningState, exportId)) {
        return;
      }

      const readAt = new Date().toISOString();
      const titleSummary = terms.length
        ? `已识别标题：${terms.join("；")}`
        : "";
      runningState = await saveChatExportState({
        ...runningState,
        total: pairs.length,
        message: `已读取 ${pairs.length} 组问答，正在保存……`,
        logs: runningState.logs.concat([
          ...(titleSummary
            ? [{
              time: readAt,
              level: "info",
              message: titleSummary
            }]
            : []),
          {
            time: readAt,
            level: "info",
            message: `当前对话共读取到 ${pairs.length} 组问答。`
          }
        ]).slice(-80)
      });

      if (terms.length) {
        const indexContent = buildTermIndexContent(terms);
        const indexResult = await saveMarkdownResult("对话导出-词条清单", indexContent);
        runningState = await getChatExportState();
        if (!isCurrentChatExportMessage(runningState, exportId)) {
          return;
        }
        runningState = await saveChatExportState({
          ...runningState,
          logs: runningState.logs.concat({
            time: new Date().toISOString(),
            level: "info",
            message: `已记录词条清单，共 ${terms.length} 条。${indexResult.locationText}`
          }).slice(-80)
        });
      }

      let completed = 0;
      let failed = 0;

      for (let index = 0; index < pairs.length; index += 1) {
        const question = typeof pairs[index]?.question === "string" ? pairs[index].question.trim() : "";
        const answer = typeof pairs[index]?.answer === "string" ? pairs[index].answer : "";

        runningState = await getChatExportState();
        if (!isCurrentChatExportMessage(runningState, exportId)) {
          return;
        }

        let logLevel = "info";
        let logMessage = "";
        if (!question || !answer) {
          failed += 1;
          logLevel = "error";
          logMessage = `第 ${index + 1}/${pairs.length} 组失败：问答内容不完整。`;
        } else {
          try {
            const content = buildMarkdownContent(question, answer);
            const saveResult = await saveMarkdownResult(question, content);
            completed += 1;
            logLevel = "success";
            logMessage = `第 ${index + 1}/${pairs.length} 组已保存：${question}。${saveResult.locationText}`;
          } catch (error) {
            failed += 1;
            logLevel = "error";
            logMessage = `第 ${index + 1}/${pairs.length} 组保存失败：${question}。${error && error.message ? error.message : String(error)}`;
          }
        }

        const logAt = new Date().toISOString();
        runningState = await getChatExportState();
        if (!isCurrentChatExportMessage(runningState, exportId)) {
          return;
        }

        await saveChatExportState({
          ...runningState,
          total: pairs.length,
          completed,
          failed,
          currentIndex: index + 1,
          currentText: question,
          message: `正在导出第 ${index + 1}/${pairs.length} 组问答……`,
          logs: runningState.logs.concat({
            time: logAt,
            level: logLevel,
            message: logMessage
          }).slice(-80)
        });
      }

      runningState = await getChatExportState();
      if (!isCurrentChatExportMessage(runningState, exportId)) {
        return;
      }

      const finishedAt = new Date().toISOString();
      const message = failed
        ? `当前对话导出结束，成功 ${completed} 组，失败 ${failed} 组。`
        : `当前对话导出结束，共保存 ${completed} 组问答。`;

      await saveChatExportState({
        ...runningState,
        running: false,
        exportId: "",
        completed,
        failed,
        message,
        finishedAt,
        logs: runningState.logs.concat({
          time: finishedAt,
          level: "info",
          message
        }).slice(-80)
      });
    } catch (error) {
      const failedState = await getChatExportState();
      if (!isCurrentChatExportMessage(failedState, exportId)) {
        return;
      }

      const finishedAt = new Date().toISOString();
      const message = error && error.message ? error.message : String(error);
      await saveChatExportState({
        ...failedState,
        running: false,
        exportId: "",
        message,
        finishedAt,
        logs: failedState.logs.concat({
          time: finishedAt,
          level: "error",
          message
        }).slice(-80)
      });
    }
  })();

  return { ok: true, state: initialState };
}

async function handleBatchProgress(payload) {
  const current = await getBatchState();
  if (!isCurrentBatchMessage(current, payload?.batchId)) {
    return current;
  }

  const patch = {};

  if (typeof payload?.running === "boolean") patch.running = payload.running;
  if (typeof payload?.total === "number") patch.total = payload.total;
  if (typeof payload?.currentIndex === "number") patch.currentIndex = payload.currentIndex;
  if (typeof payload?.currentText === "string") patch.currentText = payload.currentText;
  if (typeof payload?.message === "string") patch.message = payload.message;
  if (typeof payload?.startedAt === "string") patch.startedAt = payload.startedAt;

  return saveBatchState({ ...current, ...patch });
}

async function handleBatchItemResult(payload) {
  const index = typeof payload?.index === "number" ? payload.index : 0;
  const total = typeof payload?.total === "number" ? payload.total : 0;
  const text = typeof payload?.text === "string" ? payload.text : `item-${index}`;
  const directoryPath = normalizeDirectoryPath(payload?.directoryPath);
  const errorMessage = typeof payload?.error === "string" ? payload.error : "";
  const answer = typeof payload?.answer === "string" ? payload.answer : "";
  const retryAttempt = Number.isFinite(Number(payload?.retryAttempt)) ? Math.max(0, Number(payload.retryAttempt)) : 0;
  const maxRetries = Number.isFinite(Number(payload?.maxRetries)) ? Math.max(0, Number(payload.maxRetries)) : 1;
  const current = await getBatchState();
  if (!isCurrentBatchMessage(current, payload?.batchId)) {
    return { ok: false, saved: false, retry: false, state: current };
  }

  let nextCompleted = current.completed;
  let nextFailed = current.failed;
  let logMessage = "";
  let logLevel = "info";
  let failedItem = null;
  let retry = false;
  let retryReason = "";

  if (errorMessage) {
    if (retryAttempt < maxRetries && isRetryableBatchItemError(errorMessage)) {
      retry = true;
      retryReason = errorMessage;
      logMessage = `第 ${index}/${total} 条保存失败，准备刷新页面重试：${text}。${errorMessage}`;
    } else {
      nextFailed += 1;
      logLevel = "error";
      logMessage = `第 ${index}/${total} 条失败：${text}。${errorMessage}`;
    failedItem = {
      time: new Date().toISOString(),
      index,
      total,
      text,
      directoryPath,
      reason: errorMessage
    };
    }
  } else {
    try {
      const cleanedAnswer = sanitizeExportedAnswer(answer);
      if (!cleanedAnswer) {
        throw new Error("回答内容为空。");
      }
      const content = buildMarkdownContent(text, cleanedAnswer);
      const saveResult = await saveMarkdownResult(text, content, directoryPath);
      nextCompleted += 1;
      logLevel = "success";
      logMessage = `第 ${index}/${total} 条已保存：${text}`;
    } catch (error) {
      const reason = error && error.message ? error.message : String(error);
      if (retryAttempt < maxRetries && isRetryableBatchItemError(reason)) {
        retry = true;
        retryReason = reason;
        logMessage = `第 ${index}/${total} 条保存失败，准备刷新页面重试：${text}。${reason}`;
      } else {
        nextFailed += 1;
        logLevel = "error";
        logMessage = `第 ${index}/${total} 条保存失败：${text}。${reason}`;
        failedItem = {
          time: new Date().toISOString(),
          index,
          total,
          text,
          directoryPath,
          reason
        };
      }
    }
  }

  const logs = current.logs.concat({
    time: new Date().toISOString(),
    level: logLevel,
    message: logMessage
  }).slice(-60);
  const failedItems = failedItem
    ? (current.failedItems || []).concat(failedItem).slice(-100)
    : (current.failedItems || []);

  const state = await saveBatchState({
    ...current,
    completed: nextCompleted,
    failed: nextFailed,
    currentIndex: index,
    currentText: text,
    logs,
    failedItems
  });
  return {
    ok: true,
    saved: Boolean(logLevel === "success"),
    retry,
    error: retryReason,
    state
  };
}

async function handleBatchFinished(payload) {
  const current = await getBatchState();
  if (!isCurrentBatchMessage(current, payload?.batchId)) {
    return current;
  }
  const finishedAt = new Date().toISOString();
  const message = typeof payload?.message === "string"
    ? payload.message
    : `任务结束，成功 ${current.completed} 条，失败 ${current.failed} 条。`;

  const logs = current.logs.concat({
    time: finishedAt,
    level: "info",
    message
  }).slice(-60);

  return saveBatchState({
    ...current,
    running: false,
    batchId: "",
    message,
    finishedAt,
    logs
  });
}

async function handleBatchFailed(payload) {
  const current = await getBatchState();
  if (!isCurrentBatchMessage(current, payload?.batchId)) {
    return current;
  }
  const finishedAt = new Date().toISOString();
  const errorMessage = typeof payload?.error === "string" ? payload.error : "批量任务执行失败。";

  const logs = current.logs.concat({
    time: finishedAt,
    level: "error",
    message: errorMessage
  }).slice(-60);
  const failedItems = (current.failedItems || []).concat({
    time: finishedAt,
    index: current.currentIndex || 0,
    total: current.total || 0,
    text: current.currentText || "批量任务",
    directoryPath: [],
    reason: errorMessage
  }).slice(-100);

  return saveBatchState({
    ...current,
    running: false,
    batchId: "",
    message: errorMessage,
    finishedAt,
    logs,
    failedItems
  });
}

async function handleStopBatch() {
  const current = await getBatchState();
  if (!current.running || !current.batchId) {
    return { ok: false, error: "当前没有正在执行的批量任务。", state: current };
  }

  const batchId = current.batchId;
  const finishedAt = new Date().toISOString();
  const logs = current.logs.concat({
    time: finishedAt,
    level: "info",
    message: "批量任务已停止。"
  }).slice(-60);

  const state = await saveBatchState({
    ...current,
    running: false,
    batchId: "",
    message: "任务已停止。",
    finishedAt,
    logs
  });

  (async () => {
    try {
      const chatTab = await findChatTab();
      if (chatTab && chatTab.id) {
        await sendMessageToChatTabSafely(chatTab.id, "EXT_STOP_BATCH_EXPORT", {
          batchId
        });
      }
    } catch {}
  })();

  return { ok: true, state };
}

chrome.commands.onCommand.addListener((command) => {
  if (!["send_to_gpt_1", "send_to_gpt_2", "send_to_gpt_3", "send_to_gpt_4"].includes(command)) return;
  handleHotkeyCommand(command).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !message.type) return;

  if (message.type === "GET_BATCH_STATE") {
    getBatchState()
      .then((state) => sendResponse({ ok: true, state }))
      .catch((error) => sendResponse({ ok: false, error: String(error && error.message ? error.message : error) }));
    return true;
  }

  if (message.type === "GET_CHAT_EXPORT_STATE") {
    getChatExportState()
      .then((state) => sendResponse({ ok: true, state }))
      .catch((error) => sendResponse({ ok: false, error: String(error && error.message ? error.message : error) }));
    return true;
  }

  if (message.type === "START_BATCH_EXPORT") {
    handleStartBatch(message.payload)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: String(error && error.message ? error.message : error) }));
    return true;
  }

  if (message.type === "START_CHAT_EXPORT") {
    handleStartChatExport(message.payload)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: String(error && error.message ? error.message : error) }));
    return true;
  }

  if (message.type === "CHAT_EXPORT_PROGRESS") {
    handleChatExportProgress(message.payload)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error && error.message ? error.message : error) }));
    return true;
  }

  if (message.type === "STOP_CHAT_EXPORT") {
    handleStopChatExport()
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: String(error && error.message ? error.message : error) }));
    return true;
  }

  if (message.type === "STOP_BATCH_EXPORT") {
    handleStopBatch()
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: String(error && error.message ? error.message : error) }));
    return true;
  }

  if (message.type === "BATCH_PROGRESS") {
    handleBatchProgress(message.payload)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error && error.message ? error.message : error) }));
    return true;
  }

  if (message.type === "BATCH_ITEM_RESULT") {
    handleBatchItemResult(message.payload)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: String(error && error.message ? error.message : error) }));
    return true;
  }

  if (message.type === "BATCH_FINISHED") {
    handleBatchFinished(message.payload)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error && error.message ? error.message : error) }));
    return true;
  }

  if (message.type === "BATCH_FAILED") {
    handleBatchFailed(message.payload)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error && error.message ? error.message : error) }));
    return true;
  }
});
