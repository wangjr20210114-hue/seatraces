import { reserveApiCall } from "../repositories/api-usage.mjs";

// Every commercial call passes the same budget gate. No automatic paid retries.
// URL/headers/body and vendor error text must never reach logs or public errors.
export function createJsonRequester({
  reserve = reserveApiCall,
  fetchImpl = (...args) => fetch(...args),
  timeoutMs = 18000,
} = {}) {
  return async function request(provider, url, options = {}) {
    await reserve(provider);
    try {
      const response = await fetchImpl(url, {
        ...options,
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error("upstream response rejected");
      return await response.json();
    } catch {
      throw Object.assign(new Error(`${provider} 暂时不可用，请稍后重试`), {
        status: 502,
      });
    }
  };
}
export const request = createJsonRequester();
