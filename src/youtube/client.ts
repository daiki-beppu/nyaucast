import { z } from "zod";

import type { YouTubeAuth } from "./auth.ts";

// fallow-ignore-next-line code-duplication -- Retry limits are unrelated to process timeout constants.
const maximumAttempts = 3;
const initialRetryDelayMilliseconds = 1_000;
const retryableStatuses = new Set([429, 503]);
const youtubeApiOrigin = "https://youtube.googleapis.com";
const youtubeUploadApiOrigin = "https://www.googleapis.com";
const youtubeUploadApiPath = "/upload/youtube/v3/videos";

// fallow-ignore-next-line code-duplication -- Google API error validation is unrelated to tool input schemas.
const googleErrorSchema = z.object({
  error: z.object({
    errors: z.array(z.object({ reason: z.string() })),
  }),
});

type YouTubeClientDependencies = {
  auth: Pick<YouTubeAuth, "getAccessToken" | "refreshAccessToken">;
  // fallow-ignore-next-line code-duplication -- HTTP dependencies and process waiters only share method-signature syntax.
  fetch(input: string, init?: RequestInit): Promise<Response>;
  random(): number;
  sleep(milliseconds: number): Promise<void>;
};

type YouTubeRequest<Output> = {
  body?: () => BodyInit;
  channel: string;
  init?: Omit<RequestInit, "body">;
  schema: z.ZodType<Output>;
  url: string;
};

export type YouTubeClient = {
  request<Output>(request: YouTubeRequest<Output>): Promise<Output>;
};

type HttpFailure = {
  reason: string | undefined;
  status: number;
};

type RequestState = {
  // fallow-ignore-next-line code-duplication -- Retry state and credential types only share short property declarations.
  accessToken: string;
  refreshedAfterUnauthorized: boolean;
  retryAttempt: number;
};

type Recovery = { kind: "fail" } | { kind: "refresh" } | { delay: number; kind: "retry" };

const classifyHttpFailure = async (response: Response) => {
  // fallow-ignore-next-line code-duplication -- Google error decoding is unrelated to generic JSON-RPC routing.
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  const parsed = googleErrorSchema.safeParse(body);
  return {
    reason: parsed.success ? parsed.data.error.errors[0]?.reason : undefined,
    status: response.status,
  };
};

const httpError = (failure: HttpFailure): Error => {
  const reason = failure.reason === undefined ? "" : ` (${failure.reason})`;
  return new Error(`YouTube API request failed: HTTP ${failure.status}${reason}`);
};

const isRetryableFailure = (failure: HttpFailure) =>
  retryableStatuses.has(failure.status) ||
  (failure.status === 403 && failure.reason === "quotaExceeded");

const selectRecovery = (failure: HttpFailure, state: RequestState, random: number): Recovery => {
  // fallow-ignore-next-line code-duplication -- HTTP recovery selection is unrelated to collection-store waiter routing.
  if (failure.status === 401 && !state.refreshedAfterUnauthorized) return { kind: "refresh" };
  if (!isRetryableFailure(failure)) return { kind: "fail" };
  if (state.retryAttempt >= maximumAttempts - 1) return { kind: "fail" };
  const delay = initialRetryDelayMilliseconds * 2 ** state.retryAttempt * (1 + random);
  // fallow-ignore-next-line code-duplication -- Returning retry recovery is unrelated to returning a classified HTTP failure.
  return { delay, kind: "retry" };
};

// fallow-ignore-next-line code-duplication -- URL trust validation is unrelated to HTTP failure projection.
const resolveYouTubeApiUrl = (input: string): string => {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(
      `YouTube API request URL must use ${youtubeApiOrigin} or ${youtubeUploadApiOrigin}${youtubeUploadApiPath}`,
    );
  }
  // fallow-ignore-next-line code-duplication -- Origin validation and JSON-RPC object validation have different trust boundaries.
  const isYouTubeApi = url.origin === youtubeApiOrigin;
  const isYouTubeUploadApi =
    url.origin === youtubeUploadApiOrigin && url.pathname === youtubeUploadApiPath;
  if (!isYouTubeApi && !isYouTubeUploadApi) {
    throw new Error(
      `YouTube API request URL must use ${youtubeApiOrigin} or ${youtubeUploadApiOrigin}${youtubeUploadApiPath}`,
    );
  }
  return url.toString();
};

class RestYouTubeClient implements YouTubeClient {
  readonly #dependencies: YouTubeClientDependencies;

  constructor(dependencies: YouTubeClientDependencies) {
    // fallow-ignore-next-line code-duplication -- The client and auth services only share constructor syntax, not a domain abstraction.
    this.#dependencies = dependencies;
  }

  async request<Output>(request: YouTubeRequest<Output>): Promise<Output> {
    const url = resolveYouTubeApiUrl(request.url);
    const accessToken = await this.#dependencies.auth.getAccessToken(request.channel);
    return this.#execute(request, url, {
      accessToken,
      refreshedAfterUnauthorized: false,
      retryAttempt: 0,
    });
  }

  // fallow-ignore-next-line code-duplication -- Retry execution and repository queries only share an async method signature.
  async #execute<Output>(
    request: YouTubeRequest<Output>,
    url: string,
    state: RequestState,
  ): Promise<Output> {
    const response = await this.#fetch(request, url, state.accessToken);
    if (response.ok) return request.schema.parse(await response.json());

    const failure = await classifyHttpFailure(response);
    const recovery = selectRecovery(failure, state, this.#dependencies.random());
    if (recovery.kind === "fail") throw httpError(failure);
    if (recovery.kind === "refresh") {
      // fallow-ignore-next-line code-duplication -- Unauthorized recovery and backoff update distinct state fields.
      const accessToken = await this.#dependencies.auth.refreshAccessToken(request.channel);
      return this.#execute(request, url, {
        ...state,
        accessToken,
        refreshedAfterUnauthorized: true,
      });
    }
    await this.#dependencies.sleep(recovery.delay);
    return this.#execute(request, url, { ...state, retryAttempt: state.retryAttempt + 1 });
  }

  async #fetch<Output>(
    request: YouTubeRequest<Output>,
    url: string,
    accessToken: string,
  ): Promise<Response> {
    // fallow-ignore-next-line code-duplication -- Authorization header assembly is specific to the REST boundary.
    const headers = new Headers(request.init?.headers);
    headers.set("authorization", `Bearer ${accessToken}`);
    const init: RequestInit = { ...request.init, headers };
    if (request.body !== undefined) init.body = request.body();
    try {
      return await this.#dependencies.fetch(url, init);
    } catch {
      throw new Error("YouTube API request failed at the HTTP boundary");
    }
  }
}

export const createYouTubeClient = (dependencies: YouTubeClientDependencies): YouTubeClient =>
  new RestYouTubeClient(dependencies);
