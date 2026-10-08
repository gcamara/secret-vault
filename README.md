# secret-vault

A Claude Code plugin for handing API keys to a session without pasting them into the chat.

When a task needs a key, the agent calls the plugin's `request_secrets` tool instead of asking you for it. A modal opens next to the prompt, you paste the values there, and the plugin writes them straight into the target file (`.env`, `appsettings.json`, a key file). The agent gets back only the names that were saved, never the values.

You can also open the modal yourself with `/secret`.

## Install

From a Claude Code terminal session:

```
/plugin install secret-vault --marketplace gcamara/secret-vault
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session).

To run it from a clone instead, point `CLAUDE_CODE_PLUGIN_DIRS` at the folder in the `env` block of `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/secret-vault" } }
```

## Usage

### Let the agent ask

The plugin adds a short section to the system prompt telling the agent to call `request_secrets` whenever it needs a credential. A call looks like this:

```json
{
  "path": ".env",
  "reason": "OpenAI client for the summarizer",
  "secrets": [{ "name": "OPENAI_API_KEY", "hint": "platform.openai.com > API keys" }]
}
```

The tool returns right away and the agent ends its turn. When you save or cancel, the plugin submits a short message (`The user saved OPENAI_API_KEY to .env (env)`) and the agent picks the task back up.

### Open it yourself

```
/secret              reopens a pending request, or starts one for ./.env
/secret config.json  starts one for that file
```

The command takes only the file. Names and values go in the modal, so nothing about the keys lands in the transcript.

### In the modal

- Paste a value and press Enter. Focus moves to the next empty key.
- **from clipboard** fills a key straight from the clipboard. The value is never drawn on screen.
- **+ new key** takes a bare name (`STRIPE_SECRET`) or `NAME=value` to add and fill a key in one go.
- **paste several NAME=value lines** reads a copied `.env` block and fills every key in it.
- Each key shows whether it is **new** or **replaces existing** in the target file.
- Esc hides the modal and keeps what you entered. `/secret` brings it back.

## File formats

| Format | Picked when | What it writes |
| --- | --- | --- |
| `env` | default | `NAME=value` lines. An existing line is replaced in place (a leading `export` is kept), a new one is appended, values with spaces or quotes are quoted. |
| `json` | the path ends in `.json` | Dotted names become nested keys: `OpenAI.ApiKey` sets `{ "OpenAI": { "ApiKey": "..." } }`. Other keys are kept. |
| `raw` | chosen in the modal or by the agent | The whole file is the one value. |

## Redaction

Every user-side row the session stores (your prompts, tool results, injected files) goes through a filter first:

- Values saved through the modal are replaced with `[secret:NAME]` for the rest of the session.
- Well-known key shapes are replaced with `[redacted-secret]` even if they never went through the modal: `sk-…` (OpenAI, Anthropic), `ghp_…` / `github_pat_…`, `AKIA…`, `xox…` (Slack), `AIza…` (Google), `glpat-…`, and PEM private keys.

So if the agent runs `cat .env` later, it sees the names but not the values.

## Limitations

- The input field can't be masked, so a value you type or paste into it is visible on your own screen until you press Enter. It never reaches the conversation. Use **from clipboard** if you don't want it shown at all.
- Redacted lines can't be edited by the agent with an exact-match edit, since it never saw the original text. The system prompt tells it to edit around them or call the tool again to replace a value.
- Redaction applies to what the session stores. Anything else that sees raw tool output, such as a telemetry exporter that logs tool details, is outside its reach.
- The phone app has no input fields yet, so the modal asks you to open the session on the terminal or desktop.
- The plugin API this is built on is early access and may change between releases.

## Development

```
claude plugin validate .
claude plugin test .
```

The hooks module is `hooks/register.tsx`. Everything that calls the engine lives in that one file because the engine only follows `$` into functions declared in the hooks module itself. The pure logic (file formats, redaction, parsing) sits in the other modules and has unit tests. `hooks/modal.test.tsx` mounts the modal on the terminal and desktop surfaces and checks that no value ever appears in the drawn tree.

## License

MIT
