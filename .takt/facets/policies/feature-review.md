# Feature review policy

feature workflow の設計レビューと Standards/Spec review は、根拠を requirements.md、AGENTS.md、CONTEXT.md、関連 ADR、実コードに限定する。

- 設計承認前に tests または implement へ進めない。
- 不合格時は finding、根拠、具体的な修正または追加調査を report に残す。
- 要件未達、規約違反、過剰な変更、未解消依存があれば承認しない。
- 判断不能な場合は推測で承認せず、ABORT または requirements へ差し戻す。
