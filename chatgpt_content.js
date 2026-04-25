(function () {
  if (window.__EXT_GPT_HOTKEYS_INSTALLED__) return;
  window.__EXT_GPT_HOTKEYS_INSTALLED__ = true;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const until = async (check, timeout = 15000, interval = 150) => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeout) {
      const result = check();
      if (result) return result;
      await sleep(interval);
    }
    return null;
  };

  let batchRunning = false;
  let currentBatchId = "";
  let batchStopRequested = false;
  const BATCH_STOPPED_ERROR = "__BATCH_STOPPED__";
  const BATCH_RETRY_STORAGE_KEY = "__GPT_QUICK_SEARCH_BATCH_RETRY__";
  const BATCH_MAX_RETRIES = 1;
  const BATCH_CONVERSATION_ITEM_LIMIT = 80;
  let exportRunning = false;
  let currentExportId = "";
  let exportStopRequested = false;
  let currentExportAbortController = null;
  const CHAT_EXPORT_STOPPED_ERROR = "__CHAT_EXPORT_STOPPED__";
  const DEEP_RESEARCH_IFRAME_SELECTOR = 'iframe[title="internal://deep-research"]';
  const DEEP_RESEARCH_EXPORT_REQUEST = "__EXT_DEEP_RESEARCH_EXPORT_REQUEST__";
  const DEEP_RESEARCH_EXPORT_RESPONSE = "__EXT_DEEP_RESEARCH_EXPORT_RESPONSE__";

  function saveBatchRetryState(state) {
    try {
      sessionStorage.setItem(BATCH_RETRY_STORAGE_KEY, JSON.stringify(state));
      return true;
    } catch {}
    return false;
  }

  function takeBatchRetryState() {
    try {
      const raw = sessionStorage.getItem(BATCH_RETRY_STORAGE_KEY);
      sessionStorage.removeItem(BATCH_RETRY_STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      try {
        sessionStorage.removeItem(BATCH_RETRY_STORAGE_KEY);
      } catch {}
      return null;
    }
  }

  function isElementVisible(element) {
    return Boolean(element && element.offsetParent !== null);
  }

  function composeFullText(text, prefix) {
    const cleanPrefix = typeof prefix === "string" ? prefix.trimEnd() : "";
    const cleanText = extractContentBatchText(text);
    if (!cleanPrefix) return cleanText;
    if (!cleanText) return cleanPrefix;
    return `${cleanPrefix}\n${cleanText}`;
  }

  function extractContentBatchText(value) {
    if (typeof value === "string") return value.trim();
    if (typeof value === "number") return String(value);
    if (!value || typeof value !== "object") return "";

    for (const key of ["text", "title", "name", "value", "label"]) {
      const text = extractContentBatchText(value[key]);
      if (text) return text;
    }

    return "";
  }

  function normalizeContentBatchItem(item) {
    if (item && typeof item === "object") {
      const text = extractContentBatchText(item);
      if (!text) return null;
      return {
        text,
        directoryPath: Array.isArray(item.directoryPath)
          ? item.directoryPath.map((part) => String(part || "").trim()).filter(Boolean)
          : []
      };
    }

    const text = String(item || "").trim();
    if (!text) return null;
    return { text, directoryPath: [] };
  }

  function getTextFromNode(node) {
    if (!node) return "";
    const clone = node.cloneNode(true);
    clone.querySelectorAll("button, svg, textarea, input").forEach((element) => element.remove());
    return (clone.innerText || clone.textContent || "")
      .replace(/\u200b/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function splitIntoParagraphs(text) {
    return String(text || "")
      .replace(/\r\n?/g, "\n")
      .split(/\n\s*\n+/)
      .map((paragraph) => paragraph.trim())
      .filter(Boolean);
  }

  function normalizeParagraphKey(text) {
    return String(text || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function normalizeExternalUrl(url) {
    const raw = typeof url === "string" ? url.trim() : "";
    if (!raw) return "";

    try {
      const parsed = new URL(raw, window.location.href);
      if (!/^https?:$/i.test(parsed.protocol)) {
        return "";
      }
      return parsed.href;
    } catch {
      return "";
    }
  }

  function normalizeReferenceLabel(label, url) {
    const normalized = typeof label === "string"
      ? label.replace(/\s+/g, " ").trim()
      : "";

    if (normalized && normalized.length <= 120 && !/^https?:\/\//i.test(normalized)) {
      return normalized;
    }

    try {
      return new URL(url).hostname.replace(/^www\./i, "") || "外部链接";
    } catch {
      return "外部链接";
    }
  }

  function escapeMarkdownLinkLabel(label) {
    return String(label || "")
      .replace(/\\/g, "\\\\")
      .replace(/\[/g, "\\[")
      .replace(/\]/g, "\\]");
  }

  function appendExternalReferences(text, references) {
    const normalizedText = String(text || "").trim();
    const existingUrls = new Set(
      (normalizedText.match(/https?:\/\/[^\s)]+/g) || [])
        .map((item) => item.replace(/[)>.,;:!?]+$/g, ""))
    );
    const seenUrls = new Set();
    const lines = [];

    for (const reference of Array.isArray(references) ? references : []) {
      const url = normalizeExternalUrl(reference?.url);
      if (!url || existingUrls.has(url) || seenUrls.has(url)) {
        continue;
      }

      seenUrls.add(url);
      const label = escapeMarkdownLinkLabel(normalizeReferenceLabel(reference?.label, url));
      lines.push(`- [${label}](${url})`);
    }

    if (!lines.length) {
      return normalizedText;
    }

    return normalizedText
      ? `${normalizedText}\n\n参考链接\n${lines.join("\n")}`
      : `参考链接\n${lines.join("\n")}`;
  }

  function collectExternalReferencesFromElement(element) {
    if (!element) {
      return [];
    }

    const references = [];
    const seenUrls = new Set();
    for (const anchor of element.querySelectorAll("a[href]")) {
      const url = normalizeExternalUrl(anchor.getAttribute("href") || anchor.href);
      if (!url || seenUrls.has(url)) {
        continue;
      }

      seenUrls.add(url);
      references.push({
        url,
        label: anchor.getAttribute("title") || anchor.innerText || anchor.textContent || ""
      });
    }

    return references;
  }

  function pickReferenceLabel(candidate, url) {
    const values = [
      candidate?.title,
      candidate?.display_text,
      candidate?.displayText,
      candidate?.label,
      candidate?.name,
      candidate?.site_name,
      candidate?.siteName,
      candidate?.source,
      candidate?.text
    ];

    for (const value of values) {
      const normalized = typeof value === "string"
        ? value.replace(/\s+/g, " ").trim()
        : "";
      if (normalized && normalized.length <= 120 && normalizeExternalUrl(normalized) !== url) {
        return normalized;
      }
    }

    return normalizeReferenceLabel("", url);
  }

  function collectExternalReferencesFromValue(value, target, seenUrls, visited = new WeakSet()) {
    if (!value) return;

    if (Array.isArray(value)) {
      for (const item of value) {
        collectExternalReferencesFromValue(item, target, seenUrls, visited);
      }
      return;
    }

    if (typeof value !== "object") {
      return;
    }

    if (visited.has(value)) {
      return;
    }
    visited.add(value);

    const urlCandidates = [
      value.url,
      value.uri,
      value.href,
      value.link,
      value.source_url,
      value.sourceUrl,
      value.canonical_url,
      value.canonicalUrl
    ];

    for (const candidate of urlCandidates) {
      const url = normalizeExternalUrl(candidate);
      if (!url || seenUrls.has(url)) {
        continue;
      }

      seenUrls.add(url);
      target.push({
        url,
        label: pickReferenceLabel(value, url)
      });
    }

    for (const item of Object.values(value)) {
      if (item && typeof item === "object") {
        collectExternalReferencesFromValue(item, target, seenUrls, visited);
      }
    }
  }

  function getMessageExternalReferencesFromApi(message) {
    const references = [];
    const seenUrls = new Set();
    const visited = new WeakSet();

    collectExternalReferencesFromValue(message?.metadata, references, seenUrls, visited);
    collectExternalReferencesFromValue(message?.content, references, seenUrls, visited);

    return references;
  }

  function getDeepResearchRoot(doc = document) {
    if (!doc || typeof doc.querySelector !== "function") {
      return null;
    }

    return doc.querySelector(".deep-research-result");
  }

  function prefixMarkdownLines(text, prefix) {
    return String(text || "")
      .split("\n")
      .map((line) => line.trim() ? `${prefix}${line}` : prefix.trimEnd())
      .join("\n");
  }

  function normalizeMarkdownOutput(text) {
    return String(text || "")
      .replace(/\r\n?/g, "\n")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function renderDeepResearchInline(node) {
    if (!node) {
      return "";
    }

    if (node.nodeType === Node.TEXT_NODE) {
      return String(node.textContent || "").replace(/\s+/g, " ");
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return "";
    }

    const element = node;
    const tagName = element.tagName.toLowerCase();
    if (element.matches("script, style, button, svg, textarea, input, noscript, template")) {
      return "";
    }
    if (element.getAttribute("aria-hidden") === "true") {
      return "";
    }

    if (tagName === "br") {
      return "\n";
    }

    if (tagName === "code" && element.parentElement?.tagName.toLowerCase() !== "pre") {
      const text = String(element.textContent || "").trim();
      return text ? `\`${text.replace(/`/g, "\\`")}\`` : "";
    }

    if (tagName === "strong" || tagName === "b") {
      const text = renderDeepResearchChildrenInline(element).trim();
      return text ? `**${text}**` : "";
    }

    if (tagName === "em" || tagName === "i") {
      const text = renderDeepResearchChildrenInline(element).trim();
      return text ? `*${text}*` : "";
    }

    if (tagName === "a") {
      const href = normalizeExternalUrl(element.getAttribute("href") || element.href);
      const label = renderDeepResearchChildrenInline(element).replace(/\s+/g, " ").trim();
      if (href) {
        return `[${escapeMarkdownLinkLabel(label || normalizeReferenceLabel("", href))}](${href})`;
      }
      return label;
    }

    if (tagName === "img") {
      const src = normalizeExternalUrl(element.getAttribute("src") || element.src);
      const alt = String(element.getAttribute("alt") || "").trim();
      return src ? `![${escapeMarkdownLinkLabel(alt)}](${src})` : "";
    }

    return renderDeepResearchChildrenInline(element);
  }

  function renderDeepResearchChildrenInline(element) {
    return Array.from(element.childNodes || [])
      .map((child) => renderDeepResearchInline(child))
      .join("")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/[ \t]{2,}/g, " ");
  }

  function renderDeepResearchListItem(element, prefix, depth = 0) {
    const nestedBlocks = [];
    const inlineNodes = [];

    for (const child of Array.from(element.childNodes || [])) {
      if (
        child.nodeType === Node.ELEMENT_NODE &&
        ["ul", "ol"].includes(child.tagName.toLowerCase())
      ) {
        nestedBlocks.push(renderDeepResearchBlock(child, depth + 1).trim());
        continue;
      }
      inlineNodes.push(child);
    }

    const inlineText = inlineNodes
      .map((child) => renderDeepResearchInline(child))
      .join("")
      .replace(/\s+/g, " ")
      .trim();

    const indent = "  ".repeat(depth);
    const lines = inlineText ? [`${indent}${prefix} ${inlineText}`] : [];
    for (const block of nestedBlocks.filter(Boolean)) {
      lines.push(block);
    }
    return lines.join("\n");
  }

  function renderDeepResearchTable(element) {
    const rows = Array.from(element.querySelectorAll("tr"))
      .map((row) => Array.from(row.children || []).map((cell) => renderDeepResearchChildrenInline(cell).replace(/\s+/g, " ").trim()))
      .filter((row) => row.some(Boolean));

    if (!rows.length) {
      return "";
    }

    const header = rows[0];
    const separator = header.map(() => "---");
    const body = rows.slice(1);
    const lines = [
      `| ${header.join(" | ")} |`,
      `| ${separator.join(" | ")} |`
    ];

    for (const row of body) {
      const normalizedRow = [...row];
      while (normalizedRow.length < header.length) {
        normalizedRow.push("");
      }
      lines.push(`| ${normalizedRow.join(" | ")} |`);
    }

    return lines.join("\n");
  }

  function renderDeepResearchBlock(node, depth = 0) {
    if (!node) {
      return "";
    }

    if (node.nodeType === Node.TEXT_NODE) {
      const text = String(node.textContent || "").replace(/\s+/g, " ").trim();
      return text;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return "";
    }

    const element = node;
    const tagName = element.tagName.toLowerCase();
    if (element.matches("script, style, button, svg, textarea, input, noscript, template")) {
      return "";
    }
    if (element.getAttribute("aria-hidden") === "true") {
      return "";
    }

    if (tagName === "pre") {
      const code = String(element.textContent || "").replace(/\n+$/g, "");
      return code ? `\`\`\`\n${code}\n\`\`\`` : "";
    }

    if (tagName === "blockquote") {
      const content = normalizeMarkdownOutput(renderDeepResearchChildrenBlock(element, depth));
      return content ? prefixMarkdownLines(content, "> ") : "";
    }

    if (tagName === "ul") {
      return Array.from(element.children || [])
        .filter((child) => child.tagName?.toLowerCase() === "li")
        .map((child) => renderDeepResearchListItem(child, "-", depth))
        .filter(Boolean)
        .join("\n");
    }

    if (tagName === "ol") {
      return Array.from(element.children || [])
        .filter((child) => child.tagName?.toLowerCase() === "li")
        .map((child, index) => renderDeepResearchListItem(child, `${index + 1}.`, depth))
        .filter(Boolean)
        .join("\n");
    }

    if (tagName === "table") {
      return renderDeepResearchTable(element);
    }

    if (/^h[1-6]$/.test(tagName)) {
      const level = Number(tagName.slice(1));
      const text = renderDeepResearchChildrenInline(element).replace(/\s+/g, " ").trim();
      return text ? `${"#".repeat(level)} ${text}` : "";
    }

    if (tagName === "p") {
      return renderDeepResearchChildrenInline(element)
        .replace(/\s+\n/g, "\n")
        .replace(/\n\s+/g, "\n")
        .replace(/[ \t]{2,}/g, " ")
        .trim();
    }

    if (tagName === "hr") {
      return "---";
    }

    if (tagName === "li") {
      return renderDeepResearchListItem(element, "-", depth);
    }

    if (["main", "article", "section", "header", "footer", "div"].includes(tagName)) {
      return renderDeepResearchChildrenBlock(element, depth);
    }

    const inlineText = renderDeepResearchChildrenInline(element).replace(/\s+/g, " ").trim();
    return inlineText;
  }

  function renderDeepResearchChildrenBlock(element, depth = 0) {
    return Array.from(element.childNodes || [])
      .map((child) => renderDeepResearchBlock(child, depth))
      .filter(Boolean)
      .join("\n\n");
  }

  function convertDeepResearchRootToMarkdown(root) {
    return normalizeMarkdownOutput(renderDeepResearchChildrenBlock(root));
  }

  function extractFirstMarkdownHeading(markdown) {
    const match = String(markdown || "").match(/^\s*#\s+(.+?)\s*$/m);
    return match ? match[1].trim() : "";
  }

  function stripLeadingMarkdownHeading(markdown) {
    return normalizeMarkdownOutput(String(markdown || "").replace(/^\s*#\s+.+?\n+/u, ""));
  }

  function isThoughtMarkerParagraph(text) {
    const normalized = normalizeParagraphKey(text);
    return /^Thought for\b/i.test(normalized) || /^思考/.test(normalized);
  }

  function isSourceHeadingParagraph(text) {
    const normalized = normalizeParagraphKey(text);
    return normalized.length <= 40 && /\bSources\b/i.test(normalized);
  }

  function isSourceChipParagraph(text) {
    const normalized = normalizeParagraphKey(text);
    return normalized.length <= 40 && /^[A-Za-z0-9\u00C0-\u024F\u4e00-\u9fff .&'’_-]+\s\+\d+$/.test(normalized);
  }

  function isSourceArtifactParagraph(text) {
    const normalized = normalizeParagraphKey(text);
    if (!normalized) return false;
    if (/^参考链接$/u.test(normalized)) return true;
    if (/^[-*]\s*\[[^\]]+]\(https?:\/\/[^)]+\)\s*$/i.test(normalized)) return true;

    const sourceLikeWords = normalized.match(/\b(?:Stanford Encyclopedia of Philosophy|Encyclopedia Britannica|Britannica|Wikipedia|Internet Archive|Sources?|History of Economic Thought|dokumen\.pub|JSTOR|Project Gutenberg|Gutenberg)\b/gi) || [];
    const plusCount = (normalized.match(/\+\d+/g) || []).length;
    const urlCount = (normalized.match(/https?:\/\//gi) || []).length;
    return plusCount >= 2 || urlCount >= 2 || (sourceLikeWords.length >= 2 && plusCount >= 1);
  }

  function isStructuredMarkdownLine(text) {
    const normalized = String(text || "").trimStart();
    if (!normalized) {
      return false;
    }

    return /^#{1,6}\s/.test(normalized) ||
      /^>\s?/.test(normalized) ||
      /^[-*+]\s/.test(normalized) ||
      /^\d+\.\s/.test(normalized) ||
      /^\|/.test(normalized) ||
      /^```/.test(normalized);
  }

  function cleanAssistantText(text) {
    const lines = String(text || "")
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((line) => line.replace(/[ \t]+$/g, ""));

    let startIndex = 0;
    for (let index = 0; index < lines.length; index += 1) {
      if (isThoughtMarkerParagraph(lines[index])) {
        startIndex = index + 1;
      }
    }

    const cleaned = [];
    let lastLineKey = "";
    let previousBlank = true;

    for (const line of lines.slice(startIndex)) {
      const normalized = normalizeParagraphKey(line);
      if (!normalized) {
        if (!previousBlank && cleaned.length) {
          cleaned.push("");
        }
        previousBlank = true;
        continue;
      }

      if (isThoughtMarkerParagraph(normalized)) continue;
      if (isSourceHeadingParagraph(normalized)) continue;
      if (isSourceChipParagraph(normalized)) continue;
      if (isSourceArtifactParagraph(normalized)) continue;

      const structuredLine = isStructuredMarkdownLine(line);
      if (!structuredLine && normalized === lastLineKey) {
        continue;
      }

      cleaned.push(line);
      lastLineKey = normalized;
      previousBlank = false;
    }

    while (cleaned.length && !cleaned[0].trim()) {
      cleaned.shift();
    }
    while (cleaned.length && !cleaned[cleaned.length - 1].trim()) {
      cleaned.pop();
    }

    return cleaned.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  function stripMarkdownCodeBlocks(text) {
    return String(text || "")
      .replace(/\r\n?/g, "\n")
      .replace(/```[\s\S]*?```/g, "\n\n");
  }

  function stripInlineCodeMarkers(text) {
    return String(text || "").replace(/`([^`\n]+)`/g, "$1");
  }

  function isNonBodyArtifactParagraph(text) {
    const normalized = normalizeParagraphKey(text);
    if (!normalized) {
      return false;
    }

    return isThoughtMarkerParagraph(normalized) ||
      isSourceHeadingParagraph(normalized) ||
      isSourceChipParagraph(normalized) ||
      isSourceArtifactParagraph(normalized) ||
      /^参考链接$/u.test(normalized) ||
      /^Show\s*more(?:\s*Show\s*less)?$/i.test(normalized) ||
      /^Show\s*less$/i.test(normalized);
  }

  function stripMarkdownLinksForSignal(text) {
    return String(text || "")
      .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
      .replace(/\[[^\]]*]\(https?:\/\/[^)]+\)/gi, " ")
      .replace(/https?:\/\/[^\s)]+/gi, " ");
  }

  function isReferenceOnlyMarkdownLine(line) {
    const normalized = normalizeParagraphKey(line);
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

  function hasAssistantBodyText(text) {
    const bodyCandidate = String(text || "")
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .filter((line) => {
        const normalized = normalizeParagraphKey(line);
        return normalized &&
          !isNonBodyArtifactParagraph(normalized) &&
          !isReferenceOnlyMarkdownLine(normalized);
      })
      .join("\n");

    const signal = stripMarkdownLinksForSignal(bodyCandidate)
      .replace(/[`*_#>\-|()[\]{}.,;:!?，。！？、；：（）【】《》“”‘’·]/g, " ")
      .replace(/\s+/g, "");
    return signal.length >= 20 && /[\p{L}\p{N}]/u.test(signal);
  }

  function formatExportReferenceLines(text, references) {
    const normalizedText = String(text || "").trim();
    const existingUrls = new Set(
      (normalizedText.match(/https?:\/\/[^\s)]+/g) || [])
        .map((item) => item.replace(/[)>.,;:!?]+$/g, ""))
    );
    const lines = [];
    const seenUrls = new Set();

    for (const reference of Array.isArray(references) ? references : []) {
      const url = normalizeExternalUrl(reference?.url);
      if (!url || existingUrls.has(url) || seenUrls.has(url)) {
        continue;
      }

      seenUrls.add(url);
      const label = escapeMarkdownLinkLabel(normalizeReferenceLabel(reference?.label, url));
      lines.push(`- [${label}](${url})`);
    }

    return lines;
  }

  function finalizeExportAssistantText(text, references = []) {
    const cleanedText = stripInlineCodeMarkers(cleanAssistantText(stripMarkdownCodeBlocks(text)));
    const lines = String(cleanedText || "")
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((line) => line.replace(/[ \t]+$/g, ""));
    const paragraphs = [];
    let currentParagraph = [];

    const flushParagraph = () => {
      if (!currentParagraph.length) {
        return;
      }

      const paragraphText = currentParagraph
        .join("\n")
        .replace(/Show\s*more/gi, "")
        .replace(/Show\s*less/gi, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      if (paragraphText && !isNonBodyArtifactParagraph(paragraphText)) {
        paragraphs.push(paragraphText);
      }
      currentParagraph = [];
    };

    for (const line of lines) {
      const normalizedLine = normalizeParagraphKey(
        String(line || "")
          .replace(/Show\s*more/gi, "")
          .replace(/Show\s*less/gi, "")
      );

      if (!normalizedLine) {
        flushParagraph();
        continue;
      }

      if (isNonBodyArtifactParagraph(normalizedLine)) {
        flushParagraph();
        continue;
      }

      currentParagraph.push(line);
    }

    flushParagraph();

    const cleanedParagraphs = [];
    let lastParagraphKey = "";
    for (const paragraph of paragraphs) {
      const paragraphKey = normalizeParagraphKey(paragraph);
      if (!paragraphKey || paragraphKey === lastParagraphKey) {
        continue;
      }

      cleanedParagraphs.push(paragraph);
      lastParagraphKey = paragraphKey;
    }

    const body = cleanedParagraphs.join("\n\n").trim();
    if (!hasAssistantBodyText(body)) {
      return "";
    }

    const referenceLines = formatExportReferenceLines(body, references);
    if (!referenceLines.length) {
      return body;
    }

    return body
      ? `${body}\n\n${referenceLines.join("\n")}`
      : referenceLines.join("\n");
  }

  function finalizeAssistantText(text, references = []) {
    const cleanedText = cleanAssistantText(text);
    if (!hasAssistantBodyText(cleanedText)) {
      return "";
    }
    return appendExternalReferences(cleanedText, references);
  }

  function formatCitationLinks(urls) {
    const normalizedUrls = Array.from(new Set(
      (Array.isArray(urls) ? urls : [])
        .map((url) => normalizeExternalUrl(url))
        .filter(Boolean)
    ));

    return normalizedUrls
      .map((url) => `([${escapeMarkdownLinkLabel(normalizeReferenceLabel("", url))}](${url}))`)
      .join("");
  }

  function renderVisibleMarkdownChildren(node) {
    return Array.from(node.childNodes || [])
      .map((child) => renderVisibleMarkdownNode(child))
      .join("");
  }

  function renderVisibleMarkdownList(node, ordered = false, depth = 0) {
    const items = Array.from(node.children || []).filter((child) => child.tagName?.toLowerCase() === "li");
    return items.map((child, index) => renderVisibleMarkdownListItem(child, ordered ? `${index + 1}.` : "-", depth)).join("\n");
  }

  function renderVisibleMarkdownListItem(node, marker, depth = 0) {
    const inlineNodes = [];
    const nestedBlocks = [];
    for (const child of Array.from(node.childNodes || [])) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        const tagName = child.tagName.toLowerCase();
        if (tagName === "ul" || tagName === "ol") {
          nestedBlocks.push(renderVisibleMarkdownNode(child, depth + 1).trim());
          continue;
        }
      }
      inlineNodes.push(child);
    }

    const indent = "  ".repeat(depth);
    const inlineText = inlineNodes
      .map((child) => renderVisibleMarkdownNode(child, depth))
      .join("")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim();

    const lines = inlineText ? [`${indent}${marker} ${inlineText}`] : [];
    for (const block of nestedBlocks.filter(Boolean)) {
      lines.push(block);
    }
    return lines.join("\n");
  }

  function renderVisibleMarkdownTable(node) {
    const rows = Array.from(node.querySelectorAll("tr"))
      .map((row) => Array.from(row.children || []).map((cell) => renderVisibleMarkdownChildren(cell).replace(/\s+/g, " ").trim()))
      .filter((row) => row.some(Boolean));

    if (!rows.length) {
      return "";
    }

    const header = rows[0];
    const separator = header.map(() => "---");
    const lines = [
      `| ${header.join(" | ")} |`,
      `| ${separator.join(" | ")} |`
    ];

    for (const row of rows.slice(1)) {
      const normalizedRow = [...row];
      while (normalizedRow.length < header.length) {
        normalizedRow.push("");
      }
      lines.push(`| ${normalizedRow.join(" | ")} |`);
    }

    return lines.join("\n");
  }

  function renderVisibleMarkdownNode(node, depth = 0) {
    if (!node) {
      return "";
    }

    if (node.nodeType === Node.TEXT_NODE) {
      return String(node.textContent || "");
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return "";
    }

    const element = node;
    const tagName = element.tagName.toLowerCase();
    if (element.matches("script, style, button, svg, textarea, input, noscript, template")) {
      return "";
    }
    if (element.getAttribute("aria-hidden") === "true") {
      return "";
    }

    if (tagName === "span" && element.getAttribute("data-state") === "closed") {
      const urls = Array.from(element.querySelectorAll("a[href]"))
        .map((anchor) => anchor.getAttribute("href") || anchor.href);
      return formatCitationLinks(urls);
    }

    if (tagName === "a") {
      if (element.closest('span[data-state="closed"]')) {
        return "";
      }

      const href = normalizeExternalUrl(element.getAttribute("href") || element.href);
      const label = renderVisibleMarkdownChildren(element).replace(/\s+/g, " ").trim();
      if (!href) {
        return label;
      }

      const isCitationAnchor = element.parentElement?.tagName.toLowerCase() === "sup" && /^\d+$/.test(label);
      if (isCitationAnchor) {
        return formatCitationLinks([href]);
      }

      return `[${escapeMarkdownLinkLabel(label || normalizeReferenceLabel("", href))}](${href})`;
    }

    if (tagName === "br") {
      return "\n";
    }

    if (tagName === "strong" || tagName === "b") {
      const text = renderVisibleMarkdownChildren(element).trim();
      return text ? `**${text}**` : "";
    }

    if (tagName === "em" || tagName === "i") {
      const text = renderVisibleMarkdownChildren(element).trim();
      return text ? `*${text}*` : "";
    }

    if (tagName === "code" && element.parentElement?.tagName.toLowerCase() !== "pre") {
      const text = String(element.textContent || "").trim();
      return text ? `\`${text.replace(/`/g, "\\`")}\`` : "";
    }

    if (tagName === "pre") {
      const code = String(element.textContent || "").replace(/\n+$/g, "");
      return code ? `\`\`\`\n${code}\n\`\`\`` : "";
    }

    if (/^h[1-6]$/.test(tagName)) {
      const level = Number(tagName.slice(1));
      const text = renderVisibleMarkdownChildren(element).replace(/\s+/g, " ").trim();
      return text ? `${"#".repeat(level)} ${text}\n\n` : "";
    }

    if (tagName === "p") {
      const text = renderVisibleMarkdownChildren(element)
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n[ \t]+/g, "\n")
        .replace(/[ \t]{2,}/g, " ")
        .trim();
      return text ? `${text}\n\n` : "";
    }

    if (tagName === "blockquote") {
      const content = normalizeMarkdownOutput(renderVisibleMarkdownChildren(element));
      return content ? `${prefixMarkdownLines(content, "> ")}\n\n` : "";
    }

    if (tagName === "ul") {
      const text = renderVisibleMarkdownList(element, false, depth);
      return text ? `${text}\n\n` : "";
    }

    if (tagName === "ol") {
      const text = renderVisibleMarkdownList(element, true, depth);
      return text ? `${text}\n\n` : "";
    }

    if (tagName === "table") {
      const text = renderVisibleMarkdownTable(element);
      return text ? `${text}\n\n` : "";
    }

    if (tagName === "hr") {
      return "\n---\n\n";
    }

    if (tagName === "img") {
      const src = normalizeExternalUrl(element.getAttribute("src") || element.src);
      const alt = String(element.getAttribute("alt") || "").trim();
      return src ? `![${escapeMarkdownLinkLabel(alt)}](${src})` : "";
    }

    if (tagName === "li") {
      return renderVisibleMarkdownListItem(element, "-", depth);
    }

    return renderVisibleMarkdownChildren(element);
  }

  function convertVisibleMarkdownElementToMarkdown(element) {
    return normalizeMarkdownOutput(renderVisibleMarkdownNode(element));
  }

  function getPreferredNodeText(element, selector, transform) {
    if (!element) {
      return "";
    }

    const blocks = [];
    const seen = new Set();
    for (const node of Array.from(element.querySelectorAll(selector))) {
      const text = typeof transform === "function" ? transform(node) : getTextFromNode(node);
      const normalized = String(text || "").trim();
      if (!normalized || seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      blocks.push(normalized);
    }

    return blocks.join("\n\n").trim();
  }

  function getPreferredAssistantMarkdownText(element) {
    if (!element) {
      return "";
    }

    const blocks = [];
    const seen = new Set();
    for (const node of Array.from(element.querySelectorAll("div.markdown"))) {
      const text = convertVisibleMarkdownElementToMarkdown(node);
      const normalized = String(text || "").trim();
      if (!normalized || seen.has(normalized) || !hasAssistantBodyText(normalized)) {
        continue;
      }
      seen.add(normalized);
      blocks.push(normalized);
    }

    return blocks.join("\n\n").trim();
  }

  function getAssistantText(element) {
    if (!element) return "";
    const markdownText = getPreferredAssistantMarkdownText(element);
    const fallbackText = getTextFromNode(element);
    const references = collectExternalReferencesFromElement(element);
    return finalizeAssistantText(markdownText || fallbackText, references);
  }

  function getUserText(element) {
    const text = getPreferredNodeText(element, ".whitespace-pre-wrap", (node) => getTextFromNode(node)) ||
      getTextFromNode(element);
    return String(text || "")
      .replace(/Show\s*more/gi, "")
      .replace(/Show\s*less/gi, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function normalizeMessageKey(text) {
    return String(text || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function getAssistantMessages() {
    const byRole = Array.from(document.querySelectorAll('[data-message-author-role="assistant"]'));
    if (byRole.length) {
      return byRole.filter((element) => getAssistantText(element));
    }

    const articles = Array.from(document.querySelectorAll("article"));
    return articles.filter((element) => {
      const label = [
        element.getAttribute("aria-label") || "",
        element.getAttribute("data-testid") || ""
      ].join(" ");
      if (/assistant|chatgpt/i.test(label)) return true;

      const hasCopyButton = Array.from(element.querySelectorAll("button")).some((button) => {
        const text = [
          button.getAttribute("aria-label") || "",
          button.textContent || ""
        ].join(" ");
        return /copy|复制/i.test(text);
      });

      return hasCopyButton && Boolean(getTextFromNode(element));
    });
  }

  function getAssistantSnapshot() {
    const messages = getAssistantMessages();
    const latestMessage = messages[messages.length - 1] || null;
    const key = latestMessage
      ? (
        latestMessage.getAttribute("data-message-id") ||
        latestMessage.getAttribute("data-testid") ||
        latestMessage.getAttribute("aria-label") ||
        latestMessage.id ||
        ""
      )
      : "";
    return {
      count: messages.length,
      key,
      text: getAssistantText(latestMessage)
    };
  }

  function getUserMessages() {
    const byRole = Array.from(document.querySelectorAll('[data-message-author-role="user"]'));
    if (byRole.length) {
      return byRole.filter((element) => getUserText(element));
    }

    const articles = Array.from(document.querySelectorAll("article"));
    return articles.filter((element) => {
      const label = [
        element.getAttribute("aria-label") || "",
        element.getAttribute("data-testid") || ""
      ].join(" ");
      return /user/i.test(label) && Boolean(getUserText(element));
    });
  }

  function getConversationMessages() {
    const turnArticles = Array.from(document.querySelectorAll('article[data-testid^="conversation-turn"]'));
    if (turnArticles.length) {
      return turnArticles
        .map((element, index) => {
          const roleElement = element.querySelector("[data-message-author-role]");
          const label = [
            roleElement?.getAttribute("data-message-author-role") || "",
            element.getAttribute("aria-label") || "",
            element.getAttribute("data-testid") || ""
          ].join(" ");
          const role = /user/i.test(label)
            ? "user"
            : /assistant|chatgpt/i.test(label)
              ? "assistant"
              : "";
          if (!role) return null;
          const targetElement = roleElement || element;
          const text = role === "assistant" ? getAssistantText(targetElement) : getUserText(targetElement);
          if (!text) return null;
          const key = (
            targetElement.getAttribute("data-message-id") ||
            element.getAttribute("data-testid") ||
            `${role}:${index}:${normalizeMessageKey(text)}`
          );
          return { role, text, key };
        })
        .filter(Boolean);
    }

    const roleElements = Array.from(document.querySelectorAll('[data-message-author-role]'));
    if (roleElements.length) {
      return roleElements
        .map((element) => {
          const role = element.getAttribute("data-message-author-role");
          if (role !== "user" && role !== "assistant") return null;
          const text = role === "assistant" ? getAssistantText(element) : getUserText(element);
          if (!text) return null;
          const key = (
            element.getAttribute("data-message-id") ||
            element.id ||
            element.getAttribute("data-testid") ||
            `${role}:${normalizeMessageKey(text)}`
          );
          return { role, text, key };
        })
        .filter(Boolean);
    }

    const articles = Array.from(document.querySelectorAll("article"));
    return articles
      .map((element) => {
        const label = [
          element.getAttribute("aria-label") || "",
          element.getAttribute("data-testid") || ""
        ].join(" ");
        const text = getUserText(element);
        if (!text) return null;
        if (/user/i.test(label)) {
          return { role: "user", text, key: `user:${normalizeMessageKey(text)}` };
        }
        if (/assistant|chatgpt/i.test(label)) {
          const assistantText = getAssistantText(element) || text;
          return {
            role: "assistant",
            text: assistantText,
            key: `assistant:${normalizeMessageKey(assistantText)}`
          };
        }
        return null;
      })
      .filter(Boolean);
  }

  function getConversationScrollContainer() {
    const anchors = Array.from(document.querySelectorAll('[data-message-author-role], article'));
    for (const anchor of anchors) {
      let current = anchor.parentElement;
      while (current && current !== document.body) {
        const style = window.getComputedStyle(current);
        const overflowY = style ? style.overflowY : "";
        const canScroll = /(auto|scroll)/i.test(overflowY) && current.scrollHeight > current.clientHeight + 120;
        if (canScroll) {
          return current;
        }
        current = current.parentElement;
      }
    }

    const scrollingElement = document.scrollingElement || document.documentElement;
    if (scrollingElement && scrollingElement.scrollHeight > scrollingElement.clientHeight + 120) {
      return scrollingElement;
    }

    return null;
  }

  async function waitForConversationDomStable(previousCount = 0, exportId = "") {
    let stableRounds = 0;
    let lastCount = previousCount;
    let lastHeight = -1;

    for (let round = 0; round < 18; round += 1) {
      throwIfChatExportStopped(exportId);
      await sleep(180);
      const count = getConversationMessages().length;
      const scrollContainer = getConversationScrollContainer();
      const height = scrollContainer ? scrollContainer.scrollHeight : 0;

      if (count === lastCount && height === lastHeight) {
        stableRounds += 1;
        if (stableRounds >= 2) return count;
      } else {
        stableRounds = 0;
        lastCount = count;
        lastHeight = height;
      }
    }

    return getConversationMessages().length;
  }

  async function scrollConversationToTop(container, exportId = "") {
    if (!container) return;
    let lastHeight = -1;
    let stableRounds = 0;

    for (let round = 0; round < 18; round += 1) {
      throwIfChatExportStopped(exportId);
      scrollContainerTo(container, 0);
      await waitForConversationDomStable(0, exportId);

      const currentHeight = container.scrollHeight;
      if (Math.abs(currentHeight - lastHeight) < 4) {
        stableRounds += 1;
        if (stableRounds >= 2) return;
      } else {
        stableRounds = 0;
      }

      lastHeight = currentHeight;
    }

    scrollContainerTo(container, 0);
    await waitForConversationDomStable(0, exportId);
  }

  function collectConversationMessages(targetMap) {
    for (const message of getConversationMessages()) {
      if (!message.key || targetMap.has(message.key)) continue;
      targetMap.set(message.key, {
        role: message.role,
        text: message.text
      });
    }
  }

  async function reportChatExportProgress(exportId, patch) {
    if (!exportId) return;
    if (shouldStopChatExport(exportId)) return;
    await sendRuntimeMessage("CHAT_EXPORT_PROGRESS", {
      exportId,
      ...(patch || {})
    });
  }

  function setScrollBehaviorInstant(container) {
    if (!container) {
      return () => {};
    }

    const previousContainerBehavior = container.style.scrollBehavior;
    const documentElement = document.documentElement;
    const bodyElement = document.body;
    const previousDocumentBehavior = documentElement ? documentElement.style.scrollBehavior : "";
    const previousBodyBehavior = bodyElement ? bodyElement.style.scrollBehavior : "";

    container.style.scrollBehavior = "auto";
    if (documentElement) {
      documentElement.style.scrollBehavior = "auto";
    }
    if (bodyElement) {
      bodyElement.style.scrollBehavior = "auto";
    }

    return () => {
      container.style.scrollBehavior = previousContainerBehavior;
      if (documentElement) {
        documentElement.style.scrollBehavior = previousDocumentBehavior;
      }
      if (bodyElement) {
        bodyElement.style.scrollBehavior = previousBodyBehavior;
      }
    };
  }

  function scrollContainerTo(container, top) {
    if (!container) return;

    const targetTop = Math.max(0, Number(top) || 0);
    if (container === document.scrollingElement || container === document.documentElement || container === document.body) {
      window.scrollTo(0, targetTop);
      if (document.documentElement) {
        document.documentElement.scrollTop = targetTop;
      }
      if (document.body) {
        document.body.scrollTop = targetTop;
      }
    } else if (typeof container.scrollTo === "function") {
      container.scrollTo(0, targetTop);
    } else {
      container.scrollTop = targetTop;
    }

    container.dispatchEvent(new Event("scroll"));
  }

  function getConversationIdFromLocation() {
    const match = String(window.location.pathname || "").match(/^\/(?:share|c|g\/[a-z0-9-]+\/c)\/([a-z0-9-]+)/i);
    return match ? match[1] : "";
  }

  function isShareConversationPage() {
    return /^\/share\//i.test(String(window.location.pathname || "")) &&
      !/\/continue$/i.test(String(window.location.pathname || ""));
  }

  function getSharedConversationData() {
    try {
      if (window.__NEXT_DATA__?.props?.pageProps?.serverResponse?.data) {
        return JSON.parse(JSON.stringify(window.__NEXT_DATA__.props.pageProps.serverResponse.data));
      }
      const remixData = window.__remixContext?.state?.loaderData?.["routes/share.$shareId.($action)"]?.serverResponse?.data;
      if (remixData) {
        return JSON.parse(JSON.stringify(remixData));
      }
    } catch {}
    return null;
  }

  function getApiBaseUrl() {
    return `${window.location.origin.replace(/\/$/, "")}/backend-api`;
  }

  function getSessionApiUrl() {
    return `${window.location.origin.replace(/\/$/, "")}/api/auth/session`;
  }

  function getAccountsCheckApiUrl() {
    return `${getApiBaseUrl()}/accounts/check/v4-2023-04-27`;
  }

  function getPageAccessToken() {
    return window.__remixContext?.state?.loaderData?.root?.clientBootstrap?.session?.accessToken || null;
  }

  function getCookieValue(name) {
    const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
    return match ? decodeURIComponent(match[1]) : "";
  }

  let cachedAccessTokenPromise = null;
  let cachedAccountIdPromise = null;

  async function getAccessToken() {
    const pageAccessToken = getPageAccessToken();
    if (pageAccessToken) {
      return pageAccessToken;
    }

    if (!cachedAccessTokenPromise) {
      cachedAccessTokenPromise = fetch(getSessionApiUrl(), { credentials: "include" })
        .then(async (response) => {
          if (!response.ok) {
            throw new Error(`读取会话令牌失败：${response.status}`);
          }
          const session = await response.json();
          return session?.accessToken || "";
        })
        .finally(() => {
          cachedAccessTokenPromise = null;
        });
    }

    return cachedAccessTokenPromise;
  }

  async function getWorkspaceAccountId() {
    const workspaceId = getCookieValue("_account");
    if (!workspaceId) {
      return null;
    }

    if (!cachedAccountIdPromise) {
      cachedAccountIdPromise = (async () => {
        const accessToken = await getAccessToken();
        if (!accessToken) {
          return null;
        }

        const response = await fetch(getAccountsCheckApiUrl(), {
          credentials: "include",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "X-Authorization": `Bearer ${accessToken}`
          }
        });
        if (!response.ok) {
          throw new Error(`读取工作区信息失败：${response.status}`);
        }

        const data = await response.json();
        return data?.accounts?.[workspaceId]?.account?.account_id || null;
      })().finally(() => {
        cachedAccountIdPromise = null;
      });
    }

    return cachedAccountIdPromise;
  }

  function extractTextSegments(value, target) {
    if (!value) return;

    if (typeof value === "string") {
      const text = value.trim();
      if (text) target.push(text);
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        extractTextSegments(item, target);
      }
      return;
    }

    if (typeof value !== "object") return;

    if (typeof value.text === "string") {
      extractTextSegments(value.text, target);
    }
    if (Array.isArray(value.parts)) {
      extractTextSegments(value.parts, target);
    }
    if (Array.isArray(value.text_segments)) {
      extractTextSegments(value.text_segments, target);
    }
    if (value.result) {
      extractTextSegments(value.result, target);
    }
    if (value.content) {
      extractTextSegments(value.content, target);
    }
  }

  function getMessageTextFromApi(message) {
    const parts = [];
    extractTextSegments(message?.content, parts);
    const text = parts.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
    return message?.author?.role === "assistant"
      ? text
      : text.replace(/Show\s*more/gi, "").replace(/Show\s*less/gi, "").trim();
  }

  function buildConversationPath(mapping, startNodeId) {
    const path = [];
    const visited = new Set();
    let nodeId = startNodeId;

    while (nodeId && mapping[nodeId] && !visited.has(nodeId)) {
      const node = mapping[nodeId];
      visited.add(nodeId);
      if (node.parent === undefined) {
        break;
      }
      path.unshift(node);
      nodeId = node.parent || "";
    }

    return path;
  }

  function isExportableConversationNode(node) {
    const role = node?.message?.author?.role;
    if (role !== "user" && role !== "assistant") {
      return false;
    }

    const contentType = node?.message?.content?.content_type || "";
    if (contentType === "model_editable_context" || contentType === "user_editable_context") {
      return false;
    }

    return true;
  }

  function buildMessagesFromApiPath(path, exportId) {
    const messages = [];

    for (const node of path) {
      throwIfChatExportStopped(exportId);
      if (!isExportableConversationNode(node)) {
        continue;
      }

      const message = node.message;
      const role = message.author.role;
      const text = role === "assistant"
        ? finalizeExportAssistantText(getMessageTextFromApi(message), getMessageExternalReferencesFromApi(message))
        : getMessageTextFromApi(message);
      if (!text) continue;

      messages.push({
        role,
        text,
        key: message?.id || `${role}:${normalizeMessageKey(text)}`
      });
    }

    return messages;
  }

  function mergeContinuationMessages(messages) {
    const merged = [];

    for (const message of messages) {
      const previousMessage = merged[merged.length - 1];
      if (previousMessage?.role === "assistant" && message.role === "assistant") {
        const mergedText = finalizeExportAssistantText(`${previousMessage.text}\n\n${message.text}`);
        if (mergedText) {
          previousMessage.text = mergedText;
          previousMessage.key = `${previousMessage.key}|${message.key}`;
        }
        continue;
      }

      merged.push({ ...message });
    }

    return merged;
  }

  async function getFullConversationMessagesFromApi(exportId) {
    const conversationId = getConversationIdFromLocation();
    if (!conversationId) return [];
    throwIfChatExportStopped(exportId);

    await reportChatExportProgress(exportId, {
      message: "正在读取完整对话……",
      logMessage: "开始读取完整对话数据。"
    });

    const abortController = new AbortController();
    currentExportAbortController = abortController;
    try {
      let data = null;

      if (isShareConversationPage()) {
        data = getSharedConversationData();
      } else {
        const accessToken = await getAccessToken();
        const accountId = await getWorkspaceAccountId();
        const response = await fetch(`${getApiBaseUrl()}/conversation/${conversationId}`, {
          credentials: "include",
          headers: {
            Accept: "application/json",
            ...(accessToken
              ? {
                Authorization: `Bearer ${accessToken}`,
                "X-Authorization": `Bearer ${accessToken}`
              }
              : {}),
            ...(accountId
              ? {
                "Chatgpt-Account-Id": accountId
              }
              : {})
          },
          signal: abortController.signal
        });
        if (!response.ok) {
          throw new Error(`读取完整对话失败：${response.status}`);
        }

        data = await response.json();
      }

      const mapping = data && typeof data.mapping === "object" ? data.mapping : null;
      const currentNode = typeof data?.current_node === "string" ? data.current_node : "";
      if (!mapping) {
        return [];
      }

      const startNodeId = (currentNode && mapping[currentNode] ? currentNode : "") || Object.values(mapping).find((node) => {
        const children = Array.isArray(node?.children) ? node.children : [];
        return children.length === 0;
      })?.id || "";
      if (!startNodeId) {
        return [];
      }

      const path = buildConversationPath(mapping, startNodeId);
      const messages = mergeContinuationMessages(buildMessagesFromApiPath(path, exportId));

      if (messages.length) {
        await reportChatExportProgress(exportId, {
          message: `完整对话已读取，共 ${messages.length} 条消息，正在整理问答……`,
          logMessage: `完整对话接口已读取，共 ${messages.length} 条消息。`
        });
      }

      return messages;
    } finally {
      if (currentExportAbortController === abortController) {
        currentExportAbortController = null;
      }
    }
  }

  async function getFullConversationMessages(exportId) {
    const ready = await until(() => getConversationMessages().length > 0, 10000, 150);
    if (!ready) return [];
    throwIfChatExportStopped(exportId);

    const container = getConversationScrollContainer();
    if (!container) {
      return getConversationMessages().map((message) => ({
        role: message.role,
        text: message.text
      }));
    }

    const messages = new Map();

    await reportChatExportProgress(exportId, {
      message: "正在从顶部向下完整读取历史消息……",
      logMessage: "已开始页面完整滚动读取。"
    });
    const restoreScrollBehavior = setScrollBehaviorInstant(container);

    try {
      await scrollConversationToTop(container, exportId);
      collectConversationMessages(messages);

      let stagnantRounds = 0;
      let lastScrollTop = -1;

      for (let round = 0; round < 360; round += 1) {
        throwIfChatExportStopped(exportId);
        collectConversationMessages(messages);
        if (round % 4 === 0) {
          await reportChatExportProgress(exportId, {
            message: `正在从顶部向下完整读取历史消息，已收集 ${messages.size} 条消息……`
          });
        }

        const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
        if (container.scrollTop >= maxTop - 4) {
          break;
        }

        const step = Math.max(Math.floor(container.clientHeight * 0.2), 180);
        const nextTop = Math.min(maxTop, container.scrollTop + step);
        if (Math.abs(nextTop - container.scrollTop) < 4) {
          stagnantRounds += 1;
          if (stagnantRounds >= 8) break;
        } else {
          stagnantRounds = 0;
        }

        lastScrollTop = container.scrollTop;
        scrollContainerTo(container, nextTop);
        await waitForConversationDomStable(messages.size, exportId);

        if (Math.abs(container.scrollTop - lastScrollTop) < 4) {
          stagnantRounds += 1;
          if (stagnantRounds >= 8) break;
        }
      }

      collectConversationMessages(messages);
      scrollContainerTo(container, Math.max(0, container.scrollHeight - container.clientHeight));
      await waitForConversationDomStable(messages.size, exportId);
      collectConversationMessages(messages);
    } finally {
      restoreScrollBehavior();
    }

    const result = Array.from(messages.values());
    if (result.length) {
      await reportChatExportProgress(exportId, {
        message: `页面完整滚动已读取，共 ${result.length} 条消息，正在整理问答……`
      });
    }
    return result;
  }

  function buildConversationPairs(messages) {
    const pairs = [];
    let pendingQuestion = "";
    let pendingAnswerParts = [];

    for (const message of messages) {
      if (message.role === "user") {
        if (pendingQuestion && pendingAnswerParts.length) {
          pairs.push({
            question: pendingQuestion,
            answer: pendingAnswerParts.join("\n\n").trim()
          });
        }
        pendingQuestion = message.text;
        pendingAnswerParts = [];
        continue;
      }

      if (message.role === "assistant" && pendingQuestion) {
        const normalized = normalizeParagraphKey(message.text);
        const lastPart = pendingAnswerParts.length
          ? normalizeParagraphKey(pendingAnswerParts[pendingAnswerParts.length - 1])
          : "";
        if (normalized && normalized !== lastPart) {
          pendingAnswerParts.push(message.text);
        }
      }
    }

    if (pendingQuestion && pendingAnswerParts.length) {
      pairs.push({
        question: pendingQuestion,
        answer: pendingAnswerParts.join("\n\n").trim()
      });
    }

    return pairs.filter((pair) => pair.question && pair.answer);
  }

  function summarizeConversationCounts(messages, pairs) {
    const userCount = messages.filter((message) => message.role === "user").length;
    const assistantCount = messages.filter((message) => message.role === "assistant").length;
    return {
      userCount,
      assistantCount,
      pairCount: Array.isArray(pairs) ? pairs.length : 0
    };
  }

  async function reportConversationSummary(exportId, messages, pairs, sourceLabel) {
    const summary = summarizeConversationCounts(messages, pairs);
    await reportChatExportProgress(exportId, {
      logMessage: `${sourceLabel}共读取 ${messages.length} 条消息，其中用户 ${summary.userCount} 条，助手 ${summary.assistantCount} 条，整理出 ${summary.pairCount} 组问答。`
    });
  }

  async function finalizeConversationPairs(exportId, messages, sourceLabel) {
    const pairs = buildConversationPairs(messages);
    if (pairs.length) {
      await reportConversationSummary(exportId, messages, pairs, sourceLabel);
    }
    return pairs;
  }

  async function buildConversationResult(exportId, messages, sourceLabel) {
    const pairs = await finalizeConversationPairs(exportId, messages, sourceLabel);
    if (!pairs.length) {
      return {
        ok: false,
        error: "当前对话没有可导出的问答内容。",
        sourceLabel,
        messageCount: messages.length,
        pairCount: 0
      };
    }

    return {
      ok: true,
      pairs,
      terms: pairs.map((pair) => pair.question).filter(Boolean),
      sourceLabel,
      messageCount: messages.length,
      pairCount: pairs.length
    };
  }

  async function buildConversationResultWithLogs(exportId, messages, sourceLabel) {
    return buildConversationResult(exportId, messages, sourceLabel);
  }

  function getLastVisibleUserText() {
    const messages = getUserMessages();
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const text = getUserText(messages[index]);
      if (text) {
        return text;
      }
    }
    return "";
  }

  async function requestDeepResearchMarkdownFromIframe(iframe, exportId) {
    if (!iframe?.contentWindow) {
      return null;
    }

    throwIfChatExportStopped(exportId);
    const requestId = crypto.randomUUID();
    return new Promise((resolve) => {
      let settled = false;
      const cleanup = () => {
        settled = true;
        window.removeEventListener("message", handleMessage);
        clearTimeout(timeoutId);
      };
      const finish = (value) => {
        if (settled) {
          return;
        }
        cleanup();
        resolve(value);
      };
      const handleMessage = (event) => {
        if (event.source !== iframe.contentWindow) {
          return;
        }

        const data = event.data;
        if (!data || data.type !== DEEP_RESEARCH_EXPORT_RESPONSE || data.requestId !== requestId) {
          return;
        }

        finish({
          markdown: typeof data.markdown === "string" ? data.markdown : "",
          title: typeof data.title === "string" ? data.title : ""
        });
      };

      const timeoutId = window.setTimeout(() => finish(null), 8000);
      window.addEventListener("message", handleMessage);
      iframe.contentWindow.postMessage({
        type: DEEP_RESEARCH_EXPORT_REQUEST,
        requestId
      }, "*");
    });
  }

  async function getDeepResearchConversationResult(exportId) {
    const directRoot = getDeepResearchRoot(document);
    let markdown = "";
    let title = "";

    if (directRoot) {
      markdown = convertDeepResearchRootToMarkdown(directRoot);
      title = extractFirstMarkdownHeading(markdown);
    } else {
      const iframe = document.querySelector(DEEP_RESEARCH_IFRAME_SELECTOR);
      if (!iframe) {
        return null;
      }

      await reportChatExportProgress(exportId, {
        message: "正在读取 Deep Research 正文……",
        logMessage: "已检测到 Deep Research 页面，正在读取正文。"
      });

      const iframeResult = await requestDeepResearchMarkdownFromIframe(iframe, exportId);
      markdown = iframeResult?.markdown || "";
      title = iframeResult?.title || "";
    }

    markdown = normalizeMarkdownOutput(markdown);
    if (!markdown) {
      return null;
    }

    const heading = title || extractFirstMarkdownHeading(markdown);
    const question = heading || getLastVisibleUserText() || "Deep Research";
    const answer = heading ? stripLeadingMarkdownHeading(markdown) : markdown;

    if (!answer) {
      return null;
    }

    const result = {
      ok: true,
      pairs: [
        {
          question,
          answer
        }
      ],
      terms: [question],
      sourceLabel: "Deep Research 正文",
      messageCount: 2,
      pairCount: 1
    };

    await reportChatExportProgress(exportId, {
      message: "Deep Research 正文已提取，正在保存……",
      logMessage: "已采用 Deep Research 正文导出。"
    });

    return result;
  }

  async function handleExportCurrentConversation(payload) {
    const exportId = typeof payload?.exportId === "string" ? payload.exportId : "";
    let apiMessages = [];

    try {
      const deepResearchResult = await getDeepResearchConversationResult(exportId);
      if (deepResearchResult?.ok) {
        return deepResearchResult;
      }
    } catch (error) {
      if (isChatExportStoppedError(error)) {
        return { ok: false, stopped: true, error: "对话导出已停止。" };
      }
      await reportChatExportProgress(exportId, {
        logMessage: `Deep Research 正文读取失败：${error && error.message ? error.message : String(error)}`
      });
    }

    try {
      apiMessages = await getFullConversationMessagesFromApi(exportId);
    } catch (error) {
      if (isChatExportStoppedError(error)) {
        return { ok: false, stopped: true, error: "对话导出已停止。" };
      }
      await reportChatExportProgress(exportId, {
        logMessage: `完整对话接口读取失败：${error && error.message ? error.message : String(error)}`
      });
      apiMessages = [];
    }

    if (!apiMessages.length) {
      return { ok: false, error: "当前对话没有可读取的消息内容。" };
    }

    const result = await buildConversationResultWithLogs(exportId, apiMessages, "完整对话接口");
    if (result.ok) {
      await reportChatExportProgress(exportId, {
        message: `完整对话接口已整理出 ${result.pairCount} 组问答，正在保存……`,
        logMessage: `问答整理结果：完整对话接口 ${result.pairCount} 组问答/${result.messageCount} 条消息。已采用完整对话接口。`
      });
    }
    return result;
  }

  function isGenerating() {
    return Array.from(document.querySelectorAll("button")).some((button) => {
      if (button.offsetParent === null) return false;
      const label = [
        button.getAttribute("aria-label") || "",
        button.textContent || ""
      ].join(" ").toLowerCase();
      return label.includes("stop generating") ||
        label.includes("stop") ||
        label.includes("停止生成") ||
        label.includes("停止");
    });
  }

  function createBatchStoppedError() {
    return new Error(BATCH_STOPPED_ERROR);
  }

  function createChatExportStoppedError() {
    return new Error(CHAT_EXPORT_STOPPED_ERROR);
  }

  function shouldStopBatch(batchId) {
    return batchStopRequested && currentBatchId && currentBatchId === batchId;
  }

  function shouldStopChatExport(exportId) {
    return exportStopRequested && currentExportId && (!exportId || currentExportId === exportId);
  }

  function throwIfBatchStopped(batchId) {
    if (shouldStopBatch(batchId)) {
      throw createBatchStoppedError();
    }
  }

  function throwIfChatExportStopped(exportId) {
    if (shouldStopChatExport(exportId)) {
      throw createChatExportStoppedError();
    }
  }

  function isBatchStoppedError(error) {
    return String(error && error.message ? error.message : error) === BATCH_STOPPED_ERROR;
  }

  function isChatExportStoppedError(error) {
    return String(error && error.message ? error.message : error) === CHAT_EXPORT_STOPPED_ERROR;
  }

  async function clickStopGeneratingIfVisible() {
    const stopButton = Array.from(document.querySelectorAll("button")).find((button) => {
      if (button.offsetParent === null || button.disabled) return false;
      const label = [
        button.getAttribute("aria-label") || "",
        button.textContent || ""
      ].join(" ").toLowerCase();
      return label.includes("stop generating") ||
        label.includes("停止生成") ||
        label === "stop" ||
        label === "停止";
    });

    if (!stopButton) return false;
    stopButton.click();
    await sleep(120);
    return true;
  }

  async function sleepWithStopCheck(ms, batchId) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < ms) {
      throwIfBatchStopped(batchId);
      await sleep(Math.min(200, ms - (Date.now() - startedAt)));
    }
  }

  async function waitForAssistantReply(previousAssistantSnapshot, batchId, timeout = 180000) {
    const startedAt = Date.now();
    let lastText = "";
    let stableSince = Date.now();

    while (Date.now() - startedAt < timeout) {
      throwIfBatchStopped(batchId);
      const currentSnapshot = getAssistantSnapshot();
      const latestText = currentSnapshot.text;

      if (latestText !== lastText) {
        lastText = latestText;
        stableSince = Date.now();
      }

      const hasNewReply = Boolean(latestText) && (
        currentSnapshot.count > previousAssistantSnapshot.count ||
        (currentSnapshot.key && currentSnapshot.key !== previousAssistantSnapshot.key) ||
        latestText !== previousAssistantSnapshot.text
      );
      if (hasNewReply && !isGenerating() && Date.now() - stableSince >= 1500) {
        return latestText;
      }

      await sleepWithStopCheck(500, batchId);
    }

    throwIfBatchStopped(batchId);
    const finalSnapshot = getAssistantSnapshot();
    const hasNewReply = Boolean(finalSnapshot.text) && (
      finalSnapshot.count > previousAssistantSnapshot.count ||
      (finalSnapshot.key && finalSnapshot.key !== previousAssistantSnapshot.key) ||
      finalSnapshot.text !== previousAssistantSnapshot.text
    );
    return hasNewReply ? finalSnapshot.text : "";
  }

  async function sendRuntimeMessage(type, payload) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type, payload }, (response) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(response || { ok: true });
        });
      } catch (error) {
        resolve({ ok: false, error: String(error && error.message ? error.message : error) });
      }
    });
  }

  function normalizeConversationTitle(title) {
    return String(title || "")
      .replace(/◆/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
  }

  function getBatchConversationSegment(index) {
    return Math.floor(Math.max(0, Number(index) || 0) / BATCH_CONVERSATION_ITEM_LIMIT);
  }

  function buildBatchConversationTitle(batchItems, index) {
    const item = batchItems[index] || {};
    const path = Array.isArray(item.directoryPath) ? item.directoryPath.filter(Boolean) : [];
    const baseTitle = normalizeConversationTitle(path[path.length - 1] || item.text || "批量消息");
    const totalSegments = Math.ceil(batchItems.length / BATCH_CONVERSATION_ITEM_LIMIT);
    if (totalSegments <= 1) return baseTitle;
    return normalizeConversationTitle(`${baseTitle} ${getBatchConversationSegment(index) + 1}/${totalSegments}`);
  }

  async function renameCurrentConversationBestEffort(title) {
    const cleanTitle = normalizeConversationTitle(title);
    if (!cleanTitle) return false;

    try {
      const conversationId = await until(() => getConversationIdFromLocation(), 15000, 250);
      if (!conversationId) return false;

      const accessToken = await getAccessToken().catch(() => "");
      const accountId = await getWorkspaceAccountId().catch(() => null);
      const headers = {
        Accept: "application/json",
        "Content-Type": "application/json"
      };
      if (accessToken) {
        headers.Authorization = `Bearer ${accessToken}`;
        headers["X-Authorization"] = `Bearer ${accessToken}`;
      }
      if (accountId) {
        headers["Chatgpt-Account-Id"] = accountId;
      }

      const response = await fetch(`${getApiBaseUrl()}/conversation/${conversationId}`, {
        method: "PATCH",
        credentials: "include",
        headers,
        body: JSON.stringify({ title: cleanTitle })
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async function clickNewChatIfVisible() {
    const candidates = Array.from(document.querySelectorAll("button, a")).filter((element) => {
      if (element.offsetParent === null) return false;
      const label = [
        element.getAttribute("aria-label") || "",
        element.textContent || ""
      ].join(" ");
      return /New chat|新建对话|新建聊天|新对话/.test(label);
    });

    const button = candidates[0];
    if (!button) return false;

    button.click();
    await sleep(250);
    return true;
  }

  function findVisibleComposer() {
    const explicitSelectors = [
      "#prompt-textarea",
      'form textarea',
      'main textarea',
      '[data-testid*="composer"] textarea',
      'form [contenteditable="true"][role="textbox"]',
      'form [contenteditable="true"]',
      'main [contenteditable="true"][role="textbox"]',
      'main [contenteditable="true"]'
    ];

    for (const selector of explicitSelectors) {
      const elements = Array.from(document.querySelectorAll(selector));
      const match = elements.find((element) => {
        if (!isElementVisible(element)) return false;
        if (element.getAttribute("role") === "presentation") return false;
        return Boolean(element.closest("form, main"));
      });
      if (match) {
        return {
          type: match.tagName === "TEXTAREA" ? "textarea" : "contenteditable",
          element: match
        };
      }
    }

    const forms = Array.from(document.querySelectorAll("form"));
    for (const form of forms) {
      if (!isElementVisible(form)) continue;

      const textarea = Array.from(form.querySelectorAll("textarea"))
        .find((element) => isElementVisible(element));
      if (textarea) {
        return { type: "textarea", element: textarea };
      }

      const editable = Array.from(form.querySelectorAll('[contenteditable="true"]'))
        .find((element) => isElementVisible(element) && element.getAttribute("role") !== "presentation");
      if (editable) {
        return { type: "contenteditable", element: editable };
      }
    }

    return null;
  }

  async function waitEditor() {
    return until(() => findVisibleComposer(), 20000, 150);
  }

  function triggerInput(element) {
    try {
      element.dispatchEvent(new InputEvent("input", { bubbles: true }));
    } catch {
      element.dispatchEvent(new Event("input", { bubbles: true }));
    }
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function getEditorValue(element) {
    if (!element) return "";
    if (element.tagName === "TEXTAREA" || element.tagName === "INPUT") {
      return element.value || "";
    }
    return element.textContent || "";
  }

  function setNativeInputValue(element, text) {
    const prototype = element.tagName === "TEXTAREA"
      ? window.HTMLTextAreaElement?.prototype
      : window.HTMLInputElement?.prototype;
    const descriptor = prototype ? Object.getOwnPropertyDescriptor(prototype, "value") : null;
    if (descriptor && typeof descriptor.set === "function") {
      descriptor.set.call(element, text);
      return;
    }
    element.value = text;
  }

  function triggerUserTyping(element, text) {
    const previousValue = getEditorValue(element);
    try {
      element.focus();
      const inserted = document.execCommand("insertText", false, text);
      if (inserted && getEditorValue(element) !== previousValue) return true;
    } catch {}

    try {
      const data = new DataTransfer();
      data.setData("text/plain", text);
      const pasteEvent = new ClipboardEvent("paste", { bubbles: true, clipboardData: data });
      element.dispatchEvent(pasteEvent);
      if (getEditorValue(element) !== previousValue) return true;
    } catch {}

    return false;
  }

  function hardSetValue(element, text) {
    if (element.tagName === "TEXTAREA" || element.tagName === "INPUT") {
      setNativeInputValue(element, text);
      element.focus();
      triggerInput(element);
      return;
    }

    element.focus();
    element.textContent = text;
    triggerInput(element);
  }

  function clearEditorValue(element) {
    if (element.tagName === "TEXTAREA" || element.tagName === "INPUT") {
      setNativeInputValue(element, "");
      element.focus();
      triggerInput(element);
      return;
    }

    element.focus();
    element.textContent = "";
    triggerInput(element);
  }

  async function waitForSendAccepted(editorElement, previousUserCount, timeout = 1600) {
    return until(() => {
      const currentValue = getEditorValue(editorElement).trim();
      if (!currentValue) return true;
      return getUserMessages().length > previousUserCount;
    }, timeout, 100);
  }

  async function pressSend(editorElement, previousUserCount) {
    const findSendButton = () => {
      const form = editorElement?.isConnected ? editorElement.closest("form") : null;
      const container = form?.isConnected ? form : document;
      const buttons = Array.from(container.querySelectorAll("button")).find((element) => {
        const label = [
          element.getAttribute("aria-label") || "",
          element.textContent || ""
        ].join(" ").toLowerCase();
        return element.isConnected && isElementVisible(element) && !element.disabled && (
          label.includes("send") ||
          label.includes("发送")
        );
      });

      if (buttons) return buttons;
      const submitButton = container.querySelector('button[type="submit"]:not(:disabled)');
      if (submitButton?.isConnected && isElementVisible(submitButton)) return submitButton;
      return Array.from(document.querySelectorAll('form button[type="submit"]:not(:disabled)'))
        .find((element) => element.isConnected && isElementVisible(element));
    };

    const form = editorElement?.isConnected ? editorElement.closest("form") : null;
    const button = await until(findSendButton, 8000, 100);
    if (button?.isConnected) {
      button.click();
      if (await waitForSendAccepted(editorElement, previousUserCount)) {
        return true;
      }
    }

    if (form?.isConnected && typeof form.requestSubmit === "function") {
      form.requestSubmit();
      if (await waitForSendAccepted(editorElement, previousUserCount)) {
        return true;
      }
    }

    const activeElement = document.activeElement || editorElement;
    if (!activeElement) return false;

    activeElement.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      bubbles: true
    }));
    activeElement.dispatchEvent(new KeyboardEvent("keyup", {
      key: "Enter",
      code: "Enter",
      bubbles: true
    }));

    if (await waitForSendAccepted(editorElement, previousUserCount)) {
      return true;
    }

    if (button?.isConnected) {
      button.click();
      if (await waitForSendAccepted(editorElement, previousUserCount, 2500)) {
        return true;
      }
    }

    const sendAccepted = await until(() => {
      const currentValue = getEditorValue(editorElement).trim();
      if (!currentValue) return true;
      return getUserMessages().length > previousUserCount;
    }, 5000, 100);
    return Boolean(sendAccepted);
  }

  async function fillEditorAndSend({ text, prefix, fullText, autoSend, newChat, replaceExisting }) {
    const editor = await prepareEditor(newChat);
    if (replaceExisting && getEditorValue(editor.element).trim()) {
      clearEditorValue(editor.element);
      await sleep(80);
    }

    const messageText = typeof fullText === "string" ? fullText : composeFullText(text, prefix);
    const inserted = triggerUserTyping(editor.element, messageText);
    if (!inserted) {
      hardSetValue(editor.element, messageText);
    }

    if (getEditorValue(editor.element).trim() !== messageText.trim()) {
      hardSetValue(editor.element, messageText);
    }

    if (autoSend) {
      const previousUserCount = getUserMessages().length;
      const sent = await pressSend(editor.element, previousUserCount);
      if (!sent) {
        throw new Error("发送按钮不可用。");
      }
    }
  }
  async function ensureHomeIfNeeded(newChat) {
    if (!newChat) return;
    if (location.pathname === "/" && !/\/c\//.test(location.pathname)) return;

    location.assign("/");
    await until(
      () => document.querySelector("main") || document.querySelector('[contenteditable="true"]') || document.querySelector("textarea"),
      15000,
      150
    );
  }

  async function prepareEditor(newChat) {
    await ensureHomeIfNeeded(newChat);

    if (newChat) {
      await clickNewChatIfVisible();
      await sleep(200);
    }

    const editor = await waitEditor();
    if (!editor) {
      throw new Error("没有找到输入框。");
    }

    return editor;
  }

  async function handlePayload({ text, prefix, autoSend, newChat }) {
    try {
      await fillEditorAndSend({
        text,
        prefix,
        autoSend: Boolean(autoSend),
        newChat: Boolean(newChat),
        replaceExisting: false
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String(error && error.message ? error.message : error) };
    }
  }

  async function sendPromptAndReadReply({ text, prompt, newChat, batchId }) {
    const fullText = composeFullText(text, prompt);
    return sendSingleMessageAndReadReply({ fullText, newChat, batchId });
  }

  async function sendGlobalPromptAndReadReply({ globalPrompt, newChat, batchId }) {
    return sendSingleMessageAndReadReply({ fullText: globalPrompt, newChat, batchId });
  }

  async function sendSingleMessageAndReadReply({ fullText, newChat, batchId }) {
    const previousAssistantSnapshot = getAssistantSnapshot();
    throwIfBatchStopped(batchId);
    await fillEditorAndSend({
      fullText,
      autoSend: true,
      newChat,
      replaceExisting: true
    });

    const reply = await waitForAssistantReply(previousAssistantSnapshot, batchId);
    if (!reply) {
      throw new Error("没有提取到回答内容。");
    }

    return reply;
  }

  async function handleBatchExport(payload) {
    const {
      batchId,
      globalPrompt,
      prompt,
      items,
      itemIndexes,
      totalCount,
      completedOffset,
      newChat,
      delaySeconds,
      resumeIndex,
      resumeCompleted,
      resumeFailed,
      resumeRetryAttempt
    } = payload || {};
    const oneTimePrompt = typeof globalPrompt === "string" ? globalPrompt.trim() : "";
    const batchItems = Array.isArray(items)
      ? items.map((item) => normalizeContentBatchItem(item)).filter(Boolean)
      : [];
    const originalIndexes = Array.isArray(itemIndexes) ? itemIndexes : [];
    const originalTotal = Number.isFinite(Number(totalCount)) && Number(totalCount) >= batchItems.length
      ? Number(totalCount)
      : batchItems.length;
    const skippedCount = Number.isFinite(Number(completedOffset))
      ? Math.min(originalTotal, Math.max(0, Number(completedOffset)))
      : 0;
    const shouldNewChat = newChat !== false;
    const normalizedDelaySeconds = Number.isFinite(Number(delaySeconds))
      ? Math.min(60, Math.max(0, Number(delaySeconds)))
      : 3;
    const delayMs = Math.round(normalizedDelaySeconds * 1000);
    const startIndex = Number.isFinite(Number(resumeIndex))
      ? Math.min(batchItems.length, Math.max(0, Number(resumeIndex)))
      : 0;
    const initialCompleted = Number.isFinite(Number(resumeCompleted)) ? Math.max(0, Number(resumeCompleted)) : 0;
    const initialFailed = Number.isFinite(Number(resumeFailed)) ? Math.max(0, Number(resumeFailed)) : 0;
    const initialRetryAttempt = Number.isFinite(Number(resumeRetryAttempt)) ? Math.max(0, Number(resumeRetryAttempt)) : 0;
    const isResume = startIndex > 0 || initialRetryAttempt > 0;
    const resumeDisplayIndex = Number.isFinite(Number(originalIndexes[startIndex])) && Number(originalIndexes[startIndex]) > 0
      ? Number(originalIndexes[startIndex])
      : startIndex + skippedCount + 1;

    if (!batchItems.length) {
      await sendRuntimeMessage("BATCH_FAILED", { error: "批量任务没有可执行的文本。" });
      return;
    }

    batchRunning = true;
    currentBatchId = batchId || "";
    batchStopRequested = false;
    await sendRuntimeMessage("BATCH_PROGRESS", {
      batchId,
      running: true,
      total: originalTotal,
      currentIndex: skippedCount,
      currentText: "",
      message: isResume
        ? `页面已刷新，正在重试第 ${resumeDisplayIndex}/${originalTotal} 条……`
        : skippedCount
        ? `批量任务开始执行，共 ${originalTotal} 条，已跳过 ${skippedCount} 条。`
        : `批量任务开始执行，共 ${originalTotal} 条。`,
      startedAt: new Date().toISOString()
    });

    let completed = initialCompleted;
    let failed = initialFailed;
    const renamedSegments = new Set();
    const renameAttemptsBySegment = new Map();

    const renameSegmentConversation = async (index) => {
      if (isResume) return;
      const segment = getBatchConversationSegment(index);
      if (renamedSegments.has(segment)) return;
      const attempts = renameAttemptsBySegment.get(segment) || 0;
      if (attempts >= 2) return;

      renameAttemptsBySegment.set(segment, attempts + 1);
      const renamed = await renameCurrentConversationBestEffort(buildBatchConversationTitle(batchItems, index));
      if (renamed) {
        renamedSegments.add(segment);
      }
    };

    const openNewBatchSegmentConversation = async (index, displayIndex) => {
      await sendRuntimeMessage("BATCH_PROGRESS", {
        batchId,
        running: true,
        total: originalTotal,
        currentIndex: Math.max(skippedCount, displayIndex - 1),
        currentText: "",
        message: `已处理 ${Math.max(0, index)} 条，正在新建对话……`
      });
      await prepareEditor(true);

      if (oneTimePrompt) {
        await sendRuntimeMessage("BATCH_PROGRESS", {
          batchId,
          running: true,
          total: originalTotal,
          currentIndex: Math.max(skippedCount, displayIndex - 1),
          currentText: "",
          message: "正在发送全局 Prompt……"
        });
        await sendGlobalPromptAndReadReply({ globalPrompt: oneTimePrompt, newChat: false, batchId });
      }

      await renameSegmentConversation(index);
    };

    try {
      throwIfBatchStopped(batchId);
      if (isResume) {
        await until(() => document.readyState === "complete", 20000, 150);
      }
      if (shouldNewChat && !isResume) {
        await sendRuntimeMessage("BATCH_PROGRESS", {
          batchId,
          running: true,
          total: originalTotal,
          currentIndex: skippedCount,
          currentText: "",
          message: "正在新建对话……"
        });
        await prepareEditor(true);
      } else {
        const editor = await waitEditor();
        if (!editor) {
          throw new Error("没有找到输入框。");
        }
      }

      if (oneTimePrompt && !isResume) {
        await sendRuntimeMessage("BATCH_PROGRESS", {
          batchId,
          running: true,
          total: originalTotal,
          currentIndex: skippedCount,
          currentText: "",
          message: "正在发送全局 Prompt……"
        });
        await sendGlobalPromptAndReadReply({ globalPrompt: oneTimePrompt, newChat: false, batchId });
      }
      await renameSegmentConversation(startIndex);

      for (let index = startIndex; index < batchItems.length; index += 1) {
        throwIfBatchStopped(batchId);
        const item = batchItems[index];
        const text = item.text;
        const directoryPath = item.directoryPath;
        const retryAttempt = index === startIndex ? initialRetryAttempt : 0;
        const rawIndex = Number(originalIndexes[index]);
        const displayIndex = Number.isFinite(rawIndex) && rawIndex > 0
          ? rawIndex
          : skippedCount + index + 1;
        if (!isResume && index > startIndex && index % BATCH_CONVERSATION_ITEM_LIMIT === 0) {
          await openNewBatchSegmentConversation(index, displayIndex);
        }
        await sendRuntimeMessage("BATCH_PROGRESS", {
          batchId,
          running: true,
          total: originalTotal,
          currentIndex: displayIndex,
          currentText: text,
          message: `正在处理第 ${displayIndex}/${originalTotal} 条……`
        });

        const scheduleRetry = async (reason) => {
          await sendRuntimeMessage("BATCH_PROGRESS", {
            batchId,
            running: true,
            total: originalTotal,
            currentIndex: displayIndex,
            currentText: text,
            message: `第 ${displayIndex}/${originalTotal} 条保存失败，正在刷新页面后重试。${reason || ""}`.trim()
          });
          const retryStateSaved = saveBatchRetryState({
            payload: {
              batchId,
              globalPrompt,
              prompt,
              items: batchItems,
              itemIndexes: originalIndexes,
              totalCount: originalTotal,
              completedOffset: skippedCount,
              newChat,
              delaySeconds,
              resumeIndex: index,
              resumeCompleted: completed,
              resumeFailed: failed,
              resumeRetryAttempt: retryAttempt + 1
            },
            time: Date.now()
          });
          if (!retryStateSaved) {
            throw new Error("重试状态保存失败。");
          }
          location.reload();
        };

        const handleResult = async (result) => {
          if (result && result.retry) {
            await scheduleRetry(result.error || "");
            return "retry";
          }
          if (result && result.saved) {
            completed += 1;
            return "saved";
          }
          failed += 1;
          return "failed";
        };

        try {
          const answer = await sendPromptAndReadReply({ text, prompt, newChat: false, batchId });
          const result = await sendRuntimeMessage("BATCH_ITEM_RESULT", {
            batchId,
            index: displayIndex,
            total: originalTotal,
            text,
            directoryPath,
            prompt,
            answer,
            retryAttempt,
            maxRetries: BATCH_MAX_RETRIES
          });
          if (await handleResult(result) === "retry") return;
        } catch (error) {
          const result = await sendRuntimeMessage("BATCH_ITEM_RESULT", {
            batchId,
            index: displayIndex,
            total: originalTotal,
            text,
            directoryPath,
            prompt,
            error: String(error && error.message ? error.message : error),
            retryAttempt,
            maxRetries: BATCH_MAX_RETRIES
          });
          if (await handleResult(result) === "retry") return;
        }
        await renameSegmentConversation(index);

        if (index + 1 < batchItems.length && delayMs > 0) {
          await sleepWithStopCheck(delayMs, batchId);
        }
      }

      const messageParts = skippedCount ? [`跳过 ${skippedCount} 条`] : [];
      messageParts.push(`成功 ${completed} 条`);
      if (failed) {
        messageParts.push(`失败 ${failed} 条`);
      }
      const message = `任务结束，${messageParts.join("，")}。`;

      await sendRuntimeMessage("BATCH_FINISHED", {
        batchId,
        total: originalTotal,
        completed,
        failed,
        message
      });
    } catch (error) {
      if (isBatchStoppedError(error)) {
        return;
      }

      await sendRuntimeMessage("BATCH_FAILED", {
        batchId,
        total: originalTotal,
        completed,
        failed,
        error: String(error && error.message ? error.message : error)
      });
    } finally {
      batchRunning = false;
      currentBatchId = "";
      batchStopRequested = false;
    }
  }

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || data.type !== DEEP_RESEARCH_EXPORT_REQUEST) {
      return;
    }

    const root = getDeepResearchRoot(document);
    const markdown = root ? convertDeepResearchRootToMarkdown(root) : "";
    const title = extractFirstMarkdownHeading(markdown);
    if (event.source && typeof event.source.postMessage === "function") {
      event.source.postMessage({
        type: DEEP_RESEARCH_EXPORT_RESPONSE,
        requestId: data.requestId,
        markdown,
        title
      }, "*");
    }
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (window !== window.top) {
      return;
    }

    if (!message || !message.type) return;

    if (message.type === "EXT_SEND_TO_GPT") {
      handlePayload(message.payload).then((result) => sendResponse(result));
      return true;
    }

    if (message.type === "EXT_START_BATCH_EXPORT") {
      if (batchRunning) {
        sendResponse({ ok: false, error: "批量任务仍在执行中。" });
        return;
      }

      sendResponse({ ok: true });
      handleBatchExport(message.payload).catch(async (error) => {
        batchRunning = false;
        await sendRuntimeMessage("BATCH_FAILED", {
          error: String(error && error.message ? error.message : error)
        });
      });
      return;
    }

    if (message.type === "EXT_EXPORT_CURRENT_CONVERSATION") {
      const exportId = typeof message.payload?.exportId === "string" ? message.payload.exportId : "";
      if (exportRunning) {
        sendResponse({ ok: false, error: "对话导出任务仍在执行中。" });
        return;
      }

      exportRunning = true;
      currentExportId = exportId;
      exportStopRequested = false;
      handleExportCurrentConversation(message.payload)
        .then((result) => sendResponse(result))
        .catch((error) => sendResponse({
          ok: false,
          error: String(error && error.message ? error.message : error)
        }))
        .finally(() => {
          exportRunning = false;
          currentExportId = "";
          exportStopRequested = false;
          currentExportAbortController = null;
        });
      return true;
    }

    if (message.type === "EXT_STOP_BATCH_EXPORT") {
      const batchId = typeof message.payload?.batchId === "string" ? message.payload.batchId : "";
      if (!batchRunning || !currentBatchId || (batchId && currentBatchId !== batchId)) {
        sendResponse({ ok: true });
        return;
      }

      batchStopRequested = true;
      clickStopGeneratingIfVisible().catch(() => {});
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "EXT_STOP_CHAT_EXPORT") {
      const exportId = typeof message.payload?.exportId === "string" ? message.payload.exportId : "";
      if (!exportRunning || !currentExportId || (exportId && currentExportId !== exportId)) {
        sendResponse({ ok: true });
        return;
      }

      exportStopRequested = true;
      if (currentExportAbortController) {
        currentExportAbortController.abort();
      }
      sendResponse({ ok: true });
    }
  });

  const retryState = takeBatchRetryState();
  if (retryState && retryState.payload && retryState.payload.batchId) {
    handleBatchExport(retryState.payload).catch(async (error) => {
      batchRunning = false;
      currentBatchId = "";
      batchStopRequested = false;
      await sendRuntimeMessage("BATCH_FAILED", {
        batchId: retryState.payload.batchId,
        error: String(error && error.message ? error.message : error)
      });
    });
  }
})();
