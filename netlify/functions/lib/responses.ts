/**
 * Shared HTTP response helpers for Netlify Functions.
 */

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function errorResponse(message: string, status = 500): Response {
  return json({ error: message }, status);
}

/**
 * Classifies common provider / API errors into user-friendly messages
 * with appropriate HTTP status codes.
 */
export function classifyError(
  err: unknown,
  fallbackMessage = "Something went wrong"
): { message: string; status: number } {
  if (!(err instanceof Error)) {
    return { message: fallbackMessage, status: 500 };
  }

  const msg = err.message;

  if (msg.includes("credit balance is too low") || msg.includes("insufficient")) {
    return {
      message: "Your LLM provider account has insufficient credits. Please top up or switch providers.",
      status: 402,
    };
  }

  if (msg.includes("authentication") || msg.includes("API key") || msg.includes("Incorrect API key")) {
    return {
      message: "Invalid API key for the selected provider. Check your .env file.",
      status: 401,
    };
  }

  if (msg.includes("rate limit") || msg.includes("Rate limit")) {
    return {
      message: "Rate limited by the LLM provider. Wait a moment and try again.",
      status: 429,
    };
  }

  if (msg.includes("already exists") || msg.includes("name already exists") || msg.includes("must be unique")) {
    return {
      message: "Name conflict — that name already exists. Choose a different one.",
      status: 422,
    };
  }

  if (msg.includes("not configured") || msg.includes("GITHUB_TOKEN") || msg.includes("NETLIFY_TOKEN")) {
    return { message: msg, status: 400 };
  }

  return { message: msg, status: 500 };
}
