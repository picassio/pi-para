/**
 * Secret redaction — strips API keys, tokens, passwords, and other
 * sensitive values from wiki page content before writing.
 *
 * Runs automatically on every wiki_write to prevent secrets from
 * being persisted in the knowledge base.
 */

// -- Patterns ----------------------------------------------------------------

interface SecretPattern {
  name: string;
  /** Regex to match the full secret value. */
  pattern: RegExp;
  /** Replacement text. */
  replacement: string;
}

/**
 * Secret detection patterns — ordered from most specific to most general.
 *
 * Each pattern matches a specific type of secret. The replacement preserves
 * the key type for documentation purposes while removing the actual value.
 */
const SECRET_PATTERNS: SecretPattern[] = [
  // --- Provider-specific API key formats ---
  {
    name: "OpenRouter API key",
    pattern: /sk-or-v1-[a-f0-9]{64}/g,
    replacement: "<REDACTED:openrouter-key>",
  },
  {
    name: "OpenAI API key",
    pattern: /sk-[a-zA-Z0-9]{48,}/g,
    replacement: "<REDACTED:openai-key>",
  },
  {
    name: "Anthropic API key",
    pattern: /sk-ant-[a-zA-Z0-9_-]{40,}/g,
    replacement: "<REDACTED:anthropic-key>",
  },
  {
    name: "MiniMax API key",
    pattern: /sk-cp-[a-zA-Z0-9_-]{40,}/g,
    replacement: "<REDACTED:minimax-key>",
  },
  {
    name: "GitHub PAT (fine-grained)",
    pattern: /github_pat_[a-zA-Z0-9_]{60,}/g,
    replacement: "<REDACTED:github-pat>",
  },
  {
    name: "GitHub PAT (classic)",
    pattern: /ghp_[a-zA-Z0-9]{36,}/g,
    replacement: "<REDACTED:github-pat>",
  },
  {
    name: "GitHub OAuth token",
    pattern: /gho_[a-zA-Z0-9]{36,}/g,
    replacement: "<REDACTED:github-oauth>",
  },
  {
    name: "AWS Access Key ID",
    pattern: /AKIA[0-9A-Z]{16}/g,
    replacement: "<REDACTED:aws-key-id>",
  },
  {
    name: "AWS Secret Access Key",
    pattern: /(?<=aws_secret_access_key\s*[=:]\s*)[A-Za-z0-9/+=]{40}/g,
    replacement: "<REDACTED:aws-secret>",
  },
  {
    name: "Jina API key",
    pattern: /jina_[a-zA-Z0-9_-]{30,}/g,
    replacement: "<REDACTED:jina-key>",
  },
  {
    name: "Bearer token",
    pattern: /Bearer [a-zA-Z0-9._-]{30,}/g,
    replacement: "Bearer <REDACTED>",
  },

  // --- Generic key/value patterns in YAML/config context ---
  // Match: key: <long-alphanumeric-value> (in YAML blocks)
  {
    name: "YAML key value",
    pattern: /(?<=^\s*key:\s*)[a-zA-Z0-9_-]{32,}/gm,
    replacement: "<REDACTED>",
  },
  // Match: token: <long-alphanumeric-value>
  {
    name: "YAML token value",
    pattern: /(?<=^\s*token:\s*)[a-zA-Z0-9_-]{32,}/gm,
    replacement: "<REDACTED>",
  },
  // Match: secret: <long-alphanumeric-value>
  {
    name: "YAML secret value",
    pattern: /(?<=^\s*secret:\s*)[a-zA-Z0-9_-]{32,}/gm,
    replacement: "<REDACTED>",
  },
  // Match: password: <value> (any length, in YAML)
  {
    name: "YAML password value",
    pattern: /(?<=^\s*password:\s*)\S+/gm,
    replacement: "<REDACTED>",
  },
  // Match: api_key: / apiKey: <long-alphanumeric-value>
  {
    name: "YAML api_key value",
    pattern: /(?<=^\s*(?:api_key|apiKey|api-key):\s*)[a-zA-Z0-9_-]{20,}/gm,
    replacement: "<REDACTED>",
  },

  // --- Environment variable patterns ---
  // Match: export SECRET_NAME=value or SECRET_NAME="value"
  {
    name: "Env var secret",
    pattern: /(?<=(?:export\s+)?(?:API_KEY|SECRET|TOKEN|PASSWORD|PRIVATE_KEY|ACCESS_KEY)[A-Z_]*\s*=\s*["']?)[^\s"']{16,}/g,
    replacement: "<REDACTED>",
  },
];

// -- Public API --------------------------------------------------------------

/**
 * Redact secrets from text content.
 * Returns the redacted text and count of redactions made.
 */
export function redactSecrets(text: string): { text: string; redactions: number } {
  let result = text;
  let redactions = 0;

  for (const { pattern, replacement } of SECRET_PATTERNS) {
    // Reset regex state for global patterns
    const re = new RegExp(pattern.source, pattern.flags);
    const before = result;
    result = result.replace(re, replacement);
    if (result !== before) {
      // Count how many replacements were made
      const matches = before.match(new RegExp(pattern.source, pattern.flags));
      redactions += matches?.length ?? 1;
    }
  }

  return { text: result, redactions };
}

/**
 * Check if text contains any detectable secrets.
 * Faster than redactSecrets() — stops at first match.
 */
export function containsSecrets(text: string): boolean {
  for (const { pattern } of SECRET_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags);
    if (re.test(text)) return true;
  }
  return false;
}
