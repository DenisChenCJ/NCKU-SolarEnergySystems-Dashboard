# NCKU 太陽能供電系統：公開頁面

這個倉庫放的是「NCKU 太陽能供電系統專案」對外公開的網頁。

- 首頁：https://denischencj.github.io/NCKU-SolarEnergySystems-Dashboard/
- 氣象儀表板：https://denischencj.github.io/NCKU-SolarEnergySystems-Dashboard/weather/

## 氣象儀表板

用途是即時參考，以及說明專案「看天氣來調度電池」的概念：太陽能發多少電要看天氣，所以系統在每天清晨 05:30 和傍晚 17:00 做決定之前，會先看今天、明天的日照夠不夠。

### 運作方式

1. GitHub Actions 每小時執行一次 `scripts/fetch_weather.py`（只用 Python 標準函式庫）。
2. 程式向中央氣象署和 Open-Meteo 抓資料，整理成 JSON。
3. 資料存到 `data` 分支。這個分支每次都整個覆蓋，只留最新一筆紀錄，所以倉庫不會越來越大。
4. 把 `main` 分支的網頁和 `data` 分支的資料合在一起，發布到 GitHub Pages。

網頁是純 HTML、CSS、JavaScript，不需要編譯，也不使用外部函式庫。網頁只讀取已經整理好的 JSON，不直接呼叫氣象 API。

### 檔案

| 路徑 | 內容 |
|---|---|
| `index.html` | 倉庫首頁，列出這裡的公開頁面 |
| `weather/` | 氣象儀表板：概況、詳細預報、歷史紀錄、關於 |
| `assets/` | 共用的樣式與圖表程式 |
| `scripts/fetch_weather.py` | 抓資料的程式 |
| `config/locations.json` | 地點清單。要新增地點，在這裡加一筆 |
| `.github/workflows/update-weather.yml` | 排程設定 |

資料檔（在 `data` 分支的 `weather/data/`）：

| 檔案 | 內容 | 保留 |
|---|---|---|
| `latest.json` | 目前狀況與未來三天預報 | 只有最新一份 |
| `history/<地點>.json` | 每小時測站觀測、每日日照量、預報快照摘要 | 30 天 |
| `snapshots/<地點>/<日期>-<時段>.json` | 每天 05:30、17:00 當時的完整預報 | 30 天 |

### 設定

- 中央氣象署的 API 授權碼放在倉庫的 Actions Secret，名稱是 `CWA_API_KEY`。**授權碼不可以寫進任何檔案。**
- GitHub Pages 的來源要設成「GitHub Actions」。

### 本機預覽

```sh
CWA_API_KEY=你的授權碼 python3 scripts/fetch_weather.py   # 產生 weather/data/（不會被提交）
python3 -m http.server 8000                              # 打開 http://localhost:8000/weather/
```

沒有設定授權碼也可以執行，只是氣象署的部分會是空的。

### 日照燈號

預報的全天日照量 ÷ 理想晴天的全天日照量。65% 以上是「充足」，35% 到 65% 是「普通」，不到 35% 是「不足」。理想晴天的值用 FAO-56 的公式，由緯度和日期算出。這是粗估，沒有考慮現場遮蔭、太陽能板角度和溫度。

## 資料來源

- 中央氣象署開放資料平臺：鄉鎮天氣預報、測站觀測、颱風路徑、天氣警特報
- [Open-Meteo](https://open-meteo.com/)：每小時日照量、雲量、氣溫預報（CC BY 4.0）

## 地點

網頁只顯示到鄉鎮市區。日照預報使用區公所的位置，不是任何住家的位置。
