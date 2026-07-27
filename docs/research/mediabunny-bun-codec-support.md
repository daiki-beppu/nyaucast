# mediabunny は WebCodecs のない Bun 上でエンコード/デコードできるか

- 調査日: 2026-07-23
- 調査対象バージョン: mediabunny 1.51.0 / @mediabunny/server 1.51.0 / node-av 6.1.1（npm registry 実測、2026-07-23 時点）
- 調査方法: 公式ドキュメント (mediabunny.dev)・GitHub リポジトリ (Vanilagy/mediabunny, seydx/node-av, oven-sh/bun)・npm registry の一次情報のみ。二次記事は不使用。

## 結論サマリ

- **成立する。** mediabunny 本体は pure TypeScript で mux/demux は WebCodecs 不要。エンコード/デコードは公式拡張 `@mediabunny/server`（node-av 経由の FFmpeg N-API バインディング）で Node / Bun / Deno 向けに polyfill され、公式が Bun を明示サポートしている。
- Bun 自体に WebCodecs はなく（oven-sh/bun#14465、open）、代替は WASM ではなく **ネイティブ FFmpeg バインディング**。Bun の Node-API 実装経由で動く。
- 映像 (H.264 / H.265 / VP8 / VP9 / AV1) のエンコード・デコードは `@mediabunny/server` が全部カバー。**純 WASM の映像エンコーダ公式パッケージは存在しない**（WASM 公式拡張は音声系 + ProRes デコードのみ）。
- 既エンコード済みストリームのパススルー mux は `EncodedVideoPacketSource` / `EncodedAudioPacketSource` で WebCodecs なしに可能。
- 注意点: node-av はインストール時に FFmpeg のプレビルドバイナリを DL する。FFmpeg 部分は LGPL/GPL 準拠が必要（node-av README 明記）。

---

## 1. サーバーサイド (Node/Bun) の公式サポート範囲

mediabunny 本体は「Pure TypeScript media toolkit」であり、README は次のように明言している:

> "Works in all browsers as well as in Node, Bun, and Deno using `@mediabunny/server`."
> — https://github.com/Vanilagy/mediabunny (README)

公式ドキュメントの導入ページも同旨:

> "Mediabunny was primarily built for client-side environments, but when combined with the @mediabunny/server extension, the full Mediabunny feature set is available in server-side environments such as Node, Bun, and Deno."
> — https://mediabunny.dev/guide/introduction

つまり設計はランタイム非依存（コアは mux/demux + WebCodecs ラッパーの集合）で、WebCodecs が無い環境向けの穴埋めが `@mediabunny/server` という公式拡張として提供されている。`@mediabunny/server` の package.json は説明文・keywords の両方で Bun を明示している（"server-side environments (Node, Bun, Deno)" / keywords: `"bun"`）— https://github.com/Vanilagy/mediabunny/blob/main/packages/server/package.json

npm 実測（2026-07-23）: mediabunny 1.51.0 (MPL-2.0)、@mediabunny/server 1.51.0 (MPL-2.0、deps: `node-av ^6.0.0`, `@mediabunny/prores`、peerDep: `mediabunny ^1.45.0`)。`@mediabunny/server` の初回 publish は 2026-05-13 で、比較的新しい拡張である点は留意（npm registry `time.created`）。

## 2. WebCodecs 不在時のカスタムコーダー登録機構

### カスタムコーダー API（本体組み込み）

mediabunny 本体に `registerEncoder()` / `registerDecoder()` があり、`CustomVideoEncoder` / `CustomAudioEncoder` / `CustomVideoDecoder` / `CustomAudioDecoder` を継承したクラスを登録する。static `supports()` が `true` を返すと **デフォルト（WebCodecs）より優先して**使われる:

> "If it returns `true`, a new instance of your encoder class will be created by the library and will be used for encoding, taking precedence over the default encoders."
> — https://mediabunny.dev/guide/supported-formats-and-codecs（Custom coders 節）

実装必須メソッドは `init()` / `encode(sample)` または `decode(packet)` / `flush()` / `close()`（同上）。

### 公式拡張パッケージの供給状況

monorepo `packages/` の全一覧（https://github.com/Vanilagy/mediabunny/tree/main/packages 、GitHub API 実測）: `aac-encoder` / `ac3` / `flac-encoder` / `mp3-encoder` / `prores` / `server` の 6 つ。

| パッケージ | 実装 | 対象 |
|---|---|---|
| `@mediabunny/mp3-encoder` | LAME 3.100 の SIMD 対応 WASM ビルド。"works with bundlers, directly in the browser, as well as in Node, Deno, and Bun" | MP3 エンコード（WebCodecs 非対応領域） https://mediabunny.dev/guide/extensions/mp3-encoder |
| `@mediabunny/aac-encoder` | FFmpeg AAC エンコーダの WASM ビルド。"for use in the browser and on the server" | AAC エンコード https://mediabunny.dev/guide/extensions/aac-encoder |
| `@mediabunny/flac-encoder` | WASM | FLAC エンコード https://mediabunny.dev/guide/supported-formats-and-codecs |
| `@mediabunny/prores` | WASM | ProRes デコード（WebCodecs 非対応） 同上 |
| `@mediabunny/ac3` | WASM | AC-3 / E-AC-3 https://mediabunny.dev/guide/supported-formats-and-codecs |
| `@mediabunny/server` | **WASM ではなく node-av（FFmpeg の N-API バインディング）** | 全コーデックのエンコード/デコードをサーバーで polyfill https://mediabunny.dev/guide/extensions/server |

登録は `registerMp3Encoder()` / `registerAacEncoder()` / `registerMediabunnyServer()` のような関数 1 発（各拡張ドキュメント）。

### 対象コーデック別の充足状況（Bun 上）

`@mediabunny/server` のサポート一覧（https://mediabunny.dev/guide/extensions/server）:

- 映像: **AVC (H.264), HEVC (H.265), VP8, VP9, AV1, ProRes** — エンコード/デコード両対応
- 音声: **AAC, MP3, Vorbis, Opus, FLAC, AC-3, E-AC-3** — 同上
- PCM 系は mediabunny 本体に組み込み: "Mediabunny ships with built-in decoders and encoders for all audio PCM codecs, meaning they are always supported." — https://mediabunny.dev/guide/supported-formats-and-codecs

したがって課題の対象コーデック（MP3 / AAC / H.264 / VP9 / AV1、エンコード・デコードとも）は `@mediabunny/server` 1 本で全て充足する。音声のみなら WASM 拡張（mp3-encoder / aac-encoder）+ 本体でネイティブバイナリなしでも成立する。

## 3. 映像エンコーダの WASM 供給の穴

- **純 WASM の映像エンコーダ公式パッケージは存在しない。** 公式拡張で映像に触れるのは `@mediabunny/prores`（デコードのみ）だけで、H.264 / VP9 / AV1 の WASM エンコーダ拡張は monorepo にも npm にも見当たらない（packages 一覧・docs のコーデック表で確認）。
- 公式のサーバー向け供給ルートは WASM ではなく **node-av のネイティブ FFmpeg バインディング**。"@mediabunny/server uses NodeAV to polyfill this functionality for server-side environments such as Node, Bun, or Deno"（https://mediabunny.dev/guide/extensions/server）。ハードウェアアクセラレーション（macOS/Linux/Windows）・マルチスレッド・zero-copy（"AVFrames are never copied over to JavaScript unless explicitly needed"）対応で、性能面ではむしろ WASM より有利。
- カスタムコーダー API は video クラスも公開されているため、サードパーティが WASM 版 x264/libvpx/aom を `CustomVideoEncoder` として接続すること自体は可能だが、**既製のサードパーティ製 mediabunny 用 WASM 映像エンコーダは今回の調査では発見できなかった**（Web 検索でヒットなし。→ 未確認事項）。
- **コンテナ mux はコーデック不要で可能。** `EncodedVideoPacketSource` / `EncodedAudioPacketSource` で既エンコード済みパケットを直接 output に流せる:

  > "This source requires that you take care of the encoding process yourself, which enables you to use the WebCodecs API manually or to plug in your own encoding stack. Alternatively, you may retrieve the encoded packets directly by reading them from another media file, allowing you to skip decoding and reencoding."
  > — https://mediabunny.dev/guide/media-sources

  つまり外部 FFmpeg CLI 等でエンコードした H.264 ストリームを mediabunny で MP4/WebM に mux するパススルー構成は、WebCodecs / server 拡張なしの素の Bun でも成立する（mux/demux は pure TS）。

## 4. Bun 上での既知の動作報告・issue

### Bun 側: WebCodecs は未実装

- oven-sh/bun#14465「WebCodecs API」(2024-10-10 起票) が **open のまま**。担当者・PR なし。https://github.com/oven-sh/bun/issues/14465
- Bun の Node.js 互換ページのグローバル API 一覧にも `VideoEncoder` / `VideoDecoder` 等 WebCodecs 系クラスは載っていない。https://bun.sh/docs/runtime/nodejs-apis
- 一方 Node-API は実装済み: "Bun implements this interface from scratch, so most existing Node-API extensions work with Bun out of the box." — https://bun.sh/docs/api/node-api 。node-av の `.node` バインディングはこの経路で動く。

### mediabunny 側

- Bun 起因の非互換 issue は **見つからなかった**（`gh search issues --repo Vanilagy/mediabunny "bun"` で該当なし。ヒットしたのはドキュメント内の Bun 言及のみ）。https://github.com/Vanilagy/mediabunny/issues
- server 拡張の既知トラブルはプラットフォーム系: #378「[Windows] Could not load the node-av native binding for win32-x64」(closed)。ネイティブバイナリ DL/ロードが失敗要因になり得ることを示す。https://github.com/Vanilagy/mediabunny/issues/378
- #377「[Testing] Server Extension Hardware Testing」(closed) — server 拡張のハードウェア検証の追跡 issue。https://github.com/Vanilagy/mediabunny/issues/377

### node-av 側

- README は "native Node.js bindings to FFmpeg"、プレビルドバイナリをインストール時に自動 DL（macOS/Linux/Windows、x64/ARM64）。**README 自体は Bun を明示していない**（Bun サポートの明言は mediabunny 側）。https://github.com/seydx/node-av
- ライセンス: ラッパーは MIT だが "FFmpeg itself is licensed under LGPL/GPL. Please ensure compliance with FFmpeg's license terms when using this library."（同 README）。tayk での利用時は配布形態に応じた確認が必要。

## 未確認事項

- **Bun 実機での動作未検証。** 本調査はドキュメント・issue ベースであり、この Mac 上で `@mediabunny/server` を Bun で実行するスモークテストは行っていない（公式明言はあるが、v0.1.0 着手前に 10 行程度の encode/decode スモークを推奨）。
- node-av プレビルド FFmpeg の**ビルド構成（GPL/LGPL のどちらのビルドか、H.264 エンコーダが libx264 / libopenh264 / HW のいずれか）**は一次情報で特定できず。ライセンス影響と H.264 品質に直結するため要追加確認（node-av リポジトリのビルドスクリプト精査 or issue 質問）。
- サードパーティ製の mediabunny 向け WASM 映像エンコーダ（CustomVideoEncoder 実装）の存在は「発見できなかった」であり、悉皆調査ではない。
- Bun / Node の最小バージョン要件は mediabunny / @mediabunny/server ドキュメントに明記なし。
- `@mediabunny/server` は 2026-05 初出と若く、Bun での長期運用実績の報告はまだ乏しい。

## 出典一覧

- mediabunny README — https://github.com/Vanilagy/mediabunny
- mediabunny 導入ガイド — https://mediabunny.dev/guide/introduction
- 対応フォーマット・コーデック / Custom coders — https://mediabunny.dev/guide/supported-formats-and-codecs
- @mediabunny/server 拡張ガイド — https://mediabunny.dev/guide/extensions/server
- @mediabunny/server README / package.json — https://github.com/Vanilagy/mediabunny/blob/main/packages/server/README.md / https://github.com/Vanilagy/mediabunny/blob/main/packages/server/package.json
- @mediabunny/mp3-encoder ガイド — https://mediabunny.dev/guide/extensions/mp3-encoder
- @mediabunny/aac-encoder ガイド — https://mediabunny.dev/guide/extensions/aac-encoder
- Media sources（EncodedVideoPacketSource / EncodedAudioPacketSource）— https://mediabunny.dev/guide/media-sources
- mediabunny packages 一覧 — https://github.com/Vanilagy/mediabunny/tree/main/packages
- mediabunny issues（#377, #378）— https://github.com/Vanilagy/mediabunny/issues/377 / https://github.com/Vanilagy/mediabunny/issues/378
- node-av README — https://github.com/seydx/node-av
- Bun: WebCodecs API 要望 issue — https://github.com/oven-sh/bun/issues/14465
- Bun: Node.js 互換ステータス — https://bun.sh/docs/runtime/nodejs-apis
- Bun: Node-API — https://bun.sh/docs/api/node-api
- npm registry（バージョン・ライセンス・依存・publish 日時実測）— https://registry.npmjs.org/mediabunny ほか各パッケージ
