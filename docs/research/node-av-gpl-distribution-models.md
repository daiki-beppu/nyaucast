# node-av（GPLv3）依存は各配布モデルと両立するか

- 調査日: 2026-10-03（issue #575、map #574 の子）
- 調査方法: GPLv3 本文・GNU GPL FAQ・FSF ライセンス一覧・FFmpeg 公式 legal ページ・FSL / BSL のライセンス本文・npm registry・先行事例（Remotion・ffmpeg-static・@mediabunny/server）の一次情報を直接読んだ。二次記事は使っていない
- 出発点: [`docs/research/node-av-ffmpeg-license.md`](node-av-ffmpeg-license.md)（node-av のプレビルドは GPLv3 構成・libx264 静的リンクであることの確認）
- **法的助言ではない。** 「結合著作物（combined work）」の線引きは FSF 自身が「最終的には裁判所が決める法的問題」と書いている（GPL FAQ [#MereAggregation](https://www.gnu.org/licenses/gpl-faq.html#MereAggregation)）。以下は FSF の公式見解に沿った保守的な読み方で、判例による裏付けはない。日本法での扱いも未検証。有償配布に踏み出す前には専門家の確認が必要

## 結論サマリ

| 配布モデル | node-av を同一プロセスで通常依存（現 ADR-0005 決定 4） | node-av を optional 化（同一プロセスのまま） | メディア処理を別プロセスの GPL ワーカーに分離 |
| --- | --- | --- | --- |
| (1) nyaucast 本体を MIT / Apache-2.0 で公開 | **両立する**。MIT・Apache-2.0 は GPLv3 互換。ただし node-av と一緒に配る結合物は実効 GPLv3 で、「nyaucast = MIT」は自分のソースについての宣言にとどまる | 両立する。node-av なしで使える部分は純粋に MIT として配れる | 両立する。本体は完全に MIT |
| (1') GPLv3 で公開 | 両立する（最も議論が少ない） | 同左 | 同左 |
| (1'') GPLv2-only で公開 | **両立しない**（node-av の FFmpeg は `--enable-version3` の GPLv3 ビルド） | node-av なし構成のみ可 | 本体は可（ワーカーは GPLv3） |
| (2a) 有償部分 = 同一プロセスで動く追加機能・別パッケージ（プロプライエタリ） | **両立しない**（FSF 見解では結合著作物になり GPL 互換ライセンスが必要。MIT の中間層を挟んでも無関係） | 有償部分が node-av を読み込むプロセスで動く限り両立しない。node-av を使わない構成で配る分には両立しうる（グレー） | **両立する**。有償部分も本体も node-av と別プログラム |
| (2b) 有償部分 = 別プロセスのサービス（SaaS 等、利用者にコピーを渡さない） | **両立する**。GPL（AGPL ではない）は頒布しない限り義務が生じない | 同左 | 同左 |
| (2c) 有償だが GPL 互換ライセンスで配る（サポート・ホスティングで収益化） | 両立する。GPL は有償頒布を許すが、受領者の再配布を制限できない | 同左 | 同左 |
| (3) FSL / BSL（source-available） | **両立しない**（FSL の Competing Use 禁止・BSL の non-production 限定は GPLv3 §10 の「追加の制限」に当たり、GPL 非互換） | node-av を読み込まない構成で配る分には両立しうる。ただし「GPL プラグインを読み込むよう設計された本体」は FSF 見解で GPL 互換を要求されるためグレー | **両立する**。本体は FSL / BSL、ワーカー（node-av を使う部分）は GPLv3 で別に配る |

要点:

1. **頒布しなければ何も起きない。** v0.1 の dogfood（自社内利用）は GPL の義務を一切発生させない。問題になるのは「他者にコピーを渡す」ときだけ
2. **GPL 非互換になるのは「制限を加えるライセンス」全般**（プロプライエタリ・FSL・BSL）。MIT / Apache-2.0 / GPLv3 は問題ない
3. **境界を変えるのは「optional 化」ではなく「プロセス分離」**。optional 化は「node-av 抜きでも成立する配布物」を作れるようにするだけで、同一プロセスで node-av を読み込む構成の扱いは変わらない。FSF が「通常は別プログラム」と明言しているのは pipe / socket / コマンドライン引数で通信する別プロセスのほう

## 前提の確認（一次情報）

### node-av の実効ライセンスは GPLv3

- node-av の npm 表記は `MIT`（[registry: node-av latest](https://registry.npmjs.org/node-av/latest)、v6.1.1）だが、プレビルドの `.node` は `--enable-gpl --enable-version3` の FFmpeg と libx264 を静的リンクした単一バイナリ（[既存調査](node-av-ffmpeg-license.md) 問い 1）。README の License 節も「FFmpeg 自体は LGPL/GPL。遵守は利用者の責任」とだけ書いている（[node-av README](https://github.com/seydx/node-av#license)）
- FFmpeg 公式: 「GPL の部分（libx264 等）を使うと **FFmpeg 全体に GPL が適用される**」「FFmpeg は他のライセンス条件（プロプライエタリ・商用）では、対価を払っても提供されない」。LGPL 遵守チェックリストの最後は「GPL ライブラリ（特に libx264）を使っていないこと」（[FFmpeg License and Legal Considerations](https://ffmpeg.org/legal.html)）
- つまり **libx264 入りの node-av を使う限り、LGPL の「動的リンクなら本体は自由」という逃げ道は無い**。商用ライセンスで買い取る選択肢も無い

### nyaucast の現状

- `package.json` に `license` フィールドが無く、GitHub リポジトリは private・ライセンス未設定（`gh repo view` で確認）。一方 `publishConfig.access: public` で npm 公開の構えはある
- node-av / `@mediabunny/server` は**現時点で `dependencies` に入っていない**（`prototype/` の #45 実験だけが使った）。ADR-0005 決定 4 は「入れる前提」で許容を決めたもの。依存位置を決め直すコストは今がいちばん低い
- 依存チェーンは `@mediabunny/server`（MPL-2.0）→ `node-av: ^6.0.0` が**通常依存**（[registry: @mediabunny/server latest](https://registry.npmjs.org/@mediabunny/server/latest)、v1.61.0）。nyaucast 側で node-av を optional にしても、`@mediabunny/server` を入れた時点で node-av は必ず入る。optional 化の単位は `@mediabunny/server` ごとになる

## 根拠: GPL の線引き（GPLv3 本文と FSF の公式見解）

### 義務が生じるのは「convey（頒布）」だけ

- GPLv3 §0: 「propagate」から「コンピュータ上での実行と私的コピーの改変」は除外。「convey」は他者がコピーを作成・受領できるようにする伝播で、「**コピーの移転を伴わないネットワーク越しの対話は convey ではない**」（[GPLv3 本文](https://www.gnu.org/licenses/gpl-3.0.txt)）
- GPL FAQ [#GPLRequireSourcePostedPublic](https://www.gnu.org/licenses/gpl-faq.html#GPLRequireSourcePostedPublic): 改変版を私的に使うだけなら公開義務は無い。企業内でも同じ
- GPL FAQ [#InternalDistribution](https://www.gnu.org/licenses/gpl-faq.html#InternalDistribution): 組織内での複製は頒布ではない。ただし**社外の個人・組織（業務委託先を含む）にコピーを渡すのは頒布**
- GPL FAQ [#UnreleasedMods](https://www.gnu.org/licenses/gpl-faq.html#UnreleasedMods): Web サイトで改変版を動かすだけなら GPL はソース公開を要求しない（AGPL なら要求する）。node-av / FFmpeg は AGPL ではない
- GPL FAQ [#WhatDoesCompatMean](https://www.gnu.org/licenses/gpl-faq.html#WhatDoesCompatMean): 「すべての GPL は（非互換ライセンスのコードとの）結合を**私的には**許す」

### 同一プロセス = 結合著作物（FSF 見解）

- GPL FAQ [#GPLStaticVsDynamic](https://www.gnu.org/licenses/gpl-faq.html#GPLStaticVsDynamic): 静的リンクでも動的リンクでも、GPL 著作物とのリンクは結合著作物を作り、GPL が全体を覆う
- GPL FAQ [#MereAggregation](https://www.gnu.org/licenses/gpl-faq.html#MereAggregation): 同じ実行ファイルに入っていれば確実に 1 つのプログラム。**共有アドレス空間でリンクして動くよう設計されていれば、ほぼ確実に 1 つのプログラム**。逆に **pipe・socket・コマンドライン引数は通常は別プログラム間の通信手段**で、その場合は通常別プログラム（ただし複雑な内部データ構造をやり取りするほど親密なら結合とみなされうる）
- GPL FAQ [#IfInterpreterIsGPL](https://www.gnu.org/licenses/gpl-faq.html#IfInterpreterIsGPL): インタプリタ言語のプログラムでも、「バインディング」を通じて GPL の機能を使うなら実質的にリンクしており、GPL 互換で出す必要がある（JNI が例）。Node の N-API アドオン（node-av の `.node`）を JS から呼ぶ nyaucast はこの形に当たる
- GPL FAQ [#GPLPlugins](https://www.gnu.org/licenses/gpl-faq.html#GPLPlugins): 動的にロードして関数呼び出しとデータ構造の共有をするなら単一の結合プログラム。fork / exec で起動し、親密な通信をしなければ別プログラム
- GPL FAQ [#NFUseGPLPlugins](https://www.gnu.org/licenses/gpl-faq.html#NFUseGPLPlugins): GPL プラグインを読み込むよう設計された非自由プログラムは、結合プログラムになるなら GPL 互換で出し、**「そのプラグインと使うために本体を頒布するとき」GPL の条件に従う必要がある**
- GPL FAQ [#GPLWrapper](https://www.gnu.org/licenses/gpl-faq.html#GPLWrapper): プロプライエタリ部分 A と GPL 部分 C の間に MIT（X11）の中間層 B を挟んでも「**法的に無関係**」。全体に C が含まれることが問題
- GPL FAQ [#GPLInProprietarySystem](https://www.gnu.org/licenses/gpl-faq.html#GPLInProprietarySystem): GPL ソフトをプロプライエタリなシステムに組み込むことはできない。ただし「**arm's length（距離を置いて）通信し、実質的に 1 つのプログラムにならない**」なら並べて配れる

### ライセンス互換性

- FSF ライセンス一覧: Expat（MIT）は「GPL 互換」（[#Expat](https://www.gnu.org/licenses/license-list.html#Expat)）、Apache-2.0 は「**GPL バージョン 3 と互換**」（[#apache2](https://www.gnu.org/licenses/license-list.html#apache2)）。node-av の FFmpeg は GPLv3 構成なので Apache-2.0 でも問題ない
- GPL FAQ [#LinkingWithGPL](https://www.gnu.org/licenses/gpl-faq.html#LinkingWithGPL): GPL コードとリンクする自分のプログラムは「GPL にしなければならない」のではなく「**GPL 互換ライセンスで出す**」必要がある。結合物全体はその GPL バージョンで利用可能になる
- GPLv3 §5(c): 改変版（work based on the Program）は全体を GPLv3 でライセンスする。§5 末尾: 「本質的に拡張でなく、より大きなプログラムを形成するよう結合されていない」独立著作物と同じ媒体に入れるだけ（aggregate）なら、他の部分に GPL は及ばない
- GPLv3 §10: 「**本ライセンスが付与する権利の行使に追加の制限を課してはならない**」。§4: 頒布するコピーに価格を付けるのは自由

## 問い 1: OSS ライセンス候補で nyaucast 本体を出せるか → 出せる（GPLv2-only を除く）

- **MIT / Apache-2.0**: 出せる。FSF はどちらも GPLv3 互換と認めており（上記）、#LinkingWithGPL の条件（GPL 互換で出す）を満たす。nyaucast のソースの著作権表示とライセンスは MIT / Apache-2.0 のまま保てる
  - ただし、**node-av と結合して動く nyaucast を頒布する場面の「全体」は実効 GPLv3**。受領者は nyaucast 部分を MIT として切り出して使えるが、結合物を再配布する人は GPLv3 に従う。「nyaucast は MIT」という表示は誤りではないが、利用者には「実行には GPLv3 の node-av が必要」と明示するのが誠実（FSF が #GPLInProprietarySystem で「利用者が自分の権利を明確に理解できるように」と言っている趣旨）
  - npm 公開する nyaucast の tarball 自体には node-av のバイナリは入らない（依存として宣言するだけ。バイナリは利用者のインストール時に npm から取得される）。この場合 nyaucast は GPL コードを convey していない。ただし FSF の #NFUseGPLPlugins / #IfInterpreterIsGPL の論理では「GPL バインディングを使うよう設計された本体」も GPL 互換を求められる。MIT / Apache-2.0 はそれを満たすので、この論点は (1) では問題にならない
- **GPLv3（or later）**: 出せる。最も議論の余地が少ない
- **GPLv2-only**: 出せない。GPLv2-only と GPLv3 は互換でない（node-av の FFmpeg は `--enable-version3`）。GPLv2-or-later なら GPLv3 として結合できる
- **先行事例**: `@mediabunny/server` は MPL-2.0 で node-av を通常依存に持つ（[registry](https://registry.npmjs.org/@mediabunny/server/latest)）。MPL-2.0 も GPL 互換（FSF 一覧）で、構図は「互換な弱いライセンスの本体 + GPL バイナリ依存」と同じ。`ffmpeg-static` は GPL ビルドの ffmpeg バイナリを配る npm パッケージ自体を `GPL-3.0-or-later` と表記している（[registry: ffmpeg-static latest](https://registry.npmjs.org/ffmpeg-static/latest)、v5.3.0）。node-av の `MIT` 表記は実体と乖離しており、真似る先にはならない

## 問い 2: オープンコアの有償部分は GPL を継承するか → 形態次第

前提として、**GPL は「有償」を禁じない**（§4 で価格は自由）。禁じるのは「受領者が GPL の権利（複製・改変・再頒布）を行使することへの追加の制限」（§10）。オープンコアで問題になるのは、有償部分を**プロプライエタリ（再配布禁止・ソース非公開）**にしたい場合である。

| 有償部分の形態 | 結論 | 根拠 |
| --- | --- | --- |
| 別 npm パッケージで、node-av を読み込む同じ Node プロセスで動く（import して呼ぶ） | **GPL 互換で出す必要がある**（プロプライエタリ不可） | #MereAggregation（共有アドレス空間）、#GPLPlugins（動的ロード + 関数呼び出し）、#NFUseGPLPlugins |
| 同上だが、有償部分自体は node-av を直接呼ばず、MIT の nyaucast コア経由でだけ使う | 変わらない（不可） | #GPLWrapper（MIT の中間層は法的に無関係） |
| 同上だが、有償部分は node-av を読み込まないプロセスだけで動く（例: 分析・ダッシュボード機能で、メディア処理と同じプロセスに乗らない） | プロプライエタリ可の余地がある（グレー）。node-av を同一プロセスでロードしない設計を**構造的に**保証できることが条件 | #MereAggregation の判定基準（通信の仕組みと意味） |
| 別プロセスのサービスで、利用者にコピーを渡さない（SaaS・ホスティング） | **継承しない**。GPL の義務自体が発生しない | GPLv3 §0（ネットワーク越しの対話は convey でない）、#UnreleasedMods |
| 別プロセスで利用者の手元に配る（CLI / MCP サーバ / HTTP で nyaucast のメディア処理と通信） | **継承しない**（通常は別プログラム）。ただし親密な内部データ構造のやり取りは避ける | #MereAggregation（pipe・socket・コマンドライン引数）、#GPLInProprietarySystem（arm's length） |
| 有償だが GPLv3 / MIT 等で配る（サポート・ビルド済み配布・ホスティングに課金） | 継承の問題は起きない。ただし受領者の再配布は止められない | §4、§10 |

注意点:

- 「業務委託先にコピーを渡す」も頒布になる（#InternalDistribution）。顧客・委託先の環境に入れて動かす形の有償提供は SaaS 扱いにならない
- Docker イメージ・バンドル済みバイナリなど、**node-av の `.node` を含む成果物を自分で配る**と、nyaucast 側が GPL バイナリそのものを convey する。この場合は §6 の Corresponding Source 提供義務（FFmpeg / jellyfin-ffmpeg / x264 のソース入手手段の提示）が nyaucast 側に生じる（既存調査の「Docker イメージ配布」リスクと同じ）

## 問い 3: FSL / BSL と矛盾しないか → 同一プロセスの結合物としては矛盾する

- **FSL-1.1**: 許諾は「Permitted Purpose」に限られ、「Competing Use（ソフトウェアを代替する商用製品・サービスとして他者に提供すること）」を除外する。再頒布時もこの条件が全コピー・派生物に及ぶ（[FSL-1.1-MIT 本文](https://fsl.software/FSL-1.1-MIT.template.md)）。2 年後に MIT / Apache-2.0 へ転換（[fsl.software](https://fsl.software/)）
- **BSL-1.1**: 複製・改変・再頒布と「**non-production use**」だけを許諾し、本番利用は Additional Use Grant で許す範囲に限る。Change Date（最長 4 年）以後に Change License へ転換。本文自身が「Open Source ライセンスではない」と明記（[SPDX: BUSL-1.1](https://spdx.org/licenses/BUSL-1.1.html)）
- どちらも**利用目的に制限を課す**。GPLv3 §10 は追加の制限を禁じるので、FSL / BSL は GPL 非互換（FSF ライセンス一覧に両者の掲載は無く、互換と認められた事実も無い）。したがって:
  - **FSL / BSL の nyaucast を node-av と同一プロセスで結合した形で頒布する**のは、FSF 見解では GPL 違反になる。#NFUseGPLPlugins の論理では、npm tarball に node-av を含めずとも「node-av と使うために設計・頒布した」本体は GPL 互換を求められる
  - 利用者が手元で私的に組み合わせるのは GPL 上は自由（#WhatDoesCompatMean）だが、それは「配る側（nyaucast）が FSL / BSL で問題ない」ことの根拠にはならない。npm の依存宣言で利用者に組み立てさせる形は FSF 見解と衝突するグレーで、判例も無い
  - 転換後（FSL は 2 年、BSL は Change Date 後）の MIT / Apache-2.0 版は問題なくなる。BSL は Change License を GPLv2 以降互換にすることを要求している（[SPDX: BUSL-1.1](https://spdx.org/licenses/BUSL-1.1.html) の Covenants）が、制限期間中の非互換は変わらない
- **両立させる形**: メディア処理（node-av を使う部分）を **GPLv3 の別プロセス・別パッケージ**に切り出し、FSL / BSL の本体はそれを CLI 引数・pipe・socket で起動・通信する。本体と GPL ワーカーは #MereAggregation の意味で別プログラムになる
- **先行事例**: Remotion（独自の有償ライセンスで配布される source-available 製品）は、「**コンパイル済みの FFmpeg バイナリを GPLv2+ で配布している**。x264 / x265 が GPL なので LGPL では配れない」と公式に説明し、ソースとビルドスクリプトを公開している（[Remotion: FFmpeg license](https://www.remotion.dev/docs/miscellaneous/ffmpeg-license)）。source-available の本体と GPL の FFmpeg バイナリを並べて配る構成の実例で、FFmpeg を独立した実行ファイルとして分けている。Remotion の本体と FFmpeg 間の結合の仕組み（プロセス分離の詳細）は本調査では未確認

## optional 化・別プロセス化で結論はどう変わるか

### optional 化（`@mediabunny/server` を optionalDependencies / 動的 import にし、同一プロセスのまま）

- **変わること**: node-av 抜きで成立する配布物（媒体処理以外の tool 群）を作れる。その配布物は GPL と無関係に MIT / FSL / BSL / プロプライエタリで出せる。GPLv3 §6 の Corresponding Source は「その著作物が特に必要とするよう設計された」動的リンク先を含むので、「無くても動く」設計は必要性の主張を弱める
- **変わらないこと**: node-av をロードした状態の nyaucast プロセスは、依然として共有アドレス空間の結合物（#MereAggregation、#GPLPlugins）。FSF 見解では「node-av と使うよう設計された」本体は GPL 互換が要る（#NFUseGPLPlugins）。**FSL / BSL / プロプライエタリの本体が「optional な node-av をロードできる」設計であること自体がグレーとして残る**
- 実装上の制約: `@mediabunny/server` が node-av を通常依存に持つため、optional 化の単位は `@mediabunny/server` ごと。媒体処理 tool は ADR-0001（1 tool = 1 ファイル）で自然に閉じているので、境界を引く場所はある（ADR-0005 Why「非対称な可逆性」）

### 別プロセス化（媒体処理を GPLv3 のワーカー実行ファイルに分離）

- **変わること**: 本体（MIT / FSL / BSL / プロプライエタリ）と GPL ワーカーが別プログラムになる（#MereAggregation: コマンドライン引数・pipe・socket、#GPLInProprietarySystem: arm's length）。**本体のライセンス選択から GPL の制約が消える**。オープンコアの有償部分も同一プロセス扱いにならない
- **条件**: 通信の「意味」も arm's length に保つ。入出力ファイルのパスとレンダリング・エンコードのパラメータ程度なら「単純な起動」の範囲。内部データ構造（フレームバッファ・コーデックの内部状態）を共有メモリや細粒度 RPC でやり取りすると結合物とみなされうる（#GPLPlugins: 共有メモリでの複雑なデータ構造の受け渡しは動的リンクとほぼ等価）
- **残る義務**: ワーカーそのもの（node-av を読み込むコード）は GPLv3（互換）で出す。ワーカーと node-av を同梱して配るなら §6 のソース提供義務。ワーカーを npm 依存として利用者に取得させるだけなら、本体側は GPL コードを convey しない
- ADR-0005 の Considered Options は「ffmpeg CLI を spawn」を不採用にしたが、その理由（(a) node-av も GPL の ffmpeg CLI を同梱するので配布物から GPL が消えない、(b) グルーコードが ADR-0001 のエラーモデルと噛み合わない、(c) 性能・工数上の弱点が無い）は**本体のライセンスを GPL から切り離す**目的とは別の軸である。(a) は「GPL バイナリが配布物に残るか」の話で、「本体が GPL 互換を求められるか」には効かない。別プロセス化は後者を解く手段で、前者（ワーカーの GPL 遵守）は残る

## まとめ（配布モデル決定への入力）

- **MIT / Apache-2.0 / GPLv3 の OSS で出すなら、node-av の通常依存はそのままでよい**（ADR-0005 決定 4 の現状維持で両立）。利用者向けに「実行には GPLv3 の node-av / FFmpeg が必要」の明示と、npm の `license` フィールド設定が要る
- **オープンコアでプロプライエタリの有償部分を配る、または FSL / BSL を選ぶなら、媒体処理の別プロセス化（GPLv3 ワーカー）が実質的な前提条件**。optional 化だけでは FSF 見解上のグレーが残る。SaaS として提供する有償部分（コピーを渡さない）は、どの構成でも GPL の制約を受けない
- いずれのモデルでも、**v0.1 の dogfood（頒布なし）には影響しない**。依存位置の決定は、配布モデルが決まった時点で ADR-0005 決定 4 を改訂して行う（決定 4 の規定どおり）

## 未確認・残課題

- 日本の著作権法で「結合著作物」「二次的著作物」の範囲がどう判断されるか（FSF 見解は米国法前提。判例調査は未実施）
- Remotion の本体と FFmpeg 間の結合の仕組みの詳細
- SFLC（Software Freedom Law Center）の個別見解は本調査では一次資料を確認していない。FSF の GPL FAQ のみを公式見解として扱った
- H.264 / H.265 の特許（Via LA 等）は著作権ライセンスとは別問題で、本調査の範囲外。FFmpeg 公式は「商用製品に組み込むと特許プールから請求されうる」と注意している（[FFmpeg legal: Patent Mini-FAQ](https://ffmpeg.org/legal.html)）。有償配布ではこちらも別途判断が要る
- fdk-aac-stripped の再配布可否（既存調査の残課題を引き継ぐ）

## 出典

1. GNU GPLv3 本文: https://www.gnu.org/licenses/gpl-3.0.txt （§0, §4, §5, §6, §10）
2. GNU GPL FAQ: https://www.gnu.org/licenses/gpl-faq.html （#MereAggregation, #GPLStaticVsDynamic, #IfInterpreterIsGPL, #GPLPlugins, #NFUseGPLPlugins, #LinkingWithGPL, #GPLWrapper, #GPLInProprietarySystem, #WhatDoesCompatMean, #GPLRequireSourcePostedPublic, #InternalDistribution, #UnreleasedMods）
3. FSF ライセンス一覧: https://www.gnu.org/licenses/license-list.html （#Expat, #apache2）
4. FFmpeg License and Legal Considerations: https://ffmpeg.org/legal.html
5. FSL: https://fsl.software/ 、本文 https://fsl.software/FSL-1.1-MIT.template.md
6. BSL 1.1（SPDX）: https://spdx.org/licenses/BUSL-1.1.html
7. npm registry: https://registry.npmjs.org/node-av/latest （v6.1.1, MIT）、https://registry.npmjs.org/@mediabunny/server/latest （v1.61.0, MPL-2.0, node-av ^6.0.0）、https://registry.npmjs.org/ffmpeg-static/latest （v5.3.0, GPL-3.0-or-later）
8. node-av README License 節: https://github.com/seydx/node-av#license
9. Remotion: FFmpeg license: https://www.remotion.dev/docs/miscellaneous/ffmpeg-license
10. 既存調査: [`docs/research/node-av-ffmpeg-license.md`](node-av-ffmpeg-license.md)
