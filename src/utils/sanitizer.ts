/**
 * Sanitize Slack-formatted user input into plain text.
 * Replaces <@U123>, <#C123|name>, and <url|label> with readable forms.
 */
export function sanitizeUserInput(text: string): string {
  let result = text;

  // User mentions: <@U12345> -> @U12345
  result = result.replace(/<@([A-Z0-9]+)>/g, '@$1');

  // Channel references: <#C12345|name> -> #name, <#C12345> -> #C12345
  result = result.replace(/<#([A-Z0-9]+)\|([^>]+)>/g, '#$2');
  result = result.replace(/<#([A-Z0-9]+)>/g, '#$1');

  // URLs with labels: <https://...|label> -> label (https://...)
  result = result.replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, '$2 ($1)');

  // URLs without labels: <https://...> -> https://...
  result = result.replace(/<(https?:\/\/[^>]+)>/g, '$1');

  return result;
}

/**
 * Sanitize output text by redacting sensitive tokens and API keys.
 */
export function sanitizeOutput(text: string): string {
  let result = text;

  // Slack tokens: xoxb-*, xoxp-*, xapp-*
  result = result.replace(/xox[bp]-[A-Za-z0-9\-]+/g, '[REDACTED_SLACK_TOKEN]');
  result = result.replace(/xapp-[A-Za-z0-9\-]+/g, '[REDACTED_SLACK_TOKEN]');

  // API keys: sk-*
  result = result.replace(/sk-[A-Za-z0-9]+/g, '[REDACTED_API_KEY]');

  return result;
}
