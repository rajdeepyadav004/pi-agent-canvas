/**
 * Turn a raw agent/protocol failure into something a person can act on.
 *
 * Shared by BOTH bundles on purpose: the extension host shows it in a
 * notification and the canvas shows it above the composer, and those two must
 * not drift. No `vscode` import here — the webview bundle cannot have one.
 *
 * The raw text is never thrown away: it always goes to the "Pi Agent Canvas"
 * output channel, so this is only the friendly face.
 */
export function explainError(raw: string): string {
  const text = raw.trim();
  const first = text.split('\n')[0];

  if (/No API key found for the selected model/i.test(text)) {
    return 'Pi has no credentials for the selected model on this machine. Log in with pi itself first — run `pi` in a terminal and use /login — then try again.';
  }
  if (/ENOENT|not found/i.test(text) && /\bnode\b/i.test(text)) {
    return 'Node.js could not be started. The agent runs as a plain Node process, so `node` must be on PATH for the VS Code process. On macOS, a VS Code launched from the Dock often cannot see nvm or Homebrew paths.';
  }
  if (/ECONNREFUSED|fetch failed|ENOTFOUND|ETIMEDOUT|socket hang up|EAI_AGAIN/i.test(text)) {
    return `The model provider could not be reached — ${first}. Check this machine's network or proxy settings: a child process inherits VS Code's proxy environment.`;
  }
  if (/unknown session/i.test(text)) {
    return 'That conversation no longer exists on this machine (the session file is missing). Open another session, or start a new one.';
  }
  if (/could not load ws|Cannot find package|ERR_MODULE_NOT_FOUND/i.test(text)) {
    return `The agent's runtime could not load — ${first}. This usually means a damaged install; reinstalling the extension fixes it.`;
  }
  // Unknown failure: keep it short but real, and point at the log for the rest.
  const lines = text.split('\n').slice(0, 3).join('\n');
  return `${lines}\n\n(Full details in the "Pi Agent Canvas" output channel.)`;
}
