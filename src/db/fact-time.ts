// 新しい事実の時刻は、直前の事実より必ず後にする（同時刻・時計が戻った場合は +1ms）。
export const afterLatestFact = (now: number, latestTimestamp: string | undefined): number =>
  latestTimestamp === undefined || new Date(now).toISOString() > latestTimestamp
    ? now
    : Date.parse(latestTimestamp) + 1;
