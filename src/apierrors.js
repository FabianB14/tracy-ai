// What went wrong, in words a person can act on.
//
// Every failure in the chat handler used to surface as "Tracy hit a snag",
// which is true of a dead database, an empty API balance and a typo in a
// model name alike — so the only way to learn anything was to open the
// server logs. These classifiers turn the common failures into a sentence
// that names the cause and the fix. The full error still goes to the logs;
// this is only what the person reads.

const OUT_OF_CREDIT = /credit balance|insufficient (funds|credit|quota)|billing|payment/i;
const OVER_CAP = /spend (limit|cap)|usage limit|monthly limit/i;

/**
 * Classify an error from a model provider call.
 * Returns { kind, message, status, retryable } — `message` is user-facing.
 */
export function classifyModelError(err) {
  const status = err?.status ?? err?.statusCode ?? null;
  const apiType = err?.error?.error?.type || err?.error?.type || err?.type || "";
  const raw = String(err?.message || err || "");
  const code = err?.code || "";

  // Billing first: it arrives as a 400, so a generic 400 branch would hide it.
  if (OVER_CAP.test(raw)) {
    return {
      kind: "spend_cap",
      status,
      retryable: false,
      message:
        "I've hit the spend limit on the Anthropic account, so I can't think " +
        "right now. Raising the monthly limit in the Anthropic Console brings " +
        "me straight back.",
    };
  }
  if (OUT_OF_CREDIT.test(raw)) {
    return {
      kind: "out_of_credit",
      status,
      retryable: false,
      message:
        "The Anthropic account is out of credit, so I can't think right now. " +
        "Adding credit in the Anthropic Console brings me straight back.",
    };
  }

  switch (status) {
    case 401:
    case 403:
      return {
        kind: "auth",
        status,
        retryable: false,
        message:
          "My Anthropic API key was rejected — it may have been rotated or " +
          "revoked. Check ANTHROPIC_API_KEY on my server.",
      };
    case 404:
      return {
        kind: "model_not_found",
        status,
        retryable: false,
        message:
          "The model I'm configured to use doesn't exist or isn't available " +
          "to this account. Check the TRACY_MODEL setting on my server.",
      };
    case 413:
      return {
        kind: "too_large",
        status,
        retryable: false,
        message:
          "That was too much for one message. Try sending it in pieces, or " +
          "upload it with the 📎 button so I can read it as a document.",
      };
    case 429:
      return {
        kind: "rate_limit",
        status,
        retryable: true,
        message:
          "I'm being rate-limited right now. Give me a minute and ask again.",
      };
    case 500:
    case 502:
    case 503:
    case 529:
      return {
        kind: "overloaded",
        status,
        retryable: true,
        message:
          "The model service is having trouble at the moment. Try again in a " +
          "minute — nothing is wrong on our side.",
      };
    default:
      break;
  }

  if (apiType === "overloaded_error") {
    return {
      kind: "overloaded",
      status,
      retryable: true,
      message:
        "The model service is overloaded right now. Try again in a minute.",
    };
  }

  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|socket hang up|network|fetch failed/i.test(raw + code)) {
    return {
      kind: "network",
      status,
      retryable: true,
      message:
        "I couldn't reach the model service — looks like a network problem on " +
        "my end. Try again in a moment.",
    };
  }

  // Tracy's own Postgres, not the model provider: her memory and knowledge
  // live there, so a chat turn can fail on it.
  if (/relation .* does not exist|ECONNREFUSED .*5432|password authentication failed|too many clients/i.test(raw)) {
    return {
      kind: "database",
      status,
      retryable: true,
      message:
        "My database isn't reachable, so I can't load memory or knowledge " +
        "right now. Check the database on my server.",
    };
  }

  return {
    kind: "unknown",
    status,
    retryable: true,
    message:
      "Something went wrong on my end and I couldn't finish that. Try again " +
      "in a moment — the details are in my server logs.",
  };
}

/** True when a fallback model is worth trying for this failure. */
export function worthFallingBack(kind) {
  return kind !== "too_large";
}
