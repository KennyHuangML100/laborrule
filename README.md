# 勞基法 RAG 問答

這是一個純前端的 RAG 問答頁面，回答範圍以同目錄的 `lobrul.txt` 為主，並讓使用者自行輸入 Gemini API Key。

## 功能

- 以 `lobrul.txt` 解析出勞基法條文。
- 使用 Gemini embeddings 建立條文索引。
- 提問時先檢索相關條文，再把條文送給 Gemini 產生答案。
- 顯示本次主要來源條文。
- 將 embeddings 快取在瀏覽器本機，避免每次重建。

## 使用方式

1. 直接開啟 `index.html`。
2. 若頁面無法自動載入 `lobrul.txt`，手動選擇同目錄的 `lobrul.txt`。
3. 輸入 Gemini API Key。
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

- Cloudflare 只負責託管靜態頁面與 `lobrul.txt`。
- Gemini API Key 由使用者在頁面上自行輸入。
- Gemini API 請求會由使用者瀏覽器直接送到 Google，不需要在 Cloudflare 上保存你的 Gemini 金鑰。

## 注意

- 回答只以目前檢索到的 `lobrul.txt` 條文為主。
- 這不是正式法律意見；如果要做實務判斷，仍需再核對完整法規與主管機關解釋。
