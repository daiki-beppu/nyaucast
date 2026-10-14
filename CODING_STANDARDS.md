# Coding standards

Read during review and before merging, not during implementation. Mechanical rules live in the checks (`pnpm run check`); this file holds only the judgement calls. The reasons are in [ADR-0013](docs/adr/0013-failures-and-boundary-data.md) and [ADR-0014](docs/adr/0014-test-layers-and-structural-checks.md).

## Effect: what to wrap, what to fail, what to throw

Sort each function and each failure into one of three:

- **Plain function.** No failure, no waiting, no dependency: return the value and don't wrap it in `Effect`. A function that returns an `Effect` but can never actually fail, wait or need a service is a plain function in disguise (e.g. `toPostRecord` in `src/db/explainer-posts.ts`).
- **Typed failure.** Something from outside our code is broken, and the user can act on it: a config file the user edits, a file the user placed, a path passed as an argument, an SNS API response. Define it with `Schema.TaggedError` and return it through the failure channel with `Effect.fail`. Don't carry it in a `Result` or a plain `{ reason }` object.
- **Defect.** Our own code broke a promise it made to itself: an invariant that cannot hold, a store we manage that is corrupt. `throw`, `!` and `Effect.die` (or `orDie`) are all fine; don't add a typed failure for it.

Rules that follow from the split:

- Use `throw` only for defects. Seeing a `throw` must mean "this is a bug".
- Write an expected failure of our own code as `Effect.fail(TaggedError)` from the start. Wrap with `Effect.try` (or `Result.try`) only the exceptions an external library throws (e.g. `parse` of `fast-xml-parser`); don't `throw` an expected failure in a helper and convert it with `Effect.try` afterwards.

## Who owns the file

Whether an I/O failure is typed or a defect depends on who owns the file, i.e. who can fix it — not on the kind of error.

- **Outside files** — a config the user edits (`config/channel/video.json`, the bgm pool), material the user placed (song files), a path taken as an argument (`selectHumanImage` in `src/videos/thumbnail-selection.ts`): OS I/O failures such as `EACCES` or `EISDIR` are typed failures. Add one per file next to its existing failures, as `*Unreadable { path, reason }` (e.g. `ChannelConfigUnreadable`; precedent for a failure named after its file: `BgmSongUnreadable`), so the MCP response and the CLI line show the path and the reason.
- **Files nyaucast manages** — `local.db`, outputs written under the channel root (`src/videos/video-files.ts`, `src/thumbnails/thumbnail-files.ts`), staging, backups, creating the data directory: I/O failures are defects.
- Don't create a shared `FileUnreadable`, and don't put `PlatformError` in the failure channel; the tool's `failure` schema should name which file could not be read.
- Detect a missing file in one step, by catching the `NotFound` reason of `PlatformError` (`Effect.catchReason`). Don't check `exists` and then read: the `exists` call adds a third failure path of its own.
- `SqlError` from `local.db` is a defect.

## Data from outside and Schema

- Validate data from outside — the outside files above and responses from SNS and other APIs — with a Schema, and turn a mismatch into a typed failure. Data nyaucast manages (`local.db` rows, outputs, staging) is out of scope.
- For data that crosses a boundary (outside files, API responses, DB rows, and the domain types copied from them), the Schema is the source of truth for the type. Derive the type from the Schema; don't declare the same shape again as an `interface`. Write the mapping from a snake_case row to a camelCase domain type as a Schema transformation, not a hand-written mapping function.
- Function option bags and internal intermediate results may stay plain `interface`s.

## CLI failure messages

`describeFailure` turns a CLI failure into one line made of its tag and facts; `message` is never shown. Only for a failure where the user needs to be told what to do next, add a supplement in `cli.ts`.

## Deferred findings that depend on an external SDK

When a review defers a finding because it hinges on the behaviour of an external SDK or API (a limit, a retry, what an option counts), settle it before merging with the smallest real call that exercises it, and record the result in the PR. If a real call is impossible (authentication or cost, e.g. posting APIs), write in the PR that it could not be made and which range is left unverified.

## Tests

Unlike the rest of this file, read this section when you add a test, too.

- **Layers.** There are two. **unit** is `src/**/*.test.ts`; it may use temporary directories, SQLite (a temporary file or `:memory:`) and fake servers on localhost. **contract** is `test/**`; it checks the CLI, MCP and the package from outside.
- **Evidence gate.** Add a test only if you can show all five grounds takt requires. Source: takt's [`testing.md`](https://github.com/nrslib/takt/blob/main/builtins/en/facets/policies/testing.md) (not copied here).
- **Contracts, not structure.** Don't turn internal structure into a contract; same source as above. CLI output and protocol values are contracts and may be checked by exact match.
- **Smallest layer, no repeats.** Put each test in the smallest layer that holds its contract. Checking the same failure again in another layer is forbidden.
- **Waiting helpers.** A helper that waits for a condition stops at a real-time deadline and fails naming the condition it waited for. Polling a fixed number of times and then returning silently is forbidden. Under `TestClock`, `Effect.timeout` and `Effect.sleep` are measured on the stopped clock, so measure the deadline in real time.
- **Negative tests.** A test that asserts something does _not_ happen passes when nothing happens at all. Check first that it reaches the state it guards: removing the guarded line must turn it red.
- **Existing tests.** Follow takt: fix or remove the existing tests that touch the contract of this change and pin internal structure. Don't sweep unrelated tests.
