/**
 * Zendesk REST API client
 * Handles auth, rate-limit backoff, and structured errors.
 */

export interface ZendeskConfig {
  subdomain: string;
  email: string;
  apiToken: string;
}

export interface ZendeskError {
  error: string;
  description?: string;
  status: number;
}

export class ZendeskClient {
  private baseUrl: string;
  private authHeader: string;
  private maxRetries = 3;

  constructor(config: ZendeskConfig) {
    this.baseUrl = `https://${config.subdomain}.zendesk.com/api/v2`;
    // Zendesk token auth: {email}/token:{api_token}
    const credentials = `${config.email}/token:${config.apiToken}`;
    this.authHeader = `Basic ${Buffer.from(credentials).toString("base64")}`;
  }

  /**
   * Core fetch with exponential backoff on 429 and transient 5xx.
   */
  async request<T>(
    path: string,
    options: RequestInit = {}
  ): Promise<T> {
    const url = path.startsWith("http") ? path : `${this.baseUrl}${path}`;
    let attempt = 0;

    while (attempt <= this.maxRetries) {
      const response = await fetch(url, {
        ...options,
        headers: {
          Authorization: this.authHeader,
          "Content-Type": "application/json",
          Accept: "application/json",
          ...options.headers,
        },
      });

      // Rate limited — back off and retry
      if (response.status === 429) {
        const retryAfter = parseInt(
          response.headers.get("Retry-After") ?? "10",
          10
        );
        if (attempt < this.maxRetries) {
          await sleep(retryAfter * 1000);
          attempt++;
          continue;
        }
        throw new McpZendeskError(
          `Rate limited by Zendesk. Retry after ${retryAfter}s. Reduce call frequency or upgrade Zendesk plan.`,
          429
        );
      }

      // Transient server errors
      if (response.status >= 500 && attempt < this.maxRetries) {
        await sleep(exponentialDelay(attempt));
        attempt++;
        continue;
      }

      if (!response.ok) {
        let errorBody: Record<string, unknown> = {};
        try {
          errorBody = (await response.json()) as Record<string, unknown>;
        } catch {
          // ignore parse error
        }
        throw new McpZendeskError(
          formatZendeskError(errorBody, response.status),
          response.status
        );
      }

      // 204 No Content
      if (response.status === 204) {
        return {} as T;
      }

      return (await response.json()) as T;
    }

    throw new McpZendeskError("Max retries exceeded", 503);
  }

  async get<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: "GET" });
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, {
      method: "PUT",
      body: JSON.stringify(body),
    });
  }

  async patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  }
}

export class McpZendeskError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number
  ) {
    super(message);
    this.name = "McpZendeskError";
  }
}

function formatZendeskError(body: Record<string, unknown>, status: number): string {
  const err = (body.error as string) ?? "";
  const desc = (body.description as string) ?? "";
  if (status === 401 || status === 403) {
    return `Auth error (${status}): ${err || "Invalid credentials or insufficient permissions"}. ${desc} Check your subdomain, email, and API token.`;
  }
  if (status === 404) {
    return `Not found (404): ${err || "Resource does not exist"}. ${desc}`;
  }
  return `Zendesk API error ${status}: ${err} ${desc}`.trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function exponentialDelay(attempt: number): number {
  return Math.min(1000 * Math.pow(2, attempt), 30000);
}

/**
 * Build client from environment variables.
 * Expected env: ZENDESK_SUBDOMAIN, ZENDESK_EMAIL, ZENDESK_API_TOKEN
 */
export function clientFromEnv(): ZendeskClient {
  const subdomain = process.env.ZENDESK_SUBDOMAIN;
  const email = process.env.ZENDESK_EMAIL;
  const apiToken = process.env.ZENDESK_API_TOKEN;

  if (!subdomain || !email || !apiToken) {
    throw new Error(
      "Missing required environment variables: ZENDESK_SUBDOMAIN, ZENDESK_EMAIL, ZENDESK_API_TOKEN"
    );
  }

  return new ZendeskClient({ subdomain, email, apiToken });
}
