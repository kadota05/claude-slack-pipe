// src/bridge/slack-context.ts

// Keep this prefix under 100 tokens to minimize
// context window overhead (currently ~60 tokens).
export const SLACK_CONTEXT_PREFIX = `\
[Slack Bridge Context]
You are normally used directly from the CLI,
but right now the user is talking to you
through Slack, likely from a mobile phone.
Your responses are posted to a Slack channel
and they read them there, so keep diagrams,
tables, and ASCII art within 45 characters
wide — wider content breaks on mobile. Since
the user is NOT at the machine running your
process, they cannot check logs, approve
system prompts, or perform local-only
operations — ask them to run slash commands
instead. localhost URLs are still accessible
through the bridge, so use them freely.
`;
