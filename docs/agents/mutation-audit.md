# Mutation 監査: Stryker の運用

Stryker（<https://stryker-mutator.io/>）を監査ツールとして運用する際の正書。決定の出典は wayfinder map #343 とその ticket resolution（監査運用は #347、runner 経路は #345、実測は #346）。

## 位置づけ

- **監査ツールであってゲートではない。** mutation score を出し、surviving mutant（テストが殺せなかった変異）からテストの穴を発見して issue 化する。score 閾値で CI を落とさない — CI 常設ゲート化の再評価は、監査運用の実測データが出た後の別 effort
- `pnpm run check` の直列チェーンに入れない。ゲート集合の定義は `package.json` の check script だけが持つ
- 用語は GLOSSARY.md — 「mutation testing」（本書の対象）と「改変拒否契約テスト」（別物・旧称 mutation test）を混同しない

## 実行

- **ローカル手動のみ。** GitHub Actions の定期実行（nightly 等）は設けない。定期実行の再検討は CI ゲート化の再評価と同じ束で行う
- 節目の目安（強制しない）: **実装 issue が main にマージされた後に 1 回** + **v0.1 ゲート（dogfood 完走）前に最低 1 回**。mutate 対象が増えた直後 — surviving mutant が出やすい瞬間 — に監査を当てる
- コマンドは `pnpm run mutation`（check チェーンから独立した package.json script）

## 対象

- mutate は `src/**/*.ts` 全対象を初期値とする。除外は「この surviving mutant は許容する」と決めた場所に監査運用の中で貼る — 導入時に先回りで除外を設計しない
- mutation 対象のテストは vitest の **unit project のみ**。改変拒否契約テストは `src` を import しない（mutant を殺せない）うえ依存 install 等を含む重量級のため対象外。vitest runner に project 選択オプションは無いため、unit 層だけを include した Stryker 専用 vitest config を `vitest.configFile` で渡して実現する

## レポート

- `reports/`（HTML レポート・`stryker-incremental.json`）は gitignore。ローカル使い捨てで、incremental ファイルもコミットしない（フル実行が数秒のため共有価値が薄い）
- 監査の永続成果は**起票された issue のみ**。`docs/audits/` には置かない — あれは read-only 監査工程が publish する散文レポートの置き場で、機械生成レポートは性質が違う

## 発見の issue 化

- 実行者（人 or agent セッション）がレポートを読み、**手動で起票**する。機械起票・自動化はしない — equivalent mutant 等「許容する surviving mutant」の選別が本質的に判断業務のため
- **1 issue 1 要件系統**（「テストの穴」単位）。本文は `docs/agents/issue-tracker.md` の「takt に渡す issue の書き方」に従う
- 根拠として **mutator 種別 + 行番号 + diff + そのとき実行されたテスト名**を引用する。実害と根拠を引用で示せる発見のみ起票する
- 専用テンプレートは作らない。実運用で型が足りないと分かったときに初めて形式化する

## 構成の注意（spike #346 の実測）

- `stryker.config.json` に `"ignorePatterns": ["tsconfig.json"]` を置く。core の tsconfig preprocessor が TS6 の compiler API を呼ぶ（[stryker-js#6111](https://github.com/stryker-mutator/stryker-js/issues/6111)）ため、typescript 7 単独構成では必須の回避策。Stryker が読む `tsconfig.json` は単一ファイル・`extends` / `references` 無しなので、この前処理を外しても失うものは無い（`extends` を持つ `tsconfig.build.json` は `prepack` 専用で Stryker は読まない）。**tsconfig に `extends` / `references` / paths 依存を入れる場合は回避策を再評価する**
- typescript-checker は不採用（Stryker の TS7 対応が本実装されたら再評価）。typescript@6 は併設しない
