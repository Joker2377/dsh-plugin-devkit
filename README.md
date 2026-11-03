# dsh-plugin-devkit

[![test](https://github.com/Joker2377/dsh-plugin-devkit/actions/workflows/test.yml/badge.svg)](https://github.com/Joker2377/dsh-plugin-devkit/actions/workflows/test.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

*Start a Harness bundle in one step, and find out why yours won't install before your users do.*

兩個工具，一個管「開始」，一個管「交出去之前」：

- **`plugin_scaffold`** — 開一個外掛骨架。產出來就能跑、就跑得過測試、就通過下面那支檢查。
- **`plugin_doctor`** — 讀一個外掛，說出「DSH 安裝它會被哪一條擋下來」。

同一套邏輯也包成一支 CLI，所以你不必開對話也能用。純 host 端外掛，沒有 UI、沒有常駐服務、不改 profile。

> [!NOTE]
> 需要 Node.js `>=22.19` 與 DeepSeek Harness `>=0.1.1-rc.2 <0.3.0`。純 JavaScript，沒有原生模組，Windows / macOS / Linux 都能跑。

## 功能

- **骨架一次到位。** `package.json`（含 `dsh.bundle.patch`）、patch、入口、範例工具、測試、README、LICENSE、`.gitignore`、CI workflow，一個指令全出來。
- **產物是真的能跑的。** 骨架自帶一個工具與它的測試，`npm test` 不用安裝任何依賴就會過。
- **重現 DSH 自己的相容性判定。** `engines.dsh` 存在時只看它；不存在時才逐條檢查 `@deepseek-ai/dsh*` peers，prerelease 也參與比較 —— 跟安裝時擋你的那一條是同一套規則。
- **README 被當成產品的一部分。** 沒有「安裝」段的 README 會被點名：這個外掛的安裝方式是貼連結，讀者不會自己猜到。
- **不覆蓋你寫的東西。** 目標檔案已存在就跳過並回報，要覆蓋得明講；也可以 `dryRun` 先看會寫哪些檔。

## 安裝

就一個連結。

1. 複製倉庫網址：

   ```text
   https://github.com/Joker2377/dsh-plugin-devkit
   ```

2. 在 DSH 側邊欄打開 **Plugins**，把網址貼進安裝欄位，按 **Install**。
3. 重新載入 App。之後對話裡就有 `plugin_scaffold` 與 `plugin_doctor` 可以用。

> [!IMPORTANT]
> 貼倉庫**首頁**網址。`https://github.com/.../tree/main` 這類頁面網址會被拒絕（`a URL must point at a git repository or a tarball`）。

不安裝也能用：取得原始碼後 `node scripts/cli.mjs doctor <目錄>`，CLI 與工具走同一個核心。

## 使用

### 開一個新外掛

跟 agent 說「用 `plugin_scaffold` 開一個 dsh-foo」，它會問你名稱與目錄，然後：

| 產出的檔案 | 為什麼在那裡 |
| --- | --- |
| `package.json` | `dsh.bundle.patch` 是 DSH 認得這個 bundle 的唯一入口；`engines.dsh` 決定相容性 |
| `cordis.patch.yml` | 載入 profile 時插入的那一列：entry id、模組名、config |
| `lib/index.js` | 匯出 `name` / `inject` / `apply`，把工具掛上去 |
| `lib/tools.js` | 工具定義；`defineTool` 匯入失敗時退回恆等實現，所以純 node 也載得起來 |
| `test/bundle.test.mjs` | 假 ctx 驗證 apply() 真的註冊了工具、工具真的跑得動 |
| `README.md` | 給使用者的說明（安裝／使用／疑難排解），不是給維護者的工作日誌 |
| `LICENSE`、`.gitignore`、`.github/workflows/test.yml` | 交出去之前你不想補的那些 |

接下來四步：

```bash
cd dsh-foo
npm test                       # 不需要安裝依賴
node scripts/cli.mjs doctor .  # 或叫 agent 跑 plugin_doctor
```

3. 把 `lib/tools.js` 裡的範例工具換成你真的要的工具。
4. README 的安裝段補上你的倉庫網址，`git init` 之後推上去，就能用同樣的方式安裝。

### 檢查一個外掛

```
plugin_doctor(dir: "C:/path/to/dsh-foo", hostVersion: "0.2.1-rc.5")
```

沒給 `hostVersion` 就不做相容性判定（devkit 不去猜你跑的是哪一版 DSH）。

| 等級 | 意思 | 會擋安裝嗎 |
| --- | --- | --- |
| error | 結構上不可能載入：沒有 manifest、`main` 指到不存在的檔、patch 沒有 insert、入口沒有 `apply` | 會 |
| warn | 載得進去但會踩到：patch 的 `name` 與套件名不符、README 沒安裝段、沒有 LICENSE、相容性範圍不接受執行中的版本 | 不一定 |
| info | 少了會可惜：沒有 CI、`keywords` 沒帶 `dsh-plugin` | 不會 |

檢查的項目：manifest（`name` / `version` / `type` / `main` 與 `exports` 的目標檔 / `files` 覆蓋範圍 / `peerDependencies`）、patch（insert id 合法性與重複、模組名、給了 config 卻沒有 `Config` 匯出）、入口（`name` / `apply` / 與套件名是否一致）、文件（README 安裝段、LICENSE）、測試與 CI。全部唯讀。

### 命令列

```bash
dsh-plugin-devkit scaffold dsh-foo --desc "一行說明" --author "你的名字"
dsh-plugin-devkit scaffold dsh-foo --dry-run      # 只看會寫什麼
dsh-plugin-devkit doctor . --host-version 0.2.1-rc.5
dsh-plugin-devkit doctor . --json                 # 給腳本用
```

結束碼：`0` 通過、`1` 有 error、`2` 指令本身跑不起來（參數錯、目錄讀不到）。

## 這些規則是從哪來的

不是你我的口味，是 DSH 安裝時的實際行為：

| 規則 | 出處 |
| --- | --- |
| 有 `engines.dsh` 就只看它，`@deepseek-ai/dsh*` peers 一律不參與 | `unmetRequirements()`，`@deepseek-ai/dsh-app-boot` |
| 沒有 `engines.dsh` 時，每個 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` peer 都要接受執行中的版本 | 同上 |
| prerelease 也參與範圍比較（`0.3.0-rc.5` 落在 `<0.3.0` 內） | `semver.satisfies(..., { includePrerelease: true })`，同上 |
| patch 沒有 insert 就不會插入那一列，等於沒裝 | `plugin_manager` 的 bundle 檢查 |

## 疑難排解

| 症狀 | 可能原因 | 處理 |
| --- | --- | --- |
| DSH 沙箱裡 `npm test` 噴 `spawn EPERM` | `node --test <目錄>` 會為每個檔案開子行程，沙箱擋掉了 | 改跑 `npm run test:sandbox`，或直接 `node test/bundle.test.mjs` |
| `plugin_scaffold` 寫到不是你想要的目錄 | 相對路徑以 host 行程的 cwd 為基準，不是你 session 的工作目錄 | 傳絕對路徑；回覆一定會印出實際用掉的絕對路徑 |
| doctor 說 patch「有 N 處讀不懂」 | 它只懂 `insert` / `override` 的常見寫法 | 照它指的行號人工看過那幾行 |
| 安裝時被 `incompatible-version` 拒 | 宣告的範圍不接受執行中的 DSH | 先跑 `plugin_doctor(hostVersion: ...)` 看是哪一條，再決定改範圍還是改支援的版本 |
| 產出的工具在 DSH 裡沒出現 | 沒有重載 App，或 patch 沒插入那一列 | 重載；用 `plugin_doctor` 確認 patch 有 insert |

## 運作原理

- **核心是純函式。** `scaffold.js` 只回傳「檔案路徑 → 內容」，`checks.js` 只吃「路徑 → 內容」的快照，`semver.js` 與 `yaml.js` 沒有任何 IO。所以規則可以脫離 DSH 測試，工具與 CLI 也不可能各說各話。
- **工具只做接線。** `tools.js` 把純核心接到檔案系統：寫入前檢查既有檔案、回報絕對路徑、把結果整理成給人看的文字。
- **不猜版本。** 相容性判定需要 `hostVersion`，拿不到就明說略過，不從環境裡找一個看起來像版本的東西。

## 開發

```bash
npm test                 # 34 個測試，不需要安裝依賴，也不需要 DSH
npm run test:sandbox     # 同一套測試，不開子行程（在 DSH 沙箱內用這個）
node scripts/cli.mjs doctor .   # 對自己跑一次（dogfood）
```

CI 在 `ubuntu-latest` 與 `windows-latest` 上跑 Node 22 與 24：先 `node --check` 三個入口，再 `npm test`，最後對本 repo 跑一次 `doctor .`。

## 已知限制

- **沒有 watch／熱重載。** 改完外掛還是要重載 App 才看得到。
- **不讀 registry。** doctor 不打網路：不查 npm、不驗 tarball 雜湊、不掃 install 腳本。安裝前的供應鏈核查是另一件事，這個工具不做。
- **YAML 只懂一部分。** 讀的是 patch 實際在用的方言（`insert` / `override` 的常見寫法）；複雜的錨點、`!!js`、多行字串會落在「讀不懂」而不是被猜測。
- **semver 不是完整實作。** 支援比較子、`^`、`~`、`||`、`*`；不支援 hyphen range（`1.2.3 - 2.0.0`），build metadata 直接忽略。
- **骨架的範例工具是佔位。** `dsh-foo_hello` 只是證明接線通，不改它就是一個沒用的工具。
- **不代你安裝、不改 profile、不建 repo。** 它只寫檔案。
