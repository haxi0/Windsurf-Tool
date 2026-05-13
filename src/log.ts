import * as vscode from "vscode";
let channel: vscode.OutputChannel | undefined;
// Once deactivate triggers disposeOutput, this flag stays true forever.
// After that no log call will createOutputChannel — otherwise it triggers
// "Trying to add a disposable to a DisposableStore that has already been disposed of".
// This happens when extension unloads (e.g., switching accounts causes Windsurf to reload ext host),
// while queued async callbacks (poll tick, Promise then, subprocess stdout) continue calling log.
let disposed = false;

export function getOutputChannel(): vscode.OutputChannel | undefined {
    if (disposed) {
        return undefined;
    }
    if (!channel) {
        channel = vscode.window.createOutputChannel('Windsurf Switch');
    }
    return channel;
}

export function log(...args: unknown[]): void {
    const line = args
        .map(a => {
            if (a instanceof Error) {
                return a.stack || a.message;
            }
            return typeof a === 'string' ? a : JSON.stringify(a);
        })
        .join(' ');
    const formatted = `[${new Date().toISOString()}] ${line}`;
    const ch = getOutputChannel();
    if (ch) {
        ch.appendLine(formatted);
    } else {
        // OutputChannel already disposed (or extension deactivating) — silently fallback to stderr,
        // don't createOutputChannel to avoid leaking disposable.
        // Use console.error to send messages to Extension Host console for debugging.
        // eslint-disable-next-line no-console
        console.error('[windsurfSwitch]', formatted);
    }
}

export function disposeOutput(): void {
    disposed = true;
    channel?.dispose();
    channel = undefined;
}