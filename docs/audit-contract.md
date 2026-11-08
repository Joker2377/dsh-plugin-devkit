# plugin_audit — 凍結介面契約（0.2.0）

本檔案是并行實作時唯一的介面依據。任何模組不得改動此處簽名；若認為契約有誤，回報給 Lead，不要自行改。

## 目的

一個唯讀工具 `plugin_audit(spec)`：在把第三方套件／外掛裝進 profile 之前，一次做完
dist.integrity 比對、install/postinstall 掃描、依賴面、provenance/gitHead、`engines.dsh` 相容性、
以及與現有 profile 的版本撞車，輸出結構化報告與可否決結論（allow / block）。

唯讀硬約束：不寫入任何檔案、不執行套件程式碼、不 spawn npm、不改 profile。

## 檔案歸屬（並行時不得越界）

| 檔案 | 擁有者 |
| --- | --- |
| `lib/spec.js`、`lib/registry.js`、`lib/tar.js` | A |
| `lib/audit.js`、`lib/audit-report.js` | B |
| `lib/profile.js` | C |
| `lib/tools.js`、`scripts/cli.mjs`、`README.md` | D |
| `package.json`、`lib/index.js`、`docs/audit-contract.md` | Lead |

測試檔各自擁有：`test/spec.test.mjs`、`test/registry.test.mjs`、`test/tar.test.mjs`（A）、
`test/audit.test.mjs`（B）、`test/profile.test.mjs`（C）。不要建立共用 fixture 目錄，各測試自帶 inline 假資料。

## 共用 finding 形狀

```js
/** @typedef {{ level: 'error'|'warn'|'info', code: string, message: string, hint?: string, evidence?: object }} Finding */
```

`code` 一律以 `audit/` 開頭，且只能用下表既有代碼；要新增代碼先回報 Lead。

| level | code |
| --- | --- |
| error | `audit/spec-invalid`、`audit/network`、`audit/integrity-mismatch`、`audit/dist-missing`、`audit/install-script`、`audit/compat-unmet`、`audit/profile-collision`、`audit/version-missing`、`audit/tarball-unreadable` |
| warn | `audit/binding-gyp`、`audit/dep-surface`、`audit/provenance-missing`、`audit/provenance-unreachable`、`audit/githead-missing`、`audit/compat-missing`、`audit/spec-unsupported`、`audit/binary`、`audit/patch-js`、`audit/patch-missing`、`audit/profile-source`、`audit/manifest-mismatch` |
| info | `audit/integrity-ok`、`audit/publish-script`、`audit/dep-count`、`audit/provenance-ok`、`audit/githead-ok`、`audit/githead-unreachable`、`audit/compat-ok`、`audit/compat-undeclared`、`audit/profile-absent`、`audit/profile-upgrade`、`audit/profile-unparsable`、`audit/published`、`audit/deprecated`、`audit/patch-ok`、`audit/tarball-offhost` |

**`verdict.install` 有三態**：`allow`（全部檢查跑完、無 error）、`block`（有 error）、`not-audited`（kind 為 local/git，checked 為空——不是通過，只是沒查；`ok` 對它為 `false`，CLI exit 3）。

## `lib/spec.js`

```js
export function parseSpec(spec)
```
回傳其一：
- `{ kind: 'registry', name: string, range: string, raw }` — `foo`（range `latest`）、`foo@1.2.3`、`foo@^1`、`@scope/name@1.0.0-rc.1`。scoped 名稱的第一個 `@` 屬於 scope，range 取**最後一個** `@` 之後。
- `{ kind: 'git', url: string, raw }` — `github:owner/repo`、`git+https://…`、`https://github.com/owner/repo(.git)?`。
- `{ kind: 'local', path: string, raw }` — 絕對路徑、`./x`、`../x`、`file:`、`link:`。
- `{ kind: 'invalid', reason: string, raw }` — 空字串、含空白、其它無法辨識形式。

## `lib/registry.js`

```js
export class RegistryError extends Error {}   // code: 'NETWORK' | 'NOT_FOUND' | 'INVALID_JSON' | 'NO_MATCHING_VERSION'
export function createRegistryClient({ registry = 'https://registry.npmjs.org', fetch = globalThis.fetch, timeoutMs = 15000 } = {})
```

回傳物件（方法都 async）：
- `versionDoc(name, range)` → `{ name, version, manifest, dist: { tarball, integrity, shasum }, gitHead, publishTime, deprecated, requestedRange }`。`range` 為 `latest` 時取 `dist-tags.latest`；否則用 `lib/semver.js` 的 `parseRange`/`satisfies` 從 `versions` 挑最高符合版本（語義同 `includePrerelease: true`）。找不到範圍內版本 → `NO_MATCHING_VERSION`；套件不存在（404）→ `NOT_FOUND`。`manifest` 是該版本完整 package.json 物件。`gitHead`、`deprecated` 允許 undefined。
- `tarball(url)` → `Uint8Array`（不可用 `arrayBuffer` 型別以外的方式；回傳 Node `Buffer` 亦可）。
- `attestations(name, version)` → `{ found: boolean, status: number, url: string, predicates: string[], raw: object|undefined }`。URL 為 `${registry}/-/npm/v1/attestations/${name}@${version}`；404 → `found:false`、`status:404`，**不丟錯**；其它 5xx/網路錯 → `status` 帶原碼且 `raw: undefined`（由呼叫端轉 `provenance-unreachable`）。
- `packument(name)` → 原始 JSON（給需要 `time`、`dist-tags` 的呼叫端）。

錯誤要帶 `url`、`status`；`message` 為人看得懂的一行。

## `lib/tar.js`

```js
export function listTarEntries(gzipBuffer)   // → [{ path, size, type: 'file'|'dir'|'other' }]
export function readTarFile(gzipBuffer, path) // → Uint8Array | undefined
```

用 `node:zlib` 解 gzip，手寫 512-byte tar header 解析（ustar，含 `./` 前綴正規化與 GNU/PAX longname 的 `L`/`x` 記錄至少要跳過不崩）。`path` 對外一律去掉前導 `./` 與 `package/` 前綴。壞資料丟 `Error`（呼叫端轉 `audit/tarball-unreadable`）。

## `lib/profile.js`

```js
export async function readProfile(dir)   // dir 可為 profile 根或含 package.json 的目錄
```
→ `{ root, manifest, dependencies: Record<string, { raw, kind: 'range'|'link'|'file'|'github'|'workspace', version?: string, resolvedPath?: string }>, bundles: string[], hostVersion?: string }`
`kind` 判定：`link:`/`file:`/`github:`/`workspace:` 前綴，其餘為 `range`。`link:`/`file:` 的條目要讀被指向的 `package.json` 取 `version`（讀不到就留 undefined，不丟錯）。`bundles` 取 `manifest.dsh.profile.bundles`，缺則 `[]`。`hostVersion` 取 `manifest.dependencies['@deepseek-ai/dsh-tools']` 或 `manifest.devDependencies` 同名字串（僅供參考，實際 host 版本由呼叫端傳入優先）。

```js
export function collisionFindings({ candidate, profile, candidateName, candidateVersion })
```
`candidate` 是該套件 manifest。回傳 `Finding[]`：
1. 對 candidate 的 `dependencies` 與 `peerDependencies` 每個名稱：若 profile `dependencies` 有同名條目且 `kind === 'range'` 且有 `version`，用 `satisfies(installedVersion, candidateRange)` 判定；不滿足 → `audit/profile-collision`（error，訊息要寫出「裝了 X@V，但候選要求 R」）。
2. `candidateName` 已在 profile：同版本 → 無 finding；不同版本 → `audit/profile-upgrade`（info，寫出現有 raw spec 與將變成的版本；`link:`/`github:` 來源要點明「安裝會把來源改成 registry」）。
3. 完全沒重疊 → `audit/profile-absent`（info）。

## `lib/audit.js`

```js
export async function auditSpec(spec, options = {}) // → AuditResult
```
`options`：`{ registry, registryClient, fetch, profileDir, hostVersion, cwd, now }`（全部可選；`profileDir` 預設 `C:\Users\jimmy\.dsh\profiles\desktop`）。
`options.registryClient` 若提供（符合上面 client 形狀的物件）就**取代** `createRegistryClient`，這是測試唯一允許的注入點。

```js
/**
 * @typedef {object} AuditResult
 * @property {boolean} ok                        verdict.install === 'allow'
 * @property {{ spec: string, kind: string, name?: string, version?: string, source?: string }} target
 * @property {{ install: 'allow'|'block'|'not-audited', blocking: string[], reason: string, checked: string[] }} verdict
 * @property {Finding[]} findings
 * @property {{ error: number, warn: number, info: number }} counts
 * @property {object} evidence
 */
```
`verdict.checked` 要逐項列出實際跑過的檢查名（`integrity`、`install-scripts`、`dependency-surface`、`provenance`、`githead`、`dsh-compat`、`profile-collision`、`tarball-contents`），讓讀者知道哪一項沒跑。`verdict.blocking` 只放 error 的 code。`reason` 一行：allow 寫「N 項檢查通過，無阻斷項」，block 寫第一個阻斷原因。

步驟（固定順序，每步獨立捕捉例外轉 finding，不讓一個步驟炸掉整份報告）：
1. `parseSpec`；`invalid` → `audit/spec-invalid`（error）+ 立刻回傳 block。`local` → 只有 `audit/spec-unsupported`（warn）：指向 `plugin_doctor`，不做 registry 檢查。`git` → `audit/spec-unsupported`（warn，說明 registry 側 integrity/provenance 不適用），其餘步驟跳過。
2. `versionDoc`（失敗：`NOT_FOUND`/`NO_MATCHING_VERSION` → `audit/version-missing`；`NETWORK`/`INVALID_JSON` → `audit/network`）。
3. 下載 tarball → `listTarEntries`；`dist.integrity` 與 `dist.shasum` 都存在時，實測 sha512/sha1 必須一致 → `audit/integrity-ok`(info) / `audit/integrity-mismatch`(error)。`dist` 缺欄位 → `audit/dist-missing`(error)。tarball 解析失敗 → `audit/tarball-unreadable`(warn)，integritiy 仍可算。
4. 驗證用的 manifest 一律以**tarball 內的 package.json** 為準（`readTarFile(..., 'package.json')`）；讀不到才退回 registry 的 manifest，並在 evidence 標 `manifestSource`。
5. install 腳本：`preinstall|install|postinstall` 任一存在 → `audit/install-script`(error)；`prepare` → `audit/publish-script`(info，registry tarball 安裝時 npm 不執行它)；`prepublishOnly|prepack|prepublish` → `audit/publish-script`(info)。tarball 內任何 `binding.gyp` → `audit/binding-gyp`(warn)。tarball 內 `node_modules/**/package.json` 的 install 腳本 → `audit/install-script`(error，evidence.bundled)。`dsh.bundle.patch` 指向的檔案若含 `!!js` → `audit/patch-js`(warn)，檔案不存在 → `audit/patch-missing`(warn)，乾淨 → `audit/patch-ok`(info)。
6. 依賴面：`dependencies` 數 → `audit/dep-count`(info)；`optionalDependencies` 非空或 deps 非空但有 `*`/`latest`/git spec → `audit/dep-surface`(warn)。
7. provenance：`attestations` → found → `audit/provenance-ok`(info)；`status 404` → `audit/provenance-missing`(warn)；其它 → `audit/provenance-unreachable`(warn)。
8. gitHead：有值 → `audit/githead-ok`(info)，並在 evidence 記 repository 與 `commitUrl`（github 形式可組時）。沒有 → `audit/githead-missing`(warn)。**不做網路 commit 驗證**（AGENTS 無此授權），在 evidence 標 `githeadVerified: false` 且 `audit/githead-ok` 訊息需寫明「僅比對欄位存在，未向 GitHub 核對 commit」。
9. `engines.dsh` / peers：直接用 `lib/checks.js` 的 `evaluateRequirements(manifest, hostVersion)`。`hostVersion` 未提供 → `audit/compat-missing`(warn)；有 met → `audit/compat-ok`(info)；unmet → `audit/compat-unmet`(error，逐條列出 field/range)。
10. profile 撞車：`readProfile(profileDir)`（讀不到 → `audit/profile-absent`(info)）→ `collisionFindings`。
11. 二進位檔：tarball 內 `.node|.exe|.dll|.so|.dylib` → `audit/binary`(warn，列出前 5 個）。
12. `published`：`publishTime` 距 `now` 超過 730 天 → info。`deprecated` 有值 → info。
13. 收尾：`counts`、`verdict`。

`evidence` 至少含：`registry`、`dist`、`manifestSource`、`scripts`、`dependencies`、`optionalDependencies`、`peerDependencies`、`engines`、`gitHead`、`githeadVerified`、`commitUrl`、`provenance`、`compat`（`{ hostVersion, unmet }`）、`profile`（`{ root, installed: boolean, matched }`）、`tarballFiles`（數量與前 200 個路徑）、`publishTime`。

## `lib/audit-report.js`

```js
export function renderAuditReport(result, { format = 'text' } = {}) // format: 'text' | 'json'
export function auditSummaryLine(result) // 一行：`BLOCK 2 error 3 warn ...`
```
text 版第一行 `plugin_audit <spec>`，第二行 `結論：可以安裝 / 不可以安裝 — <reason>`，第三行 counts 與 `已檢查：…`，空行後 findings（error→warn→info，`✗`/`⚠`/`·`，hint 用 `   → `）。最後一行給下一步建議（block 時「先解決 error；供應鏈核查未過就不安裝」）。

## `lib/tools.js`（D）

新增 `export function createAuditTool()`，`name: 'plugin_audit'`，參數：
`spec`（string，必填）、`registry`、`profileDir`、`hostVersion`、`format`（`'text'|'json'`，預設 `text`）皆 optional string。
description 要寫清楚：唯讀、不安裝、不執行套件程式碼、回傳 allow/block 與 findings。
預設 `hostVersion` 取 `ctx` 不可得時用 `process.env.DSH_VERSION`，都沒有就讓 `audit/compat-missing` 出現。
`lib/index.js`（Lead）會把 `createAuditTool()` 加進註冊清單，D 不要改 `lib/index.js`。

## CLI（D）

`node scripts/cli.mjs audit <spec> [--json] [--registry=…] [--profile=…] [--host=…]`；block 時 exit code 1，allow 時 0；spec 缺 → 用法訊息 + exit 2。

## 測試規則

- `npm run test:sandbox`（`--experimental-test-isolation=none`），沙箱內會 spawn 的 `node --test "test/**"` 可能被擋。
- 全部測試離線：注入假 `fetch`／假 registry client，不連網。需要真網路的測試以 `process.env.DSH_AUDIT_LIVE === '1'` 守門。
- 每個模組至少覆蓋：正常路徑、錯誤路徑（與對應 code）、唯讀性（呼叫前後檔案雜湊不變，涉及 profile 的測試在 `os.tmpdir()` 造 profile）。
