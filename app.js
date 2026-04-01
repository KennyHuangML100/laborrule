const GENERATE_MODEL = "gemini-2.5-flash";
const EMBEDDING_MODEL = "models/gemini-embedding-001";
const EMBEDDING_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001";
const GENERATE_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GENERATE_MODEL}:generateContent`;
const MODELS_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

const PDFJS_VERSION = "2.15.349";
const PDFJS_MODULE_URL = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/legacy/build/pdf.min.js`;
const PDFJS_WORKER_URL = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/legacy/build/pdf.worker.min.js`;
const MAMMOTH_BROWSER_URL = "https://unpkg.com/mammoth@1.11.0/mammoth.browser.min.js";

const EMBEDDING_DIMENSIONALITY = 768;
const EMBEDDING_BATCH_SIZE = 12;
const TOP_K = 8;
const CONTEXT_SOURCE_COUNT = 5;
const CONTEXT_MAX_CHARS = 900;
const CHUNK_MAX_CHARS = 1800;
const CHUNK_OVERLAP_CHARS = 120;
const MIN_UNIT_CHARS = 90;
const CACHE_VERSION = 2;

const STORAGE_KEYS = {
  apiKey: "lobrul-rag-gemini-key",
  remember: "lobrul-rag-remember-key",
};

const IDB_CONFIG = {
  name: "lobrul-rag-cache",
  version: 1,
  store: "embedding-snapshots",
};

const SYSTEM_PROMPT = [
  "你是台灣勞動法規與參考資料問答助手。",
  "回答必須優先根據提供的檢索片段，不要自行補充未提供的法規、判例、函釋或想像內容。",
  "如果檢索片段不足以支持明確答案，直接說明「依目前提供的參考資料，無法確定」，並指出還缺什麼資訊。",
  "請使用繁體中文。",
  "回答格式請依序包含：結論、依據、提醒。",
  "若片段中有條號或標題，請優先點出來源名稱與條號或標題。",
  "不要宣稱這是正式法律意見。",
].join("\n");

const state = {
  apiKey: "",
  rememberKey: false,
  sources: [],
  bundleHash: "",
  chunks: [],
  retrievalStats: {
    avgLength: 1,
    docCount: 0,
    docFreq: new Map(),
  },
  history: [],
  lastRetrieved: [],
  isParsingSources: false,
  isIndexing: false,
  isAnswering: false,
  isVerifyingKey: false,
};

const elements = {
  apiKeyInput: document.getElementById("apiKeyInput"),
  verifyApiKeyBtn: document.getElementById("verifyApiKeyBtn"),
  apiKeyVerifyText: document.getElementById("apiKeyVerifyText"),
  rememberKeyInput: document.getElementById("rememberKeyInput"),
  corpusFileInput: document.getElementById("corpusFileInput"),
  sourceFileList: document.getElementById("sourceFileList"),
  buildIndexBtn: document.getElementById("buildIndexBtn"),
  resetIndexBtn: document.getElementById("resetIndexBtn"),
  corpusStatusText: document.getElementById("corpusStatusText"),
  corpusMetaText: document.getElementById("corpusMetaText"),
  indexStatusText: document.getElementById("indexStatusText"),
  indexMetaText: document.getElementById("indexMetaText"),
  answerStatusText: document.getElementById("answerStatusText"),
  answerMetaText: document.getElementById("answerMetaText"),
  askForm: document.getElementById("askForm"),
  questionInput: document.getElementById("questionInput"),
  askBtn: document.getElementById("askBtn"),
  answerHistory: document.getElementById("answerHistory"),
  sourceList: document.getElementById("sourceList"),
  sampleChips: Array.from(document.querySelectorAll(".sample-chip")),
};

const runtimeCache = {
  pdfjs: null,
  mammoth: null,
  db: null,
  scriptPromises: new Map(),
};

init().catch((error) => {
  setAnswerStatus("初始化失敗", getErrorMessage(error));
  console.error(error);
});

async function init() {
  restorePreferences();
  setApiKeyVerification("idle", state.apiKey ? "尚未驗證" : "請先輸入 API Key");
  bindEvents();
  renderHistory();
  renderSources([]);
  renderSourceLibrary();
  updateButtons();
  await loadBundledCorpus();
}

function bindEvents() {
  elements.apiKeyInput.addEventListener("input", (event) => {
    state.apiKey = event.target.value.trim();
    persistPreferences();
    setApiKeyVerification("idle", state.apiKey ? "尚未驗證" : "請先輸入 API Key");
    if (!state.apiKey && !hasEmbeddings()) {
      setIndexStatus("尚未建立", "需要 API Key 才能產生 Gemini embeddings。");
    }
    updateButtons();
  });

  elements.verifyApiKeyBtn.addEventListener("click", async () => {
    try {
      await verifyApiKey();
    } catch (error) {
      setApiKeyVerification("error", getErrorMessage(error));
      console.error(error);
    }
  });

  elements.rememberKeyInput.addEventListener("change", (event) => {
    state.rememberKey = event.target.checked;
    persistPreferences();
  });

  elements.corpusFileInput.addEventListener("change", async (event) => {
    const files = Array.from(event.target.files || []);
    if (!files.length) {
      return;
    }

    try {
      await importReferenceFiles(files);
    } catch (error) {
      setCorpusStatus("解析失敗", getErrorMessage(error));
      console.error(error);
    } finally {
      event.target.value = "";
    }
  });

  elements.sourceFileList.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-remove-source-id]");
    if (!button) {
      return;
    }

    const sourceId = button.getAttribute("data-remove-source-id");
    if (!sourceId) {
      return;
    }

    try {
      await removeUploadedSource(sourceId);
    } catch (error) {
      setCorpusStatus("移除失敗", getErrorMessage(error));
      console.error(error);
    }
  });

  elements.buildIndexBtn.addEventListener("click", async () => {
    try {
      await ensureEmbeddings(true);
    } catch (error) {
      setIndexStatus("建立失敗", getErrorMessage(error));
      console.error(error);
    }
  });

  elements.resetIndexBtn.addEventListener("click", async () => {
    try {
      await clearEmbeddingCache();
      state.chunks.forEach((chunk) => {
        chunk.embedding = null;
      });
      setIndexStatus("快取已清除", "已刪除目前資料集的索引快取，需要時會重新建立。");
      updateButtons();
    } catch (error) {
      setIndexStatus("清除失敗", getErrorMessage(error));
      console.error(error);
    }
  });

  elements.askForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const question = elements.questionInput.value.trim();
    if (!question) {
      setAnswerStatus("缺少問題", "請先輸入問題。");
      elements.questionInput.focus();
      return;
    }

    try {
      await answerQuestion(question);
    } catch (error) {
      setAnswerStatus("回答失敗", getErrorMessage(error));
      console.error(error);
    }
  });

  elements.sampleChips.forEach((chip) => {
    chip.addEventListener("click", () => {
      elements.questionInput.value = chip.dataset.question || "";
      elements.questionInput.focus();
    });
  });
}

function restorePreferences() {
  state.rememberKey = localStorage.getItem(STORAGE_KEYS.remember) === "1";
  state.apiKey = state.rememberKey ? localStorage.getItem(STORAGE_KEYS.apiKey) || "" : "";
  elements.rememberKeyInput.checked = state.rememberKey;
  elements.apiKeyInput.value = state.apiKey;
}

function persistPreferences() {
  localStorage.setItem(STORAGE_KEYS.remember, state.rememberKey ? "1" : "0");
  if (state.rememberKey && state.apiKey) {
    localStorage.setItem(STORAGE_KEYS.apiKey, state.apiKey);
  } else {
    localStorage.removeItem(STORAGE_KEYS.apiKey);
  }
}

async function verifyApiKey() {
  if (!state.apiKey) {
    throw new Error("請先輸入 Gemini API Key。");
  }

  state.isVerifyingKey = true;
  setApiKeyVerification("loading", "驗證中...");
  updateButtons();

  try {
    const response = await fetch(`${MODELS_ENDPOINT}?key=${encodeURIComponent(state.apiKey)}&pageSize=1`, {
      method: "GET",
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error?.message || `API Key 驗證失敗 (${response.status})`);
    }
    setApiKeyVerification("success", "success");
  } finally {
    state.isVerifyingKey = false;
    updateButtons();
  }
}

async function loadBundledCorpus() {
  try {
    setCorpusStatus("載入中", "正在讀取內建法條 lobrul.txt。");
    const response = await fetch("./lobrul.txt", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`讀取失敗 (${response.status})`);
    }

    const buffer = await response.arrayBuffer();
    const text = decodeTextBuffer(buffer);
    const bundledSource = await createSourceRecord({
      name: "lobrul.txt",
      type: "txt",
      text,
      origin: "內建法條",
      isBundled: true,
    });
    await rebuildCorpus([bundledSource]);
    setCorpusStatus("已載入", describeCorpusSummary());
  } catch (error) {
    setCorpusStatus("等待上傳", "無法讀取內建法條，請直接上傳你的參考資料。");
    console.warn(error);
  }
}

async function importReferenceFiles(files) {
  state.isParsingSources = true;
  updateButtons();
  setCorpusStatus("解析中", `正在處理 ${files.length} 份參考資料。`);

  try {
    const uploadedSources = [];

    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      setCorpusStatus("解析中", `正在解析 ${file.name} (${index + 1}/${files.length})。`);
      const source = await createSourceFromFile(file);
      uploadedSources.push(source);
    }

    const bundledSources = state.sources.filter((source) => source.isBundled);
    const existingUploads = state.sources.filter((source) => !source.isBundled);
    const mergedUploads = mergeSources(existingUploads, uploadedSources);

    await rebuildCorpus([...bundledSources, ...mergedUploads]);
    setCorpusStatus("已載入", describeCorpusSummary());
  } finally {
    state.isParsingSources = false;
    updateButtons();
  }
}

async function removeUploadedSource(sourceId) {
  const nextSources = state.sources.filter((source) => source.id !== sourceId);
  await rebuildCorpus(nextSources);
  setCorpusStatus("已載入", describeCorpusSummary());
}

function mergeSources(existingSources, incomingSources) {
  const map = new Map(existingSources.map((source) => [source.id, source]));
  incomingSources.forEach((source) => {
    map.set(source.id, source);
  });
  return Array.from(map.values()).sort((left, right) => left.name.localeCompare(right.name, "zh-Hant"));
}

async function rebuildCorpus(sources) {
  state.sources = sources;
  state.history = [];
  state.lastRetrieved = [];
  state.chunks = buildChunksForSources(sources);
  state.retrievalStats = buildRetrievalStats(state.chunks);
  state.bundleHash = await hashText(
    JSON.stringify(
      sources.map((source) => ({
        id: source.id,
        name: source.name,
        type: source.type,
        hash: source.hash,
      }))
    )
  );

  await hydrateEmbeddingCache();
  renderHistory();
  renderSources([]);
  renderSourceLibrary();
  updateCorpusMeta();
  updateButtons();
}

async function createSourceFromFile(file) {
  const extension = getFileExtension(file.name);
  const parsed = await extractTextFromFile(file, extension);
  return createSourceRecord({
    id: buildUploadedSourceId(file),
    name: file.name,
    type: extension,
    text: parsed.text,
    sections: parsed.sections,
    warning: parsed.warning,
    origin: "使用者上傳",
    isBundled: false,
  });
}

async function createSourceRecord({ id, name, type, text, sections = [], warning = "", origin, isBundled }) {
  const normalizedText = normalizeText(text);
  if (!normalizedText) {
    throw new Error(`${name} 沒有可用內容。`);
  }

  return {
    id: id || `source-${fastHashText(`${name}:${type}:${normalizedText.slice(0, 240)}`)}`,
    name,
    type,
    text: normalizedText,
    sections: sections.map((section) => ({
      ...section,
      text: normalizeText(section.text),
    })),
    warning,
    origin,
    isBundled,
    hash: fastHashText(`${name}:${type}:${normalizedText}`),
  };
}

async function extractTextFromFile(file, extension) {
  switch (extension) {
    case "txt":
    case "md":
      return extractTextFromPlainFile(file, extension);
    case "pdf":
      return extractTextFromPdf(file);
    case "doc":
    case "docx":
      return extractTextFromWordFile(file, extension);
    default:
      throw new Error(`${file.name} 格式不支援。請上傳 txt、md、pdf、doc 或 docx。`);
  }
}

async function extractTextFromPlainFile(file, extension) {
  const buffer = await file.arrayBuffer();
  const text = decodeTextBuffer(buffer);
  return {
    text,
    type: extension,
    sections: [],
    warning: "",
  };
}

async function extractTextFromPdf(file) {
  const arrayBuffer = await file.arrayBuffer();
  const pdfjsLib = await loadPdfJs();
  pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;

  const loadingTask = pdfjsLib.getDocument({
    data: arrayBuffer,
    useWorkerFetch: true,
    isEvalSupported: false,
  });
  const pdf = await loadingTask.promise;
  const sections = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const pageText = buildPdfPageText(textContent.items || []);
    if (pageText) {
      sections.push({
        heading: `第 ${pageNumber} 頁`,
        text: pageText,
        sectionKey: `page-${pageNumber}`,
      });
    }
  }

  return {
    type: "pdf",
    text: sections.map((section) => `${section.heading}\n${section.text}`).join("\n\n"),
    sections,
    warning: sections.length ? "" : "PDF 內沒有擷取到可辨識文字，可能是掃描影像型 PDF。",
  };
}

async function extractTextFromWordFile(file, extension) {
  const arrayBuffer = await file.arrayBuffer();

  if (extension === "docx" || looksLikeZip(arrayBuffer)) {
    const mammoth = await loadMammoth();
    const result = await mammoth.extractRawText({ arrayBuffer });
    return {
      type: "docx",
      text: result.value || "",
      sections: [],
      warning: formatMammothMessages(result.messages),
    };
  }

  const extractedText = extractLegacyDocText(arrayBuffer);
  if (!extractedText) {
    throw new Error(`${file.name} 無法解析內容。建議先將舊版 .doc 另存為 .docx 後再上傳。`);
  }

  return {
    type: "doc",
    text: extractedText,
    sections: [],
    warning: "舊版 .doc 以相容模式抽取文字，段落與排序可能不完全準確。",
  };
}

function buildPdfPageText(items) {
  const lines = [];
  let currentLine = [];
  let lastY = null;

  items.forEach((item) => {
    const value = String(item?.str || "").trim();
    if (!value) {
      return;
    }

    const y = Math.round(item.transform?.[5] || 0);
    const hasBreak = item.hasEOL === true;

    if (lastY !== null && Math.abs(y - lastY) > 2) {
      flushLine();
    }

    currentLine.push(value);
    lastY = y;

    if (hasBreak) {
      flushLine();
    }
  });

  flushLine();
  return lines.join("\n");

  function flushLine() {
    if (!currentLine.length) {
      return;
    }
    const line = currentLine.join(" ").replace(/\s+/g, " ").trim();
    if (line) {
      lines.push(line);
    }
    currentLine = [];
  }
}

function extractLegacyDocText(arrayBuffer) {
  const utf16Lines = extractUtf16CandidateLines(arrayBuffer);
  const latinLines = extractPrintableByteLines(arrayBuffer);
  const merged = dedupeLines([...utf16Lines, ...latinLines]);
  const filtered = merged.filter((line) => isMeaningfulLine(line));
  return normalizeText(filtered.join("\n"));
}

function extractUtf16CandidateLines(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const lines = [];
  let current = "";

  for (let index = 0; index < bytes.length - 1; index += 2) {
    const codePoint = bytes[index] | (bytes[index + 1] << 8);
    const char = String.fromCharCode(codePoint);
    if (isReadableDocChar(char)) {
      current += char;
      continue;
    }

    if (current.trim().length >= 6) {
      lines.push(cleanLegacyLine(current));
    }
    current = "";
  }

  if (current.trim().length >= 6) {
    lines.push(cleanLegacyLine(current));
  }

  return lines;
}

function extractPrintableByteLines(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const lines = [];
  let current = "";

  for (const byte of bytes) {
    if ((byte >= 32 && byte <= 126) || byte === 9) {
      current += String.fromCharCode(byte);
      continue;
    }

    if (current.trim().length >= 12) {
      lines.push(cleanLegacyLine(current));
    }
    current = "";
  }

  if (current.trim().length >= 12) {
    lines.push(cleanLegacyLine(current));
  }

  return lines;
}

function isReadableDocChar(char) {
  if (!char) {
    return false;
  }
  const code = char.charCodeAt(0);
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    "，。、；：？！,.!?（）()[]「」『』《》【】+-/%:".includes(char) ||
    /\s/.test(char)
  );
}

function cleanLegacyLine(line) {
  return line.replace(/\u0000/g, "").replace(/\s+/g, " ").trim();
}

function isMeaningfulLine(line) {
  if (!line || line.length < 4) {
    return false;
  }

  const cleaned = line.replace(/\s+/g, "");
  if (cleaned.length < 4) {
    return false;
  }

  const readableChars = Array.from(cleaned).filter((char) => isReadableDocChar(char));
  return readableChars.length / cleaned.length >= 0.7;
}

function dedupeLines(lines) {
  const seen = new Set();
  const result = [];

  lines.forEach((line) => {
    const normalized = cleanLegacyLine(line);
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    result.push(normalized);
  });

  return result;
}

function decodeTextBuffer(buffer) {
  const encodings = ["utf-8", "utf-16le", "utf-16be", "big5"];
  const candidates = [];

  encodings.forEach((encoding) => {
    try {
      const decoder = new TextDecoder(encoding, { fatal: false });
      const text = decoder.decode(buffer);
      candidates.push({
        encoding,
        text,
        score: scoreDecodedText(text),
      });
    } catch (error) {
      console.warn(error);
    }
  });

  candidates.sort((left, right) => right.score - left.score);
  return normalizeText(candidates[0]?.text || new TextDecoder("utf-8").decode(buffer));
}

function scoreDecodedText(text) {
  if (!text) {
    return -Infinity;
  }

  const replacementPenalty = (text.match(/\uFFFD/g) || []).length * 8;
  const weirdPenalty = (text.match(/[�□]/g) || []).length * 6;
  const readableCount = (text.match(/[\u4E00-\u9FFF\w，。、；：？！,.!?()\[\]「」『』《》【】\s-]/g) || []).length;
  return readableCount - replacementPenalty - weirdPenalty;
}

function looksLikeZip(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  return bytes[0] === 0x50 && bytes[1] === 0x4b;
}

function formatMammothMessages(messages = []) {
  const warning = messages.find((message) => message.type === "warning");
  return warning?.message || "";
}

function buildUploadedSourceId(file) {
  return `upload-${fastHashText(`${file.name}:${file.size}:${file.lastModified}`)}`;
}

function getFileExtension(filename) {
  const parts = String(filename).toLowerCase().split(".");
  return parts.length > 1 ? parts.pop() : "";
}

function normalizeText(text) {
  return String(text)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\u0000/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function buildChunksForSources(sources) {
  const chunks = [];
  let chunkIndex = 0;

  sources.forEach((source) => {
    const sections = source.sections.length ? source.sections : deriveSections(source);
    sections.forEach((section) => {
      const chunkTexts = splitSectionIntoChunks(section.text);
      chunkTexts.forEach((chunkText, partIndex) => {
        const heading = chunkTexts.length > 1 ? `${section.heading}（片段 ${partIndex + 1}）` : section.heading;
        const retrievalText = [
          `來源：${source.name}`,
          section.chapter ? `章節：${section.chapter}` : "",
          heading ? `標題：${heading}` : "",
          chunkText,
        ]
          .filter(Boolean)
          .join("\n");

        const tokens = tokenizeForSearch(retrievalText);
        const termFrequency = countTokens(tokens);

        chunks.push({
          id: `chunk-${++chunkIndex}`,
          chunkHash: fastHashText(`${source.id}:${section.sectionKey}:${heading}:${chunkText}`),
          sourceId: source.id,
          sourceName: source.name,
          sourceType: source.type,
          sourceOrigin: source.origin,
          heading,
          chapter: section.chapter || "",
          articleNumber: section.articleNumber || "",
          sectionKey: section.sectionKey || heading,
          text: chunkText,
          retrievalText,
          tokens,
          termFrequency,
          tokenLength: tokens.length || 1,
          embedding: null,
          warning: source.warning || "",
        });
      });
    });
  });

  return chunks;
}

function deriveSections(source) {
  if (looksLikeLawDocument(source.text)) {
    return parseLawSections(source);
  }

  if (source.type === "md") {
    return parseMarkdownSections(source);
  }

  return parseGenericSections(source);
}

function looksLikeLawDocument(text) {
  return /^第\s*[一二三四五六七八九十百零]+\s*章/m.test(text) && /^第\s*\d+(?:-\d+)?\s*條/m.test(text);
}

function parseLawSections(source) {
  const lines = source.text.split("\n");
  const sections = [];
  let chapter = "";
  let articleNumber = "";
  let currentLines = [];

  const flushArticle = () => {
    if (!articleNumber) {
      return;
    }
    const body = joinLawLines(currentLines);
    if (!body) {
      return;
    }
    sections.push({
      heading: `第 ${articleNumber} 條`,
      chapter,
      articleNumber,
      sectionKey: `article-${articleNumber}`,
      text: body,
    });
  };

  lines.forEach((rawLine) => {
    const line = rawLine.trimEnd();
    const chapterMatch = line.match(/^第\s*[一二三四五六七八九十百零]+\s*章/);
    const articleMatch = line.match(/^第\s*(\d+(?:-\d+)?)\s*條/);

    if (chapterMatch) {
      flushArticle();
      chapter = line.trim();
      articleNumber = "";
      currentLines = [];
      return;
    }

    if (articleMatch) {
      flushArticle();
      articleNumber = articleMatch[1];
      currentLines = [];
      return;
    }

    if (articleNumber) {
      currentLines.push(line);
    }
  });

  flushArticle();
  return sections.length
    ? sections
    : [
        {
          heading: source.name,
          chapter: "",
          articleNumber: "",
          sectionKey: source.id,
          text: source.text,
        },
      ];
}

function joinLawLines(lines) {
  const paragraphs = [];
  let current = "";

  lines.forEach((rawLine) => {
    const line = rawLine.trim();
    if (!line) {
      if (current) {
        paragraphs.push(current);
        current = "";
      }
      return;
    }

    const startsNumberedItem =
      /^[一二三四五六七八九十]+、/.test(line) ||
      /^\(\w+\)/.test(line) ||
      /^\d+\./.test(line) ||
      /^第\s*\d+(?:-\d+)?\s*款/.test(line);

    if (!current) {
      current = line;
      return;
    }

    if (startsNumberedItem) {
      paragraphs.push(current);
      current = line;
      return;
    }

    current += line;
  });

  if (current) {
    paragraphs.push(current);
  }

  return paragraphs.join("\n");
}

function parseMarkdownSections(source) {
  const lines = source.text.split("\n");
  const sections = [];
  let currentHeading = source.name;
  let currentLevel = 0;
  let currentLines = [];
  let sectionIndex = 0;

  const flushSection = () => {
    const body = normalizeText(currentLines.join("\n"));
    if (!body) {
      return;
    }
    sections.push({
      heading: currentHeading,
      chapter: currentLevel ? `Markdown H${currentLevel}` : "",
      articleNumber: "",
      sectionKey: `md-${sectionIndex++}-${currentHeading}`,
      text: body,
    });
  };

  lines.forEach((line) => {
    const match = line.match(/^(#{1,6})\s+(.+)/);
    if (match) {
      flushSection();
      currentHeading = match[2].trim();
      currentLevel = match[1].length;
      currentLines = [];
      return;
    }

    currentLines.push(line);
  });

  flushSection();

  return sections.length
    ? sections
    : [
        {
          heading: source.name,
          chapter: "",
          articleNumber: "",
          sectionKey: source.id,
          text: source.text,
        },
      ];
}

function parseGenericSections(source) {
  const paragraphs = splitIntoSemanticUnits(source.text);
  const groups = [];
  let current = [];
  let currentLength = 0;

  paragraphs.forEach((paragraph) => {
    if (currentLength > 0 && currentLength + paragraph.length > 1600) {
      groups.push(current.join("\n"));
      current = [];
      currentLength = 0;
    }

    current.push(paragraph);
    currentLength += paragraph.length;
  });

  if (current.length) {
    groups.push(current.join("\n"));
  }

  return groups.length
    ? groups.map((text, index) => ({
        heading: groups.length === 1 ? source.name : `${source.name}（段落 ${index + 1}）`,
        chapter: source.type === "pdf" ? "PDF" : source.type.toUpperCase(),
        articleNumber: "",
        sectionKey: `section-${index + 1}`,
        text,
      }))
    : [
        {
          heading: source.name,
          chapter: "",
          articleNumber: "",
          sectionKey: source.id,
          text: source.text,
        },
      ];
}

function splitSectionIntoChunks(text) {
  const units = splitIntoSemanticUnits(text);
  if (!units.length) {
    return [];
  }

  const chunks = [];
  let currentUnits = [];
  let currentLength = 0;

  units.forEach((unit) => {
    if (currentLength > 0 && currentLength + unit.length > CHUNK_MAX_CHARS) {
      chunks.push(currentUnits.join("\n"));
      const overlapUnits = buildOverlapUnits(currentUnits, CHUNK_OVERLAP_CHARS);
      currentUnits = overlapUnits.slice();
      currentLength = currentUnits.join("\n").length;
    }

    currentUnits.push(unit);
    currentLength += unit.length;
  });

  if (currentUnits.length) {
    chunks.push(currentUnits.join("\n"));
  }

  return chunks.map((chunk) => normalizeText(chunk)).filter(Boolean);
}

function splitIntoSemanticUnits(text) {
  const paragraphs = normalizeText(text)
    .split(/\n{2,}/)
    .flatMap((paragraph) => splitLargeParagraph(paragraph))
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length >= MIN_UNIT_CHARS || /第\s*\d+(?:-\d+)?\s*條/.test(paragraph));

  if (paragraphs.length) {
    return paragraphs;
  }

  return splitLargeParagraph(text).map((item) => item.trim()).filter(Boolean);
}

function splitLargeParagraph(text) {
  const clean = normalizeText(text).replace(/\n/g, " ");
  if (clean.length <= CHUNK_MAX_CHARS * 0.75) {
    return clean ? [clean] : [];
  }

  const sentences = [];
  let current = "";

  Array.from(clean).forEach((char) => {
    current += char;
    if ("。！？；.!?;".includes(char) && current.trim()) {
      sentences.push(current.trim());
      current = "";
    }
  });

  if (current.trim()) {
    sentences.push(current.trim());
  }

  if (!sentences.length) {
    return [clean];
  }

  const parts = [];
  let bucket = "";

  sentences.forEach((sentence) => {
    if (bucket && bucket.length + sentence.length > CHUNK_MAX_CHARS * 0.7) {
      parts.push(bucket.trim());
      bucket = "";
    }
    bucket += `${sentence} `;
  });

  if (bucket.trim()) {
    parts.push(bucket.trim());
  }

  return parts;
}

function buildOverlapUnits(units, overlapChars) {
  const overlap = [];
  let length = 0;

  for (let index = units.length - 1; index >= 0; index -= 1) {
    const unit = units[index];
    overlap.unshift(unit);
    length += unit.length;
    if (length >= overlapChars) {
      break;
    }
  }

  return overlap;
}

function tokenizeForSearch(text) {
  const normalized = String(text).toLowerCase();
  const tokens = [];
  const latinTokens = normalized.match(/[a-z0-9]{2,}/g) || [];
  tokens.push(...latinTokens);

  const cjkSequences = normalized.match(/[\u3400-\u9fff]{2,}/g) || [];
  cjkSequences.forEach((sequence) => {
    if (sequence.length <= 4) {
      tokens.push(sequence);
    }
    for (let index = 0; index < sequence.length - 1; index += 1) {
      tokens.push(sequence.slice(index, index + 2));
    }
  });

  return tokens;
}

function countTokens(tokens) {
  return tokens.reduce((result, token) => {
    result[token] = (result[token] || 0) + 1;
    return result;
  }, Object.create(null));
}

function buildRetrievalStats(chunks) {
  const docFreq = new Map();
  let totalLength = 0;

  chunks.forEach((chunk) => {
    totalLength += chunk.tokenLength;
    const uniqueTokens = new Set(chunk.tokens);
    uniqueTokens.forEach((token) => {
      docFreq.set(token, (docFreq.get(token) || 0) + 1);
    });
  });

  return {
    avgLength: totalLength / Math.max(chunks.length, 1),
    docCount: chunks.length,
    docFreq,
  };
}

async function hydrateEmbeddingCache() {
  state.chunks.forEach((chunk) => {
    chunk.embedding = null;
  });

  if (!state.bundleHash || !state.chunks.length) {
    setIndexStatus("尚未建立", "尚未有可索引的參考資料。");
    return;
  }

  try {
    const snapshot = await readEmbeddingSnapshot(state.bundleHash);
    const isValid =
      snapshot &&
      snapshot.version === CACHE_VERSION &&
      snapshot.bundleHash === state.bundleHash &&
      snapshot.model === EMBEDDING_MODEL &&
      snapshot.outputDimensionality === EMBEDDING_DIMENSIONALITY &&
      Array.isArray(snapshot.entries);

    if (!isValid) {
      setIndexStatus("尚未建立", "找不到符合目前資料集的本機 embeddings 快取。");
      return;
    }

    const embeddingMap = new Map(snapshot.entries.map((entry) => [entry.chunkHash, entry.embedding]));
    state.chunks.forEach((chunk) => {
      chunk.embedding = embeddingMap.get(chunk.chunkHash) || null;
    });

    setIndexStatus(
      hasEmbeddings() ? "已載入快取" : "部分快取可用",
      hasEmbeddings()
        ? "目前資料集的 embeddings 快取已載入，可直接提問。"
        : "找到部分快取，但仍需要補齊新的 embeddings。"
    );
  } catch (error) {
    console.warn(error);
    setIndexStatus("尚未建立", "本機快取讀取失敗，之後會重新建立索引。");
  }
}

function hasEmbeddings() {
  return state.chunks.length > 0 && state.chunks.every((chunk) => Array.isArray(chunk.embedding));
}

async function ensureEmbeddings(forceRebuild = false) {
  if (!state.sources.length || !state.chunks.length) {
    throw new Error("請先載入至少一份參考資料。");
  }

  if (!state.apiKey) {
    throw new Error("請先輸入 Gemini API Key。");
  }

  if (forceRebuild) {
    await clearEmbeddingCache();
    state.chunks.forEach((chunk) => {
      chunk.embedding = null;
    });
  } else if (hasEmbeddings()) {
    setIndexStatus("索引已就緒", "目前資料集已有 embeddings，可直接提問。");
    updateButtons();
    return;
  }

  state.isIndexing = true;
  updateButtons();
  setIndexStatus("建立中", `正在為 ${state.chunks.length} 個 chunks 建立 embeddings。`);

  try {
    const pendingChunks = state.chunks.filter((chunk) => !Array.isArray(chunk.embedding));
    for (let start = 0; start < pendingChunks.length; start += EMBEDDING_BATCH_SIZE) {
      const batch = pendingChunks.slice(start, start + EMBEDDING_BATCH_SIZE);
      const embeddings = await embedDocumentBatch(batch);
      if (embeddings.length !== batch.length) {
        throw new Error("Gemini embeddings 回傳筆數與 chunk 數量不一致。");
      }

      batch.forEach((chunk, index) => {
        chunk.embedding = embeddings[index];
      });

      setIndexStatus(
        "建立中",
        `已完成 ${Math.min(start + batch.length, pendingChunks.length)} / ${pendingChunks.length} 個 chunks。`
      );
    }

    const cacheSaved = await saveEmbeddingSnapshot();
    setIndexStatus(
      "索引完成",
      cacheSaved
        ? "Embeddings 已寫入 IndexedDB 快取，重新整理後可直接使用。"
        : "Embeddings 已建立，但本機快取寫入失敗，重新整理後需要重建。"
    );
  } finally {
    state.isIndexing = false;
    updateButtons();
  }
}

async function answerQuestion(question) {
  if (state.isAnswering) {
    return;
  }

  state.isAnswering = true;
  updateButtons();
  setAnswerStatus("檢索中", "正在檢索參考資料並建立回答。");

  try {
    await ensureEmbeddings(false);
    const retrieved = await retrieveChunks(question);
    state.lastRetrieved = retrieved;
    renderSources(retrieved);

    const contextBlock = retrieved
      .slice(0, CONTEXT_SOURCE_COUNT)
      .map((item, index) => {
        return [
          `【來源 ${index + 1}】`,
          `檔名：${item.chunk.sourceName}`,
          item.chunk.chapter ? `分類：${item.chunk.chapter}` : "",
          item.chunk.heading ? `標題：${item.chunk.heading}` : "",
          clipText(item.chunk.text, CONTEXT_MAX_CHARS),
        ]
          .filter(Boolean)
          .join("\n");
      })
      .join("\n\n");

    const prompt = [
      `問題：${question}`,
      "",
      "檢索片段：",
      contextBlock,
      "",
      "請嚴格依照以上片段回答；如果資料不足，就直接說明不足。",
    ].join("\n");

    const response = await geminiRequest(GENERATE_ENDPOINT, {
      systemInstruction: {
        parts: [{ text: SYSTEM_PROMPT }],
      },
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }],
        },
      ],
      generationConfig: {
        temperature: 0.2,
        topP: 0.9,
      },
    });

    const answerText = extractResponseText(response);
    if (!answerText) {
      throw new Error("Gemini 沒有回傳可用的文字內容。");
    }

    const citations = dedupeValues(
      retrieved.map((item) => {
        return [item.chunk.sourceName, item.chunk.heading].filter(Boolean).join(" · ");
      })
    );

    state.history.unshift({
      id: `answer-${Date.now()}`,
      question,
      answer: answerText.trim(),
      citations,
    });

    renderHistory();
    setAnswerStatus("完成", `已完成回答，主要依據 ${citations.slice(0, 4).join("、")}。`);
  } finally {
    state.isAnswering = false;
    updateButtons();
  }
}

async function retrieveChunks(question) {
  const queryEmbedding = await embedQuery(question);
  const questionTokens = tokenizeForSearch(question);
  const referencedArticles = extractArticleRefs(question);

  const scored = state.chunks.map((chunk) => {
    const semanticScore = cosineSimilarity(queryEmbedding, chunk.embedding || []);
    const lexicalScore = computeBm25Score(questionTokens, chunk);
    const articleBoost = referencedArticles.has(chunk.articleNumber) ? 0.12 : 0;
    return {
      chunk,
      semanticScore,
      lexicalScore,
      articleBoost,
    };
  });

  normalizeScoreField(scored, "semanticScore", "semanticNorm");
  normalizeScoreField(scored, "lexicalScore", "lexicalNorm");

  scored.forEach((item) => {
    item.combinedScore = item.semanticNorm * 0.72 + item.lexicalNorm * 0.28 + item.articleBoost;
  });

  scored.sort((left, right) => right.combinedScore - left.combinedScore);
  return selectDiverseResults(scored, TOP_K);
}

async function embedQuery(question) {
  const response = await geminiRequest(`${EMBEDDING_ENDPOINT}:embedContent`, {
    model: EMBEDDING_MODEL,
    taskType: "RETRIEVAL_QUERY",
    outputDimensionality: EMBEDDING_DIMENSIONALITY,
    content: {
      parts: [{ text: question }],
    },
  });

  const queryEmbedding = response.embedding?.values || response.embeddings?.[0]?.values;
  if (!Array.isArray(queryEmbedding)) {
    throw new Error("無法取得查詢 embedding。");
  }

  return queryEmbedding;
}

async function embedDocumentBatch(chunks) {
  try {
    const response = await geminiRequest(`${EMBEDDING_ENDPOINT}:batchEmbedContents`, {
      requests: chunks.map((chunk) => ({
        model: EMBEDDING_MODEL,
        taskType: "RETRIEVAL_DOCUMENT",
        title: [chunk.sourceName, chunk.heading].filter(Boolean).join(" · "),
        outputDimensionality: EMBEDDING_DIMENSIONALITY,
        content: {
          parts: [{ text: chunk.retrievalText }],
        },
      })),
    });

    return (response.embeddings || []).map((embedding) => embedding?.values || null);
  } catch (error) {
    if (isRateLimitError(error)) {
      throw error;
    }
    console.warn("batchEmbedContents failed, falling back to embedContent", error);
    return embedDocumentBatchIndividually(chunks);
  }
}

async function embedDocumentBatchIndividually(chunks) {
  const embeddings = [];

  for (const chunk of chunks) {
    const response = await geminiRequest(`${EMBEDDING_ENDPOINT}:embedContent`, {
      model: EMBEDDING_MODEL,
      taskType: "RETRIEVAL_DOCUMENT",
      title: [chunk.sourceName, chunk.heading].filter(Boolean).join(" · "),
      outputDimensionality: EMBEDDING_DIMENSIONALITY,
      content: {
        parts: [{ text: chunk.retrievalText }],
      },
    });

    const values = response.embedding?.values || response.embeddings?.[0]?.values;
    if (!Array.isArray(values)) {
      throw new Error("單筆 embedding 回傳格式不正確。");
    }
    embeddings.push(values);
  }

  return embeddings;
}

function computeBm25Score(queryTokens, chunk) {
  if (!queryTokens.length) {
    return 0;
  }

  const uniqueQueryTokens = dedupeValues(queryTokens);
  const avgLength = state.retrievalStats.avgLength || 1;
  const docCount = state.retrievalStats.docCount || 1;
  const k1 = 1.2;
  const b = 0.75;
  let score = 0;

  uniqueQueryTokens.forEach((token) => {
    const tf = chunk.termFrequency[token] || 0;
    if (!tf) {
      return;
    }

    const df = state.retrievalStats.docFreq.get(token) || 0;
    const idf = Math.log(1 + (docCount - df + 0.5) / (df + 0.5));
    const numerator = tf * (k1 + 1);
    const denominator = tf + k1 * (1 - b + b * (chunk.tokenLength / avgLength));
    score += idf * (numerator / denominator);
  });

  return score;
}

function normalizeScoreField(items, inputField, outputField) {
  const values = items.map((item) => item[inputField]);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min;

  items.forEach((item) => {
    item[outputField] = range > 0 ? (item[inputField] - min) / range : 0;
  });
}

function selectDiverseResults(candidates, limit) {
  const selected = [];
  const remaining = candidates.slice(0, Math.max(limit * 3, limit));

  while (remaining.length && selected.length < limit) {
    let bestIndex = 0;
    let bestScore = -Infinity;

    remaining.forEach((candidate, index) => {
      let redundancy = 0;

      selected.forEach((chosen) => {
        redundancy = Math.max(redundancy, cosineSimilarity(candidate.chunk.embedding || [], chosen.chunk.embedding || []));
        if (candidate.chunk.sourceId === chosen.chunk.sourceId && candidate.chunk.sectionKey === chosen.chunk.sectionKey) {
          redundancy = Math.max(redundancy, 0.98);
        }
      });

      const mmrScore = selected.length
        ? candidate.combinedScore * 0.82 - redundancy * 0.18
        : candidate.combinedScore;

      if (mmrScore > bestScore) {
        bestScore = mmrScore;
        bestIndex = index;
      }
    });

    selected.push(remaining.splice(bestIndex, 1)[0]);
  }

  return selected;
}

function extractArticleRefs(question) {
  const matches = question.match(/第\s*(\d+(?:-\d+)?)\s*條/g) || [];
  return new Set(matches.map((match) => match.match(/\d+(?:-\d+)?/)).filter(Boolean).map((match) => match[0]));
}

function cosineSimilarity(left, right) {
  if (!left.length || !right.length || left.length !== right.length) {
    return 0;
  }

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;

  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }

  if (!leftNorm || !rightNorm) {
    return 0;
  }

  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

async function geminiRequest(url, body) {
  const apiKey = state.apiKey.trim();
  if (!apiKey) {
    throw new Error("請先輸入 Gemini API Key。");
  }

  const maxAttempts = 4;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await fetch(`${url}?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const payload = await response.json().catch(() => ({}));
    if (response.ok) {
      return payload;
    }

    const error = buildGeminiError(payload, response);
    if (attempt < maxAttempts && shouldRetryGeminiRequest(error)) {
      const retryDelayMs = getRetryDelayMs(error, attempt);
      await sleep(retryDelayMs);
      continue;
    }

    throw error;
  }
}

function extractResponseText(response) {
  const parts = response.candidates?.[0]?.content?.parts || [];
  return parts
    .map((part) => part.text || "")
    .join("")
    .trim();
}

function renderHistory() {
  if (!state.history.length) {
    elements.answerHistory.className = "answer-history empty-state";
    elements.answerHistory.textContent = "尚未有回答。先輸入 API Key，建立索引後再提問。";
    return;
  }

  elements.answerHistory.className = "answer-history";
  elements.answerHistory.replaceChildren(
    ...state.history.map((item) => {
      const card = document.createElement("article");
      card.className = "answer-card";

      const question = document.createElement("p");
      question.className = "answer-card-question";
      question.textContent = `Q：${item.question}`;

      const answer = document.createElement("div");
      answer.className = "answer-card-answer";
      item.answer
        .split(/\n{2,}/)
        .filter(Boolean)
        .forEach((section) => {
          const paragraph = document.createElement("p");
          paragraph.textContent = section.trim();
          answer.appendChild(paragraph);
        });

      const citations = document.createElement("div");
      citations.className = "citation-row";
      item.citations.forEach((citation) => {
        const tag = document.createElement("span");
        tag.className = "citation-tag";
        tag.textContent = citation;
        citations.appendChild(tag);
      });

      card.append(question, answer, citations);
      return card;
    })
  );
}

function renderSources(sources) {
  if (!sources.length) {
    elements.sourceList.className = "source-list empty-state";
    elements.sourceList.textContent = "送出問題後會顯示來源片段。";
    return;
  }

  elements.sourceList.className = "source-list";
  elements.sourceList.replaceChildren(
    ...sources.map((item) => {
      const card = document.createElement("article");
      card.className = "source-card";

      const heading = document.createElement("div");
      heading.className = "source-heading";

      const titleWrap = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = item.chunk.sourceName;
      const subtitle = document.createElement("span");
      subtitle.textContent = item.chunk.heading || item.chunk.chapter || item.chunk.sourceType.toUpperCase();
      titleWrap.append(title, subtitle);

      const score = document.createElement("div");
      score.className = "source-score";
      score.textContent = `相似度 ${item.combinedScore.toFixed(3)}`;

      heading.append(titleWrap, score);

      const excerpt = document.createElement("p");
      excerpt.className = "source-excerpt";
      excerpt.textContent = clipText(item.chunk.text, 240);

      card.append(heading, excerpt);
      return card;
    })
  );
}

function renderSourceLibrary() {
  if (!state.sources.length) {
    elements.sourceFileList.className = "source-file-list empty-state compact-empty";
    elements.sourceFileList.textContent = "尚未載入參考資料。";
    return;
  }

  elements.sourceFileList.className = "source-file-list";
  elements.sourceFileList.replaceChildren(
    ...state.sources.map((source) => {
      const item = document.createElement("article");
      item.className = "source-file-item";

      const head = document.createElement("div");
      head.className = "source-file-head";

      const infoWrap = document.createElement("div");
      const title = document.createElement("p");
      title.className = "source-file-name";
      title.textContent = source.name;

      const meta = document.createElement("div");
      meta.className = "source-file-meta";

      const typeBadge = document.createElement("span");
      typeBadge.className = "source-badge";
      typeBadge.textContent = source.type.toUpperCase();
      meta.appendChild(typeBadge);

      const originBadge = document.createElement("span");
      originBadge.className = "source-badge";
      originBadge.textContent = source.isBundled ? "內建" : "上傳";
      meta.appendChild(originBadge);

      if (source.warning) {
        const warningBadge = document.createElement("span");
        warningBadge.className = "source-badge warning";
        warningBadge.textContent = "解析提醒";
        meta.appendChild(warningBadge);
      }

      infoWrap.append(title, meta);
      head.appendChild(infoWrap);

      if (!source.isBundled) {
        const removeButton = document.createElement("button");
        removeButton.className = "source-remove-btn";
        removeButton.type = "button";
        removeButton.textContent = "移除";
        removeButton.setAttribute("data-remove-source-id", source.id);
        head.appendChild(removeButton);
      }

      item.appendChild(head);

      const note = document.createElement("p");
      note.className = "source-file-note";
      const relatedChunkCount = state.chunks.filter((chunk) => chunk.sourceId === source.id).length;
      note.textContent = source.warning
        ? `${source.warning} 目前共切成 ${relatedChunkCount} 個 chunks。`
        : `${source.origin}，目前共切成 ${relatedChunkCount} 個 chunks。`;
      item.appendChild(note);

      return item;
    })
  );
}

function updateCorpusMeta() {
  if (!state.sources.length) {
    elements.corpusMetaText.textContent = "等待載入內建法條或使用者參考資料。";
    return;
  }

  elements.corpusMetaText.textContent = `${state.sources.length} 份資料，共 ${state.chunks.length} 個 chunks。`;
}

function describeCorpusSummary() {
  if (!state.sources.length) {
    return "尚未載入參考資料。";
  }

  return `已載入 ${state.sources.length} 份資料，共 ${state.chunks.length} 個 chunks。`;
}

function clipText(text, maxLength) {
  const compact = String(text).replace(/\s+/g, " ").trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength)}...`;
}

function dedupeValues(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function setCorpusStatus(title, meta) {
  elements.corpusStatusText.textContent = title;
  elements.corpusMetaText.textContent = meta;
}

function setIndexStatus(title, meta) {
  elements.indexStatusText.textContent = title;
  elements.indexMetaText.textContent = meta;
}

function setAnswerStatus(title, meta) {
  elements.answerStatusText.textContent = title;
  elements.answerMetaText.textContent = meta;
}

function setApiKeyVerification(status, message) {
  elements.apiKeyVerifyText.textContent = message;
  elements.apiKeyVerifyText.className = `verify-message ${status}`;
}

function updateButtons() {
  const busy = state.isParsingSources || state.isIndexing || state.isAnswering || state.isVerifyingKey;
  const hasSources = state.sources.length > 0;

  elements.verifyApiKeyBtn.disabled = busy || !state.apiKey;
  elements.buildIndexBtn.disabled = busy || !state.apiKey || !hasSources;
  elements.resetIndexBtn.disabled = busy || !hasSources;
  elements.askBtn.disabled = busy || !state.apiKey || !hasSources;

  elements.verifyApiKeyBtn.textContent = state.isVerifyingKey ? "驗證中..." : "驗證 API Key";
  elements.buildIndexBtn.textContent = state.isIndexing ? "建立中..." : "建立 / 更新索引";
  elements.askBtn.textContent = state.isAnswering ? "回答中..." : "送出問題";
}

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function buildGeminiError(payload, response) {
  const message = payload.error?.message || `Gemini API 請求失敗 (${response.status})`;
  const error = new Error(message);
  error.status = response.status;
  error.retryAfterMs = parseRetryAfterMs(response, message);
  return error;
}

function shouldRetryGeminiRequest(error) {
  return isRateLimitError(error) || isTransientServerError(error);
}

function isRateLimitError(error) {
  const message = String(error?.message || "").toLowerCase();
  return error?.status === 429 || message.includes("quota exceeded") || message.includes("rate limit");
}

function isTransientServerError(error) {
  return typeof error?.status === "number" && error.status >= 500;
}

function parseRetryAfterMs(response, message) {
  const headerValue = response.headers.get("retry-after");
  if (headerValue) {
    const headerSeconds = Number(headerValue);
    if (!Number.isNaN(headerSeconds)) {
      return Math.max(1000, Math.ceil(headerSeconds * 1000));
    }
  }

  const match = String(message).match(/retry in\s+([\d.]+)s/i);
  if (match) {
    return Math.max(1000, Math.ceil(Number(match[1]) * 1000) + 1000);
  }

  return null;
}

function getRetryDelayMs(error, attempt) {
  if (error.retryAfterMs) {
    return error.retryAfterMs;
  }

  return Math.min(15000, 1000 * 2 ** (attempt - 1));
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function loadPdfJs() {
  if (runtimeCache.pdfjs) {
    return runtimeCache.pdfjs;
  }

  await loadScriptOnce(PDFJS_MODULE_URL, "pdfjsLib");
  runtimeCache.pdfjs = window.pdfjsLib;
  if (!runtimeCache.pdfjs) {
    throw new Error("PDF.js 載入失敗。");
  }
  return runtimeCache.pdfjs;
}

async function loadMammoth() {
  if (runtimeCache.mammoth) {
    return runtimeCache.mammoth;
  }

  await loadScriptOnce(MAMMOTH_BROWSER_URL, "mammoth");
  runtimeCache.mammoth = window.mammoth;
  if (!runtimeCache.mammoth) {
    throw new Error("Word 解析器載入失敗。");
  }
  return runtimeCache.mammoth;
}

async function loadScriptOnce(url, globalName) {
  if (window[globalName]) {
    return window[globalName];
  }

  if (runtimeCache.scriptPromises.has(url)) {
    return runtimeCache.scriptPromises.get(url);
  }

  const promise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = url;
    script.async = true;
    script.onload = () => resolve(window[globalName]);
    script.onerror = () => reject(new Error(`無法載入外部腳本：${url}`));
    document.head.appendChild(script);
  });

  runtimeCache.scriptPromises.set(url, promise);
  return promise;
}

async function saveEmbeddingSnapshot() {
  if (!state.bundleHash) {
    return false;
  }

  const snapshot = {
    version: CACHE_VERSION,
    bundleHash: state.bundleHash,
    model: EMBEDDING_MODEL,
    outputDimensionality: EMBEDDING_DIMENSIONALITY,
    entries: state.chunks.map((chunk) => ({
      chunkHash: chunk.chunkHash,
      embedding: chunk.embedding,
    })),
    updatedAt: new Date().toISOString(),
  };

  try {
    await writeEmbeddingSnapshot(snapshot);
    return true;
  } catch (error) {
    console.warn(error);
    return false;
  }
}

async function clearEmbeddingCache() {
  if (!state.bundleHash) {
    return;
  }
  try {
    await deleteEmbeddingSnapshot(state.bundleHash);
  } catch (error) {
    console.warn(error);
  }
}

async function readEmbeddingSnapshot(bundleHash) {
  const db = await openCacheDatabase();
  return promisifyRequest(db.transaction(IDB_CONFIG.store).objectStore(IDB_CONFIG.store).get(bundleHash));
}

async function writeEmbeddingSnapshot(snapshot) {
  const db = await openCacheDatabase();
  const transaction = db.transaction(IDB_CONFIG.store, "readwrite");
  transaction.objectStore(IDB_CONFIG.store).put(snapshot);
  await promisifyTransaction(transaction);
}

async function deleteEmbeddingSnapshot(bundleHash) {
  const db = await openCacheDatabase();
  const transaction = db.transaction(IDB_CONFIG.store, "readwrite");
  transaction.objectStore(IDB_CONFIG.store).delete(bundleHash);
  await promisifyTransaction(transaction);
}

async function openCacheDatabase() {
  if (!("indexedDB" in window)) {
    throw new Error("瀏覽器不支援 IndexedDB。");
  }

  if (runtimeCache.db) {
    return runtimeCache.db;
  }

  runtimeCache.db = await new Promise((resolve, reject) => {
    const request = indexedDB.open(IDB_CONFIG.name, IDB_CONFIG.version);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(IDB_CONFIG.store)) {
        db.createObjectStore(IDB_CONFIG.store, { keyPath: "bundleHash" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB 開啟失敗。"));
  });

  return runtimeCache.db;
}

function promisifyRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB 請求失敗。"));
  });
}

function promisifyTransaction(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("IndexedDB 寫入失敗。"));
    transaction.onabort = () => reject(transaction.error || new Error("IndexedDB 交易中止。"));
  });
}

async function hashText(text) {
  if (window.crypto?.subtle) {
    const buffer = new TextEncoder().encode(text);
    const digest = await window.crypto.subtle.digest("SHA-256", buffer);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  return fastHashText(text);
}

function fastHashText(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `h${(hash >>> 0).toString(16)}`;
}
