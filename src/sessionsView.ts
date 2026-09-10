import * as vscode from 'vscode';

/**
 * The Sessions view: every conversation stored for this workspace, as a row you
 * click to open. Reads the list from pi-canvas-server over HTTP — the session
 * index is filesystem work the extension host can't do cheaply itself (the pi
 * SDK is ESM-only and takes ~850ms to load, which is not a cost activation
 * should pay).
 *
 * Sessions are tiles: clicking a row opens the editor panel that owns that
 * session, revealing the existing tab if it is already open.
 */
export interface SessionSummary {
  id: string;
  name?: string;
  /** ISO timestamp of the last write. */
  modified: string;
  messageCount: number;
  firstMessage: string;
  cwd: string;
  file: string;
  /** Live in pi-canvas-server right now. */
  open: boolean;
}

export class SessionItem extends vscode.TreeItem {
  constructor(readonly summary: SessionSummary) {
    super(label(summary), vscode.TreeItemCollapsibleState.None);

    const parts = [relativeTime(summary.modified)];
    if (summary.messageCount) parts.push(`${summary.messageCount} msg${summary.messageCount === 1 ? '' : 's'}`);
    parts.push(summary.id.slice(0, 8));
    this.description = parts.join(' · ');

    const tooltip = new vscode.MarkdownString();
    tooltip.appendMarkdown(`**${label(summary)}**\n\n`);
    if (summary.firstMessage && summary.firstMessage !== label(summary)) {
      tooltip.appendMarkdown(`${summary.firstMessage}\n\n`);
    }
    tooltip.appendMarkdown(`Session \`${summary.id}\`\n\n`);
    tooltip.appendMarkdown(`${summary.open ? '$(hubot) open' : '$(history) closed'}\n\n`);
    tooltip.appendMarkdown(`${summary.file}`);
    tooltip.supportThemeIcons = true;
    this.tooltip = tooltip;

    // The robot face marks a live session, matching the activity-bar icon.
    this.iconPath = summary.open
      ? new vscode.ThemeIcon('hubot', new vscode.ThemeColor('charts.green'))
      : new vscode.ThemeIcon('history');

    this.contextValue = summary.open ? 'session.open' : 'session';
    this.command = {
      command: 'piAgentCanvas.openSession',
      title: 'Open Session',
      arguments: [summary.id],
    };
  }
}

export class SessionsTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(private readonly load: () => Promise<SessionSummary[]>) {}

  refresh(): void {
    this.changeEmitter.fire();
  }

  /**
   * A newly opened session only reaches disk once the server has created it, so
   * a refresh fired immediately after "open" would still miss it. Debounce a
   * little to catch that file.
   */
  refreshSoon(delayMs = 700): void {
    if (this.pending) clearTimeout(this.pending);
    this.pending = setTimeout(() => {
      this.pending = undefined;
      this.changeEmitter.fire();
    }, delayMs);
  }

  private pending?: ReturnType<typeof setTimeout>;

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<vscode.TreeItem[]> {
    let sessions: SessionSummary[];
    try {
      sessions = await this.load();
    } catch (err) {
      // Keep the failure visible in the view instead of silently showing an
      // empty tree that looks like "you have no sessions".
      const item = new vscode.TreeItem('pi-canvas-server unreachable', vscode.TreeItemCollapsibleState.None);
      item.description = 'click Refresh to retry';
      item.iconPath = new vscode.ThemeIcon('warning');
      item.tooltip = String(err);
      return [item];
    }

    // Live sessions first, then most recently used.
    return sessions
      .slice()
      .sort((a, b) => Number(b.open) - Number(a.open) || Date.parse(b.modified) - Date.parse(a.modified))
      .map((session) => new SessionItem(session));
  }
}

function label(session: SessionSummary): string {
  const name = session.name?.trim();
  if (name) return name;
  const first = session.firstMessage?.replace(/\s+/g, ' ').trim();
  if (first) return first.length > 60 ? `${first.slice(0, 60)}…` : first;
  return `Session ${session.id.slice(0, 8)}`;
}

function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(then).toLocaleDateString();
}
