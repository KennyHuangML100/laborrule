# 勞基法 RAG 問答

這是一個純前端的 RAG 問答頁面，會先載入同目錄的 `lobrul.txt` 作為內建法條，也可再上傳自己的參考資料，並讓使用者自行輸入 Gemini API Key。

## 功能

- 自動載入 `lobrul.txt`，也可額外上傳 `txt`、`md`、`pdf`、`doc`、`docx`。
- 依資料類型做解析、切塊與索引。
- 使用 Gemini embeddings 建立向量索引，並搭配詞彙分數做混合檢索。
- 提問時先檢索最相關片段，再把片段送給 Gemini 產生答案。
- 顯示本次主要來源片段與已載入檔名。
- 將 embeddings 快取在瀏覽器 IndexedDB，避免每次重建。

## 使用方式

1. 直接開啟 `index.html`。
2. 輸入 Gemini API Key，必要時可先按 `驗證 API Key`。
3. 視需要上傳自己的參考資料。
4. 按 `建立 / 更新索引`，或直接提問讓頁面自動建立索引。

## 建議

如果你希望頁面一打開就能自動讀到 `lobrul.txt`，建議用本機靜態伺服器開啟這個資料夾，例如：

```bash
python -m http.server 8080
```

之後瀏覽 `http://localhost:8080/`。

## 部署到 Cloudflare Pages

這個專案目前是純前端靜態網站，所以最適合部署到 Cloudflare Pages。

### 方式 1：Dashboard 直接上傳

1. 到 Cloudflare Dashboard 的 `Workers & Pages`。
2. 建立 `Pages` 專案。
3. 選 `Direct Upload` 或 `Drag and drop your files`。
4. 上傳這個資料夾，至少要包含：
   - `index.html`
   - `app.js`
   - `styles.css`
   - `lobrul.txt`
5. 部署完成後，Cloudflare 會提供一個 `https://<project-name>.pages.dev` 網址。

### 方式 2：Wrangler CLI

如果你想用指令部署：

```bash
npx wrangler login
npx wrangler pages project create
npx wrangler pages deploy .
```

部署後同樣會得到 `https://<project-name>.pages.dev`。

### 自訂網域

如果你有自己的網域，可以在 Pages 專案內的 `Custom domains` 新增，例如：

- `law.example.com`
- `rag.example.com`

完成後，使用者就能直接輸入該網址使用。

### 這個專案在 Cloudflare 上的運作方式

- Cloudflare 只負責託管靜態頁面與內建的 `lobrul.txt`。
- Gemini API Key 由使用者在頁面上自行輸入。
- Gemini API 請求會由使用者瀏覽器直接送到 Google，不需要在 Cloudflare 上保存你的 Gemini 金鑰。

## 注意

- 回答只以目前檢索到的參考資料片段為主。
- 舊版 `.doc` 會以瀏覽器相容模式抽取文字，效果通常不如 `txt`、`md`、`pdf`、`docx` 穩定。
- 這不是正式法律意見；如果要做實務判斷，仍需再核對完整法規與主管機關解釋。
