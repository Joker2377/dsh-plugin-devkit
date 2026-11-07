# dsh-plugin-devkit

[![test](https://github.com/Joker2377/dsh-plugin-devkit/actions/workflows/test.yml/badge.svg)](https://github.com/Joker2377/dsh-plugin-devkit/actions/workflows/test.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

*Start a Harness bundle in one step, find out why yours won't install before your users do, and check the other guy's package before it runs in your profile.*

四個工具，對應外掛生命週期的四個時刻：

- **`plugin_scaffold`** — 開一個外掛骨架。產出來就能跑、就跑得過測試、就通過下面那支檢查。
- **`plugin_doctor`** — 讀一個外掛，說出「DSH 安裝它會被哪一條擋下來」。
- **`plugin_audit`** — 讀一個已發佈的套件，說出「現在把它裝進我的 profile 合不合理」。
- **`plugin_inspect`** — 裝完之後，說出「它在 Host 裡真的載入了嗎」。

同一套邏輯也包成一支 CLI，所以你不必開對話也能用。純 host 端外掛，沒有 UI、沒有常駐服務、不改 profile。

> [!NOTE]
> 需要 Node.js `>=22.19` 與 DeepSeek Harness `>=0.1.1-rc.2 <0.3.0`。純 JavaScript，沒有原生模組，Windows / macOS / Linux 都能跑。

## 功能

- **骨架一次到位。** `package.json`（含 `dsh.bundle.patch`）、patch、入口、範例工具、測試、README、LICENSE、`.gitignore`、CI workflow，一個指令全出來。
- **產物是真的能跑的。** 骨架自帶一個工具與它的測試，`npm test` 不用安裝任何依賴就會過。
- **重現 DSH 自己的相容性判定。** `engines.dsh` 存在時只看它；不存在時才逐條檢查 `@deepseek-ai/dsh*` peers，prerelease 也參與比較 —— 跟安裝時擋你的那一條是同一套規則。
- **README 被當成產品的一部分。** 沒有「安裝」段的 README 會被點名：這個外掛的安裝方式是貼連結，讀者不會自己猜到。
- **不覆蓋你寫的東西。** 目標檔案已存在就跳過並回報，要覆蓋得明講；也可以 `dryRun` 先看會寫哪些檔。
- **安裝前先核查來源。** `plugin_audit` 在把別人的套件貼進 profile 之前，先比對 tarball 雜湊、掃 install 腳本、看依賴面與 provenance、判 `engines.dsh` 相容性、比對現有版本 —— 只讀，不裝、不執行對方程式碼。

## 安裝

就一個連結。

1. 複製倉庫網址：

   ```text
   https://github.com/Joker2377/dsh-plugin-devkit
   ```

2. 在 DSH 側邊欄打開 **Plugins**，把網址貼進安裝欄位，按 **Install**。
3. 重新載入 App。之後對話裡就有 `plugin_scaffold`、`plugin_doctor`、`plugin_audit` 與 `plugin_inspect` 可以用。

> [!IMPORTANT]
> 貼倉庫**首頁**網址。`https://github.com/.../tree/main` 這類頁面網址會被拒絕（`a URL must point at a git repository or a tarball`）。

不安裝也能用：取得原始碼後 `node scripts/cli.mjs doctor <目錄>` 或 `node scripts/cli.mjs audit <spec>`，CLI 與工具走同一個核心。

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

檢查的項目：manifest（`name` / `version` / `type` / `main` 與 `exports` 的目標檔 / `files` 覆蓋範圍 / `peerDependencies`）、patch（insert id 合法性與重複、模組名）、入口（`name` / `apply` / 與套件名是否一致、`Config` 是否為 standard-schema）、`engines.dsh` 上限是否放行下一版 prerelease、文件（README 安裝段、LICENSE）、測試與 CI。全部唯讀。

### 命令列

```bash
dsh-plugin-devkit scaffold dsh-foo --desc "一行說明" --author "你的名字"
dsh-plugin-devkit scaffold dsh-foo --dry-run      # 只看會寫什麼
dsh-plugin-devkit doctor . --host-version 0.2.1-rc.5
dsh-plugin-devkit doctor . --json                 # 給腳本用
```

結束碼（`scaffold`／`doctor`）：`0` 通過、`1` 有 error、`2` 指令本身跑不起來（參數錯、目錄讀不到）。`audit` 的結束碼見下一節。

## 裝完之後：plugin_inspect

`application=applied` 只代表安裝完成。dsh-repo-ops 0.1.1 安裝成功，載入時才失敗，九個工具都沒註冊。`plugin_inspect` 把三個來源對起來：profile 的宣告、磁碟上的檔案、Cordis loader 的即時狀態。

跟 agent 說「用 `plugin_inspect` 看 dsh-foo 有沒有載入」，或不指定名稱檢查整個 profile。

| state | 意思 |
| --- | --- |
| `active` | 正在執行 |
| `failed` | 載入失敗，報告附上錯誤訊息 |
| `disabled` | 已安裝但停用 |
| `loading` | 還在載入 |
| `not-loaded` | 在 bundle 清單裡，但 loader 沒有執行中的 entry，通常要重啟 |
| `not-selected` | 已安裝，但不在 bundle 清單裡 |
| `not-installed` | 宣告了但檔案不在，或 `link:` 目標被搬走 |
| `unknown` | 讀不到 loader，只做了靜態檢查 |

CLI 不在 Host 裡，所以只有靜態檢查，state 都是 `unknown`：

```bash
dsh-plugin-devkit inspect                       # 整個 desktop profile
dsh-plugin-devkit inspect dsh-foo --host=0.2.2-rc.1
dsh-plugin-devkit inspect --profile=<dir> --json
```

有 error 時結束碼是 `1`。全程唯讀，也不會執行任何 bundle 的程式碼。

## 這些規則是從哪來的

不是你我的口味，是 DSH 安裝時的實際行為：

| 規則 | 出處 |
| --- | --- |
| 有 `engines.dsh` 就只看它，`@deepseek-ai/dsh*` peers 一律不參與 | `unmetRequirements()`，`@deepseek-ai/dsh-app-boot` |
| 沒有 `engines.dsh` 時，每個 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` peer 都要接受執行中的版本 | 同上 |
| prerelease 也參與範圍比較（`0.3.0-rc.5` 落在 `<0.3.0` 內） | `semver.satisfies(..., { includePrerelease: true })`，同上 |
| patch 沒有 insert 就不會插入那一列，等於沒裝 | `plugin_manager` 的 bundle 檢查 |
| 匯出 `Config` 就必須是 standard-schema；沒匯出時 config 原樣傳給 `apply` | `resolveConfig()`，`@deepseek-ai/cordis` |

## 安裝前核查：plugin_audit

`plugin_doctor` 回答的是「你自己寫的 bundle 少了什麼」；`plugin_audit` 回答的是另一個問題：**這個別人寫的套件，現在裝進我的 profile 可不可以**。兩件事都會在安裝時咬你，但檢查的東西完全不同 —— doctor 看檔案結構，audit 看 registry 上的供應鏈訊號。

### 什麼時候用

- 要把一個沒看過的 npm 套件或 GitHub 外掛貼進 **Plugins** 之前。
- 要升級一個已經在用的外掛，但這次版本落差很大之前。
- 同事丟來 `@scope/name` 或 `github:owner/repo`，你想先知道它會不會被 DSH 的相容性判定擋掉。

### 怎麼呼叫

跟 agent 說「用 `plugin_audit` 核查 lodash@4.17.21」，或指定細節：

| 參數 | 必填 | 說明 |
| --- | --- | --- |
| `spec` | ✔ | `lodash@4.17.21`、`dsh-foo-bar@^0.2`、`@scope/name@1.0.0-rc.1`、`github:owner/repo`、`./path` |
| `registry` | | 換 mirror 時用；預設 `https://registry.npmjs.org` |
| `profileDir` | | 版本撞車要比對的 profile；預設是桌面 profile |
| `hostVersion` | | 相容性判定的基準；沒給就讀環境變數 `DSH_VERSION`，再沒有就明說這一項沒檢查 |
| `format` | | `text`（預設，給人讀）或 `json`（完整 `AuditResult`，給腳本） |

不開對話也能跑：

```bash
node scripts/cli.mjs audit lodash@4.17.21
node scripts/cli.mjs audit dsh-foo-bar@^0.2 --host=0.2.1-rc.5 --json
node scripts/cli.mjs audit github:owner/repo --registry=https://registry.npmmirror.com
```

結束碼就是契約：`0` 判 allow、`1` 判 block、`2` 參數或執行環境有問題（例如沒給 spec）、`3` 判 not-audited（沒有跑 registry 側檢查，不能當成通過）。

### 結論怎麼讀

第一行是受檢的 spec，第二行直接給結論 —— **可以安裝**、**不可以安裝 — 第一個阻斷原因**，或 **未核查**（`github:`／本地目錄這類 spec 沒有 registry 側資料可查；這不是通過，CLI 以 exit 3 表示）；第三行是 error／warn／info 的數量與 `已檢查：…` 清單。那份清單是誠實條款：沒列到的項目代表這次沒跑，例如沒給 `hostVersion` 就沒有相容性判定，報告不會把它算成通過。

findings 依嚴重度排序，每條都有可 grep 的 `code`、一行訊息，`→` 後面是具體做法：

| 代碼 | 代表什麼 |
| --- | --- |
| `audit/integrity-mismatch`、`audit/dist-missing` | 下載到的 tarball 與 registry 宣告的雜湊對不上，或 `dist` 缺欄位 |
| `audit/install-script` | 套件會在安裝時執行 `preinstall`／`install`／`postinstall` —— **包括 tarball 內建（`node_modules/…`）的依賴**，根 manifest 乾淨不代表安全 |
| `audit/patch-js`、`audit/patch-missing` | `dsh.bundle.patch` 含 `!!js`（載入 profile 時會執行），或 manifest 指向的 patch 檔不存在 |
| `audit/tarball-unreadable` | tarball 解不開：腳本與二進位都無法確認，所以直接阻擋（integrity 仍照原始位元組算） |
| `audit/manifest-mismatch` | tarball 內的 `package.json` 版本／名稱與 registry 不一致，本身就是可疑訊號 |
| `audit/profile-source` | profile 內同名依賴來自 `link:`／`github:`，沒有版本範圍可比，改以人工確認 |
| `audit/profile-unparsable`、`audit/tarball-offhost` | 候選寫的範圍讀不懂所以略過比較；或 tarball 由 registry 以外的 CDN 主機提供（info，不是錯） |
| `audit/compat-undeclared` | 套件沒有宣告 `engines.dsh` 也沒有 DSH peer：沒有任何相容性承諾（不是錯，是風險） |
| `audit/compat-unmet` | `engines.dsh` 或 `@deepseek-ai/dsh*` peers 不接受你現在跑的版本 |
| `audit/profile-collision` | profile 已裝的版本不滿足它的依賴範圍 |
| `audit/version-missing` | registry 沒有這個套件，或沒有符合範圍的版本 |
| `audit/provenance-missing` | 沒有 npm provenance 簽章（warn，不阻擋） |
| `audit/dep-surface`、`audit/binding-gyp`、`audit/binary` | 依賴面太大、要現場編譯、或帶原生二進位檔 |

warn 不會阻擋安裝，但要當成「我知道這件事，而且我接受」。`audit/githead-ok` 只代表 `gitHead` 欄位存在，**沒有**向 GitHub 核對過那個 commit；報告的 evidence 也照實標成未核對。

### 判 block 之後怎麼辦

1. 先看 `verdict.blocking` 的第一個代碼，那就是結論的理由。
2. 供應鏈類的 error（`integrity-mismatch`、`install-script`、`tarball-unreadable`、`version-missing`）沒有「再試一次就好」的解法：換版本、換來源，或不裝。決定要裝，就等於接受安裝期會執行對方指定的程式碼。
3. 相容性類的 error（`compat-unmet`）先分清是範圍寫死還是你跑錯 Host 版本；`plugin_doctor` 對本地目錄用的是同一套判定，兩邊結論應該一致。
4. 撞車類（`profile-collision`）先處理既有版本，別讓兩個不相容的版本同時留在同一個 profile。
5. 決定照裝時把 `--json` 的報告留著 —— 出事時那是唯一能回溯「當初看到什麼」的證據。

### 它的界限

`plugin_audit` 是**唯讀**的：不寫檔、不安裝、不執行套件程式碼、不 spawn npm、不改 profile；唯一的網路行為是讀 registry 與它回報的 tarball。它**不是沙箱**：allow 只代表上面那幾項供應鏈訊號都對得上，不代表程式碼沒有惡意行為 —— 真正的隔離要另外做。

## 疑難排解

| 症狀 | 可能原因 | 處理 |
| --- | --- | --- |
| DSH 沙箱裡 `npm test` 噴 `spawn EPERM` | 預設的測試 runner 會為每個檔案開子行程，沙箱擋掉了 | 改跑 `npm run test:sandbox`，或直接 `node test/bundle.test.mjs` |
| CI 上 `npm test` 噴 `ERR_UNSUPPORTED_DIR_IMPORT` | `node --test test/` 把目錄當成單一測試檔去 spawn | 用這個 repo 的寫法：`node --test "test/**/*.test.mjs"` |
| `plugin_scaffold` 寫到不是你想要的目錄 | 相對路徑以 host 行程的 cwd 為基準，不是你 session 的工作目錄 | 傳絕對路徑；回覆一定會印出實際用掉的絕對路徑 |
| doctor 說 patch「有 N 處讀不懂」 | 它只懂 `insert` / `override` 的常見寫法 | 照它指的行號人工看過那幾行 |
| 安裝時被 `incompatible-version` 拒 | 宣告的範圍不接受執行中的 DSH | 先跑 `plugin_doctor(hostVersion: ...)` 看是哪一條，再決定改範圍還是改支援的版本 |
| 產出的工具在 DSH 裡沒出現 | 沒有重載 App，或 patch 沒插入那一列 | 重載；用 `plugin_doctor` 確認 patch 有 insert |
| `audit` 回「未核查」且 exit 3 | 這個 spec 是 `github:` 或本地目錄，registry 側沒有 integrity／provenance 可查 | 要核查就指向已發佈的 registry 版本；本地目錄改用 `plugin_doctor`。這不是通過 |
| `audit` 說 `version-missing` | 套件不存在，或你給的範圍內沒有版本（例如只有 prerelease，而範圍沒寫到） | 先 `npm view <name> versions` 對一次；或把範圍寫成完整三段 |
| `audit` 說 `provenance-unreachable` | attestation 服務暫時不可用，不是「沒有簽章」 | 稍後重跑；不要把它當成有簽章 |

## 運作原理

- **核心是純函式。** `scaffold.js` 只回傳「檔案路徑 → 內容」，`checks.js` 只吃「路徑 → 內容」的快照，`semver.js` 與 `yaml.js` 沒有任何 IO；`spec.js` 只解析字串，`tar.js` 只解一個 Buffer，`profile.js` 只讀一個目錄，`audit.js` 把 `fetch` 與 registry client 當參數注入。所以規則可以脫離 DSH 測試，工具與 CLI 也不可能各說各話。
- **工具只做接線。** `tools.js` 把純核心接到檔案系統：寫入前檢查既有檔案、回報絕對路徑、把結果整理成給人看的文字。
- **不猜版本。** 相容性判定需要 `hostVersion`，拿不到就明說略過，不從環境裡找一個看起來像版本的東西。

## 開發

```bash
npm test                 # 不需要安裝依賴，也不需要 DSH（全部離線）
npm run test:sandbox     # 同一套測試，不開子行程（在 DSH 沙箱內用這個）
node scripts/cli.mjs doctor .                  # 對自己跑一次（dogfood）
node scripts/cli.mjs audit lodash@4.17.21      # 真的連 registry（需要網路）
```

CI 在 `ubuntu-latest` 與 `windows-latest` 上跑 Node 22 與 24：先對入口與 audit 模組做 `node --check`，再 `npm test`（全部離線，不連 registry），最後對本 repo 跑一次 `doctor .`。

## 已知限制

- **沒有 watch／熱重載。** 改完外掛還是要重載 App 才看得到。
- **doctor 不讀 registry。** `plugin_doctor` 只看本地檔案：不查 npm、不驗 tarball 雜湊、不掃 install 腳本。需要那些判定的場合用 `plugin_audit` —— 它會連 registry，但仍然不裝、不執行對方程式碼。
- **YAML 只懂一部分。** 讀的是 patch 實際在用的方言（`insert` / `override` 的常見寫法）；複雜的錨點、`!!js`、多行字串會落在「讀不懂」而不是被猜測。
- **semver 不是完整實作。** 支援比較子、`^`、`~`、`||`、`*`、部分版本（`1`、`1.2`、`1.x`）與 hyphen range（`1.2.3 - 2.0.0`）；build metadata 直接忽略。範圍寫到它讀不懂時會明說「無法比較」，不會默默判定不相容或相容。
- **audit 只查供應鏈訊號，不查惡意。** 它證明的是「雜湊對得上、安裝期沒有未經檢視的腳本、宣告的相容性成立」，不是「這段程式碼安全」。真正的隔離要靠最小權限與可丟棄的環境。
- **骨架的範例工具是佔位。** `dsh-foo_hello` 只是證明接線通，不改它就是一個沒用的工具。
- **`Config` 只做靜態判斷。** doctor 與 inspect 不執行被檢查的程式碼，所以只能判定字面物件；zod schema 或重新匯出的 `Config` 會標成未驗證。
- **`plugin_inspect` 列不出工具名稱。** 它回報的是 entry 的載入狀態，不是每個工具有沒有註冊。
- **不代你安裝、不改 profile、不建 repo。** 它只寫檔案。
