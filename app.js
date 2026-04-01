const GENERATE_MODEL = "gemini-2.5-flash";
const EMBEDDING_MODEL = "models/gemini-embedding-001";
const EMBEDDING_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001";
const GENERATE_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GENERATE_MODEL}:generateContent`;
const MODELS_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
const EMBEDDING_DIMENSIONALITY = 768;
const EMBEDDING_BATCH_SIZE = 12;
const TOP_K = 6;
const CACHE_VERSION = 1;

const STORAGE_KEYS = {
  apiKey: "lobrul-rag-gemini-key",
  remember: "lobrul-rag-remember-key",
  embeddingCache: "lobrul-rag-embedding-cache-v1",
};

const SYSTEM_PROMPT = [
  "你是台灣《勞動基準法》問答助手。",
  "回答只能以提供的檢索條文為主要依據，不要自行補充未提供的其他法規、判例、函釋或想像內容。",
  "如果檢索條文不足以支持明確答案，直接說明「依目前提供的勞基法條文片段，無法確定」，並指出還缺什麼資訊。",
  "請使用繁體中文。",
  "回答格式請依序包含：結論、依據、提醒。",
  "回答時盡量點出條號，例如「依第24條」。",
  "不要宣稱這是正式法律意見。",
].join("\n");

const state = {
  apiKey: "",
  rememberKey: false,
  corpusText: "",
  corpusHash: "",
  corpusOrigin: "",
  chunks: [],
  lastRetrieved: [],
  history: [],
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
    const [file] = event.target.files || [];
    if (!file) {
      return;
    }

    try {
      setCorpusStatus("讀取中", `正在從 ${file.name} 讀取條文。`);
      const buffer = await file.arrayBuffer();
      const text = new TextDecoder("utf-8").decode(buffer);
      await setCorpus(text, `手動載入 ${file.name}`);
    } catch (error) {
      setCorpusStatus("讀取失敗", getErrorMessage(error));
    } finally {
      event.target.value = "";
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

  elements.resetIndexBtn.addEventListener("click", () => {
    clearEmbeddingCache();
    state.chunks = state.chunks.map((chunk) => ({ ...chunk, embedding: null }));
    setIndexStatus("快取已清除", "已刪除本機 embeddings 快取，需要時會重新建立。");
    updateButtons();
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

async function loadBundledCorpus() {
  try {
    setCorpusStatus("載入中", "正在嘗試讀取同目錄的 lobrul.txt。");
    const response = await fetch("./lobrul.txt", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`讀取失敗 (${response.status})`);
    }

    const buffer = await response.arrayBuffer();
    const text = new TextDecoder("utf-8").decode(buffer);
    await setCorpus(text, "已自動載入同目錄 lobrul.txt");
  } catch (error) {
    setCorpusStatus(
      "等待手動載入",
      "無法自動讀取 lobrul.txt。若你是直接開啟 HTML，請改用上方的手動選檔。"
    );
    console.warn(error);
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

async function setCorpus(text, origin) {
  const normalized = normalizeText(text);
  const chunks = parseLawDocument(normalized);

  if (!chunks.length) {
    throw new Error("找不到任何條文，請確認檔案內容是否正確。");
  }

  state.corpusText = normalized;
  state.corpusOrigin = origin;
  state.corpusHash = await hashText(normalized);
  state.chunks = chunks;
  state.lastRetrieved = [];
  state.history = [];

  hydrateEmbeddingCache();
  setCorpusStatus("已載入", origin);
  elements.corpusMetaText.textContent = `共解析 ${chunks.length} 條，將以條文為單位建立 RAG 索引。`;
  renderHistory();
  renderSources([]);
  updateButtons();
}

function normalizeText(text) {
  return String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

function parseLawDocument(text) {
  const lines = text.split("\n");
  const chunks = [];
  let chapter = "未分類";
  let currentArticle = null;
  let currentLines = [];

  const flushArticle = () => {
    if (!currentArticle) {
      return;
    }

    const body = joinLawLines(currentLines);
    if (!body) {
      return;
    }

    const heading = `第 ${currentArticle} 條`;
    chunks.push({
      id: `article-${currentArticle}`,
      articleNumber: currentArticle,
      chapter,
      heading,
      text: body,
      retrievalText: [chapter, heading, body].join("\n"),
      embedding: null,
    });
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const chapterMatch = line.match(/^第\s*[一二三四五六七八九十百零]+\s*章/);
    const articleMatch = line.match(/^第\s*(\d+(?:-\d+)?)\s*條/);

    if (chapterMatch) {
      flushArticle();
      currentArticle = null;
      currentLines = [];
      chapter = line.trim();
      continue;
    }

    if (articleMatch) {
      flushArticle();
      currentArticle = articleMatch[1];
      currentLines = [];
      continue;
    }

    if (currentArticle) {
      currentLines.push(line);
    }
  }

  flushArticle();
  return chunks;
}

function joinLawLines(lines) {
  const paragraphs = [];
  let current = "";

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      if (current) {
        paragraphs.push(current);
        current = "";
      }
      continue;
    }

    const startsNumberedItem =
      /^[一二三四五六七八九十]+、/.test(line) ||
      /^\(\w+\)/.test(line) ||
      /^\d+\./.test(line) ||
      /^第\s*\d+(?:-\d+)?\s*款/.test(line);

    if (!current) {
      current = line;
      continue;
    }

    if (startsNumberedItem) {
      paragraphs.push(current);
      current = line;
      continue;
    }

    current += line;
  }

  if (current) {
    paragraphs.push(current);
  }

  return paragraphs.join("\n");
}

async function hashText(text) {
  if (window.crypto && window.crypto.subtle) {
    const buffer = new TextEncoder().encode(text);
    const digest = await window.crypto.subtle.digest("SHA-256", buffer);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fallback-${hash >>> 0}`;
}

function hydrateEmbeddingCache() {
  const raw = localStorage.getItem(STORAGE_KEYS.embeddingCache);
  if (!raw) {
    setIndexStatus("尚未建立", "需要 API Key 才能產生 Gemini embeddings。");
    return;
  }

  try {
    const cache = JSON.parse(raw);
    const isValid =
      cache &&
      cache.version === CACHE_VERSION &&
      cache.hash === state.corpusHash &&
      cache.model === EMBEDDING_MODEL &&
      cache.outputDimensionality === EMBEDDING_DIMENSIONALITY &&
      Array.isArray(cache.entries) &&
      cache.entries.length === state.chunks.length;

    if (!isValid) {
      setIndexStatus("尚未建立", "找不到符合目前條文版本的本機 embeddings 快取。");
      return;
    }

    state.chunks = state.chunks.map((chunk, index) => ({
      ...chunk,
      embedding: cache.entries[index].embedding,
    }));

    setIndexStatus("已載入快取", "已套用本機 embeddings 快取，可直接提問。");
  } catch (error) {
    clearEmbeddingCache();
    setIndexStatus("尚未建立", "快取格式無效，已清除，之後會重新建立。");
    console.warn(error);
  }
}

function saveEmbeddingCache() {
  const payload = {
    version: CACHE_VERSION,
    hash: state.corpusHash,
    model: EMBEDDING_MODEL,
    outputDimensionality: EMBEDDING_DIMENSIONALITY,
    entries: state.chunks.map((chunk) => ({
      id: chunk.id,
      embedding: chunk.embedding,
    })),
    createdAt: new Date().toISOString(),
  };

  try {
    localStorage.setItem(STORAGE_KEYS.embeddingCache, JSON.stringify(payload));
    return true;
  } catch (error) {
    console.warn(error);
    return false;
  }
}

function clearEmbeddingCache() {
  localStorage.removeItem(STORAGE_KEYS.embeddingCache);
}

function hasEmbeddings() {
  return state.chunks.length > 0 && state.chunks.every((chunk) => Array.isArray(chunk.embedding));
}

async function ensureEmbeddings(forceRebuild = false) {
  if (!state.corpusText || !state.chunks.length) {
    throw new Error("請先載入 lobrul.txt。");
  }

  if (!state.apiKey) {
    throw new Error("請先輸入 Gemini API Key。");
  }

  if (forceRebuild) {
    clearEmbeddingCache();
    state.chunks = state.chunks.map((chunk) => ({ ...chunk, embedding: null }));
  } else if (hasEmbeddings()) {
    setIndexStatus("索引已就緒", "目前條文已有 embeddings，可直接提問。");
    updateButtons();
    return;
  }

  state.isIndexing = true;
  updateButtons();
  setIndexStatus("建立中", `正在為 ${state.chunks.length} 條條文建立 embeddings。`);

  try {
    const pendingChunks = state.chunks.filter((chunk) => !Array.isArray(chunk.embedding));

    for (let start = 0; start < pendingChunks.length; start += EMBEDDING_BATCH_SIZE) {
      const batch = pendingChunks.slice(start, start + EMBEDDING_BATCH_SIZE);
      const response = await geminiRequest(`${EMBEDDING_ENDPOINT}:batchEmbedContents`, {
        requests: batch.map((chunk) => ({
          model: EMBEDDING_MODEL,
          task_type: "RETRIEVAL_DOCUMENT",
          output_dimensionality: EMBEDDING_DIMENSIONALITY,
          content: {
            parts: [{ text: chunk.retrievalText }],
          },
        })),
      });

      const embeddings = response.embeddings || [];
      if (embeddings.length !== batch.length) {
        throw new Error("Gemini embeddings 回傳筆數與條文數量不一致。");
      }

      batch.forEach((chunk, index) => {
        chunk.embedding = embeddings[index]?.values || null;
      });

      setIndexStatus(
        "建立中",
        `已完成 ${Math.min(start + batch.length, pendingChunks.length)} / ${pendingChunks.length} 條 embeddings。`
      );
    }

    const cacheSaved = saveEmbeddingCache();
    setIndexStatus(
      "索引完成",
      cacheSaved
        ? "Embeddings 已寫入本機快取，之後重開頁面可直接使用。"
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
  setAnswerStatus("檢索中", "正在確認條文並建立回答。");

  try {
    await ensureEmbeddings(false);

    const retrieved = await retrieveChunks(question);
    state.lastRetrieved = retrieved;
    renderSources(retrieved);

    const contextBlock = retrieved
      .map((item, index) => {
        const body = clipText(item.chunk.text, 1300);
        return [`【來源 ${index + 1}】`, `${item.chunk.chapter} ${item.chunk.heading}`, body].join("\n");
      })
      .join("\n\n");

    const prompt = [
      `問題：${question}`,
      "",
      "檢索條文：",
      contextBlock,
      "",
      "請根據以上條文回答，若條文不足就明確說明不足，不要超出已提供條文內容。",
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

    state.history.unshift({
      id: `answer-${Date.now()}`,
      question,
      answer: answerText.trim(),
      citations: retrieved.map((item) => item.chunk.heading),
      createdAt: new Date().toISOString(),
    });

    renderHistory();
    setAnswerStatus("完成", `已完成回答，主要依據 ${retrieved.map((item) => item.chunk.heading).join("、")}。`);
  } finally {
    state.isAnswering = false;
    updateButtons();
  }
}

async function retrieveChunks(question) {
  const response = await geminiRequest(`${EMBEDDING_ENDPOINT}:embedContent`, {
    model: EMBEDDING_MODEL,
    task_type: "RETRIEVAL_QUERY",
    output_dimensionality: EMBEDDING_DIMENSIONALITY,
    content: {
      parts: [{ text: question }],
    },
  });

  const queryEmbedding = response.embedding?.values || response.embeddings?.[0]?.values;
  if (!Array.isArray(queryEmbedding)) {
    throw new Error("無法取得查詢 embedding。");
  }

  const referencedArticles = extractArticleRefs(question);
  return state.chunks
    .map((chunk) => {
      const semanticScore = cosineSimilarity(queryEmbedding, chunk.embedding || []);
      const articleBoost = referencedArticles.has(chunk.articleNumber) ? 0.18 : 0;
      return {
        chunk,
        score: semanticScore + articleBoost,
      };
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, TOP_K);
}

function extractArticleRefs(question) {
  const matches = question.match(/第\s*(\d+(?:-\d+)?)\s*條/g) || [];
  return new Set(
    matches
      .map((item) => item.match(/\d+(?:-\d+)?/))
      .filter(Boolean)
      .map((match) => match[0])
  );
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

  const response = await fetch(`${url}?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error?.message || `Gemini API 請求失敗 (${response.status})`);
  }

  return payload;
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
      const sections = item.answer.split(/\n{2,}/).filter(Boolean);
      sections.forEach((section) => {
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
    elements.sourceList.textContent = "送出問題後會顯示來源條文。";
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
      title.textContent = item.chunk.heading;
      const chapter = document.createElement("span");
      chapter.textContent = item.chunk.chapter;
      titleWrap.append(title, chapter);

      const score = document.createElement("div");
      score.className = "source-score";
      score.textContent = `相似度 ${item.score.toFixed(3)}`;

      heading.append(titleWrap, score);

      const excerpt = document.createElement("p");
      excerpt.className = "source-excerpt";
      excerpt.textContent = clipText(item.chunk.text, 220);

      card.append(heading, excerpt);
      return card;
    })
  );
}

function clipText(text, maxLength) {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.slice(0, maxLength)}...`;
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
  elements.verifyApiKeyBtn.disabled = state.isIndexing || state.isAnswering || state.isVerifyingKey || !state.apiKey;
  elements.buildIndexBtn.disabled =
    state.isIndexing || state.isAnswering || state.isVerifyingKey || !state.corpusText || !state.apiKey;
  elements.resetIndexBtn.disabled = state.isIndexing || state.isAnswering || state.isVerifyingKey || !state.corpusText;
  elements.askBtn.disabled =
    state.isIndexing || state.isAnswering || state.isVerifyingKey || !state.corpusText || !state.apiKey;
  elements.askBtn.textContent = state.isAnswering ? "回答中..." : "送出問題";
  elements.buildIndexBtn.textContent = state.isIndexing ? "建立中..." : "建立 / 更新索引";
  elements.verifyApiKeyBtn.textContent = state.isVerifyingKey ? "驗證中..." : "驗證 API Key";
}

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
