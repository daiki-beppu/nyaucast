# メディア処理基盤は mediabunny + node-av に統一し、ffmpeg CLI は撤退先に留める

## Status

accepted (2026-07-24)

## Context

マップ issue #42「メディア処理基盤の技術選定マップ」の destination。collection lifecycle の MIX/マスタリング（クロスフェード結合 + -14 LUFS ラウドネスノーマライズ）と動画生成（静止画 + 音声の長尺動画）、および upload 前検証（メタデータ読み）をどの技術で実装するかを、Bun 上の実機検証を根拠に確定する。ADR-0003 は Bun 必須配布を定めており、Bun には WebCodecs が実装されていない（oven-sh/bun#14465、open）ため、エンコード/デコードには何らかの外部手段が要る。第一候補は純 TS/npm 完結（Bun + `ni` で動く）、ffmpeg CLI は撤退先という前提で、5 件の調査・プロトタイプチケットを実施した:

- issue #43（調査）: mediabunny は WebCodecs のない Bun 上で成立するか → 成立。コアは pure TS、encode/decode は公式拡張 `@mediabunny/server`（node-av 経由の FFmpeg ネイティブバインディング）
- issue #44（調査）: ラウドネス測定・正規化は純 TS/npm で完結できるか → 成立。`@audio/loudness-lufs` が BS.1770-4 準拠
- issue #45（プロトタイプ）: Bun 上で mediabunny 音声パスは動くか → 成立。1 時間素材 202.5 秒（実時間の 0.056 倍）
- issue #46（プロトタイプ）: Bun 上で mediabunny 動画パスは動くか → 成立。1 時間動画 78.7 秒（実時間の 0.022 倍）、動的映像も 1080p30 で 165 frames/s
- issue #49（調査）: node-av プレビルド FFmpeg のビルド構成とライセンス → 全プラットフォーム GPLv3 ビルド確定（libx264 静的リンク）

全チケットが「成立」で決着し、ffmpeg CLI 側の詳細検証が不要と判明したため、残る作業は本 ADR による最終確定のみだった。

## Decision

1. **音声（MIX/マスタリング）・動画生成・アップロード前検証（メタデータ読み）の全工程を mediabunny + `@mediabunny/server`（node-av 経由のネイティブ FFmpeg バインディング）に統一する。** 工程ごとの技術分岐は設けない。ffmpeg CLI 直接呼び出し、音声のみ WASM エンコーダ（`@mediabunny/mp3-encoder` 等）に逃がす構成のいずれも採用しない
2. **LUFS 測定・正規化は `@audio/loudness-lufs`（MIT・純 JS）を npm 依存として採用する。** vendor 化はしない。BS.1770-4 準拠の integrated loudness を測定し、`gainLinear = 10 ** ((target - measured) / 20)` の単純ゲイン乗算で -14 LUFS に正規化する。増幅方向になる場合のみ `lufs-web` の true peak 測定でゲインを -1 dBTP 以内にキャップする（音楽ミックスは通常 -14 LUFS より大きく減衰方向が支配的なため、通常は素通りする安全弁）
3. **ffmpeg CLI 直接呼び出しは採用しない。** Considered Options に撤退先として記録するに留め、実装はしない
4. **node-av の GPLv3 ネイティブバイナリ依存を許容する。** 配布時の「結合著作物（実効 GPLv3）」論点は先送りし、tayk の公開/配布を具体的に検討する段階で本 ADR を改訂して再判断する
5. **追加のエラーラッパーは設けない。** mediabunny/node-av の失敗は通常の throw / Promise reject で表面化し、ADR-0001「内部throw、境界で変換」にそのまま乗る

## Why

- **実測で裏付けられた成立確実性**: 音声・動画とも合格ライン（実時間 2 倍以内）に対し 36〜90 倍の余裕。動的映像（毎フレーム描画）も 1080p30 で 165 frames/s と拡張性十分（残る課題は Bun 用描画ライブラリ選定のみ）
- **セットアップ摩擦の低さ**: node-av のネイティブバイナリは npm の optionalDependencies として非圧縮同梱され、Bun でも postinstall なしに動作する（mediabunny#378 の Windows ロード失敗は node-av v5.2.4 で解決済み）。システムへの ffmpeg 手動インストールは不要
- **工程分割に技術的必然性がない**: `@mediabunny/server` 1 本で対象コーデック（H.264 / AAC / MP3 等）とメタデータ読み取りを全充足する。音声のみ WASM に逃がしても動画側は構造的に node-av 必須のままで GPL surface は縮小せず、コードパスが二重化するだけ
- **エラーモデルの整合**: プロトタイプ実コード（`decodeAudio` の `if (!track) throw new Error(...)`）で確認した通り、mediabunny の失敗は素直な throw/reject。ADR-0001 の境界変換モデルに追加の適合コストがない
- **非対称な可逆性**: 今 node-av を必須依存として受け入れても、将来の optional 化・差し替えは（ADR-0001「1 MCP tool = 1 ファイル」規約により呼び出しが tool 実装内に自然に閉じているため）着手が容易。逆に今から抽象化境界を先回りで作るのは、v0.1 時点で受益者のいない投機的設計になる

## Considered Options

- **ffmpeg CLI を subprocess spawn で本採用**: node-av の「リンク」ではなく「別プロセス起動」（mere aggregation）に倒せば結合著作物論点は弱まるが、(a) node-av 自身も同じ GPL ビルドの ffmpeg CLI バイナリを同梱しており配布物から GPL コードが消えるわけではない、(b) JSON パース・2 回実行等のグルーコードが ADR-0001 の throw モデルと噛み合わない、(c) 実測で純 TS + node-av 側に性能・工数上の弱点が見つからなかった。不採用
- **音声のみ WASM エンコーダで node-av を回避**: `@mediabunny/mp3-encoder` / `@mediabunny/aac-encoder` で音声はネイティブバイナリなしにできるが、動画生成が destination のスコープに入っている以上 node-av は構造的に必須。GPL 回避効果がないままコードパスが二系統化するだけ。不採用
- **LUFS 実装を vendor 化**: 保守断絶リスクを初期から回避できるが、v0.1 時点では投機的。「壊れたら直す」の方針（ADR-0001 の教訓）と整合しない。不採用（上流が壊れた場合のフォールバック選択肢として Consequences に残す）
- **node-av 呼び出しを差し替え可能な抽象境界の裏に隔離**: ADR-0001「1 MCP tool = 1 ファイル」規約により、`audio.master` 等の tool 実装内に呼び出しは自然に閉じる。追加のレイヤーを今から作る理由がない。不採用

## Consequences

- `audio.master`・動画生成用 primitive tool・アップロード前検証 tool は `@mediabunny/server`（node-av）に直接依存する。node-av の GPLv3 ネイティブバイナリは通常の（optionalDependencies ではない）依存としてインストールされる
- v0.1.0 dogfood（社内・first-party チャンネルでの利用、配布なし）の間は GPL の頒布義務は発生しない
- tayk の公開/配布（npm public 化・OSS 化・バイナリ配布等）を具体的に検討する際は、本 ADR を改訂し、node-av の依存位置（必須 or optional）・結合著作物の解釈・ライセンス表記を再判断する
- `@audio/loudness-lufs` は 2026 年発足・star 0 の若いパッケージ。EBU Tech 3341 相当の回帰テストを tayk 側のテストスイートに置き、上流の破壊的変更/放棄を検知する。メンテが止まった場合は同アルゴリズムの vendor 化（~220 行、実装コストは調査済みで小さい）で緩和する
- true peak ガードは増幅方向のケース（元音源が -14 LUFS より静かな場合）のみ発火する。通常の音楽ミックス（-14 LUFS より大きいのが通例）では素通りする
- Bun 実機での動作は issue #45 / #46 のプロトタイプ（PR #51 / #52、いずれも merge しない前提の draft）で検証済み。本採用時は同等のロジックを `src/` 配下の実装として書き起こす。Bun 固有の追加対応は `trustedDependencies: ["node-av"]` の明示のみ
- サムネ生成・動的映像の実装本体・EQ/コンプレッション等の本格マスタリング加工は本 ADR のスコープ外（マップ issue #42 の Out of scope を参照）

## Related

- ADR-0001（内部throw・境界で変換 / 1 tool = 1 file）/ ADR-0003（Bun 必須配布・ビルドレス出荷）
- マップ issue #42「メディア処理基盤の技術選定マップ」とその子チケット #43 / #44 / #45 / #46 / #49
- `docs/research/mediabunny-bun-codec-support.md`（issue #43 / PR #48）/ `docs/research/lufs-pure-ts-normalization.md`（issue #44 / PR #50）/ `docs/research/node-av-ffmpeg-license.md`（issue #49 / PR #53）
- プロトタイプ PR #51（音声パス）/ PR #52（動画パス）— いずれも merge しない前提の draft
