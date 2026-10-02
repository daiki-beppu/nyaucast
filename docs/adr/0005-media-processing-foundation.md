# メディア処理基盤は mediabunny + node-av に統一し、ffmpeg CLI は撤退先に留める

旧称 tayk

## Status

accepted (2026-07-24) / 改訂 2026-07-31（#178。動画生成工程を「agent が書く HTML composition → Chrome rasterize → mediabunny エンコード」のパイプラインへ載せ替え — 決定 6〜11 を追加。エンコード層の mediabunny + node-av 統一（決定 1）と ffmpeg CLI 不採用（決定 3）は不変。Chrome 依存は `video.render` / `video.preview` の 2 tool に限定して許容する）/ 改訂 2026-08-22（#332。Remotion への置き換え検討を不採用として Considered Options に追記 — 決定 1〜11 は不変）/ 改訂 2026-10-02（#467。解説動画の composition は agent が書かず、図解から組み立ての tool が作る — 決定 12・13 を追加。Chrome 依存の許可リスト（決定 7）は変えない） / 改訂 2026-10-02（#494。図解を ③ から外し、agent が書く入力として扱う。ADR-0009 決定 11）/ 改訂 2026-10-02（#475。決定 5 を Effect の失敗の扱いに合わせた）

## Context

マップ issue #42「メディア処理基盤の技術選定マップ」の destination。collection lifecycle の MIX/マスタリング（クロスフェード結合 + -14 LUFS ラウドネスノーマライズ）と動画生成（静止画 + 音声の長尺動画）、および upload 前検証（メタデータ読み）をどの技術で実装するかを、Bun 上の実機検証を根拠に確定する。ADR-0003 は Bun 必須配布を定めており、Bun には WebCodecs が実装されていない（oven-sh/bun#14465、open）ため、エンコード/デコードには何らかの外部手段が要る。第一候補は純 TS/npm 完結（Bun + `ni` で動く）、ffmpeg CLI は撤退先という前提で、5 件の調査・プロトタイプチケットを実施した:

- issue #43（調査）: mediabunny は WebCodecs のない Bun 上で成立するか → 成立。コアは pure TS、encode/decode は公式拡張 `@mediabunny/server`（node-av 経由の FFmpeg ネイティブバインディング）
- issue #44（調査）: ラウドネス測定・正規化は純 TS/npm で完結できるか → 成立。`@audio/loudness-lufs` が BS.1770-4 準拠
- issue #45（プロトタイプ）: Bun 上で mediabunny 音声パスは動くか → 成立。1 時間素材 202.5 秒（実時間の 0.056 倍）
- issue #46（プロトタイプ）: Bun 上で mediabunny 動画パスは動くか → 成立。1 時間動画 78.7 秒（実時間の 0.022 倍）、動的映像も 1080p30 で 165 frames/s
- issue #49（調査）: node-av プレビルド FFmpeg のビルド構成とライセンス → 全プラットフォーム GPLv3 ビルド確定（libx264 静的リンク）

全チケットが「成立」で決着し、ffmpeg CLI 側の詳細検証が不要と判明したため、残る作業は本 ADR による最終確定のみだった。

### 改訂の経緯（2026-07-31 / #178）

マップ issue #172「動画生成 HTML パイプライン化マップ」の destination。動機は**基盤一本化** — v0.1 の動画要件は「静止画 1 枚 + 音声」のまま動かさず、v0.2 動的映像で動画パスを作り直す二重実装を避けるため、基盤だけ先に将来形（agent が書く HTML composition をブラウザで rasterize する形）へ載せ替える。エンコード層は本 ADR の mediabunny を維持し、Chrome（rasterize）依存のみ動画工程限定で許容するかが改訂の論点だった。4 件の調査・プロトタイプ・設計チケットを実施した:

- issue #173（調査）: HyperFrames（HeyGen 製 OSS）の部分利用は成立するか → 成立。ただし capture engine の要求は `window.__hf` seek プロトコル（`duration` + `seek(t)`）だけで、模倣自体が不要になり得ると判明
- issue #174（調査）: ブラウザ frame capture の決定論的手段 → 本命は seek 方式 + `Page.captureScreenshot`。ロックステップ（`HeadlessExperimental.beginFrame`）は macOS 非対応、screencast は wall-clock 従属で構造的に非決定論
- issue #175（プロトタイプ）: HTML → rasterize → mediabunny の end-to-end → **成立・合格ライン PASS**。静止画 + 音声 1h がフルパイプライン 125.9 秒（実時間の 0.035 倍、合格ライン 2 倍以内に対し 57 倍の余裕）。決定論 sweep 300 フレーム全 PASS、単タブ 15.0 fps・4 タブ並列 59.8 fps で線形スケール。自前 CDP client 約 210 行で成立
- issue #176 / #177（設計）: composition 記述規約（`window.__hf` 契約）・tool 役割分担・プレビュー工程を確定（本改訂の決定 9・10 に反映）

## Decision

1. **音声（MIX/マスタリング）・動画生成・アップロード前検証（メタデータ読み）の全工程を mediabunny + `@mediabunny/server`（node-av 経由のネイティブ FFmpeg バインディング）に統一する。** 工程ごとの技術分岐は設けない。ffmpeg CLI 直接呼び出し、音声のみ WASM エンコーダ（`@mediabunny/mp3-encoder` 等）に逃がす構成のいずれも採用しない
2. **LUFS 測定・正規化は `@audio/loudness-lufs`（MIT・純 JS）を npm 依存として採用する。** vendor 化はしない。BS.1770-4 準拠の integrated loudness を測定し、`gainLinear = 10 ** ((target - measured) / 20)` の単純ゲイン乗算で -14 LUFS に正規化する。増幅方向になる場合のみ `lufs-web` の true peak 測定でゲインを -1 dBTP 以内にキャップする（音楽ミックスは通常 -14 LUFS より大きく減衰方向が支配的なため、通常は素通りする安全弁）
3. **ffmpeg CLI 直接呼び出しは採用しない。** Considered Options に撤退先として記録するに留め、実装はしない
4. **node-av の GPLv3 ネイティブバイナリ依存を許容する。** 配布時の「結合著作物（実効 GPLv3）」論点は先送りし、nyaucast の公開/配布を具体的に検討する段階で本 ADR を改訂して再判断する
5. **追加のエラーラッパーは設けない。** mediabunny/node-av の失敗は通常の throw / Promise reject で表面化する。呼ぶ側はそれを `Effect.tryPromise` で型付きの失敗に変えるだけで、ADR-0001「境界で変換」にそのまま乗る（改訂 2026-10-02 / #475。ADR-0001 決定 3 が「内部 throw」から「型付きの失敗」に変わったのに合わせた）

（以下、改訂 2026-07-31 / #178 で追加）

6. **動画生成工程は「HTML composition → Chrome rasterize → mediabunny エンコード」のパイプラインとする。** composition は `window.__hf` seek プロトコル（`duration` + `seek(t)`）を実装した自己完結 HTML 1 枚で、契約の正書は `docs/reference/composition-contract.md`。rasterize は pin 済み chrome-headless-shell への CDP 直結（seek 方式 + `Page.captureScreenshot`。seek 後の settle — double rAF・50ms timeout と race — は capturer 側の責務）。エンコード層は決定 1 の mediabunny + node-av を維持し、ffmpeg CLI 不採用（決定 3）は変えない。HyperFrames はエンジンとしては採用せず、`__hf` プロトコル互換のみ共有する
7. **Chrome 依存を許容するのは `video.render` / `video.preview` の 2 tool のみ。** 用途や工程の言い換えではなく tool 名の列挙で限定する。他 tool への拡大（サムネ生成の同基盤化等）は本 ADR の改訂を要する
8. **Chrome 供給は `@puppeteer/browsers`（純 JS・Bun 動作確認済み）による pin 済み chrome-headless-shell の初回実行時自動ダウンロードとする。** pin（バージョン）は `src/lib/` の chrome 供給インフラが持つ。システムへの手動インストール・Nix devShell 供給・明示 setup コマンドのいずれも採用しない
9. **tool 構成は `video.render` + `video.preview` の 2 枚とし、鮮度付き冪等を共通規約とする。** 生成時に composition の内容ハッシュを記録し、一致すれば既存成果物を返し、不一致なら作り直す（明示的再生成の `force` も規約通り持つ）。ADR-0007 決定 4「実体があれば作らず返す」の実体を「**この** composition の成果物」と読む解釈の精緻化であり、ADR-0007 本体は改訂しない。プレビューは非ゲートの codec 主導ステップ（新ゲート・新 CLI コマンドは作らない。正式な GO/NO-GO はゲート②のまま）で、契約検証を内包するため validate 単体 tool は置かない
10. **実装配置は tool 1 ファイル + プロトコル汎用インフラのみ `src/lib/` 許可。** ADR-0001「1 MCP tool = 実装 1 ファイル」の解釈を明文化する（ADR-0001 決定 7 に基づく改訂手続き）: CDP transport / chrome 供給・pin・起動のようなプロトコル汎用インフラに限り `src/lib/` に置いてよい。業務ロジック（契約検証規則・capture plan・サンプリング規則）の lib 化は禁止し、tool 実装ファイルに同居させる
11. **撤退先は issue #46 の mediabunny 静止画パス（実証済み・1h 動画 78.7 秒）とし、撤退トリガを列挙・発動は都度判断とする。** トリガは 3 群 — (a) Chrome 供給不能（pin 版 chrome-headless-shell の配布消滅・プラットフォーム廃止）、(b) 上流の破壊的変更（`@puppeteer/browsers` の Bun 非互換化・CDP プロトコル変更で自前 client が修復不能）、(c) 決定論の破れ（Chrome 更新後に再 seek バイト比較が恒常的に失敗する）。いずれも修復不能と判断した時点で本 ADR を再改訂して発動する。数値基準（N 日等）は設けず、撤退先実装の常時保守もしない

（以下、改訂 2026-10-02 / #467 で追加）

12. **解説動画の composition は agent が書かず、Chrome を使わない組み立ての tool が作る。** agent が書くのはシーンごとの図解（演出の時刻を台本上の位置で宣言し、script を持たない HTML）だけで、組み立ての tool がタイミング表で位置を秒に直し、字幕・テーマ・`window.__hf`（seek と segments）を加えて、カット 1 本 = composition 1 枚を作る。seek を実装するタイムラインの runtime は、組み立ての tool が composition にインラインで埋め込む。これは改訂 2026-07-31 の Consequences「nyaucast 本体にブラウザ内 runtime 資産を持たない」を、解説動画について改めるものである。runtime と演出の語彙は業務ロジックなので、決定 10 に従い `src/lib/` に置かず組み立ての tool の実装に同居させる。collection（BGM 動画）は agent が composition 全体を書く形のまま変えない。組み立ては Chrome を使わないので、決定 7 の許可リストは広げない
13. **`video.preview` は各 segment の終わる直前のフレームを撮る。** 中点では、解説動画のシーンが組み上がる途中を撮ってしまう。static 区間ではどの時刻でも同じ絵なので、collection のプレビューは変わらない

## Why

- **実測で裏付けられた成立確実性**: 音声・動画とも合格ライン（実時間 2 倍以内）に対し 36〜90 倍の余裕。動的映像（毎フレーム描画）も 1080p30 で 165 frames/s と拡張性十分（残る課題は Bun 用描画ライブラリ選定のみ）
- **セットアップ摩擦の低さ**: node-av のネイティブバイナリは npm の optionalDependencies として非圧縮同梱され、Bun でも postinstall なしに動作する（mediabunny#378 の Windows ロード失敗は node-av v5.2.4 で解決済み）。システムへの ffmpeg 手動インストールは不要
- **工程分割に技術的必然性がない**: `@mediabunny/server` 1 本で対象コーデック（H.264 / AAC / MP3 等）とメタデータ読み取りを全充足する。音声のみ WASM に逃がしても動画側は構造的に node-av 必須のままで GPL surface は縮小せず、コードパスが二重化するだけ
- **エラーモデルの整合**: プロトタイプ実コード（`decodeAudio` の `if (!track) throw new Error(...)`）で確認した通り、mediabunny の失敗は素直な throw/reject。ADR-0001 の境界変換モデルに追加の適合コストがない
- **非対称な可逆性**: 今 node-av を必須依存として受け入れても、将来の optional 化・差し替えは（ADR-0001「1 MCP tool = 1 ファイル」規約により呼び出しが tool 実装内に自然に閉じているため）着手が容易。逆に今から抽象化境界を先回りで作るのは、v0.1 時点で受益者のいない投機的設計になる

（以下、改訂 2026-07-31 / #178 で追加）

- **実測で裏付けられたパイプライン成立**（決定 6）: #175 でフルパイプライン 125.9 秒 / 1h 動画 — 撤退先の静止画パス（78.7 秒）に対する browser 化の追加コストは capture 約 0.7 秒のみ。決定論も 300 フレーム sweep 全 PASS（マーカー誤差 max 1px・再 seek / 逆順 seek バイト一致）で、「同じ composition から同じ動画が出る」ことを機械検証できる
- **基盤一本化による二重実装の回避**（決定 6）: v0.1 の動画要件（静止画 1 枚 + 音声）は動かさないまま、基盤だけ v0.2 動的映像と同じ形に載せ替える。静止画パスのまま v0.1 を作ると、v0.2 で動画パスの作り直しが確定する
- **tool 列挙で限定する理由**（決定 7）: 「動画工程」「rasterize 用途」のような概念での限定は境界解釈に幅が出て、マップ #172 が out of scope と判断したサムネ同基盤化が黙って入り込める。tool 名の列挙は検証可能で、拡大を ADR 改訂という明示的な決定に強制できる
- **初回実行時自動ダウンロードの理由**（決定 8）: 既存 Why の「セットアップ摩擦の低さ」と同じ価値基準。明示 setup コマンドは CLI が 1 本増えた上に実行忘れで tool が失敗するケースを生み、Nix devShell 供給は ADR-0003（Bun 必須配布）の外へ runtime 依存を出し #175 でも未検証
- **トリガ列挙 + 都度判断の理由**（決定 11）: 性能面の撤退トリガは #175 で消え、残るのは環境・上流起因のみ。発動頻度の実データがない段階で数値基準を作るのは投機的で、決定 4（node-av GPL 論点の「検討段階で再判断」）と同じ時点判断 + ADR 改訂パターンに揃える。撤退先の常時グリーン保守は二重実装の保守コストを恒常化させ、基盤一本化の動機と矛盾する

（以下、改訂 2026-10-02 / #467 で追加）

- **秒を書くのは nyaucast だけにする**（決定 12）: 尺は音声が決め、agent は台本上の位置で時刻を指す（#466）。agent が composition 全体を書くと、タイミング表から秒を写す工程が戻り、写し間違いや古い時刻表のまま書く事故を防げない。字幕・縦型のレイアウト（切り抜きショートの帯）・図解の安全性の検査も、組み立ての tool の 1 か所に集まる。先行実装の `life` の動画ダイジェストが同じ分担（LLM はシーンの断片、決定的なビルダーが時間軸と字幕）で動いている

## Considered Options

- **ffmpeg CLI を subprocess spawn で本採用**: node-av の「リンク」ではなく「別プロセス起動」（mere aggregation）に倒せば結合著作物論点は弱まるが、(a) node-av 自身も同じ GPL ビルドの ffmpeg CLI バイナリを同梱しており配布物から GPL コードが消えるわけではない、(b) JSON パース・2 回実行等のグルーコードが ADR-0001 の throw モデルと噛み合わない、(c) 実測で純 TS + node-av 側に性能・工数上の弱点が見つからなかった。不採用
- **音声のみ WASM エンコーダで node-av を回避**: `@mediabunny/mp3-encoder` / `@mediabunny/aac-encoder` で音声はネイティブバイナリなしにできるが、動画生成が destination のスコープに入っている以上 node-av は構造的に必須。GPL 回避効果がないままコードパスが二系統化するだけ。不採用
- **LUFS 実装を vendor 化**: 保守断絶リスクを初期から回避できるが、v0.1 時点では投機的。「壊れたら直す」の方針（ADR-0001 の教訓）と整合しない。不採用（上流が壊れた場合のフォールバック選択肢として Consequences に残す）
- **node-av 呼び出しを差し替え可能な抽象境界の裏に隔離**: ADR-0001「1 MCP tool = 1 ファイル」規約により、`audio.master` 等の tool 実装内に呼び出しは自然に閉じる。追加のレイヤーを今から作る理由がない。不採用

（以下、改訂 2026-07-31 / #178 で追加）

- **HyperFrames をエンジンごと採用**: `png-sequence` が第一級出力で FFmpeg 抜きのフレーム列出力を公式サポートし、capture 層も公開セッション API で改造ゼロの部分利用が可能（#173、Apache-2.0）。しかし engine が composition に要求するのは `window.__hf` seek プロトコルだけで、mediabunny 直結の自前 capturer（CDP client 約 210 行、#175 実証済み）で足りる。依存面を増やす必然がなく、プロトコル互換のみ共有する。不採用
- **screencast / ロックステップ方式の capture**: screencast は wall-clock 従属で構造的に非決定論。正典のロックステップ（`HeadlessExperimental.beginFrame`）は macOS 非対応（#174）。seek 方式 + `Page.captureScreenshot` を採用。不採用
- **静止画パス（#46 の形）のまま v0.1 を作る**: 実証済みで最速（78.7 秒 / 1h）だが、v0.2 動的映像で動画パスを作り直す二重実装が確定する。撤退先（決定 11）として記録に留める。不採用
- **capture / encode の tool 分割**: 中間フレーム列を agent に見せる価値がなく、#175 は streaming 直結（フレーム列をディスクに置かない）で成立済み。`video.render` 1 tool に内包する。不採用（#176）
- **validate 単体 tool**: `video.preview` が契約検証を内包し、需要は preview として確定した。不採用（#177）

（以下、改訂 2026-08-22 / #332 で追加）

- **動画生成基盤を Remotion へ置き換え**: 「公式 Agent Skills の充実」と「mediabunny の内部採用」を動機に wayfinder セッションで検討した（#332。地図は作らず撤回で決着）。不採用の理由は 3 点 — (a) mediabunny 採用はブラウザ側スタック限定（`@remotion/web-renderer` と旧 Media Parser / WebCodecs の後継系譜）で、nyaucast が Bun から叩くサーバーサイドの `renderMedia()` は FFmpeg バイナリ同梱（`@remotion/compositor-*`）のまま。エンコード層を mediabunny にする動機は決定 1・6 が既に満たしている。(b) Remotion のライセンスは頒布ではなく**利用**に有償条件が掛かる（無償は「Remotion を操作する関係者 3 人以下」の組織まで。CLI/API の自動レンダリングは Automators 区分 $0.01/render・最低 $100/月）。nyaucast には将来的に有償ツールとして公開する意向があり、下流利用者それぞれに free/有償のライセンス判定が波及する構図は配布性を損なう。(c) 公式 Agent Skills（remotion-dev/skills の 12 skill・llms.txt・AI 向けシステムプロンプト文書）は事実として確認できたが、上記 2 点を覆すには足りない。不採用。再検討トリガ: Remotion のサーバーサイドレンダリングの mediabunny 移行が完了し、かつライセンス条件が nyaucast の利用・配布形態と両立すると判断できたとき（新規の wayfinder 効力として起こし、#332 の記録を出発点にする）。主な根拠（2026-08-22 時点）: ライセンス <https://www.remotion.dev/docs/terms> / <https://www.remotion.pro/license>、mediabunny 移行範囲 <https://www.remotion.dev/blog/mediabunny> / <https://www.remotion.dev/docs/ffmpeg>、公式 skills <https://www.remotion.dev/docs/ai/skills>、Bun <https://www.remotion.dev/docs/bun>、決定論 <https://www.remotion.dev/docs/using-randomness>

（以下、改訂 2026-10-02 / #467 で追加）

- **解説動画も agent が composition 全体を書く**: ADR は変わらないが、上の Why のとおり秒の写しが戻り、字幕と縦型レイアウトを毎回 agent が組むことになる。不採用
- **切り抜きショートを、長尺のカットの再エンコードで作る**: 縦型への配置と帯の合成を mediabunny 側で行う処理が要る。組み立ての tool が長尺の図解を縦型レイアウトに置き直し、長尺のタイミング表を区間の開始だけずらして使えば、Chrome の描画 1 本で済む。不採用
- **字幕をエンコード時に重ねる**: Chrome 以外の文字描画系が要り、決定 6 の一本化に反する。不採用

## Consequences

- `audio.master`・動画生成用 primitive tool・アップロード前検証 tool は `@mediabunny/server`（node-av）に直接依存する。node-av の GPLv3 ネイティブバイナリは通常の（optionalDependencies ではない）依存としてインストールされる
- v0.1.0 dogfood（社内・first-party チャンネルでの利用、配布なし）の間は GPL の頒布義務は発生しない
- nyaucast の公開/配布（npm public 化・OSS 化・バイナリ配布等）を具体的に検討する際は、本 ADR を改訂し、node-av の依存位置（必須 or optional）・結合著作物の解釈・ライセンス表記を再判断する
- `@audio/loudness-lufs` は 2026 年発足・star 0 の若いパッケージ。EBU Tech 3341 相当の回帰テストを nyaucast 側のテストスイートに置き、上流の破壊的変更/放棄を検知する。メンテが止まった場合は同アルゴリズムの vendor 化（~220 行、実装コストは調査済みで小さい）で緩和する
- true peak ガードは増幅方向のケース（元音源が -14 LUFS より静かな場合）のみ発火する。通常の音楽ミックス（-14 LUFS より大きいのが通例）では素通りする
- Bun 実機での動作は issue #45 / #46 のプロトタイプ（PR #51 / #52、いずれも merge しない前提の draft）で検証済み。本採用時は同等のロジックを `src/` 配下の実装として書き起こす。Bun 固有の追加対応は `trustedDependencies: ["node-av"]` の明示のみ
- サムネ生成・動的映像の実装本体・EQ/コンプレッション等の本格マスタリング加工は本 ADR のスコープ外（マップ issue #42 の Out of scope を参照）

（以下、改訂 2026-07-31 / #178 で追加）

- 旧 Consequences の「動画生成用 primitive tool」は `video.render` / `video.preview` と読む。両 tool は `@mediabunny/server`（node-av）に加えて `@puppeteer/browsers` と pin 済み chrome-headless-shell に依存し、初回実行はダウンロードのためネットワークを要する。供給失敗は通常の throw で表面化する（決定 5 のエラーモデルのまま）
- 契約の正書は `docs/reference/composition-contract.md`。codec は執筆レシピの根拠として、`video.render` / `video.preview` は検証実装の根拠として、本 ADR は決定記録として参照する。決定論化の知識（GSAP `updateRoot(t)` 外部駆動・WAAPI `currentTime` seek 等のレシピ）は `collection-lifecycle` codec が持ち、執行は agent（composition に埋め込む）、検証は render（サンプルフレームの同一 t 再 seek バイト比較。不一致は非決定論として throw）が担う — nyaucast 本体にブラウザ内 runtime 資産を持たない
- composition HTML・プレビュー PNG はデータ 4 分類 ③（生成成果物）として collection ディレクトリ配下に置く。プレビュー手順の WHEN/HOW（提示 → GO/NO → 修正ループ）は codec の動画生成節が持ち、tool description は WHAT のみ
- 撤退トリガ（決定 11）に専用の監視機構は作らない — いずれも通常運用の失敗（ダウンロード失敗・起動失敗・決定論検証の throw）として表面化する
- v0.2 動的映像はこの基盤の上に乗る。残る課題はブラウザ内アニメーション手段の codec レシピ拡充のみで、パイプライン側の作り直しは発生しない

（以下、改訂 2026-10-02 / #467 で追加）

- 解説動画では、図解の書き方の知識は `explainer-lifecycle` codec が持ち、演出の語彙（`data-beat` 等）と並べ方の規則は組み立ての tool の定数とする。図解の契約の正書は `docs/reference/` に新しく置く（実装 ticket で書く）。図解・composition・カット・プレビューは、動画のディレクトリの下に置く。composition・カット・プレビューはデータ 4 分類 ③ である。図解は agent が書く入力で、決定的には作り直せないので ③ に含めず、消してはいけないものとして扱う（改訂 2026-10-02 / #494。ADR-0009 決定 11）
- 図解が検査に落ちたら、組み立ての tool は違反をすべて列挙して throw する（そのシーンだけ縮退して続ける形は採らない）

- ADR-0001（内部throw・境界で変換 / 1 tool = 1 file — 決定 10 はその解釈明文化）/ ADR-0003（Bun 必須配布・ビルドレス出荷）/ ADR-0007（決定 9 の鮮度付き冪等はその決定 4 の解釈精緻化。本体は改訂しない）
- マップ issue #42「メディア処理基盤の技術選定マップ」とその子チケット #43 / #44 / #45 / #46 / #49
- マップ issue #172「動画生成 HTML パイプライン化マップ」とその子チケット #173 / #174 / #175 / #176 / #177 / #178（改訂 2026-07-31 の出所）
- issue #332「Remotion 置き換え検討の不採用記録」（改訂 2026-08-22 の出所。wayfinder セッションで検討し、地図は作らず撤回で決着）
- issue #467「カット 3 種の描画方式と字幕の焼き込み」（改訂 2026-10-02 の出所。地図 #457 の決定 ticket）
- issue #494「解説動画の成果物の実体行と、進捗の導出」（改訂 2026-10-02 の出所。地図 #457 の決定 ticket）
- `docs/research/mediabunny-bun-codec-support.md`（issue #43 / PR #48）/ `docs/research/lufs-pure-ts-normalization.md`（issue #44 / PR #50）/ `docs/research/node-av-ffmpeg-license.md`（issue #49 / PR #53）
- `docs/research/hyperframes-internals-partial-use.md`（issue #173 / PR #179）/ `docs/research/browser-frame-capture-deterministic.md`（issue #174 / PR #180）
- `docs/reference/composition-contract.md` — `window.__hf` 契約の正書
- プロトタイプ PR #51（音声パス）/ PR #52（動画パス）/ PR #183（HTML パイプライン end-to-end、issue #175）— いずれも merge しない前提の draft
