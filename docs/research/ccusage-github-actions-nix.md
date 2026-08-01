# ccusageを参考にしたtayk GitHub Actions・Nix改善調査

- 調査日: 2026-07-31
- ccusage固定commit: `1e47c1f526d6afcd68b754a3595f194e9baeb40c`
- tayk固定commit: `0a81050ec2b08d8954e95a2cc420d1ace83d13e3`
- 調査区分: 事実 / 分析 / 推奨を分離
- 実装状態: 本調査ではrepository実装を変更していない。以下は後続担当向けの確定実装指示
- 原典: [issue #141 の research 完了コメント](https://github.com/daiki-beppu/tayk/issues/141#issuecomment-5134716708)

以下の基礎データは takt run の一時 report path であり、run 掃除後は残っていない。主要な事実は本文の固定 commit URL と公式出典から再検証できる。

- `reports/data-ccusage-github.md`
- `reports/data-ccusage-nix.md`
- `reports/data-tayk-current.md`
- `reports/data-tayk-history.md`
- `reports/tayk-npm-registry-20260731.json`

## 1. 結論と推奨する実装範囲

### 結論

ccusageの構成をそのまま移植しない。taykで問題を実測・確認でき、既存ADRと検査SSOTを壊さない次の6候補だけを実装対象にする。

| ID | 採用 | 優先度 | 実装概要 |
|---|---|---:|---|
| C-01 | そのまま採用 | P1 | checkout全箇所に `persist-credentials: false` |
| C-02 | tayk向けに変更して採用 | P1 | Nix pinの `actionlint` を `bun run check` に追加 |
| C-03 | tayk向けに変更して採用 | P1 | Nix pinの `nixfmt`、flake `formatter`、read-only format gate |
| C-04 | tayk向けに変更して採用 | P1 | CI/releaseのconcurrencyとjob timeout |
| C-05 | tayk向けに変更して採用 | P1 | `package.json.repository` とnpm CLI限定例外のADR明文化 |
| C-06 | tayk向けに変更して採用 | P2 | DependabotでBun/Actions/Nixを週次・3日cooldown更新 |

推奨しない主要候補:

- ccusageの4-system宣言、native build matrix、pkg.pr.new、性能コメント
- flake-partsと15 Nix moduleへの分割
- bun2nixとgenerated `bun.nix`
- Rust/Crane artifact layering
- `/nix` store全体を使う独自cache action
- `nix flake check` と別package testへの検査分割
- Renovate、tagpr、contributor gate、Pullfrog
- taktをflake/CIへpinすること

これらはtayk側に対応する問題がないか、ADR-0003/0008と衝突するか、実測なしでは保守費用が効果を上回る。

### 実装後も維持する不変条件

1. ゲート集合のSSOTは `package.json.scripts.check` だけ。
2. CI入口は `nix develop --command bun run check` の1 step。
3. Bun versionのSSOTは `flake.nix` / `flake.lock`。
4. `takt workflow doctor` はpre-push限定で、CI/`check`へ入れない。
5. releaseはmanualなら常にdry-run、tagだけ実publish、CI成功後にpublish。
6. external Actionは40桁SHA pin + version commentを維持。

## 2. ccusageのGitHub Actions構成

### 事実

固定commitの `.github` は30ファイル。

- workflow: 9
- composite action: 7
- Nushell script: 5
- Issue template: 3
- その他: 6
- reusable workflow: 0
- remote Action: 14種、全て40桁SHA pin
- Dependabot: なし
- Renovate: あり

固定URL:

- tree: https://github.com/ccusage/ccusage/tree/1e47c1f526d6afcd68b754a3595f194e9baeb40c/.github
- CI: https://github.com/ccusage/ccusage/blob/1e47c1f526d6afcd68b754a3595f194e9baeb40c/.github/workflows/ci.yaml
- release: https://github.com/ccusage/ccusage/blob/1e47c1f526d6afcd68b754a3595f194e9baeb40c/.github/workflows/release.yaml
- Nix cache composite: https://github.com/ccusage/ccusage/blob/1e47c1f526d6afcd68b754a3595f194e9baeb40c/.github/actions/setup-nix-cache/action.yaml
- Renovate: https://github.com/ccusage/ccusage/blob/1e47c1f526d6afcd68b754a3595f194e9baeb40c/.github/renovate.json

CIは単純なlint/test workflowではない。主なグラフは以下。

```text
changes / security scan / preflight
  -> tests + 5 native build legs
  -> preview package
  -> npm/pnpm × 5 OS E2E + performance
  -> action timeline + final ci-gate
```

主な構造:

- workflow defaultはread-only、write権限はjob単位。
- PR codeを実行するscan jobと `security-events: write` のSARIF upload jobをartifact境界で分離。
- docs-only時もsecurity/workflow lintは実行。
- conditional jobを最後の `ci-gate` が集約。
- matrixは `fail-fast: false`。
- 主要jobに10〜30分のtimeout。一部jobは未設定。
- checkoutの多くで `persist-credentials: false`。
- native artifactsは欠損時error、E2E downloadはbackoff retry。
- CI workflow自体にconcurrencyはない。

release:

```text
tagpr -> 6 native builds -> OIDC npm publish -> GitHub Release
```

- `concurrency: tagpr`
- npm jobだけ `id-token: write`
-長期npm tokenなし
- `--provenance --access public`
- release job再実行の制約をworkflowコメントに明記

### 分析

taykへ価値があるのは大規模graphではなく、資格情報をcheckoutへ残さないこと、read/write責務分離、timeout、release直列化、workflow静的検査である。taykは1 quality jobなのでfinal gateやdocs-only分岐を導入する意味がない。

## 3. ccusageのNix構成

### 事実

- `flake.nix`: 63行
- Nix直下module: 15件
- Nix関連合計: 1,904行（lock含む）
- direct inputs: 11
- lock nodes: 18
- declared systems: Linux/Darwin × x86_64/aarch64 の4件
- outputs: apps、packages、11 checks、formatter、devShell
- Node/pnpm/Bun/Rustを用途別に併用

固定URL:

- flake: https://github.com/ccusage/ccusage/blob/1e47c1f526d6afcd68b754a3595f194e9baeb40c/flake.nix
- lock: https://github.com/ccusage/ccusage/blob/1e47c1f526d6afcd68b754a3595f194e9baeb40c/flake.lock
- checks: https://github.com/ccusage/ccusage/blob/1e47c1f526d6afcd68b754a3595f194e9baeb40c/nix/checks.nix
- formatter: https://github.com/ccusage/ccusage/blob/1e47c1f526d6afcd68b754a3595f194e9baeb40c/nix/treefmt.nix
- devShell: https://github.com/ccusage/ccusage/blob/1e47c1f526d6afcd68b754a3595f194e9baeb40c/nix/dev-shell.nix

重要な実測:

```text
nix flake show --all-systems
-> x86_64-darwin評価失敗
-> "Nixpkgs 26.11 has dropped support for x86_64-darwin"
```

したがって、4 systemsの宣言は4 systemsの継続的な評価成功を意味しない。

lock更新は `nix flake update litellm` のようにinputを限定し、snapshot内容が変わらなければlock-only churnを破棄する。cacheは独自substituterではなく、cache.nixos.orgとGitHub Actions `/nix` cacheの二層。

### 分析

ccusageのflake分割、bun2nix、Crane、source filteringはnative Rust monorepoの実在するbuild costに対応する。taykはbuildless Bun packageで `flake.nix` 53行、input 1件、devShellだけなので移植根拠がない。

転用できる原則は次の3点。

1. input更新を限定する。
2. formatter/checkの実装を一箇所にする。
3. system対応は宣言ではなく評価で検証する。

## 4. taykの現行構成

### GitHub Actions

`ci.yml`:

- trigger: 全PR、main push、workflow_call
- runner: `ubuntu-24.04`
- permissions: `contents: read`
- checkout/Nix installer/magic cacheは40桁SHA pin
- command: `nix develop --command bun run check`
- concurrency、timeoutなし
- checkout credential保持は既定値のまま

`release.yml`:

- trigger: `v*` tag、workflow_dispatch
- reusable CI成功後だけpublish
- publish job: `contents: read`, `id-token: write`
- manualは `npm publish --dry-run`
- tag/version不一致はexit 1
- concurrency、timeout、environmentなし
- checkout credential保持は既定値

### Nix / package

```text
input: nixpkgs/nixos-unstable
systems: aarch64-darwin, x86_64-linux
outputs: devShells only
devShell packages: bun, direnv, git, nodejs_24
.envrc: use flake
```

shellHookはGit rootとpackage nameを検証し、taykだけにfrozen installする。失敗は警告でdevShell入場を止めない。

`check` は次の6ゲートを直列実行。

```text
lockfile:check -> typecheck -> lint -> format:check -> test -> fallow
```

実測:

| command | 結果 |
|---|---|
| `nix flake check --no-build` | exit 0、0.48秒 |
| `nix flake show --all-systems --json --no-write-lock-file` | exit 0、0.54秒、2 systems評価 |
| `bun run check` | exit 0、52.93秒、225 pass / 1 skip |
| pinned `actionlint 1.7.12` | exit 1、release nested shellにSC2016 |
| `# shellcheck disable=SC2016` をrun block先頭へ加えた入力 | actionlint exit 0 |
| pinned `nixfmt 1.4.0 --check flake.nix` | exit 1、`flake.nix: not formatted` |

### 完了済み変更

指定11 issueを7 commitで再確認した。11/11が現在も解決済み、無効化0。

- #105: cwd非依存shellHook
- #114: check gateの動的導出
- #106: lockfile gateをcheck先頭へ一本化
- #83/#102: direnv一発setup
- #82/#92: check SSOT
- #72/#91: FlakeHub不要OIDC削除とcache責務
- #95/#96: trusted publishingとmanual dry-run

再提案してはならない。

残存する別finding:

- ARCH-001: install失敗時のLefthook ownership
- ARCH-003: Bun-only規約とreleaseのnpm CLI例外が未定義

ARCH-001は今回の主要変更から分離する。ARCH-003はC-05で明文化する。

## 5. ccusageとtaykの比較表

| 軸 | ccusage | tayk | 判定 |
|---|---|---|---|
| Action pin | 14種全てfull SHA | 3種全てfull SHA | 同等、変更不要 |
| permissions | default read + job昇格 | job `contents: read`; publishだけOIDC | taykで既に最小化 |
| checkout credential | 多くでfalse | 未指定 | C-01 |
| CI concurrency | なし | なし | ccusage模倣ではなくtayk運用改善C-04 |
| timeout | 主要jobに設定 | なし | C-04 |
| workflow lint | actionlint + zizmor | 構造testのみ | C-02 |
| gate SSOT | Nix checks + just +別test package | package.json `check` 1本 | tayk方式維持 |
| final gate | conditional multi-jobを集約 | quality 1 job | 不要 |
| matrix | native/OS/package runner多数 | ubuntu 1件 | 不要 |
| release | tagpr/native/GH release | tag/manual npm package | tayk方式維持 |
| OIDC publish | あり | あり | 解決済み |
| dependency bot | Renovate | なし | C-06はDependabotで実現 |
| direct Nix inputs | 11 | 1 | 分割/flake-parts不要 |
| systems | 4宣言、1評価失敗 | 2宣言、2 show評価成功 | tayk維持 |
| formatter output | treefmt | なし | C-03 |
| checks output | 11 | なし | SSOT二重化を避け不採用 |
| store cache | custom `/nix` cache | magic-nix-cache | 実測なし変更不要 |
| Bun packaging | bun2nix補助tool | Bun runtime/package manager | bun2nix不採用 |

## 6. 採用可否・優先度付き候補一覧

| ID | 問題 | 効果 | コスト/保守 | リスク | 結論 |
|---|---|---|---|---|---|
| C-01 | test scriptへcheckout tokenが残る | credential露出面縮小 | YAML 2箇所 | git authが必要なstepを将来追加時に明示必要 | P1採用 |
| C-02 | GitHub workflow schema/式/shellを完全検査しない | PR前にworkflow error検出 | Nix package + gate + SC2016 directive | actionlint更新時の新診断 | P1採用 |
| C-03 | flake.nixが公式formatterで未整形 | format drift防止、`nix fmt`標準入口 | Nix package/output + scripts | 初回format差分 | P1採用 |
| C-04 | 重複runと無制限hang | runner浪費/停止不能を抑制 | YAMLのみ | timeoutが短すぎるとfalse failure | P1採用、15分 |
| C-05 | npm公式repository要件欠落、npm例外未定義 | trusted publish設定整合、規約矛盾解消 | manifest/ADR/AGENTS | private repoではprovenance生成不可 | P1採用 |
| C-06 | Bun/Action/Nix更新が手動 | stale dependency削減 | bot PR運用 | PR noise、bot初回互換性 | P2採用 |
| C-07 | flake outputsがdevShellだけ | なし（欠落自体は問題でない） | checks/package derivation大 | check SSOT二重化 | 不採用 |
| C-08 | 2 systemsのみ | 利用要求未発見 | runner/matrix増 | ccusage同様宣言drift | 不採用 |
| C-09 | flake単一ファイル | 現状53行で問題なし | flake-parts/input/module保守 | 過剰設計 | 不採用 |
| C-10 | cache hit率未取得 | 効果未測定 | custom action/key/GC | unsigned cache、容量 | 不採用 |
| C-11 | dependency botなし | Renovateの高度policy | App/config運用 | Dependabotと二重化 | Renovateは不採用 |
| C-12 | release自動化が単純 | GH Release/native不要 | tagpr導入大 | tayk配布形態に不適合 | 不採用 |

## 7. 対象ファイル別の具体的変更指示

### 7.1 `flake.nix`

同じnixpkgs inputを使い、input追加・lock更新なしで変更する。

```nix
let
  systems = [ "aarch64-darwin" "x86_64-linux" ];
  forAllSystems = nixpkgs.lib.genAttrs systems;
  pkgsFor = system: import nixpkgs { inherit system; };
in {
  formatter = forAllSystems (system: (pkgsFor system).nixfmt);
  devShells = forAllSystems (system:
    let pkgs = pkgsFor system;
    in {
      default = pkgs.mkShell {
        packages = with pkgs; [
          actionlint
          bun
          direnv
          git
          nixfmt
          nodejs_24
        ];
        # existing shellHookは変更しない
      };
    });
}
```

合格条件:

- `nix eval .#formatter.aarch64-darwin` 成功
- `nix develop --command actionlint --version` がpinned版を表示
- `nix develop --command nixfmt --version` がpinned版を表示
- existing shellHook test全件成功

### 7.2 `package.json`

`repository` を追加。

```json
"repository": {
  "type": "git",
  "url": "https://github.com/daiki-beppu/tayk.git"
}
```

scriptsはゲート集合をここだけで変更する。

```json
"check": "bun run lockfile:check && bun run actions:check && bun run typecheck && bun run lint && bun run format:check && bun run format:nix:check && bun run test && bun run fallow",
"actions:check": "actionlint",
"format:nix:check": "nixfmt --check flake.nix",
"format:nix:fix": "nixfmt flake.nix"
```

既存 `format:check` / `format:fix` はOxfmt所有のまま変えない。Nixを別scriptにすることでfix/check対応を明示する。

依存package追加はないため `bun.lock` は変更しない。実装後に `bun install --frozen-lockfile --dry-run --ignore-scripts` で不変を確認する。

### 7.3 `.github/workflows/release.yml`

SC2016は意図したnested bashのため、run block先頭に局所directiveを置く。

```yaml
concurrency:
  group: release-${{ github.ref }}
  cancel-in-progress: false

jobs:
  publish:
    timeout-minutes: 15
    steps:
      - name: Checkout
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      # ...
      - name: Publish package
        run: |
          # shellcheck disable=SC2016
          nix develop --command bash -euc '
            # existing body unchanged
          '
```

workflow-level concurrencyによりmanual dry-runとtag releaseをref単位で直列化する。公開jobはキャンセルしない。

変更しないもの:

- trigger
- reusable CI
- publish permissions
- DRY_RUN判定
- version照合
- `npm publish`

### 7.4 `.github/workflows/ci.yml`

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}

jobs:
  quality:
    timeout-minutes: 15
    # existing permissions unchanged
    steps:
      - name: Checkout
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
```

`Check` stepは1件、commandは正確に `nix develop --command bun run check` のまま。

### 7.5 `.github/dependabot.yml`（新規）

ccusageの「3日minimum release age」という問題対策を、taykではGitHub標準Dependabotのcooldownで実現する。

```yaml
version: 2
updates:
  - package-ecosystem: bun
    directory: /
    schedule:
      interval: weekly
      day: monday
      time: "09:00"
      timezone: Asia/Tokyo
    cooldown:
      default-days: 3
    open-pull-requests-limit: 5
    labels: [dependencies]
    commit-message:
      prefix: "chore(deps)"
    groups:
      bun-minor-and-patch:
        patterns: ["*"]
        update-types: [minor, patch]

  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
      day: monday
      time: "09:15"
      timezone: Asia/Tokyo
    cooldown:
      default-days: 3
    open-pull-requests-limit: 5
    labels: [dependencies]
    commit-message:
      prefix: "chore(deps)"
    groups:
      actions-minor-and-patch:
        patterns: ["*"]
        update-types: [minor, patch]

  - package-ecosystem: nix
    directory: /
    schedule:
      interval: weekly
      day: monday
      time: "09:30"
      timezone: Asia/Tokyo
    cooldown:
      default-days: 3
    open-pull-requests-limit: 5
    labels: [dependencies]
    commit-message:
      prefix: "chore(deps)"
    groups:
      nix-inputs:
        patterns: ["*"]
```

前提: repositoryに `dependencies` labelを作る。存在しないままmergeしない。

GitHub公式は2026-07-31時点で `bun`（Bun >=1.2.5）、`github-actions`、`nix` をecosystemとして掲載する。

- https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference
- https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/secure-your-dependencies/auto-update-actions

### 7.6 `lefthook.yml`

既存Oxfmt commandは維持し、Nix用fix commandを追加。

```yaml
pre-commit:
  commands:
    format-fix:
      # existing
    format-nix-fix:
      glob: "*.nix"
      run: bun run format:nix:fix
      stage_fixed: true
```

pre-pushは変更しない。

### 7.7 tests

`test/check.test.ts`:

- CI/releaseをYAML parseし、全checkoutの `persist-credentials === false` を検査。
- CI concurrency group/cancel式、quality timeout 15を検査。
- release concurrency/cancel false、publish timeout 15を検査。
- release run blockにSC2016 directiveがあることではなく、`actionlint` exit 0を観測する。本文一致testを増やさない。
- gate sequenceは既存 `deriveExpectedGateNames()` に追随させ、固定列を追加しない。

`test/devshell.test.ts`:

- host PATHを除いたdevShellで `actionlint --version` と `nixfmt --version` がexit 0。
- existing cwd/space path/frozen failure testsは維持。

`test/repository-config.test.ts`:

- `package.json.repository.url` が上記GitHub URL。
- Dependabot YAMLが3 ecosystemを一意に持ち、directory `/`、weekly、cooldown 3、open limit 5。

### 7.8 `flake.lock`

C-02/C-03は既存nixpkgs内packageを参照するだけなので変更しない。

確認:

```sh
git diff --exit-code -- flake.lock
```

将来のNix更新は全更新でなく:

```sh
nix flake update nixpkgs
git diff -- flake.lock
```

review項目:

- 変更nodeが `nixpkgs` と不可避なtransitive nodeだけ
- owner/repo不変
- rev/narHash更新を確認
- actionlint/nixfmt/Bun/Nodeのversion差
- `bun.lock`無変更

### 7.9 `.envrc`

変更なし。taykはimport moduleを持たず `use flake` だけで責務が完結する。ccusageの `watch_dir nix/` は転用しない。

## 8. 実施順序

### Stage 0: baseline

```sh
git status --short
nix flake show --all-systems --no-write-lock-file
nix flake check --no-build
bun run check
takt workflow doctor
```

全てexit 0を進行条件とする。現在の実測では前3件中Nix2件と`bun run check`は0。doctorは本調査で未実行のため後続が必ず確認する。

### Stage 1: 決定境界

対象:

- ADR-0003
- AGENTS/CLAUDE
- package repository metadata

検証:

- JSON parse
- package test
- `npm publish --dry-run` はまだworkflow_dispatchで実行しない

切り戻し単位: 文書とmanifest metadataを同時にrevert。

### Stage 2: Nix quality tools

対象:

- `flake.nix`
- `package.json`
- `lefthook.yml`
- flake initial format
- tests

実行:

```sh
nix develop --command nixfmt flake.nix
nix develop --command actionlint
nix develop --command nixfmt --check flake.nix
bun run check
```

進行条件: 全exit 0、`flake.lock`/`bun.lock`無変更。

### Stage 3: workflow hardening

対象:

- CI/release concurrency、timeout、checkout
- workflow contract tests

実行:

```sh
nix develop --command actionlint
bun run check
```

進行条件: exact CI commandが1件だけ、release manual/tag条件が不変。

### Stage 4: dependency automation

対象:

- `dependencies` label
- `.github/dependabot.yml`
- config test

進行条件: GitHub Dependabot画面がconfig errorを表示せず、最初のscheduled/manual checkが3 ecosystemを認識。

### 推奨commit分割

1. `docs: npm公開境界の限定例外を明文化する (#issue)`
2. `feat: Nix固定のActions・flake検査をcheckへ追加する (#issue)`
3. `ci: workflowの資格情報・並行実行・timeoutを制約する (#issue)`
4. `chore: DependabotでBun・Actions・Nix更新を管理する (#issue)`

## 9. 検証手順と合格基準

| 検証 | command / 操作 | 合格 |
|---|---|---|
| flake全system評価 | `nix flake show --all-systems --no-write-lock-file` | exit 0、2 systems |
| flake既知output | `nix flake check --no-build` | exit 0 |
| formatter output | `nix eval .#formatter.aarch64-darwin` | exit 0 |
| devShell | `nix develop --command true` | exit 0 |
| frozen install | `nix develop --command bun install --frozen-lockfile` | exit 0 |
| workflow lint | `nix develop --command actionlint` | exit 0、warning/error 0 |
| Nix format | `nix develop --command nixfmt --check flake.nix` | exit 0、作業tree無変更 |
| repository gate | `bun run check` | exit 0、全gate通過 |
| Takt定義 | `takt workflow doctor` | exit 0、`Workflow OK` |
| lock不変 | `git diff --exit-code -- flake.lock bun.lock` | exit 0 |
| PR CI | PR作成 | quality成功、15分未満 |
| PR concurrency | 同PRへ短時間に2 push | 古いPR run canceled、新run継続 |
| main/release安全 | main/tag runを重複開始 | PR以外は実行中runを自動cancelしない |
| cache cold/warm | cache削除後runと同SHA re-runのcache log/時間比較 | 1回目miss、2回目restore。機能結果は同一 |
| release dry-run | workflow_dispatch | CI成功、`npm publish --dry-run`、registry version増加なし |
| tag/version mismatch | test fixtureまたは安全なscript unit | mismatchでpublish前exit 1 |
| Dependabot | Insights/Dependency graph | 3 ecosystem認識、config error 0 |

複数OSを新規提案していないためmatrix追加検証は不要。現在の2 Nix systemsは`show --all-systems`で評価し、Linux実buildはPR CIが担う。

actionlintのSC2016 directiveは局所適用し、global `-ignore SC2016` は使わない。

## 10. リスクとロールバック方法

| 変更 | リスク | 緩和 | rollback |
|---|---|---|---|
| checkout credential false | 将来auth git操作が失敗 | 現行にauth git操作なし | 当該stepだけwithを戻す |
| actionlint | upstream診断追加でgate赤 | Nix lockでversion固定、限定更新review | script/package/directiveを1単位でrevert |
| nixfmt | 初回大きなformat差分 | flake.nixだけ、意味差分と分離review | formatter/scriptsをrevert。format差分は独立revert可 |
| timeout | cold CIが15分超過 | 現行local 53秒、CIログで監視 | 15→30へ拡大、削除は最終手段 |
| CI cancel | reusable caller誤衝突 | groupにworkflowとPR/refを含める | concurrency blockをrevert |
| release直列化 | manual queue待ち | cancelせず安全優先 | release concurrencyのみrevert |
| repository metadata | URL不一致 | README正本URLとnpm設定を照合 | metadata revert、publish前に修正 |
| Dependabot | PR noise/互換失敗 | cooldown、minor/patch group、limit 5 | config削除で新規version PR停止、既存PR close |

material deletionはない。全変更はcommit単位でrevert可能。

## 11. ADR・文書更新案

### ADR-0003改訂

新規ADRは不要。既存Bun-only決定へ限定例外を追記する。

記録内容:

1. dependency install、package scripts、runtime、testはBun-only。
2. npm registry公開境界だけ、trusted publishing/OIDCを行う `npm publish` と安全確認の `npm publish --dry-run` を許可。
3. npm CLIをinstall/test/buildへ拡張しない。
4. この例外はNode/npm versionをNix pinし、release jobだけが使う。
5. package `repository` metadataはtrusted publisher登録先と一致させる。

### AGENTS/CLAUDE

「npm等禁止」の直後に、npm registry公開境界だけADR-0003の限定例外であることを1文追記する。gate列は書き写さない。

### README

変更不要。開発者操作は引き続きdirenv/Bunで、Dependabotやrelease内部npm CLIを通常手順へ露出しない。

### ADR-0008

変更不要。`actionlint` はGitHub Actions workflow検査でありTakt workflow doctorの責務を侵害しない。`takt workflow doctor` の配置も変えない。

## 12. 調査できなかった事項

| 項目 | 状態 | 理由 |
|---|---|---|
| tayk GitHub Actions実run時間/cache hit率 | 調査不可 | 未認証GitHub APIが404。repositoryは公開APIで取得不能 |
| npm trusted publisher登録値 | 調査不可 | npmjs.com認証済み外部設定 |
| traditional npm token禁止設定 | 調査不可 | 同上 |
| private repositoryでのprovenance | 公式上生成不可 | npm公式はpublic repository/packageを自動provenance条件とする |
| ccusage全4 system build | 部分取得 | `x86_64-darwin`評価で失敗、native全runner build未実施 |
| ccusage cache cold/warm実測 | 未確認 | workflow定義は確認、run artifact/log未取得 |
| tayk過去run exact branch | 未発見 | sibling worktreeのprimary reportsとlanding commitは発見 |
| Dependabot初回Bun/Nix PR | 未確認 | config未導入。導入後の外部実行が必要 |

## 主要公式出典

- GitHub concurrency: https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency
- GitHub secure use / SHA pin: https://docs.github.com/en/actions/reference/security/secure-use
- Dependabot options: https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference
- Dependabot config: https://docs.github.com/en/code-security/concepts/supply-chain-security/about-the-dependabot-yml-file
- npm trusted publishing: https://docs.npmjs.com/trusted-publishers/
- npm provenance: https://docs.npmjs.com/generating-provenance-statements/
- Nix flakes: https://nix.dev/concepts/flakes.html
- Nix flake check: https://nix.dev/manual/nix/latest/command-ref/new-cli/nix3-flake-check.html
- Nix input update: https://nix.dev/manual/nix/latest/command-ref/new-cli/nix3-flake-update.html
- actionlint: https://github.com/rhysd/actionlint
