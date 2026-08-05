ABORT 前の回収 manifest を作成してください。ソース、設定、Git index、Git history は変更しません。

次の read-only command を実行し、結果を report に記録してください。

- `git rev-parse --show-toplevel`
- `git rev-parse HEAD`
- `git status --short`
- `git diff --stat`
- `git diff --name-only`
- `git diff --cached --stat`
- `git diff --cached --name-only`

作業ツリーの絶対パス、HEAD、staged / unstaged / untracked の各ファイルを区別し、未コミット成果物が残っていることを確認します。差分が無い場合も、その観測を明記します。

回収手順には、記録した worktree へ移動して `git status --short` と `git diff` を確認する手順を必ず含めます。`git reset`、`git clean`、checkout の破棄、commit、push は実行も提案もしません。ABORT 後に自動 cleanup されると主張してはいけません。
