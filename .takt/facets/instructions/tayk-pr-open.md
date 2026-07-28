実装が完了したブランチを commit・push し、**レビュー可能な PR** として着地させてください。

## 手順

1. push 先を確保する。**takt の実行クローンには remote が無い**（takt が隔離のため `origin` を除去する）。
   `git remote get-url origin` が失敗したら、先に remote を追加する:
   `git remote add origin git@github.com:daiki-beppu/tayk.git`
   これ以降の step（CI 確認・レビュー対応・finalize・spillover）は同じクローンで動くため、ここで追加すれば以後の `gh` はリポジトリを推定できる
2. `git status --porcelain` と `git diff --stat` で変更内容を確認する
3. 変更を stage して commit する。**commit 規約は絶対**:
   - 日本語 Conventional Commits（`feat:` / `fix:` / `docs:` / `chore:` / `refactor:` / `test:`）
   - タイトル末尾に linked issue 番号 `(#<N>)`
   - 例: `feat: collection.plan の benchmark 収集を実装する (#55)`
   - 変更が複数の関心事にまたがるなら、関心事ごとに commit を分ける
4. `git push -u origin HEAD` で push する
5. 既に PR が存在するか確認する: `gh pr view --json number,state,url`
   - **存在する**: 既存 PR を再利用する。本文を最新の状態へ更新する（新しい PR を作らない）
   - **存在しない**: `gh pr create` で作成する
6. PR 本文には以下を必ず含める:
   - `Closes #<N>`（linked issue。wayfinder ticket 起点なら ticket 番号、map 起点なら map 番号）
   - 要件 ID ごとの充足状況 — 要件 ID は**テストコードに埋め込まれている**。`rg 'REQ-\d+-\d+' -n` で一覧を取り、各 ID について「それを検証しているテスト」と「対応する差分の場所」を示す
   - テスト実行結果（実際に走らせたコマンドと結果）
   - ADR 整合性の結論（差分が ADR の決定に触れるか。逸脱があれば ADR 改訂の有無）
7. PR 番号と URL を報告する

**`plan.md` / `diagnosis.md` をファイルとして探さないでください。** この step は callable sub-workflow（`tayk-delivery`）の中で動くため、親の Report Directory は見えません。要件の担体はテストコードです（ADR-0008 決定 13）。

スコープ外発見の起票結果は、この step の後に走る `spillover` が PR 本文へ追記します。ここでは扱いません。

## 制約

- **main へ直接 push しない。** push 先は現在の作業ブランチのみ
- force push / `git reset --hard` / ブランチ削除を行わない
- PR をマージしない（マージは人間の判断）
- draft の要否はリポジトリ設定に従う。明示の指示がなければ通常 PR で作成する
- commit されていない変更を残したまま次へ進まない
- 生成物・一時ファイル（`.takt/runs/` 配下のレポート等）を commit に含めない。`git status` で意図しないファイルが混ざっていないか確認する

## 判定

- commit・push・PR 作成（または既存 PR の更新）が完了した → CI 確認へ
- push が拒否された（保護ブランチ・権限不足）→ 原因を報告して ABORT
