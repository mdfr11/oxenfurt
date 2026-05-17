// Thin client over OpenAI-compatible /chat/completions. The OpenAI Chat
// Completions API is the de facto standard format — Anthropic (via their
// compat layer at /v1/chat/completions), Moonshot/Kimi, Minimax, Together,
// Groq, OpenRouter and most other providers expose this exact shape. By
// reading base URL + key + model from env we can swap providers without
// touching code.

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatOptions {
  /** Optional response_format `{ type: 'json_object' }` for JSON-mode. */
  jsonMode?: boolean
  /** Hard cap on output tokens — defaults to provider's max. */
  maxTokens?: number
  /** Sampling temperature, default 0.2 (we want deterministic-ish output). */
  temperature?: number
  /** Optional fetch timeout — default 30s. */
  timeoutMs?: number
}

export interface LlmClient {
  /** Send a chat and return the assistant message text. */
  chat(messages: ChatMessage[], opts?: ChatOptions): Promise<string>
}

export interface LlmConfig {
  baseUrl?: string | undefined
  apiKey?: string | undefined
  model?: string | undefined
}

class OpenAICompatClient implements LlmClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
    const url = `${this.baseUrl.replace(/\/+$/, '')}/chat/completions`
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      temperature: opts.temperature ?? 0.2,
    }
    if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens
    if (opts.jsonMode === true) body.response_format = { type: 'json_object' }

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000)
    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timeoutId)
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      // Truncate to keep journald-friendly; full body is rarely useful.
      throw new Error(`llm_http_${res.status}: ${text.slice(0, 200)}`)
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const content = data.choices?.[0]?.message?.content
    if (typeof content !== 'string' || content.length === 0) {
      throw new Error('llm_empty_response')
    }
    return content
  }
}

/**
 * Returns a client only when all three env vars are set; otherwise
 * `null`. Callers gate on the null check (the previous DisabledClient
 * stub existed solely so they could do `if (!llm.available)` — same
 * thing as `if (llm === null)`, one class fewer).
 */
export function createLlmClient(cfg: LlmConfig): LlmClient | null {
  if (
    cfg.baseUrl === undefined ||
    cfg.baseUrl.length === 0 ||
    cfg.apiKey === undefined ||
    cfg.apiKey.length === 0 ||
    cfg.model === undefined ||
    cfg.model.length === 0
  ) {
    return null
  }
  return new OpenAICompatClient(cfg.baseUrl, cfg.apiKey, cfg.model)
}
