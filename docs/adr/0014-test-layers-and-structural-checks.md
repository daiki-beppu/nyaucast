# テストの層と構造の検査: 層は unit と contract の 2 つ、構造は lint → スクリプトで検査する

## Status

accepted (2026-10-14 / #816。決定は map #775 の #779・#780・#782・#806・#807)

## Context

2026-10-14 時点で、テストは Vitest の project でディレクトリごとに `unit`（`src/**/*.test.ts`）と `contract`（`test/**/*.test.ts`）に分かれていた。src の unit 69 本のうち 61 本が、`test/` の helper を通して本物の fs と SQLite を使っていた。重いテストを示していたのは、Stryker の除外の一覧だけだった。

アーキテクチャの規約（`throw` の禁止、runner を呼ぶ場所、tool の配置、exact pin など）は、`test/effect-migration.test.ts` が vitest のテストとして検査していた。

テストの判断基準は、feature の経路では takt builtin の方針（`testing.md`）が課している。fix の経路（`/implement` → `/code-review`）には takt の方針が届かず、`/code-review` が出典として読む `CODING_STANDARDS.md` も無かった（#781）。

参照したのは live-mindmap である。テストの層を接尾辞で unit / `.it` / `.heavy` に分け、unit が本物の資源を import していないことを構文木で検査し、構造の検査を `scripts/check-*.ts` に置いている。

## Decision

1. **層は unit（`src/**/*.test.ts`）と contract（`test/**`）の 2 つにする（#779・#807）。** unit は一時ディレクトリの読み書き・SQLite（一時ファイル・`:memory:`）・localhost の fake サーバーを使ってよい。contract は CLI・MCP・パッケージを外から確かめる層で、ディレクトリで分ける。`.it` の層も、`.heavy` の層（接尾辞・所要時間のしきい値・それを照合する検査）も作らない。`pnpm run check` と CI はすべての層を走らせる
2. **unit が本物の資源を import していないかの検査は持ち込まない（#779）。**
3. **構造の検査は lint → スクリプトの 2 段で持ち、vitest のテストには置かない（#780）。** lint で書けるもの（`no-restricted-imports` / `no-restricted-properties` / `no-restricted-globals` と、ファイルごとの override）は lint に置く。lint で書けないものだけを `scripts/check-*.ts` に置き、check のゲートに加える。依存の置き場所と import の境界は fallow がすでに持っているので、重ねて検査しない。テストは振る舞いの契約だけを持つ
4. **`test/effect-migration.test.ts` を解体して削除する（#780）。** 検査は lint・スクリプトに移すか、別の検査がすでに覆っているものは捨てる。`throw` の禁止は、`CODING_STANDARDS.md` を置くのと同じ差分で外す（ADR-0013 決定 1）。移し替えと削除は、後続のゲートの issue で行う
5. **検査器は素の Node で書く（#780）。** Effect にはしない。違反を探す処理は純粋な関数として export し、実行部は薄くする。その関数のテストは `scripts/*.test.ts` に置き、unit の project に含める
6. **テストの判断基準の要旨を `CODING_STANDARDS.md` に置く（#782）。** Evidence gate と「内部構造を契約にしない」は、要旨 1 行と takt の `testing.md` へのリンクだけを書き、中身は takt を正本にする。takt に無いもの（層をまたいだ重複の明示的な禁止、待ちの補助関数の締め切り、否定テストの到達確認、外部 SDK に依存する指摘の決着）は `CODING_STANDARDS.md` に書く。既存テストの扱いは takt に揃える
7. **Fakes・E2E・Evals の規則は持ち込まない（#782）。**

## Why

- **層を 2 つにし、`.it` を作らない**: live-mindmap が unit に `fs` などを禁じるのは、core がブラウザでも動くという要件（live-mindmap の ADR 0003）による。nyaucast にはその要件が無い（ADR-0013 決定 6）。unit に資源を許すと、`.it` に入るテストが残らない。ファイルや SQLite に触れるものを `.it` に移す案（約 53 本の改名）は、どちらの層も 1 本 0.1 秒前後で、分けて走らせる理由が無い
- **heavy を作らない**: heavy を分ける目的は、Stryker の時間上限と、手元で速いテストだけを回すことだった。Stryker は廃止すると決めた（#807）。check と pre-push はすべての層を走らせ、手元で heavy を除く script も無いので、接尾辞を読むものが何も残らない。読む側のいない接尾辞と、それを守らせるゲートだけが残ることになる
- **contract をディレクトリで分ける**: contract は「どこから確かめるか」の軸で、重さの軸とは別である
- **構造をテストに置かない**: テストは振る舞いの契約を確かめるもので、内部構造を契約にしない（takt の方針）。lint は編集中に出て、違反の行を指せる。lint で書けないものだけをスクリプトにすれば、検査の置き場所が 2 つに収まる
- **検査器を素の Node で書く**: 検査器は check の中で 1 回走って終わるだけで、並行・時間・依存の注入が要らない。既存の `scripts/update-shard-weights.ts` と同じ書き方にする。検査器のテストは「違反を見つける」という振る舞いを確かめるので、構造をテストに置かない方針とは矛盾しない
- **takt の方針の要旨を `CODING_STANDARDS.md` に置く**: takt の方針は feature の経路にしか届かない。fix の経路で効くのは `CODING_STANDARDS.md` だけなので、要旨を置かないと 2 つの経路で基準が食い違う。中身まで写すと二重管理になるので、要旨とリンクだけにする
- **既存テストの扱いを takt に揃える**: live-mindmap の「新しいテストにだけ適用する」を採ると、takt の方針（今回の契約に触れる既存テストは直すか消す）と食い違う
- **Fakes・E2E・Evals を持ち込まない**: nyaucast の fake の形を決めた記録は無く、Playwright の E2E も Evals も無い

## Considered Options

- **live-mindmap と同じく unit / `.it` / `.heavy` の 3 層にし、unit の資源を構文木で検査する**（#779）: 分けて走らせる理由が無く、約 53 本の改名が要る。不採用
- **unit / heavy / contract の 3 層にし、所要時間 7 秒のしきい値で `.heavy` を付ける**（#779。#807 で改めた）: Stryker の廃止で、接尾辞を読むものが無くなる。不採用
- **構造の検査を vitest のテストのまま残す**（#780）: 1 つのテストファイルに集まって見通しはよいが、構造を契約にすることになり、lint のように違反の行を編集中に示せない。不採用
- **検査器を Effect で書く**（#780）: Effect の得が無い。不採用
- **takt の `testing.md` を `CODING_STANDARDS.md` に写す**（#782）: 二重管理になる。不採用

## Consequences

- v0.2 の Workers 案（#476・#505）が tool を Workers で動かすと決めたら、この ADR（とくに決定 1・2 の層の分け方）を問い直す
- 手元で遅いテストを除いて走らせたくなったら、heavy の層を作らないこと（決定 1）を問い直す
- `effect-migration.test.ts` の検査は、後続のゲートの issue（lint への移し替え、スクリプトへの移し替えと解体）が移すまで残る。lint のメッセージとスクリプトのエラー文は、この ADR を出典として指す
- `CODING_STANDARDS.md` の Tests の節が、テストを足すときの判断の規則を持つ。この ADR は理由だけを持つ

## Related

- ADR-0001 決定 9（検査ゲート。構造の検査の置き場所はこの ADR）/ ADR-0008（開発側の takt 運用）/ ADR-0013（失敗と境界のデータ）
- `CODING_STANDARDS.md` / takt の [`testing.md`](https://github.com/nrslib/takt/blob/main/builtins/en/facets/policies/testing.md)
- live-mindmap の ADR [0003](https://github.com/daiki-beppu/live-mindmap/blob/main/docs/adr/0003-local-node-server-owns-pipeline.md)・[0007](https://github.com/daiki-beppu/live-mindmap/blob/main/docs/adr/0007-core-session-on-effect.md)・[0009](https://github.com/daiki-beppu/live-mindmap/blob/main/docs/adr/0009-http-and-browser-socket-on-effect-http.md)・[0010](https://github.com/daiki-beppu/live-mindmap/blob/main/docs/adr/0010-cli-on-effect-cli.md)
- 地図 issue #775 と決定 ticket #779 / #780 / #781 / #782 / #806 / #807
