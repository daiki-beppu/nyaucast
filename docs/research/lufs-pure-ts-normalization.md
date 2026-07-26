# ITU-R BS.1770 ラウドネス測定と -14 LUFS 正規化は純 TS/npm で完結できるか

- 調査日: 2026-07-23（issue #44）
- 調査方法: npm registry API・パッケージ tarball の実コード読解・Node v25.4 での実測（EBU Tech 3341 相当のテスト信号 + 1 時間スケールの性能計測）・ITU/EBU/ffmpeg/GitHub の一次情報。二次記事は不使用
- 前提: ランタイムは Bun（WebCodecs / AudioWorklet / Web Audio API なし、オフライン処理）。WASM 同梱は可、ネイティブバイナリは不可
- 注意: 本機に Bun が未導入のため、実行検証は Node v25.4 で実施した（純 ESM・Node API 非依存のパッケージは Bun でも同一に動く前提。WASM の Bun 固有問題は §1.3 参照）

## 結論サマリ

- **成立する。** integrated LUFS（2 段ゲーティング込み）は純 JS の npm パッケージで実現でき、実測で EBU Tech 3341 相当の検証（±0.1 LU 許容）を余裕でパスした
- **推奨: `@audio/loudness-lufs`（MIT、純 JS、依存は同族 2 個のみ）**。実装は BS.1770-4 に忠実で、任意サンプルレート対応（De Man 方式の係数再設計 = pyloudnorm と同系）。1 時間ステレオの integrated 測定が実測 4.4 秒
- true peak (-1 dBTP ガード) が必要な場合は `lufs-web` の `measureTruePeak`（純 JS、1h ステレオ 37 秒）か `ebur128-wasm`（13 秒、ただし Bun では bare import 不可 → §1.3 の回避策が必要）。同族の `@audio/loudness-truepeak` は 1 時間素材では非実用（2 分超でタイムアウト）
- -14 LUFS への正規化は**単純ゲイン適用で足りる**（linear gain = 10^((target−measured)/20)）。音楽ミックスは通常 -14 LUFS より大きく、正規化は減衰方向なので true peak リスクは増えない。増幅方向になった場合のみ「TP が -1 dBTP を超えない範囲にゲインをキャップ」すれば、YouTube 側の挙動（大きい音源のみ下げる）とも整合する
- 自前実装する場合も integrated LUFS だけなら **TS 100〜200 行**で書ける（実在の純 JS 実装が計 216 行。参照 C 実装 libebur128 は全機能込みで 1,475 行）。ただし既製の MIT 実装が検証込みで存在するため自前実装の必然性は薄い
- ffmpeg loudnorm の linear モード（2-pass）と本方式は数学的に同じ「測定 + 単一ゲイン」。loudnorm を使う理由は dynamic モード（AGC + リミッター）が必要な場合だけで、本用途では不要

---

## 1. 既存 npm パッケージの評価

npm registry を "lufs" / "ebur128" / "bs1770" / "loudness" / "r128" / "true peak" で横断検索し（registry API 実測、2026-07-23）、候補を tarball 展開してコードを読み、テスト信号で実測した。

### 1.1 一覧

| パッケージ | 方式 | integrated (ゲーティング込み) | 最終更新 | DL/月 | ライセンス | Bun 適性 |
| --- | --- | --- | --- | --- | --- | --- |
| **`@audio/loudness-lufs`** ([npm](https://www.npmjs.com/package/@audio/loudness-lufs) / [GitHub](https://github.com/audiojs/loudness)) | 純 JS | ○ 2 段ゲート実装を実コードで確認 | 2026-07-11 | 608 | MIT | ◎ 純 ESM・Node API 非依存 |
| **`lufs-web`** ([npm](https://www.npmjs.com/package/lufs-web) / [GitHub](https://github.com/JeffreyG244/lufs-web)) | 純 JS | ○ 同上（+LRA, true peak） | 2026-05-13 | 87 | MIT | ◎ zero-dep 純 ESM |
| `@audio/loudness-truepeak` ([npm](https://www.npmjs.com/package/@audio/loudness-truepeak)) | 純 JS | —（true peak 専用） | 2026-07-11 | 715 | MIT | ◎ だが 1h 素材で非実用（実測 >2 分） |
| `ebur128-wasm` ([npm](https://www.npmjs.com/package/ebur128-wasm) / [GitHub](https://github.com/streamonkey/ebur128_wasm)) | WASM（Rust [ebur128 crate](https://crates.io/crates/ebur128)） | ○ | 2022-10 | 2,557 | Apache-2.0 | △ Bun の wasm ESM import 未対応が刺さる（§1.3） |
| `@tigerabrodioss/neiro` ([npm](https://www.npmjs.com/package/@tigerabrodioss/neiro)) | 純 TS | ○（+正規化 API 内蔵、デフォルト target -14 / TP -1） | 2026-03-14 | 102 | MIT | ○ ただし 44.1k/48k 固定係数、それ以外の fs は throw（実コード確認） |
| `essentia.js` ([npm](https://www.npmjs.com/package/essentia.js) / [GitHub](https://github.com/MTG/essentia.js)) | WASM | ○（LoudnessEBUR128） | 2022-05 | 56,096 | **AGPL-3.0** | × ライセンスが実質不採用理由。ビルドも重量級 |
| `meyda` ([npm](https://www.npmjs.com/package/meyda)) | 純 JS | ×（Bark 帯域の知覚 loudness で **BS.1770 ではない**） | 2024-04 | 67,632 | MIT | 対象外 |
| `@domchristie/needles` ([npm](https://www.npmjs.com/package/@domchristie/needles)) | 純 JS | ○だが Web Audio (OfflineAudioContext) 前提 | 2022-04 | — | MIT | × Bun に Web Audio がない |
| `loudness-worklet` 系 | 純 JS | AudioWorklet 前提 | 2026-07 | — | — | × 同上 |
| `audionorm` / `normalize-audio` / `peaknorm` 等 | ffmpeg ラッパー | ○（loudnorm 委譲） | 2026 | — | MIT | × ffmpeg バイナリ同梱で「ネイティブ不可」に抵触 |
| `bs1770` / `needle-loudness` / `audio-loudness` | — | **npm に存在しない**（registry 404 実測） | — | — | — | — |

### 1.2 実測検証（EBU Tech 3341 相当 + 1 時間スケール）

EBU Tech 3341 の minimum requirements 相当のテスト信号（997 Hz 正弦波、ステレオ、許容 ±0.1 LU。[Tech 3341 v4.0, 2023-11](https://tech.ebu.ch/publications/tech3341)）を生成して Node v25.4 で実測した:

| テスト | 期待値 | `@audio/loudness-lufs` | `lufs-web` | `ebur128-wasm` |
| --- | --- | --- | --- | --- |
| -23 dBFS 20s | -23.0 LUFS | -22.99998 | -22.99998 | -22.99998 |
| -33 dBFS 20s | -33.0 LUFS | -32.99998 | -32.99998 | — |
| ゲーティング（-36 dBFS 10s + -23 dBFS 60s） | ≈ -23.0 | -23.010 | -23.010 | — |
| -23 dBFS @44.1 kHz | -23.0 | -22.997 | — | — |
| true peak（-23 dBFS 正弦波） | ≈ -23 dBTP | -22.980 | -23.000 | -22.995 |

1 時間ステレオ 48 kHz（想定ユースケースそのもの）の性能実測（Apple Silicon Mac / Node v25.4）:

| 処理 | 実装 | 時間 |
| --- | --- | --- |
| integrated LUFS | `@audio/loudness-lufs` | **4.4 秒** |
| true peak | `ebur128-wasm` | 13.3 秒 |
| true peak | `lufs-web` (24-tap 4× polyphase) | 37.2 秒 |
| true peak | `@audio/loudness-truepeak` (`@audio/resample-sinc` 使用) | **>2 分でタイムアウト（非実用）** |

`@audio/loudness-lufs` のコード品質は高い: K-weighting 係数を De Man 2014（"Evaluation of Implementations of the ITU-R BS.1770 Loudness Algorithm"、[pyloudnorm](https://github.com/csteinmetz1/pyloudnorm) と同方式）のアナログプロトタイプから任意 fs 向けに再設計し、48 kHz では仕様書の係数表を ~1e-11 で再現するとコメントに明記、実際に 44.1 kHz でも ±0.003 LU で一致した（[k-weighting.js 実コード](https://github.com/audiojs/loudness/blob/main/packages/weighting-k/k-weighting.js)）。実装は `lufs.js` 55 行 + `k-weighting.js` 51 行 + `@audio/biquad` 110 行のみで、Node/Bun 固有 API への依存はゼロ（tarball 全ファイルを rg で確認）。

懸念点は若さ: audiojs org のリポジトリは 2026 年に整備されたばかりで star 0、公開リポジトリに Tech 3341 テストベクタは同梱されていない（README の "Verified against EBU Tech 3341" は自己申告）。ただし上記の通り**こちらで独立に検証して通っている**ので、採用時に同種のテストを tayk 側に置けばリスクは相殺できる。

### 1.3 `ebur128-wasm` の Bun 問題

`ebur128-wasm` のエントリは wasm-bindgen bundler ターゲットで、`import * as wasm from "./ebur128_wasm_bg.wasm"` を含む（tarball 実確認）。Bun は runtime での `.wasm` ESM import が未実装（import がモジュールでなくファイルパス文字列を返す。[oven-sh/bun#12434](https://github.com/oven-sh/bun/issues/12434)、2026-07-23 時点で open）で、`bun build` 経由でも不整合の報告がある（[#22026](https://github.com/oven-sh/bun/issues/22026), [#10873](https://github.com/oven-sh/bun/issues/10873)）。Node では `--experimental-wasm-modules` + 直接パス指定で動作した（package.json が `module` フィールドのみで `exports`/`main` がなく、Node の bare import も素では失敗する）。つまり **Bun でそのまま使える状態ではなく**、`WebAssembly.instantiate` の手動ワイヤリングか事前バンドルが要る。純 JS 側で十分な性能が出ているため、あえて選ぶ理由はない。

## 2. 自前実装する場合の規模感

### 2.1 仕様の要点（ITU-R BS.1770-5）

現行は BS.1770-5（2023-11、[ITU 公式ページ](https://www.itu.int/rec/R-REC-BS.1770)。PDF: [R-REC-BS.1770-5](https://www.itu.int/rec/R-REC-BS.1770-5-202311-I/en)）。integrated loudness のアルゴリズムは:

1. **K-weighting**: 2 段の biquad（①頭部モデルの high shelf ②RLB highpass）。48 kHz での係数表が仕様書に明記。他レートは係数再設計が必要（→ 落とし穴 §2.3）
2. **ブロック化**: 400 ms ブロック、75% オーバーラップ（= 100 ms hop）でチャンネル別 mean square → チャンネル重み（L/R/C = 1.0, Ls/Rs = 1.41）付き合算
3. **2 段ゲーティング**: 絶対ゲート -70 LKFS で除外 → 残りの平均から -10 LU の相対ゲートで再除外 → 生き残りの平均を `-0.691 + 10·log10(Σ)` で LKFS に（相対ゲート -10 LU は BS.1770-2 以降）

### 2.2 行数規模

- 参照 C 実装 [libebur128](https://github.com/jiixyj/libebur128)（MIT）: コア `ebur128.c` は **1,475 行**（raw 実測）。ただしこれは M/S/I モード・LRA・ヒストグラム・true peak・自前 FIR リサンプラまで全部入りの行数
- integrated のみの純 JS 実装の実在サンプル: `@audio/loudness-lufs` 一式で **216 行**（lufs 55 + k-weighting 51 + biquad 110）、`lufs-web` の lufs.js + k-weighting.js で **189 行**
- よって TS で integrated + ゲイン適用だけなら **100〜200 行 + テスト**が妥当な見積り。true peak（4× polyphase FIR）を足すと +70〜100 行だが、素朴に書くと 1 時間素材で数十秒〜数分かかる（§1.2 実測）ので性能チューニング工数を見ておく

### 2.3 落とし穴

- **44.1 kHz 対応**: 仕様書の係数は 48 kHz のみ。44.1 kHz 素材に 48 kHz 係数を流用すると誤差が出る。De Man 方式の再設計（pyloudnorm / `@audio/weighting-k` 採用）が定石
- **メモリ**: 1 時間ステレオ 48 kHz の Float32Array は約 660 MiB/ch。既存パッケージは全量バッファ + K-weighted コピーを作るため、ステレオでピーク ~2.6 GiB。動くが、decode ストリームから 400 ms ブロック単位で逐次 mean square を積むチャンクラッパー（biquad の状態を跨いで保持、~50 行）を挟むのが本命
- **相対ゲートの 2 パス性**: 全ブロックの power を保持してから相対ゲートを適用する必要がある（power 配列自体は 1h で 36,000 要素と小さいので実害なし）

### 2.4 検証手段

- [EBU Tech 3341](https://tech.ebu.ch/publications/tech3341)（v4.0, 2023-11）が EBU Mode メーターの minimum requirements テスト信号を定義し、リファレンス音源は [EBU Loudness test set](https://tech.ebu.ch/publications/ebu_loudness_test_set) として無償ダウンロード可能。tayk の CI に組み込める
- 差分テスト: `ffmpeg -af ebur128` / libebur128 と同一素材で突合（audiojs/loudness も README でこの方式に言及）

## 3. 正規化側: 単純ゲインで足りるか

**足りる。** integrated LUFS が測れれば、必要ゲインは

```
gainDb = target − measured          // target = −14
gainLinear = 10^(gainDb / 20)
samples[i] *= gainLinear
```

の定数倍のみで、ラウドネスは定義上ちょうど gainDb だけ動く（ゲーティング閾値との相互作用で ±0.1 LU 未満のずれが出うる程度。厳密を期すなら適用後に再測定して 1 回反復）。

**true peak (-1 dBTP) の扱い**:

- 音楽ミックスは通常 -14 LUFS より大きい（-8〜-11 LUFS 程度）ため、本用途の正規化は**ほぼ常に減衰方向**であり、ピークも一緒に下がる → リミッター不要
- 増幅方向（元が -14 より静か）の場合のみ TP 超過があり得る。対処は「`gainLinear = min(gainLinear, 10^(−1/20) / truePeakLinear)` でキャップ」すれば十分。YouTube のノーマライズは大きい音源を下げるだけで静かな音源をブーストしない（[YouTube の loudness 挙動の解説](https://www.meterplugs.com/blog/2019/09/18/youtube-changes-loudness-reference-to-14-lufs.html)、Stats for nerds の "content loudness" で確認可能）ので、キャップして目標未達のまま上げないのはプラットフォーム挙動と整合する。`@tigerabrodioss/neiro` の `normalize({ target: -14 })` も同じキャップ方式（dist 実コード確認）
- ルックアヘッド式 true peak リミッター（増幅しつつ -1 dBTP を守る）は実装コストが跳ね上がる領域で、必要になったら ffmpeg loudnorm dynamic へ撤退する方が合理的
- true peak 測定自体は BS.1770-5 Annex 2 の 4× オーバーサンプリング。既製の `lufs-web` / `ebur128-wasm` で賄える（§1.2）ので自作不要

なお YouTube の -14 LUFS / -1 dBTP という数値は Google 公式ドキュメントに明記がなく、業界での実測ベースの通説である点は認識しておく（Stats for nerds の content loudness 表示が事実上の一次確認手段）。

## 4. ffmpeg loudnorm との比較

loudnorm（[ffmpeg-filters 公式ドキュメント](https://ffmpeg.org/ffmpeg-filters.html#loudnorm)、設計解説は作者 Kyle Swanson の [k.ylo.ph/2016/04/04/loudnorm.html](https://k.ylo.ph/2016/04/04/loudnorm.html)）:

- **2-pass ワークフロー**: 1 パス目で I/LRA/TP/threshold を測定（`print_format=json`）、2 パス目で `measured_*` を渡して適用。`linear=true` かつヘッドルームが足りる場合は**単一の線形ゲイン**を適用する — すなわち本調査の「純 TS 測定 + ゲイン適用」と数学的に等価。精度差は測定器差（どちらも BS.1770 準拠、Tech 3341 の ±0.1 LU 許容内）のみ
- **dynamic モード**: ヘッドルーム不足時に自動フォールバックし、EBU R128 ベースの loudness-tuned AGC + 100 ms ルックアヘッド true peak リミッターで時間可変ゲインを適用する。音を触る度合いが大きく、ダイナミクスが変わる。さらに loudnorm は内部で **192 kHz にアップサンプルし、出力もそのまま**（要手動ダウンサンプル）という運用上の罠がある（公式ドキュメント・作者解説の両方に明記）
- **工数比較**: ffmpeg CLI 側は「spawn + JSON パース + 2 回実行 + 192 kHz 後始末」のグルーコードが必要で、純 TS 側（測定 1 関数 + 乗算ループ）と工数はほぼ同等かむしろ重い。決定的な差は tayk の方針（ネイティブバイナリ不可、ffmpeg は撤退先）との整合で、純 TS 側が方針どおり
- **使い分け**: 減衰方向が支配的な本用途では linear 相当で足り、loudnorm を選ぶ積極的理由は「増幅しつつ TP を守る」ケースだけ。その場合も既決定の node-av（@mediabunny/server 経由の FFmpeg バインディング、`docs/research/mediabunny-bun-codec-support.md` = issue #43 / PR #48 参照）に libavfilter が含まれるため、ffmpeg CLI まで戻らずに loudnorm 相当へ撤退できる可能性がある（→ 未確認事項）

## 5. tayk への組み込み案

1. decode: mediabunny の sample sink で Float32Array PCM を取得（mediabunny 調査どおり。PCM codec は本体組み込み）
2. 測定: `@audio/loudness-lufs`（+ 必要なら `lufs-web` の true peak）。1 時間素材でも数秒〜数十秒
3. 正規化: 単純ゲイン乗算、増幅時のみ TP キャップ
4. encode: 既定路線（@mediabunny/server or WASM AAC/MP3 エンコーダ）
5. 検証: EBU Loudness test set + `ffmpeg -af ebur128` 差分テストを CI に置く

依存追加は MIT の小粒パッケージ 2〜4 個（`@audio/loudness-lufs` → `@audio/weighting-k` → `@audio/biquad`、計 ~220 行）のみ。パッケージの若さが不安なら、同アルゴリズムを ~150 行で vendor する選択肢も現実的（実装コストは既製実装の読解済みなので小さい）。

## 未確認事項

- **Bun 実機未検証**: 本機に Bun 未導入のため Node v25.4 での検証。対象パッケージは純 ESM・Node API 非依存を確認済みで Bun でも同一動作の見込みだが、v0.1.0 着手時に同じテスト信号でのスモークを推奨（テストスクリプトは本調査で作成済み、~40 行）
- `@audio/loudness-*` の長期メンテ性（2026 年立ち上げ・star 0）。vendor 化で緩和可能
- node-av 経由で loudnorm フィルタチェーンを呼べるか（libavfilter の API 露出範囲）は未確認
- YouTube の -14 LUFS / -1 dBTP は公式文書の裏付けなし（業界通説 + Stats for nerds 実測ベース）
- チャンク処理ラッパー（メモリ 2.6 GiB → 数十 MiB 化）は設計のみで未実装

## issue #44 の Question への直接回答

**ある。純 TS/npm 完結で成立する。** `@audio/loudness-lufs`（MIT・純 JS・~220 行・依存 2 個）が BS.1770-4 の integrated LUFS（2 段ゲーティング込み）を正しく実装しており、Tech 3341 相当の検証を ±0.01 LU で通過、1 時間ステレオを 4.4 秒で測定できることを実測確認した。-14 LUFS への正規化は単純ゲイン乗算で足り、減衰方向が支配的な音楽ミックス用途では true peak リミッターも不要（増幅時はゲインキャップで対応、TP 測定は `lufs-web` / `ebur128-wasm` で可能）。自前実装でも TS 100〜200 行だが、既製 MIT 実装の採用（不安なら vendor 化)が合理的。ffmpeg loudnorm の linear 2-pass と数学的に等価であり、loudnorm へ撤退する必要があるのは「増幅しつつ -1 dBTP を守るリミッティング」が要件化した場合のみ。

## 出典一覧

- ITU-R BS.1770 公式ページ（BS.1770-5, 2023-11 が現行） — https://www.itu.int/rec/R-REC-BS.1770
- EBU Tech 3341（EBU Mode メーター・minimum requirements テスト信号、v4.0 2023-11） — https://tech.ebu.ch/publications/tech3341
- EBU Loudness test set（リファレンス音源） — https://tech.ebu.ch/publications/ebu_loudness_test_set
- `@audio/loudness-lufs` — https://www.npmjs.com/package/@audio/loudness-lufs / https://github.com/audiojs/loudness
- `lufs-web` — https://www.npmjs.com/package/lufs-web / https://github.com/JeffreyG244/lufs-web
- `ebur128-wasm` — https://www.npmjs.com/package/ebur128-wasm / https://github.com/streamonkey/ebur128_wasm
- `@tigerabrodioss/neiro` — https://www.npmjs.com/package/@tigerabrodioss/neiro
- libebur128（参照 C 実装、MIT） — https://github.com/jiixyj/libebur128
- pyloudnorm（De Man 方式係数再設計の Python 参照実装） — https://github.com/csteinmetz1/pyloudnorm
- ffmpeg loudnorm 公式ドキュメント — https://ffmpeg.org/ffmpeg-filters.html#loudnorm
- loudnorm 設計解説（作者 Kyle Swanson） — https://k.ylo.ph/2016/04/04/loudnorm.html
- Bun の wasm ESM import 未対応 issue — https://github.com/oven-sh/bun/issues/12434 （関連: #22026, #10873）
- Bun のモジュール解決（`module` フィールドの扱い） — https://bun.com/docs/runtime/modules
- YouTube -14 LUFS 移行の解説（MeterPlugs） — https://www.meterplugs.com/blog/2019/09/18/youtube-changes-loudness-reference-to-14-lufs.html
- 関連調査: mediabunny の Bun 対応 — `docs/research/mediabunny-bun-codec-support.md`（branch `docs/research-mediabunny`, issue #43 / PR #48）
