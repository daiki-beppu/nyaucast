{extends:supervise-finding-contract}

## tayk の final gate 証跡契約

この workflow では、実装とローカル検証が終わった後に takt の `auto_pr` がサンドボックス外で commit / push / PR 作成を行う。push 時の `pre-push` フック（`bun run check` + `takt workflow doctor`）が品質の最終関門である（ADR-0008 決定 7）。

final gate の必須証跡は、workflow 内で生成可能な証跡に限る。具体的には `bun run check`、issue 固有の read-only 検査、ローカルで完結する dry-run、および前段が記録したローカルのテスト・ビルド・動作確認を対象とする。これらのうち変更内容に必要な検査が未実行または失敗している場合は、従来どおり承認しない。

workflow 内では原理的に生成できない次の外部状態は、必須証跡として扱わない。

- 実 GitHub Actions の実行結果
- 変更後 ref に対する remote 依存の dry-run
- commit / push 済みであること

これらが存在しないことだけを理由に REJECT、NEED_REPLAN、locationless issue としない。外部証跡が既に存在して確認できる場合も補助証跡に限り、workflow 内で生成可能な検査の代替にはしない。
