# 失敗と境界のデータ: 3 分類、ファイルの持ち主による線引き、型の正本は Schema

## Status

accepted (2026-10-14 / #816。決定は map #775 の #776・#777・#778・#806)

## Context

ADR-0001 決定 3 は、エラーを `Schema.TaggedError` の型付きの失敗として持ち、境界で変換すると決めた。しかし、型付きの失敗にしないもの（defect）の扱いは決めていなかった。2026-10-14 時点の src には次の揺れがあった。

- `throw` は 0 か所で、`test/effect-migration.test.ts` が src 全体で `throw` を禁止していた。defect は `Effect.die`・`orDie`・`catchTag("SqlError", Effect.die)` で書かれていた
- 利用者が編集するファイル（チャンネルの設定、bgm-pool）の読み取り失敗も `orDie` で defect にしていた。そのため、利用者が自分で直せる失敗でも、MCP の応答や CLI の 1 行にパスと理由が出なかった
- 失敗も待ちも無いのに Effect で包んだ関数（`toPostRecord` など）や、TaggedError ではない素のオブジェクトを `Result` に載せて内部の失敗を運ぶコード（`src/feeds/feed-reader.ts`）があった
- export している手書きの interface のうち 7 件が、Schema と同じ形を二重に書いていた

参照したのは live-mindmap の `CODING_STANDARDS.md` と ADR 0007（`effect` 本体だけに依存する core）である。live-mindmap は関数と失敗を「普通の関数 / 型付きの失敗 / defect」の 3 つに分けている。

## Decision

1. **関数と失敗を 3 つに分ける（#776）。** 普通の関数（失敗も待ちも依存も無い。Effect で包まない）、型付きの失敗（外から来たものが壊れている。`Effect.fail(TaggedError)`）、defect（自分のコードが自分との約束を破った。`throw`・`!`・`Effect.die` のどれで書いてもよい）。分け方は live-mindmap に揃える
2. **`throw` を `Effect.try` で型付きの失敗に変える書き方は取り込まない（#776）。** `throw` は defect のときだけ使う。`Effect.try` / `Result.try` で包むのは、外部ライブラリが投げる例外だけにする。自分のコードの予期された失敗は、最初から `Effect.fail(TaggedError)` で書く
3. **型付きの失敗にするか defect にするかは、ファイルの持ち主で決める（#777）。** 外のもの（利用者が編集する設定・利用者が置いた素材・引数で受け取ったパス）の I/O 失敗は、そのファイルの失敗の仲間として `*Unreadable { path, reason }` を足す（例: `ChannelConfigUnreadable`。ファイルの名前を付けた失敗の前例は `BgmSongUnreadable`）。nyaucast が管理するもの（local.db・成果物・staging・バックアップ・データディレクトリの作成）の I/O 失敗は defect にする。共通の `FileUnreadable` は作らず、`PlatformError` を失敗チャネルに出さない。ファイルが無いことは、`PlatformError` の `NotFound` を捕まえる 1 段で検出する
4. **local.db の `SqlError` は defect にする（#777）。** 別のプロセスが握るロックは `busy_timeout` で待って吸収し（#787）、待っても取れなければ defect にする
5. **3・4 の線引きにはゲートを作らない（#777）。** `CODING_STANDARDS.md` に基準と例を書き、レビューで守らせる
6. **core を物理的な層にしない（#778）。** `src/core/` のディレクトリも、Node の型を外した型検査（live-mindmap の `tsconfig.core.json`）も持ち込まない。ADR-0002 と GLOSSARY の「core = MCP tool の handler」は変えない
7. **外から来るデータは Schema で検証し、壊れていれば型付きの失敗にする（#778）。** 範囲は決定 3 の「外のもの」と、SNS などの API の応答。nyaucast が管理するもの（local.db の行・成果物・staging）は対象外。JSON は Schema を通して読み、src の本体（`*.test.ts` を除く）で `JSON.parse` を禁止する（#807 決定 4。テストが自分で出力させた JSON は外から来るデータに当たらない）
8. **境界を越えるデータの型の正本を Schema にする（#778）。** 外のファイル・API の応答・DB の行と、それを写した業務の型は、Schema から型を導き、interface で二重に書かない。snake_case の Row から業務の型への写しも、Schema の変換で書く。関数の入力オプションと内部の計算結果は interface でよい。二重定義にはゲートを作らず、レビューで見る

## Why

- **3 分類を live-mindmap に揃える**: Effect 自身が予期された失敗と defect を分けている。同じ作者が持つ 2 つのリポジトリで分け方が違うと、レビューの基準が揺れる
- **`throw` → `Effect.try` を取り込まない**: nyaucast は旧リポの「throw で失敗を運ぶ」から抜けるために、決定 3 を型付きの失敗に改めた（ADR-0001 決定 3、#475）。`throw` を予期された失敗にも使ってよいことにすると、`throw` を見ただけではバグか利用者の誤りかが分からなくなる。`throw` を defect だけに使えば、その状態を保てる。`Effect.gen` の中の `throw` は Effect 4 では die になるので、defect を `throw` で書いても意味は変わらない
- **持ち主で線を引く**: 型付きの失敗にする価値は、利用者が自分で直せることにある。外のファイルの `EACCES` は利用者が直せるので、パスと理由を MCP の応答と CLI の 1 行に出す。local.db や成果物の I/O 失敗は nyaucast のバグか環境の故障で、利用者に渡しても直す手が無い。live-mindmap も実際にはこの基準で分けている（CLI 引数と正解ファイルは型付き、同梱の資産と自分で管理するファイルは `orDie`）
- **ファイルごとの `*Unreadable`**: 共通の `FileUnreadable` や `PlatformError` を出すと、tool の `failure` Schema から「何が読めないのか」が消える。ファイルごとの名前にすれば、宣言を見るだけで分かる
- **`NotFound` を 1 段で捕まえる**: `exists` → `read` の 2 段では、`exists` 自身の I/O 失敗という 3 本目の経路が生まれ、今の `orDie` の多くがここから出ている。1 段にすれば「無い」と「読めない」をそれぞれ 1 か所で割り当てられる
- **`SqlError` を defect にする**: local.db は nyaucast 自身の store なので、壊れていることや制約違反は自分のバグである
- **線引きにゲートを作らない**: 誰がファイルを直せるかは、コードの形からは機械で見分けられない
- **core を層にしない**: live-mindmap の core が分かれているのは、core がブラウザでも動くという要件（ADR 0003）による。nyaucast は Node だけで動き、その要件が無い。さらに tool のファイルはすべて `effect/ai` の `Tool` に依存し、多くが `SqlClient` を直接使う。「core = handler」と「core = 実行環境に依存しない層」は両立せず、純粋な判定を抜き出す組み替えは重すぎる
- **`JSON.parse` を禁止する**: `JSON.parse` は検証していない値を `any` で返し、外から来たデータが型を素通りする。Schema を通せば、壊れたデータは型付きの失敗になる。違反は 0 件なので、すぐ禁止できる
- **型の正本を Schema にする**: 同じ形を Schema と interface に二重に書くと、片方だけ直したときに検証と型がずれる。対象を境界を越えるデータに限るのは、live-mindmap の ADR 0007 と同じで、すべての型を Schema にしても検証の得が無いため

## Considered Options

- **defect を `Effect.die` / `orDie` に揃え、`throw` の禁止を続ける**（#776）: 書き方は 1 つになるが、`!` や同期の helper の不変条件まで Effect で書くことになる。defect の書き方が違っても意味は同じなので、揃える得が小さい。不採用
- **live-mindmap と同じく、`throw` を `Effect.try` で型付きの失敗に変える書き方を認める**（#776）: 同期の helper が書きやすくなるが、`throw` を見てもバグとは限らなくなる。不採用
- **失敗の種類で線を引く**（#777。例: OS の I/O 失敗はすべて defect、内容が壊れていれば型付き）: 利用者が直せる `EACCES` が defect になり、パスが応答に出ない。不採用
- **共通の `FileUnreadable` を 1 つ作る**（#777）: 型は減るが、`failure` Schema から何のファイルかが消える。不採用
- **`effect` 本体だけに依存する core を物理的な層として作る**（#778。live-mindmap の ADR 0007）: 要件が無く、組み替えが重い。不採用
- **`as` による型の断定を lint で禁止する**（#778）: 誤検出の調整が要り、`as` の多くは Schema の検証と関係が無い。不採用
- **すべてのオブジェクト型を Schema にする**（#778）: 入力オプションや計算結果まで Schema にしても、検証する相手がいない。不採用

## Consequences

- v0.2 の Workers 案（#476 の知識置き場のリモート MCP、#505 の状態を実行環境の外に置く案）が tool を Workers で動かすと決めたら、この ADR（とくに決定 6 の core を層にしないこと）を問い直す
- `CODING_STANDARDS.md` が判断の規則と例を持ち、`/code-review` の Standards 軸と fix の経路の実装者がそれを読む。この ADR は決定とその理由を持つ
- `JSON.parse` の禁止は lint のゲートとして別の issue で入れる。lint のメッセージはこの ADR を出典として指す
- 既存のコードのうち規則に合わないもの（`orDie` の持ち主による分け直し、`exists` → `read` の 2 段、feed-reader の `{reason}`、Schema の二重定義 7 件）は、v0.2 の移行 issue で直す。それまでの間、これらは新しいコードの手本にしない

## Related

- ADR-0001 決定 3（型付きの失敗と境界の変換。defect の分け方はこの ADR）/ ADR-0002（core = MCP tool の handler。変えない）/ ADR-0014（テストの層と構造の検査）
- `CODING_STANDARDS.md`
- live-mindmap の ADR [0003](https://github.com/daiki-beppu/live-mindmap/blob/main/docs/adr/0003-local-node-server-owns-pipeline.md)・[0007](https://github.com/daiki-beppu/live-mindmap/blob/main/docs/adr/0007-core-session-on-effect.md)・[0009](https://github.com/daiki-beppu/live-mindmap/blob/main/docs/adr/0009-http-and-browser-socket-on-effect-http.md)・[0010](https://github.com/daiki-beppu/live-mindmap/blob/main/docs/adr/0010-cli-on-effect-cli.md)
- 地図 issue #775 と決定 ticket #776 / #777 / #778 / #806
