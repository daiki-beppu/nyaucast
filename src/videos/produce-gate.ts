import { Effect, Schema } from "effect";

import { getExplainerGateDecision } from "../db/gates.ts";

export class ProduceGateNotApproved extends Schema.TaggedError<ProduceGateNotApproved>()(
  "ProduceGateNotApproved",
  { videoId: Schema.String },
) {}

/** produce 区間の tool の事前条件。企画ゲートの最新の判定が承認でなければ、型付きの失敗にする。 */
export const requireProduceApproval = (videoId: string) =>
  Effect.gen(function* () {
    if ((yield* getExplainerGateDecision(videoId, "produce")) !== "approved") {
      return yield* new ProduceGateNotApproved({ videoId });
    }
  });
