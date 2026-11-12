# CTREND 前向驗證週帳本 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** EC2 每週一用凍結的 CTREND 規則記一筆模擬多空組合，App 顯示並在停擺時告警。

**Architecture:** 純函式核心 `research/ctrend/ctrend_core.py`（回測與前向共用）＋前向腳本 `ctrend_forward.py`（幣安公開 API → 核心 → Upstash REST），EC2 systemd timer 觸發。App 只讀 `ctrend:*`：帳本卡片、status 一行、route.ts 停擺推播。

**Tech Stack:** Python 3（numpy、pandas、scikit-learn、pytest）、Next.js／TypeScript、vitest、Upstash Redis REST、systemd。

## Global Constraints

- 規則完全等於研究端 `C:\trading_stratage\ctrend.py`（2026-11-13 commit 510f1ba）：28 指標、排名 [−0.5, 0.5]、成交額加權單變量迴歸、M = 52、elastic net l1_ratio 0.5、λ 依 AICc、θ > 0、五分位、成交額加權、每邊 0.07%＋資金費。
- 幣池：`contractType == PERPETUAL`、`quoteAsset == USDT`、`underlyingType in (COIN, PREMARKET)`、`status == TRADING`、日線 ≥ 200 根、30 天平均成交額 ≥ 1e6。
- 週一 00:00 UTC 開盤進出；起點週 `2026-10-26`；主要追蹤「全部合格」，另記「前 100」。
- Redis 鍵：`ctrend:meta`（JSON 字串）、`ctrend:weeks`（hash：`YYYY-MM-DD` → JSON）、`ctrend:open`（JSON）。
- 停擺門檻：status 8 天顯示 ⚠、推播 9 天。
- 檔案一律 UTF-8；Python 寫檔指定 `encoding='utf-8'`。

---

### Task 1: 共用核心 ctrend_core.py＋單元測試

**Files:**
- Create: `research/ctrend/ctrend_core.py`
- Create: `research/ctrend/test_core.py`
- Create: `research/ctrend/requirements.txt`

**Interfaces:**
- Produces:
  - `NAMES: list[str]`（28 個指標名，順序固定）
  - `indicators(c, h, l, v) -> dict[str, pd.DataFrame]`（日線 panel，index 日期、columns 幣）
  - `build_weeks(P: dict, ind: dict, F: pd.DataFrame, mondays: list[pd.Timestamp], require_next: bool) -> list[dict]`；每週 `{"m0", "Z"(DataFrame 排名), "r"(Series，下週一開盤／本週一開盤−1，未知為 NaN), "f"(Series 資金費和), "w"(Series 30 天成交額)}`
  - `fit_scores(weeks: list[dict], M: int = 52) -> list[tuple[pd.Timestamp, pd.Series, int]]`（從第 2M 週起；只用該週以前的資訊）
  - `leg_weights(score: pd.Series, w: pd.Series, top: int | None) -> pd.Series`（多 +、空 −，各腿和為 1）
  - `settle(wgt, prev, r, f, cost=0.0007) -> tuple[float, float, float]`（gross, net, turnover）

- [ ] **Step 1:** 寫 `test_core.py`：(a) `rank_unit` 範圍在 [−0.5, 0.5]、最小 −0.5 最大 0.5；(b) `wls` 對 y = 1 + 2x 回傳 (1, 2)；(c) `enet_select` 在 y 只跟第 0 欄正相關時保留第 0 欄、不保留負相關欄；(d) `leg_weights` 多腿和 = 1、空腿和 = −1、多空不重疊；(e) `settle` 換手 = |新−舊| 加總、淨 = 毛 − 0.0007×換手 − Σw×f。
- [ ] **Step 2:** `py -m pytest research/ctrend/test_core.py -q` → FAIL（模組不存在）。
- [ ] **Step 3:** 實作 `ctrend_core.py`：把研究端 `ctrend.py` 的 `ema`、`indicators`、`wls`、`enet_select` 原樣搬入；新增 `rank_unit(Z)`（`Z.rank().sub(1).div(len(Z)-1).sub(0.5)`）、`build_weeks`（研究端 main 的週迴圈；`require_next=False` 時下週一沒有開盤價就用 `m1` 以前最後一個收盤價，再沒有就 NaN）、`fit_scores`（研究端 coef／fc／elastic net 段落）、`leg_weights`（`pd.qcut(rank, 5)`、Q5 正、Q1 負）、`settle`。
- [ ] **Step 4:** `py -m pytest research/ctrend/test_core.py -q` → PASS。
- [ ] **Step 5:** `requirements.txt`：`numpy`、`pandas`、`scikit-learn`、`pytest`（不鎖死版本；EC2 用當下版本）。Commit：`feat(ctrend): 共用核心與單元測試`。

### Task 2: 研究端改用核心＋一致性驗收

**Files:**
- Modify: `C:\trading_stratage\ctrend.py`（main 改呼叫核心；`sys.path.insert(0, r"C:\tradding_app\research\ctrend")`）
- Create: `C:\trading_stratage\ctrend_equiv.py`

**Interfaces:**
- Consumes: Task 1 全部函式。

- [ ] **Step 1:** `ctrend_equiv.py`：讀研究端 `data/ext` → `build_weeks(require_next=True)` → `fit_scores` → 兩組（全部、前 100）`leg_weights`＋`settle` → 跟 `results/ctrend.pkl` 的 `gross`、`net` 逐週比，印最大絕對誤差，> 1e-9 就 `sys.exit(1)`。
- [ ] **Step 2:** 執行 `.venv/Scripts/python.exe ctrend_equiv.py` → 印 `max abs diff gross … net …` 且 `OK`。
- [ ] **Step 3:** `ctrend.py` 改呼叫核心，重跑確認輸出同 510f1ba 那次（+0.81%/週、t 1.83；+1.02%/週、t 2.01）。Commit（研究端 repo）。

### Task 3: 前向腳本 ctrend_forward.py

**Files:**
- Create: `research/ctrend/ctrend_forward.py`
- Create: `research/ctrend/test_forward.py`

**Interfaces:**
- Consumes: Task 1。
- Produces（App 依賴的 JSON 形狀）：
  - meta：`{"lastRun": ms, "lastWeek": "YYYY-MM-DD", "weeks": int, "meanNet": float, "tNet": float|null, "startWeek": "2026-10-26", "version": 1}`
  - week：`{"wk", "gross", "net", "fund", "turnover", "nLong", "nShort", "nUniverse", "kept", "skipped", "top100": {"gross", "net"}}`
  - open：`{"wk", "long": [[sym, w], …], "short": [[sym, w], …], "top100": {"long": …, "short": …}}`
- 純函式（可測）：`mondays_to_process(last_week: str|None, start: str, now: pd.Timestamp) -> list[pd.Timestamp]`、`summarize(weeks: list[dict]) -> tuple[int, float, float|None]`。

- [ ] **Step 1:** `test_forward.py`：`mondays_to_process(None, "2026-10-26", 2026-11-13)` = [10-26, 11-02, 11-09]；`mondays_to_process("2026-11-09", …, 2026-11-16 00:30)` = [11-16]；同一天再跑 = []；`summarize` 的 t 在少於 3 週時為 None。
- [ ] **Step 2:** pytest → FAIL。
- [ ] **Step 3:** 實作：`fetch_universe()`（`/fapi/v1/exchangeInfo`）、`fetch_daily(sym)`（`/fapi/v1/klines?interval=1d&limit=1000`，每次間隔 0.25 秒，429／418 退避）、`fetch_funding(sym, start_ms)`（`/fapi/v1/fundingRate`）、`Upstash`（urllib POST）、`run(dry: bool)`：讀 meta 與 open → 對每個待處理週一：先用 `settle` 結算上一週持倉（兩組），寫一筆週紀錄；再 `fit_scores` 取該週一分數、`leg_weights` 組新持倉 → 最後一次寫 `ctrend:open`、`ctrend:meta`，週紀錄以 `HSET ctrend:weeks` 一次寫多個欄位。`--dry` 不寫 Redis，只印。CSV 副本 `research/ctrend/out/weeks.csv`。任何例外：不寫 meta、非零結束。
- [ ] **Step 4:** pytest → PASS；`py research/ctrend/ctrend_forward.py --dry`（本機，需網路）印出 10-26、11-02、11-09 三週的持倉與兩週結算。
- [ ] **Step 5:** Commit：`feat(ctrend): 前向週帳本腳本`。

### Task 4: EC2 部署檔

**Files:**
- Create: `deploy/ctrend.service`、`deploy/ctrend.timer`、`deploy/install-ctrend.sh`、`docs/EC2-ctrend.md`
- Modify: `.gitignore`（`research/ctrend/out/`、`research/ctrend/.venv/`）

- [ ] **Step 1:** `ctrend.service`：`Type=oneshot`、`WorkingDirectory=/home/<使用者>/tradding_app`、`EnvironmentFile=/etc/live-runner.env`（沿用；要有 `UPSTASH_REDIS_REST_URL`／`TOKEN`）、`ExecStart=…/research/ctrend/.venv/bin/python research/ctrend/ctrend_forward.py`。`ctrend.timer`：`OnCalendar=Mon *-*-* 01:30:00 UTC`、`Persistent=true`。
- [ ] **Step 2:** `install-ctrend.sh`：檢查 python3、建 venv、裝 requirements、跑 pytest、`--dry` 試跑、把 service／timer 的使用者與路徑換成目前的（`$USER`、`$PWD`）後裝到 `/etc/systemd/system/`、`daemon-reload`、`enable --now ctrend.timer`、手動 `systemctl start ctrend.service`、印 `journalctl -u ctrend -n 40` 與 `systemctl list-timers ctrend*`。每步先 echo 在做什麼；任何一步失敗就停（`set -euo pipefail`）。不碰 live-runner。
- [ ] **Step 3:** `docs/EC2-ctrend.md`：安裝兩行指令、更新方式（`git pull` 即可，timer 下次自動用新程式）、看紀錄、停用、手動補跑。Commit。

### Task 5: App 端（view、API、卡片、status、推播）

**Files:**
- Create: `src/lib/ctrend/view.ts`、`tests/ctrend.test.ts`
- Modify: `src/app/api/s3/ledgers/route.ts`、`src/lib/s3s1/apiTypes.ts`、`src/app/ledgers/page.tsx`、`scripts/status.ts`、`src/app/api/analyze/route.ts`

**Interfaces:**
- Produces：
  - `export interface CtrendMeta { lastRun: number; lastWeek: string; weeks: number; meanNet: number; tNet: number | null; startWeek: string; version: number }`
  - `export interface CtrendWeek { wk: string; gross: number; net: number; fund: number; turnover: number; nLong: number; nShort: number; nUniverse: number; kept: number; skipped: number; top100: { gross: number; net: number } }`
  - `export interface CtrendOpen { wk: string; long: [string, number][]; short: [string, number][] }`
  - `export interface CtrendSummary { weeks: number; cumNet: number; meanNet: number; tNet: number | null; lastRun: number | null; stale: boolean; recent: CtrendWeek[]; topLong: string[]; topShort: string[] }`
  - `ctrendSummary(meta: CtrendMeta | null, weeks: CtrendWeek[], open: CtrendOpen | null, now: number): CtrendSummary`（`stale` = 有 lastRun 且 now − lastRun > 8 天；`cumNet` = Π(1+net)−1；`recent` 最近 8 週新到舊；top 各 5 個權重最大）
  - `decideCtrendAlert(meta: CtrendMeta | null, now: number): boolean`（meta 為 null → false；now − lastRun > 9 天 → true）
  - `ctrendStatusLine(meta: CtrendMeta | null, now: number): string`

- [ ] **Step 1:** `tests/ctrend.test.ts`：summary 的 cumNet、排序、top5、stale 邊界（8 天整不算、8 天又 1 毫秒算）；alert：null → false、剛更新 → false、9 天又 1 毫秒 → true；status line：null 印「還沒跑過」、stale 有「⚠」。
- [ ] **Step 2:** `npx vitest run tests/ctrend.test.ts` → FAIL。
- [ ] **Step 3:** 實作 `view.ts`。`apiTypes.ts` 的 `LedgersResp` 加 `ctrend: CtrendSummary | null`。ledgers route 多讀 `ctrend:meta`、`ctrend:weeks`（`hgetall`）、`ctrend:open`，用 `parseJson` 解析後呼叫 `ctrendSummary`。ledgers page 在 BR 卡下方加卡片（週數、累積、平均／週、t、最後更新、多空前 5、說明「前 26 週不看結果；滿 52 週平均 > 0 且 t > 1.5 才考慮下一步」）。status.ts 印 `ctrendStatusLine`。route.ts 在 xcheck 告警旁：`claimPeriodicSlot('ctrend-stale-alert', 12 * 3600)` → 讀 meta → `decideCtrendAlert` → 推播「⚠ CTREND 週帳本停了」（tag `ctrend-stale`）。
- [ ] **Step 4:** `npx vitest run` 全過、`npx tsc --noEmit` 無錯。Commit。

### Task 6: 登記判定、文件、驗證、推送

**Files:**
- Modify: `C:\trading_stratage\docs\試驗登記表.md`、`CLAUDE.md`、`docs/TODO.md`

- [ ] **Step 1:** 登記表加一列「CTREND 前向驗證」：起點 2026-10-26、判定（前 26 週不看；52 週平均 > 0 且 t > 1.5 才考慮；≤ 0 結案；中間累積到 104 週）。
- [ ] **Step 2:** CLAUDE.md 加一段 CTREND（跑在哪、鍵、判定、更新要 EC2 git pull 但不用重啟）；TODO 加「EC2 安裝 CTREND」。
- [ ] **Step 3:** `npx tsc --noEmit`、`npx vitest run`、`npx next build` 全過；`git push origin main`；研究端 commit。
