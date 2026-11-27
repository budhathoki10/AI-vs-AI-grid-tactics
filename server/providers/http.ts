import { ProviderError } from "./types";

const MAX_ERROR_DETAIL = 240;

/** POST JSON and map transport failures to ProviderErrors. Aborts propagate unchanged so the caller can tell timeouts from cancellations. */
export async function postJson(url: string, body: unknown, headers: Record<string, string>, signal: AbortSignal, label: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body), signal });
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw new ProviderError(`Could not reach ${label}: ${(error as Error).message}`, true);
  }
  const text = await response.text().catch(() => "");
  if (!response.ok) throw httpError(label, response.status, text);
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError(`${label} returned a non-JSON response`, true);
  }
}

export function httpError(label: string, status: number, bodyText: string): ProviderError {
  let detail = bodyText;
  try {
    const parsed = JSON.parse(bodyText) as { error?: { message?: string } | string; message?: string };
    detail = (typeof parsed.error === "string" ? parsed.error : parsed.error?.message) ?? parsed.message ?? bodyText;
  } catch {
    /* plain text body */
  }
  detail = detail.replace(/\s+/g, " ").trim().slice(0, MAX_ERROR_DETAIL) || "no details";
  if (status === 401 || status === 403) return new ProviderError(`${label} rejected the API key (${status}): ${detail}`, false);
  if (status === 404) return new ProviderError(`${label} does not know this model (404): ${detail}`, false);
  if (status === 429) return new ProviderError(`${label} rate limit (429): ${detail}`, true);
  if (status >= 500) return new ProviderError(`${label} server error (${status}): ${detail}`, true);
  return new ProviderError(`${label} rejected the request (${status}): ${detail}`, false);
}

export async function getJson(url: string, headers: Record<string, string>, timeoutMs: number): Promise<unknown> {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}
