/** 解説動画の最終の音声トラック（48 kHz・2ch の WAV）の相対キー。ミックスが書き、render が読む。 */
export const audioTrackKey = (videoId: string) => `videos/${videoId}/audio/track.wav`;
