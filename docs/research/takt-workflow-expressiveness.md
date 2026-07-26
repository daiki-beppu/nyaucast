# takt workflow は collection lifecycle の実行要件を表現できるか

調査日: 2026-07-26 / 対象: **takt v0.52.0**（`~/.bun/install/global/node_modules/takt`、`takt --version` で確認 / MIT / 作者 nrslib）

調査方法: 配布物の zod schema・エンジン実装・builtin workflow・同梱スキーマリファレンス（一次情報）を読む。加えて tayk リポジトリ内に実在する `.takt/runs/` の実行成果物を実データとして参照した。以下、行番号はすべて上記インストール先の `dist/` および `builtins/` を指す。

## TL;DR

1. **人間 GO/NO-GO ゲートは表現できる。ただし「fail-closed な構文」と「fail-open な構文」が混在しており、選択を誤ると非対話時にゲートが黙って消える。** step レベルの `requires_user_input: true` は非対話時に `user_input_required` で **ABORT**（fail-closed / `WorkflowRunLoop.js:173-179`）。一方 rule レベルの `interactive_only: true` は非対話時に **その rule が評価候補から除外される**だけで、エンジンは別 rule を選んで**先へ進む**（fail-open / `rule-utils.js:159`）。builtin workflow は両者を同一 rule に併記する書き方をしており（`builtins/ja/workflows/draft.yaml:80-84`）、これをそのまま真似るとゲートにならない。
2. **charting 時の前提「遷移判定は LLM が行うので非決定的」は不正確だった。** takt v0.52.0 には `when(...)` という**エンジンが自前で評価する決定的条件**があり、決定的 rule は LLM の選択候補から除外され（`rule-utils.js:153-161`）、さらに LLM の判定結果を**先行して上書きする**（`rule-utils.js:129-149`）。決定的境界は「takt の外に出す」以外の選択肢がある。
3. **長時間の外部待ち（Suno 生成待ち等）を表現する専用プリミティブは存在しない。** wait / sleep / poll 系の step 種別も effect も無い。待ちは「agent step の中でツールを呼んで待つ」か「run を分割する」しかない。ただし run 自体は長時間保持できる（実データで **1 run = 4 時間 15 分**の実績あり）。
4. **MCP tool は step レベル `mcp_servers` で呼べる。ただし provider が `claude` / `claude-sdk` / `claude-terminal` のときだけで、それ以外（codex 等）では検証エラーにならず「黙って捨てられる」**（`provider-capabilities.js:2-6` + `engine-provider-options.js:9-13`）。tayk の既存 run は provider `codex` で回っている実績があるため、ここは実質的な地雷。
5. **resume の粒度は step 境界（+ subworkflow のコールスタック）。step の途中からは戻れない。** `takt resume` は「**最後の** failed / aborted な direct run」1 本だけが対象（`commands.js:82-84`）。
6. **コスト観測はトークン単位までは可能、金額換算は takt に無い。** `observability.usage_events_phase: true` で step / phase / persona / provider / model 別のトークン内訳が JSONL で出る（実ファイルで確認）。`run_id` で括れるので「1 collection = 1 run」に設計すれば 1 本あたりのトークンは測れる。金額は自前の単価表が必要。
7. **takt の非 AI 決定層は GitHub の PR / task ドメインに作り付けである。** `system` step が扱える入力は 9 種・effect は 6 種で、すべて issue / PR / task queue / worktree に関するもの（`workflow-system-schemas.js`）。collection lifecycle の題材（音源・サムネ・upload）に対応する非 AI プリミティブは**無い**ので、当該操作は必ず agent step 経由になる。

---

## 前提: 何が「workflow YAML の表現力」を決めているか

権威ソースは 3 つ。

| 対象 | ファイル |
| --- | --- |
| YAML の受理可能な形（zod schema） | `dist/core/models/workflow-schemas.js`（559 行）、`dist/core/models/workflow-system-schemas.js`（271 行）、`dist/core/models/mcp-schemas.js` |
| 実行時の意味 | `dist/core/workflow/engine/`（`WorkflowRunLoop.js` / `StepExecutor.js` / `OptionsBuilder.js`）、`dist/core/workflow/evaluation/`（`RuleEvaluator.js` / `rule-utils.js` / `when-evaluator.js`） |
| 仕様書（同梱・日本語） | `builtins/skill/references/yaml-schema.md`（278 行）、`builtins/skill/references/engine.md` |

step の種別は `agent` / `system` / `workflow_call` の 3 つで、これに `parallel` / `arpeggio` / `team_leader` が加わる（`dist/core/workflow/step-kind.js:6-12`）。以降の可否はこの分類に強く依存する。

---

## 問い 1: 人間 GO/NO-GO ゲート → **表現できる。ただし構文の選択が安全性を決める**

### 判明した 3 つの構文と、その非対話時の挙動

| 構文 | 置き場所 | 非対話時（`interactive !== true`）の挙動 | 性質 |
| --- | --- | --- | --- |
| `requires_user_input: true` | **step**（agent step 限定） | `user_input_required` で **workflow を ABORT** | **fail-closed** |
| `requires_user_input: true` | **rule**（遷移） | `onUserInput` ハンドラが無ければ ABORT | fail-closed |
| `interactive_only: true` | **rule**（遷移） | **その rule を評価候補から除外し、他の rule で先へ進む** | **fail-open** |

#### 根拠 1: step レベルは agent step 限定で、非対話なら abort

schema 側で agent step 以外は `z.never()`（`workflow-schemas.js:237` = workflow_call、`:278` = system）。バリデーションも明示的:

```js
// dist/core/models/workflow-schemas.js:403-414
if (data.requires_user_input !== undefined && stepKind !== 'agent') {
    ...message: 'requires_user_input is only supported on agent steps',
}
if (data.requires_user_input !== undefined && data.parallel !== undefined) {
    ...message: 'requires_user_input is not supported on parallel parent steps',
}
```

実行時:

```js
// dist/core/workflow/engine/WorkflowRunLoop.js:173-179
function validateUserInputRuntime(deps, step) {
    if (step.requiresUserInput !== true) return undefined;
    if (deps.options.interactive !== true) {
        return abortWorkflow(deps, 'user_input_required',
            `Step "${step.name}" requires interactive user input but workflow interactive mode is disabled`);
    }
```

→ **非対話で走らせたら止まる**。ゲート 1（企画後）/ ゲート 2（サムネ後）を「人間が居ないなら絶対に先へ進めない」形で表現したいなら、これが唯一の fail-closed 構文。

#### 根拠 2: rule レベルの `interactive_only` は非対話時に消える

```js
// dist/core/workflow/evaluation/rule-utils.js:153-161
/**
 * 判定（Phase 3 / タグ / 構造化）でモデルが選択してよいルールか。
 * interactiveOnly の対話外ルールと、エンジンが実状態から評価する
 * 決定的条件（when(...)）は選択対象にしない。
 */
export function isJudgeableRule(rule, interactive) {
  if (rule === undefined) return false;
  if (rule.interactiveOnly && !interactive) return false;
  return !isDeterministicCondition(rule.condition);
}
```

同じ除外が `RuleEvaluator.js:124, 148, 167, 194, 232` と `rule-utils.js:112` にも入っている。**エラーにも警告にもならず、単に選ばれなくなる。**

#### 根拠 3: builtin はこの 2 つを併記している（＝真似ると危険）

```yaml
# builtins/ja/workflows/draft.yaml:79-84
- condition: ユーザー入力が必要
  next: implement
  requires_user_input: true
  interactive_only: true
```

この rule は「LLM が『ユーザー入力が必要』と判定したら人間に聞く」という**任意の**分岐であって、必ず通る関門ではない。対話時は聞く / 非対話時は rule ごと消える、という設計。**GO/NO-GO ゲートの雛形として転用してはいけない。**

### 非対話モードの入り口

- `--pipeline`: `Pipeline mode: non-interactive, no worktree, direct branch creation`（`dist/app/cli/program.js:44`）
- `-q, --quiet`: `Minimal output mode: suppress AI output (for CI)`（同 `:46`）— これは**出力抑制であって対話性の切り替えではない**
- `interactive` の既定値は **false**（`dist/features/tasks/execute/workflowExecutionBootstrap.js:39`）。true になるのは対話選択モード（`dist/app/cli/routing.js:214`）と exec モード（`dist/features/exec/workflowRunner.js:87`）のみ

### 付随して判明: AskUserQuestion は workflow 実行中は既定で禁止

```js
// dist/core/workflow/ask-user-question-error.js
const DENY_MESSAGE =
  "AskUserQuestion is not available in non-interactive mode. Present your questions directly as text output and wait for the user to respond.";
```

`workflowExecution.js:150` で `onAskUserQuestion: options.onAskUserQuestion ?? createDenyAskUserQuestionHandler()` が既定。つまり **agent step の中から Claude の AskUserQuestion で人間に聞く経路は塞がれている**（拒否され、AI は「自力で進め」と促される）。人間への問い合わせは takt の `requires_user_input` 機構を通すしかない。

---

## 問い 2: 長時間の外部待ち → **専用プリミティブは無い。run 自体は長時間保持できる**

### できないこと: wait / poll の宣言的表現

`workflow-schemas.js` / `workflow-system-schemas.js` を通して、`wait` / `sleep` / `poll_until` / `wait_for` 相当の step 種別・effect・条件は**存在しない**（grep で 0 件）。effect の全種は以下 6 つのみ（`workflow-system-schemas.js:104-160`）:

`enqueue_task` / `comment_pr` / `sync_with_root` / `resolve_conflicts_with_ai` / `merge_pr` / `close_pr`

system step の入力（`system_inputs`）も全 9 種がすべて GitHub / task queue ドメイン（`workflow-system-schemas.js:24-58`）:

`task_context` / `branch_context` / `pr_context` / `issue_context` / `task_queue_context` / `pr_list` / `issue_list` / `pr_selection` / `issue_selection`

→ **「Suno の生成完了をポーリングする」を非 AI の宣言で書く手段は無い。** agent step の中で tayk の MCP tool を呼び、その tool の内部で待つ / ポーリングするしかない。

### できること: run を長時間保持する

tayk リポジトリに実在する run の実データ（`.takt/runs/20260724-131055-tayk-takt-github-issue-wo/meta.json`）:

```json
"startTime": "2026-07-24T13:10:55.120Z",
"endTime": "2026-07-24T17:26:42.437Z",
"iterations": 51,
"resume_point": { "version": 1, "stack": [...], "iteration": 51, "elapsed_ms": 15347099 }
```

**1 run = 4 時間 15 分・51 iteration** が実績として残っている。分〜時間単位の待ちを含む run が原理的に不可能ということはない。

### 迂回路: command gate（step 完了後にシェルを実行できる唯一の宣言的経路）

```yaml
quality_gates:
  - type: command
    name: quality-check
    command: "./.takt/quality-gates/check.sh"
    cwd: "."
    timeout_ms: 300000
```

exit code 0 のみ成功。失敗時は stdout/stderr（サニタイズ・上限付き）が**同じ step の差し戻し入力**に入る（`builtins/skill/references/yaml-schema.md:224-238`）。有効化には project config の `workflow_command_gates.custom_scripts: true` が必要（`dist/infra/config/env/project-current-env-specs.js:35-36`）。**agent step 専用**で `system` / `workflow_call` step では使えない。

これは「待ち」ではなく「step 完了時の機械的検査」だが、**LLM を通さずに決定的な検査を差し込める唯一の宣言的フック**である点は問い 1・問い 3 にも効く。

### 未確認

- run のプロセスを跨いだ待機（プロセスを落として後で再開する形）の実挙動。`takt resume` は「最後の failed / aborted な run」しか対象にしないため、**正常終了させた run を後から続きから再開する経路は確認できていない**（問い 3 参照）
- provider 側（Claude / Codex）の 1 回の呼び出しあたりのタイムアウト上限。takt 側の step 実行に明示的な timeout 設定は見つからなかった（`StepExecutor.js` に `'timeout'` の文字列が 1 箇所あるのみ、`:189`）

---

## 問い 3: resume / 中断復帰 → **step 境界まで。run 単位・最新 1 本のみ**

### 粒度: step 境界 + subworkflow コールスタック

`meta.json` の `resume_point`（実データ）:

```json
"currentStep": "_loop_judge_ai-antipattern-review-1st_ai-antipattern-fix",
"currentIteration": 51,
"phase": 3,
"resume_point": {
  "version": 1,
  "stack": [ { "workflow": "takt-default", "step": "peer-review", "kind": "workflow_call" } ],
  "iteration": 51,
  "elapsed_ms": 15347099
}
```

再開位置は `resumePoint.stack[0].step`（`dist/features/tasks/resume/index.js:79-80`）、無ければ `meta.currentStep` にフォールバック（`:200`）。`stack` は subworkflow のネストを保持し、解決できるプレフィックスまで遡る（`dist/core/workflow/run/resume-point.js:44-59`）。

→ **step の途中（phase 2 の最中など）からは戻れない。再開すると当該 step は頭から再実行される。**

### 対象: 最新の failed / aborted な direct run 1 本

```js
// dist/app/cli/commands.js:82-84
.command('resume')
.description('Resume the latest failed or aborted direct run')
```

引数を取らない。**run を指定して選ぶことはできない。**

### 状態ファイルの配置（tayk リポジトリの実物）

| パス | 中身 |
| --- | --- |
| `.takt/runs/<slug>/meta.json` | run のメタ + `currentStep` / `currentIteration` / `phase` / `resume_point` |
| `.takt/runs/<slug>/reports/` | output_contracts の成果物。上書き時は `<name>.<ISO8601>` で世代保存される |
| `.takt/runs/<slug>/context/` | `previous_responses` / `knowledge` / `policy` / `subworkflows` |
| `.takt/runs/<slug>/logs/*.jsonl` | セッションログ・usage events・OTel shadow |
| `.takt/runs/<slug>/monitor.json` | OTel メトリクス（`takt.workflow.phase.runs` 等） |
| `.takt/runs/<slug>/trace.md` | 人間可読トレース |
| `.takt/session-state.json` | **グローバルに 1 つ。直近 run の結果のみ**（`status` / `errorMessage` / `timestamp` / `workflowName` / `taskContent`） |
| `.takt/persona_sessions.json` | persona 別の provider セッション。`takt clear` で消える |

`.takt/.gitignore` は `*` を無視し `!config.yaml` と `!.gitignore` だけを追跡する（＝**run 状態は git 管理外**）。

→ **takt の run 状態は「ローカルの作業状態」であり、tayk の local store（libSQL）が持つべき collection の状態とは層が違う。** 二重化の解消方針は #61 の判断材料。

---

## 問い 4: MCP tool の呼び出し → **step レベル `mcp_servers` で可能。ただし provider 依存で黙って落ちる**

### できること

step（および parallel サブ step）に `mcp_servers` を書ける（`workflow-schemas.js:229` / `:339`）。形式は MCP 標準の 3 トランスポート（`dist/core/models/mcp-schemas.js`）:

```js
McpStdioServerSchema: { type?: 'stdio', command, args?, env? }
McpSseServerSchema:   { type: 'sse',  url, headers? }
McpHttpServerSchema:  { type: 'http', url, headers? }
// McpServersSchema = Record<serverName, 上記の union>
```

claude provider では一時的な MCP config ファイルを書き出して SDK に渡す（`dist/infra/claude/mcp-config.js:5-13`、`dist/infra/claude/options-builder.js:62-63`）。

### 致命的な制約: 対応 provider は Claude 系のみ、非対応時は無言で破棄

```js
// dist/infra/providers/provider-capabilities.js:2-6
const MCP_SERVER_PROVIDERS = new Set([
  "claude",
  "claude-sdk",
  "claude-terminal",
]);
```

```js
// dist/core/workflow/engine/engine-provider-options.js:9-13
// Silent-drop: workflows may carry options for providers they aren't currently
// running under. Keep the value only when capability is confirmed true.
function keepWhenProviderSupports(value, provider, probe) {
  return probe(provider) === true ? value : undefined;
}
```

→ **codex / cursor / copilot / opencode で走らせると `mcp_servers` は検証エラーにもならず消える。** tayk の既存 run は provider `codex`（model `gpt-5.6-sol`）で回っている実績がある（`.takt/runs/*/logs/*usage-events.phase.jsonl`）ため、「tayk MCP tool を呼ぶ step だけ provider を Claude 系に固定する」という制約が実質的に生じる。step レベルで `provider` は指定できる（`workflow-schemas.js:230`）。

### その他の制約

- **`system` step では `mcp_servers` を指定できない**（禁止フィールド一覧に含まれる。`workflow-system-schemas.js:170-205`）。非 AI step から MCP tool は呼べない
- `allowed_tools` は**権限制御ではない**。Skill 経由実行では「ホスト側の設定に従う参考情報」であり、権限は `edit` フィールドで制御する（`builtins/skill/references/yaml-schema.md:276-278`）
- `takt-mcp`（`package.json` の bin）は **takt 自身を MCP server として公開する逆向きの機能**であり、この問いとは無関係（チケット記載の通り）

---

## 問い 5: 観測（コスト）→ **トークンは測れる。金額換算は takt に無い**

### 有効化

`observability.usage_events_phase`（boolean、project / global config どちらでも可。既定 **false**）。`dist/infra/config/observabilityConfig.js:5, 15, 41-43`、env 経由の指定は `dist/infra/config/env/project-current-env-specs.js:29`。

### 出力（tayk の実ファイルから）

`.takt/runs/<slug>/logs/<session>-usage-events.phase.jsonl` の 1 行:

```json
{
  "run_id": "20260724-131055-tayk-takt-github-issue-wo",
  "session_id": "20260724-221055-f1m4za",
  "provider": "codex",
  "provider_model": "gpt-5.6-sol",
  "step": "plan",
  "step_type": "agent",
  "persona": "planner",
  "tags": ["plan"],
  "phase": "phase1_execute",
  "phase_name": "execute",
  "phase_execution_id": "plan:1:1:1",
  "timestamp": "2026-07-24T13:17:10.524Z",
  "success": true,
  "usage_missing": false,
  "usage": {
    "input_tokens": 2708136,
    "output_tokens": 15197,
    "total_tokens": 2723333,
    "cached_input_tokens": 2499840
  }
}
```

実ログ全体のキー集合: `run_id` / `session_id` / `provider` / `provider_model` / `step` / `step_type` / `persona` / `tags` / `phase` / `phase_name` / `phase_execution_id` / `timestamp` / `success` / `usage_missing` / `usage` / `judge_method` / `judge_stage` / `reason`。

→ **step 別・phase 別・persona 別・provider/model 別のトークン内訳が取れる。`run_id` で括れる。**

### 測れないこと

- **金額**。`cost` / `price` / `usd` に相当するフィールドもモジュールも存在しない（`dist/features/analytics/` は events / metrics / purge / report-parser / writer のみ）。単価表は自前で持つ必要がある
- `usage_missing: true` の行が発生しうる（provider がトークン数を返さない場合）。取りこぼしの割合は未計測
- 「1 collection あたり」の粒度は **1 collection = 1 run** に設計して初めて成立する。1 run に複数 collection を詰めると `run_id` では分離できない（`step` / `phase_execution_id` で按分することになる）

---

## 追加の重要発見: `when(...)` — エンジンが自前で評価する決定的条件

charting 時の前提（地図 Notes:「`rules` は `condition:` の自然言語条件を persona が判定して次 step を選ぶ。遷移表は宣言的だが判定は非決定的」）は **v0.52.0 では不正確**。

### 何ができるか

```js
// dist/core/workflow/evaluation/when-evaluator.js:166-168
export function evaluateWhenExpression(expression, state) {
  return splitTopLevel(expression, "||").some((orPart) =>
    splitTopLevel(orPart, "&&").every((andPart) =>
      evaluateClause(andPart, state)
    )
  );
}
```

- 演算子: `==` `!=` `>` `<` `>=` `<=`（`:10`）、`&&` / `||`、および `exists(list, predicate)`（`:100-125`。predicate は `==` と `&&` のみ）
- オペランドの名前空間: **`context.` / `structured.` / `effect.` / `findings.`**（`:89-94`）。それ以外は `Unsupported when operand` で **throw**（`:98`）
- 不正な式は黙殺せず即座に失敗する（`:5-7` のコメント）

### 決定的条件が LLM に対して持つ優先権

1. **LLM の選択候補から除外される** — `isJudgeableRule` が決定的条件を弾く（`rule-utils.js:153-161`）
2. **LLM の判定を先行して上書きする** — `resolvePhase3Adoption` は、LLM が選んだ rule より**前**にある決定的 rule が成立していればそちらを採用する（`rule-utils.js:129-149`）。さらに LLM が決定的 rule を指してきた場合は真偽を問わず不採用にする

```js
// dist/core/workflow/evaluation/rule-utils.js:135-140
const preemptIndex = findImmediateDeterministicMatch(
  rules,
  state,
  interactive,
  0,
  phase3Result.ruleIndex
);
if (preemptIndex !== -1) {
  result = { ...result, ruleIndex: preemptIndex, method: "auto_select" };
}
```

### データの供給元: `structured_output`

step に `structured_output: { schema_ref: <name> }` を付けると、JSON Schema に沿った構造化出力を要求できる（`workflow-system-schemas.js:5-7`、解決は `dist/infra/config/loaders/workflowStructuredOutputResolver.js:13-36`）。同梱例は `builtins/schemas/*.json`（`judgment.json` / `evaluation.json` / `decomposition.json` / `followup-task.json` / `more-parts.json` / `pr-followup-task.json`）。

→ **「AI に構造化された事実を出させ、遷移判定はエンジンが `when()` で決定的に行う」という書き方が takt 内で成立する。** ただし `structured_output` は provider の `supportsStructuredOutput` に依存する（`provider-capabilities.js:36`）。

なお LLM 判定側のスキーマは `builtins/schemas/judgment.json` = `{ step: integer（1-based の rule 番号）, reason: string }`。

---

## 総括表

| 要件 | 可否 | 条件 / 注意 |
| --- | --- | --- |
| 人間 GO/NO-GO ゲート（fail-closed） | **できる** | step レベル `requires_user_input: true`（agent step 限定）。非対話なら ABORT |
| 人間 GO/NO-GO ゲート（rule で分岐） | **条件付き** | `interactive_only: true` は非対話で**消える**。ゲートには使えない |
| 非対話実行（`--pipeline`） | できる | `interactive` 既定 false。`-q` は出力抑制のみで別物 |
| agent step から人間に質問 | **できない** | AskUserQuestion は既定で拒否される |
| 長時間の外部待ちの宣言的表現 | **できない** | wait / poll プリミティブ無し。agent step + MCP tool 内で待つ |
| 長時間 run の保持 | できる | 実績 4h15m / 51 iteration |
| step 完了後の機械的検査 | できる | `quality_gates` の command gate。要 `workflow_command_gates.custom_scripts: true`。agent step 専用 |
| resume（step 境界から） | できる | `resume_point.stack` で subworkflow も復元 |
| resume（step の途中から） | **できない** | 当該 step は頭から再実行 |
| resume する run の選択 | **できない** | 「最後の failed / aborted な direct run」固定 |
| step から MCP tool を呼ぶ | **条件付き** | provider が `claude` / `claude-sdk` / `claude-terminal` のときのみ。他は**無言で破棄** |
| system step から MCP tool を呼ぶ | **できない** | `mcp_servers` は system step の禁止フィールド |
| 遷移の決定的判定 | **できる**（前提の訂正） | `when(...)` + `structured_output`。決定的 rule は LLM 判定に優先する |
| 非 AI の副作用（音源生成・upload 等） | **できない** | effect は GitHub PR / task ドメインの 6 種のみ |
| collection 1 本あたりのトークン計測 | できる | `usage_events_phase: true`。1 collection = 1 run 設計が前提 |
| collection 1 本あたりの金額計測 | **できない**（takt 単体では） | 金額フィールド無し。自前の単価表が必要 |

---

## 未確認事項

1. **provider 側のタイムアウト上限** — takt 側に step 単位の timeout 設定は見当たらないが、Claude / Codex の 1 回の呼び出しあたりの上限は未確認。数十分の待ちを agent step 内で行えるかはここで決まる
2. **正常終了した run の継続再開** — `takt resume` は failed / aborted 限定。「ゲートで人間の判断待ちのために一旦正常終了し、後で続きから」という運用が組めるかは未検証（`enqueue_task` effect で次の run を積む形なら可能に見えるが、GitHub task queue 前提の作りなので tayk の題材に流用できるかは別途確認が必要）
3. **`usage_missing: true` の発生率** — provider ごとの取りこあしの実測なし
4. **`when()` の `context.` / `structured.` / `effect.` / `findings.` に実際に何が入るか** — 名前空間は確認したが、`resolveWorkflowStateReference`（`dist/core/workflow/state/workflow-state-access.js`）の中身までは追っていない。決定的条件で参照できる事実の実際の範囲は #60 で要確認
5. **subworkflow（`workflow_call`）の params 受け渡しの詳細** — 存在は確認したが本調査の 5 論点に直接関わらないため未展開

---

## 他チケットへの申し送り（判断はしない）

- **#60 決定的境界の確定** — 前提が変わる。「LLM 判定しかない」ではなく「`when()` の決定的条件 / command gate / LLM 判定」の 3 層から選べる。ただし `when()` が参照できる事実の実際の範囲（未確認 4）を先に確定する必要がある
- **#61 状態の SSOT** — takt の run 状態（`.takt/runs/`）は git 管理外のローカル作業状態で、`.takt/session-state.json` はグローバルに 1 つしか無い。collection の状態を載せる器としては設計されていない
- **#62 誤公開ガード** — `interactive_only` は fail-open なのでガードに使えない。fail-closed な選択肢は ① step レベル `requires_user_input`（人間が居なければ止まる）② command gate（機械的検査で exit != 0 なら差し戻し）③ `when()` による決定的遷移、の 3 つ
- **#64 置き場所と配布経路** — `mcp_servers` の provider 依存（Claude 系のみ・無言破棄）と、`quality_gates` の command gate が project config `workflow_command_gates.custom_scripts: true` を要求する点が、配布物の構成に効く
- **#65 適用範囲** — 「非 AI の副作用は表現できない」ため、collection lifecycle の実処理は結局 tayk の MCP tool 側に残る。takt に寄せられるのは**オーケストレーションと知識**であって実行そのものではない
