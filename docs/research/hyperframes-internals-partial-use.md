# HyperFrames の内部構造と部分利用可能性の調査（capture 分離・FFmpeg 差し替え・Bun 実行・ライセンス）

調査日: 2026-07-31 / 対象: heygen-com/hyperframes main = `1481fe1` (2026-07-30)、npm `hyperframes` v0.7.84（latest。monorepo 各パッケージも同一バージョン）/ issue #173（親: #172）

## TL;DR

1. **(a) フレーム列出力: 可能（2 経路とも公式サポート）**。`png-sequence` は `mp4 | webm | mov | gif` と並ぶ第一級の出力フォーマットで、encode stage は FFmpeg を一切呼ばず RGBA PNG（`frame_%06d.png`）+ `audio.aac` サイドカーを書くだけ。capture 層の分離利用も `@hyperframes/engine` のセッション API（`createCaptureSession` → `captureFrame` / `captureFrameToBuffer`）として公開されており、公式ドキュメントが「エンコードなしのフレームキャプチャ」「**FFmpeg 以外のカスタムエンコードバックエンド実装**」を明示的にユースケースとして挙げている。
2. **(b) FFmpeg 段の差し替え: プラグイン interface は無いが、切れ目（seam）が 2 つある**。producer の render パイプライン内部に encoder フックは無く、FFmpeg spawn がハードコード。ただし①製品レベル: `--format png-sequence` で FFmpeg 段を丸ごとバイパスし、PNG ディレクトリを mediabunny に食わせる。②ライブラリレベル: engine の capture ループを自前で回し `captureFrameToBuffer` の Buffer を mediabunny に直接流す。**メディア（`<video>`/audio）を含まない composition なら、ffmpeg バイナリが PATH に無くても png-sequence render が完走することを実機検証済み**。
3. **(c) Bun 実行: 動く（macOS arm64 / Bun 1.3.13 で実機検証）**。CLI の `--version` / `doctor` / `render`（png-sequence・mp4 streaming encode）、producer のライブラリ利用、すべて成功。Node >= 22 の実体は `bin/hyperframes.mjs` の `process.versions.node` メジャーバージョン数値比較だけで、特定 Node API への依存は発見できず（サポートポリシー宣言）。Bun は node-compat 24.3.0 を名乗るため素通しになる。そもそも HyperFrames 自身の開発環境が Bun（root に `bun.lock`、全スクリプトが `bun run`、producer に `test:unit:bun` レーン）。
4. **(d) ライセンス: Apache-2.0。コード借用・部分利用は可**。リポジトリルート LICENSE = Apache 2.0、npm `hyperframes` の license フィールドも Apache-2.0。特許許諾つきで MIT/プロプライエタリと互換。NOTICE ファイルは無いので、借用時の義務はライセンス文の同梱・帰属表示・改変明記（§4）のみ。なお HyperFrames 自身が studio で **mediabunny (MPL-2.0) を既に利用している**（相性の先例）。
5. **data-\* スキーマの模倣規模: 「完全互換」は大規模（parsers 約 14.5k 行 + core runtime 約 15k 行）だが、tayk に必要なのはそこではない**。capture engine が要求するのは `window.__hf` seek プロトコル（`duration` + `seek(time)` + 任意の `media`/`transitions`）だけで、data-\* スキーマ非依存。決定的 seek を実装した自前ページなら数十行のグルーコードで capture 層に載る。

---

## 前提: リポジトリ構成

- monorepo（Bun workspaces）。`packages/{core, engine, producer, cli, parsers, player, studio, studio-server, sdk, lint, shader-transitions, aws-lambda, gcp-cloud-run}`
- render パイプラインの本体は **`@hyperframes/producer`**（「HTML-to-video rendering engine using Chrome's BeginFrame API」）。低レベル capture は **`@hyperframes/engine`**（「Seekable web page to video rendering engine (Puppeteer + FFmpeg)」）
- npm `hyperframes`（CLI, `packages/cli`）は workspace 依存を tsup で dist にバンドルして公開（published dependencies に `@hyperframes/*` が無いことで確認）。`@hyperframes/producer` / `@hyperframes/engine` も個別に npm 公開されている（v0.7.84）
- テスト用メディアが Git LFS（`packages/producer/tests/**`）。clone 時は `GIT_LFS_SKIP_SMUDGE=1` 推奨（本調査もそれで実施、checkout 約 172MB）

出典: ルート `package.json`（workspaces / scripts）、`packages/producer/package.json`、`packages/engine/package.json`、`.gitattributes`、npm registry `hyperframes@0.7.84` / `@hyperframes/producer@0.7.84`

## パイプライン構造（stage 分割）

`executeRenderJob`（`packages/producer/src/services/renderOrchestrator.ts`, 約 4,000 行）が stage を直列に呼ぶ:

| Stage | ファイル (`packages/producer/src/services/render/stages/`) | 役割 |
|---|---|---|
| compile | `compileStage.ts` | HTML 読み込み・runtime 注入・アセットローカライズ |
| probe | `probeStage.ts` | メディアの ffprobe（HDR 判定・寸法） |
| extract-videos | `extractVideosStage.ts` | `<video>` を ffmpeg でフレーム展開（frame injection 用） |
| audio | `audioStage.ts` | 音声抽出・ミックス（ffmpeg） |
| capture | `captureStage.ts` / `captureStreamingStage.ts` / `captureHdrStage.ts` | Chrome (BeginFrame / drawElement / screenshot) でフレーム取得 |
| encode | `encodeStage.ts` | FFmpeg エンコード（**png-sequence はここで no-op コピー**） |
| assemble | `assembleStage.ts` | mux + faststart（png-sequence / gif はスキップ） |

- 通常の mp4 経路はデフォルトで **streaming encode 融合**（`captureStreamingStage`）: フレーム Buffer を `ffmpeg -f image2pipe` の stdin に直接パイプし、ディスク書き込みと Stage 5 を吸収する（`packages/engine/src/services/streamingEncoder.ts` 冒頭コメント。「Inspired by Remotion's approach」と明記）
- FFmpeg バイナリは**同梱しない**。解決順は env `HYPERFRAMES_FFMPEG_PATH` → PATH → `.hyperframes/bin` → 既知ディレクトリ（`packages/parsers/src/ffBinaries.ts`）。つまりライセンス上も配布物にも FFmpeg は含まれず、ユーザー環境のバイナリを spawn するだけ

## 問い (a): フレーム列出力 / capture 層の分離利用 → 両方可能

### 経路 1: `--format png-sequence`（製品レベル・CLI/ライブラリ両対応）

- `RenderOutputFormat = "mp4" | "webm" | "mov" | "png-sequence" | "gif"`（`packages/producer/src/services/render/renderFormat.ts`）
- `encodeStage.ts` の png-sequence 分岐（line 225-253）: 「No encoder, no mux, no faststart — captured frames already carry alpha and are the deliverable.」 RGBA PNG を `frame_NNNNNN.png` に連番リネームコピーし、音声があれば `audio.aac` サイドカーを併置。assemble stage もスキップ（trace: `"skipped for png-sequence"`）
- CLI 使用例（`packages/cli/src/commands/render.ts` 組み込みヘルプ）: `hyperframes render --format png-sequence --output frames/`（「RGBA frames for AE/Nuke/Fusion」）
- **実機検証**: 最小 composition（640x360, 1 秒, 10fps）→ `frame_000001.png`〜`frame_000010.png`、`file` 判定 = PNG 640x360 8-bit RGBA。encode phase 所要 3ms（コピーのみ）

### 経路 2: engine のセッション API（capture 層そのもの）

`@hyperframes/engine`（`@hyperframes/producer` からも再 export）の公開 API（`packages/engine/src/services/frameCapture.ts`, 約 3,850 行）:

```
createCaptureSession(serverUrl, outputDir, options) → CaptureSession
initializeSession(session)
getCompositionDuration(session)
captureFrame(session, frameIndex, time)          → { path }   // frame_NNNNNN.{png,jpg} をディスクへ
captureFrameToBuffer(session, frameIndex, time)  → { buffer }  // メモリ上の PNG/JPEG Buffer
closeCaptureSession(session)
+ BeforeCaptureHook（seek 後・screenshot 前のフック）
```

`docs/packages/engine.mdx` が用途を明文化している:

> **Use `@hyperframes/engine` when you need to:** … Capture individual frames (e.g., for thumbnails or sprite sheets) without encoding to video / **Implement a custom encoding backend (not FFmpeg)**

つまり「capture 層だけ借りる」は非公式ハックではなく**設計上サポートされた利用形態**。`CaptureOptions.format` は `"jpeg" | "png"`（`packages/engine/src/types.ts` line 131）。ほかに `hyperframes snapshot`（キーフレームの PNG 抽出）もある。

### 注意点

- CLI の `render` は preflight（`packages/cli/src/browser/preflight.ts`）で **FFmpeg/FFprobe の存在を無条件にチェックし、無ければ format を問わず失敗する**（`runEnvironmentChecks` が常に `checkFFmpeg()` を積み、`render.ts` line 800-806 で failed check → `failCommand()`）。png-sequence でも CLI 経由なら ffmpeg のインストールが必要
- **ライブラリ経由（`executeRenderJob` 直呼び）には preflight が無い**。メディア無し composition の png-sequence render を PATH から ffmpeg を外した状態で実行し、完走することを確認した（後述の検証ログ）。ただし `<video>` を含む composition は extract-videos stage が `runFfmpeg` を呼ぶ（`packages/engine/src/services/videoFrameExtractor.ts`）ため、capture だけでも ffmpeg が要る。音声付きは audio stage（ffmpeg ミックス）が走る

## 問い (b): FFmpeg 段の差し替え拡張点 → interface は無い。seam は 2 つ

### 差し替え「フック」は存在しない

- `encodeStage.ts` は `encodeFramesFromDir` / `encodeFramesChunkedConcat`（`packages/engine/src/services/chunkEncoder.ts` — 「Encodes captured frames into video using FFmpeg」）を直接呼ぶ。streaming 経路も `spawnStreamingEncoder`（`streamingEncoder.ts` — `spawn(ffmpeg, [...])` + `-f image2pipe`）を直接呼ぶ。encoder を注入する引数・config・DI は `RenderConfig` にも `EncodeStageInput` にも無い
- したがって「`executeRenderJob` の内部で FFmpeg を mediabunny に置き換える」は fork（改造）になる

### seam 1: png-sequence → mediabunny（推奨・改造ゼロ）

HyperFrames を「HTML → PNG 連番 + audio.aac」までの装置として使い、encode/mux は tayk 側で mediabunny（ADR-0005）が担う。境界はディスク上のファイル（`frame_%06d.png` は ffmpeg image2 demuxer 互換の連番で、encodeStage コメントも globbed-import 前提と明記）。デメリットはフレームの一時ディスク I/O（1080p RGBA PNG × 30fps で数 GB/分オーダー）。

### seam 2: engine capture ループ → mediabunny 直結（改造ゼロ・ただし自前オーケストレーション）

`createCaptureSession` → 毎フレーム `captureFrameToBuffer` → PNG/JPEG Buffer をデコードして mediabunny の VideoSample に流す。ディスクを経由しない Remotion 型パイプになる。**代償**として producer が持つオーケストレーション（runtime 注入・readiness gate・音声ミックス・並列 worker・static-frame dedup・HDR・警告ポリシー）は自前になる。フレーム供給の「hook」としては `BeforeCaptureHook`（seek 後に呼ばれる）だけで、これは video frame injection 用の入力側フックであり出力側ではない。

### 参考: Frame Adapter は encoder seam ではない

`docs/concepts/frame-adapters.mdx` の Adapter API (v0) は「アニメーションランタイム側」の seam（`getDurationFrames` / `seekFrame`）。GSAP / Lottie / Three.js 等を差し替えるためのもので、FFmpeg 段とは無関係。

## 問い (c): Bun から実行できるか → 実機で動作確認済み

### Node >= 22 必須の「実体」

- ゲートは `packages/cli/bin/hyperframes.mjs` → `runtimeVersionError(process.versions.node)`（`packages/cli/src/runtimeVersion.ts`）。**`MINIMUM_NODE_MAJOR = 22` とのメジャーバージョン数値比較のみ**
- Node 22 でしか動かない API の使用は確認できなかった（`node:sqlite` / `fs.glob` / `import.meta.dirname` 等を横断 grep → ゼロ件）。`engines: { node: ">=22" }` は全パッケージ共通のサポートポリシー宣言と判断
- Bun 1.3.13 は `process.versions.node = "24.3.0"` を名乗るためゲートを通過する（bun install はデフォルトで engines を強制しない）

### 実機検証（macOS arm64 / Bun 1.3.13 / hyperframes@0.7.84）

| テスト | 結果 |
|---|---|
| `bun add hyperframes` | 成功（postinstall 3 件ブロック、後述） |
| `bun …/bin/hyperframes.mjs --version` / `--help` | 成功 |
| `hyperframes doctor` | 成功（Node.js v24.3.0 と表示。FFmpeg/Chrome 検出も動作） |
| `hyperframes render --format png-sequence`（CLI） | **成功**。chrome-headless-shell (HeadlessChrome/152) を自動取得・起動、BeginFrame capture、PNG 10 枚出力 |
| `hyperframes render --format mp4`（CLI） | **成功**。drawElement capture + streaming encode（ffmpeg stdin パイプ）で h264 出力、1 秒素材が 1.8 秒で完走 |
| `@hyperframes/producer` をライブラリとして `executeRenderJob`（**PATH に ffmpeg 無し**） | **成功**。メディア無し composition の png-sequence が約 2 秒で完走 |

### Bun 利用時の注意

- **postinstall ブロック**: `onnxruntime-node` / `protobufjs` / `@google/genai` の install script がデフォルトでブロックされる。`onnxruntime-node`（NAPI ネイティブ）は CLI の background-removal 機能（`packages/cli/src/background-removal/inference.ts`）が使う。使うなら `trustedDependencies` に追加。render 経路には不要（上記検証はブロックされたまま成功）
- HyperFrames 自身の開発は Bun 前提（root `bun.lock`、CONTRIBUTING.md「Install dependencies: `bun install`」、producer に `test:unit:bun` テストレーン）。Bun 上で壊れる変更は上流でも検知されやすい体制
- 未検証領域: HDR 経路・shader transitions（`node:worker_threads` の Worker を spawn する `captureHdrStage` / `shaderTransitionWorkerPool`）・distributed render・Windows/Linux。通常 render は上記のとおり動作

## 問い (d): ライセンス → Apache-2.0、借用可

- リポジトリルート `LICENSE` = Apache License 2.0。npm `hyperframes` の `license` フィールドも `Apache-2.0`
- `CREDITS.md`: 「All code in this repository is independently implemented and distributed under the Apache 2.0 License.」（Remotion に着想を得たことを明記しつつ、コードは独立実装と宣言）
- **コード借用・部分利用の義務**（Apache-2.0 §4）: ライセンス文の写しを同梱・改変ファイルへの改変明記・帰属表示の保持。NOTICE ファイルは存在しないため NOTICE 転載義務は発生しない。§3 の特許許諾つき。MIT / プロプライエタリなコードベースへの取り込みと互換
- 細かい注意: npm 公開版 `@hyperframes/engine` / `@hyperframes/producer` の package.json には license フィールドが**無い**（メタデータ不備。リポジトリの LICENSE が正）。また `hyperframes` npm tarball に LICENSE ファイル自体は同梱されていない（license フィールドのみ）。借用時はリポジトリの LICENSE を根拠として同梱すればよい
- 相性の先例: HyperFrames の studio は **mediabunny (MPL-2.0)** をメタデータ抽出に利用しており（`packages/studio/src/player/lib/mediaProbe.ts`、CREDITS.md「Third-party licenses」）、mediabunny と組み合わせる構成は上流に前例がある

## data-\* スキーマの模倣可能性の見積り

- **属性表面積**: parsers が参照する `data-*` 属性は約 46 種（`data-start` / `data-duration` / `data-track-index` / `data-media-start` / `data-playback-rate` / `data-volume` / `data-composition-*` / `data-keyframes` / `data-text-*` ほか）。`docs/reference/html-schema.mdx`（270 行）+ `docs/concepts/data-attributes.mdx` に全仕様。相対タイミング（`data-start="intro + 2"`）や変数バインディング（`data-var-src` / `data-var-text`）まで含む
- **完全互換の実装規模**: パーサ層 `packages/parsers/src` 約 14.5k 行 + ブラウザ内 runtime `packages/core/src/runtime` 約 15k 行（seek 決定性・クリップ可視性ライフサイクル・メディアプロキシ・GSAP/anime.js/Lottie/Three.js アダプタ・変数スコープ等）。**個人プロジェクトで書き直す規模ではない**
- **ただし tayk の撤退ラインはもっと手前にある**: capture engine が要求する契約は `window.__hf`（`HfPageContract`: `duration` + `seek(time)` + 任意の `media[]` / `transitions[]`、`packages/engine/src/types.ts`）だけ。frameCapture.ts 冒頭コメントも「any web page implementing the window.__hf seek protocol」と明記。**data-\* スキーマを一切模倣せず、tayk 側で決定的 seek を実装した自前 HTML に `window.__hf` を数十行で生やせば capture 層に載る**。模倣が必要になるのは「HyperFrames 互換の記述資産・Studio・lint を使い回したい」場合のみ

## tayk への含意（判断材料）

| 選択肢 | 改造 | ffmpeg 依存 | 備考 |
|---|---|---|---|
| A. `hyperframes render --format png-sequence` → mediabunny | ゼロ | CLI preflight が要求（実際のエンコードには不使用） | 最小工数。ディスク I/O が増える |
| B. `@hyperframes/producer` ライブラリ + png-sequence → mediabunny | ゼロ | メディア無しなら不要（実測）。`<video>`/音声ありなら必要 | preflight 回避。producer のオーケストレーションはフル活用 |
| C. `@hyperframes/engine` capture ループ + mediabunny 直結 | ゼロ | 同上（`<video>` injection 時のみ） | ディスクレス。readiness/音声/並列は自前 |
| D. executeRenderJob 内の encoder 差し替え | fork | — | フック無し。上流追従コストが高く非推奨 |
| E. `window.__hf` プロトコルだけ模倣した自前 capture | capture 自前 | 不要 | HyperFrames は不使用になる。Puppeteer + BeginFrame の再実装は非自明（decision: HyperFrames を使う意味が薄れる） |

- Bun 前提の tayk 環境（CLAUDE.md）と衝突しない: CLI・ライブラリとも Bun 1.3.13 で動作確認済み
- Apache-2.0 なので、C 案で必要になる薄いグルー（例: reorder buffer の考え方）を参考実装として借用することも法的に問題ない

## 検証ログ（抜粋・再現手順）

```sh
# クローン（LFS スキップ）
GIT_LFS_SKIP_SMUDGE=1 git clone --depth 1 https://github.com/heygen-com/hyperframes.git

# Bun で CLI 実行
bun add hyperframes            # → Blocked 3 postinstalls (onnxruntime-node ほか)
bun node_modules/hyperframes/bin/hyperframes.mjs doctor   # → Node.js v24.3.0 / 全チェック動作

# png-sequence render（CLI, Bun）
bun .../hyperframes.mjs render proj --fps 10 --format png-sequence --output frames-out/
# → frames-out/frame_000001.png … frame_000010.png（PNG 640x360 8-bit RGBA）
# trace: "phase":"encode","durationMs":3 / "assemble" … "skipped for png-sequence"

# mp4 render（CLI, Bun）
bun .../hyperframes.mjs render proj --fps 10 --format mp4 --output out.mp4
# → capture_streaming (drawElement) → assemble、ffprobe: h264 640x360

# ライブラリ + ffmpeg 無し PATH（Bun）
env PATH="<bun>:/usr/bin:/bin" bun lib-render.ts   # createRenderJob → executeRenderJob(format: png-sequence)
# → "artifact validated" 完走、frames-lib/ に PNG 10 枚（ffmpeg は /usr/bin にも /bin にも無い）
```

最小 composition（`data-no-timeline` が無いと sub-timeline 待ち 45 秒 timeout が入る点に注意）:

```html
<body data-composition-id="root" data-width="640" data-height="360"
      data-duration="1" data-no-timeline>
  <h1 id="title" class="clip" data-start="0" data-duration="1" data-track-index="0">Hello</h1>
</body>
```

## 出典一覧

1. リポジトリ: https://github.com/heygen-com/hyperframes （main = `1481fe1`, 2026-07-30）
2. npm registry: https://registry.npmjs.org/hyperframes （v0.7.84: license / engines / bin / dependencies）、https://registry.npmjs.org/@hyperframes%2Fproducer/latest 、https://registry.npmjs.org/@hyperframes%2Fengine/latest
3. 出力フォーマット定義: `packages/producer/src/services/render/renderFormat.ts`
4. encode stage（png-sequence no-op 分岐）: `packages/producer/src/services/render/stages/encodeStage.ts`
5. capture API: `packages/engine/src/services/frameCapture.ts` / `packages/engine/src/types.ts`（`CaptureOptions` / `CaptureResult` / `CaptureBufferResult` / `HfPageContract`）/ `packages/producer/src/index.ts`（再 export）
6. streaming encoder（ffmpeg stdin パイプ・Remotion inspired）: `packages/engine/src/services/streamingEncoder.ts` / `packages/engine/src/services/chunkEncoder.ts`
7. FFmpeg バイナリ解決: `packages/parsers/src/ffBinaries.ts`
8. CLI preflight（FFmpeg 必須チェック）: `packages/cli/src/browser/preflight.ts` / `packages/cli/src/commands/render.ts`
9. Node 22 ゲート: `packages/cli/bin/hyperframes.mjs` / `packages/cli/src/runtimeVersion.ts`
10. 公式ドキュメント: `docs/packages/engine.mdx`（カスタムエンコードバックエンド）/ `docs/packages/producer.mdx` / `docs/concepts/frame-adapters.mdx` / `docs/concepts/data-attributes.mdx` / `docs/reference/html-schema.mdx` / `docs/quickstart.mdx`（要件表）
11. ライセンス: リポジトリルート `LICENSE`（Apache 2.0）/ `CREDITS.md`（独立実装宣言・mediabunny MPL-2.0 利用）
12. mediabunny 利用箇所: `packages/studio/src/player/lib/mediaProbe.ts`
13. video frame injection の ffmpeg 依存: `packages/engine/src/services/videoFrameExtractor.ts`
14. Bun 開発体制: ルート `bun.lock` / `CONTRIBUTING.md` / `packages/producer/package.json`（`test:unit:bun`）
15. 実機検証: Bun 1.3.13 / macOS arm64 / hyperframes@0.7.84（本ドキュメント「検証ログ」節）
