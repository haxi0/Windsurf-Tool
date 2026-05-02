import * as vscode from "vscode";
let channel: vscode.OutputChannel | undefined;
// 一旦 deactivate 触发 disposeOutput，这个标记永远为 true。
// 之后任何 log 调用都不会再 createOutputChannel —— 否则会触发
// "Trying to add a disposable to a DisposableStore that has already been disposed of"。
// 这种情况发生在扩展卸载（如切号导致 Windsurf 重新加载扩展宿主）时，
// 还在排队的异步回调（轮询 tick、Promise then、子进程 stdout）继续调用 log。
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
        // OutputChannel 已 dispose（或扩展正在 deactivate） —— 静默 fallback 到 stderr，
        // 不再 createOutputChannel，避免泄漏 disposable。
        // 用 console.error 让消息进 Extension Host 控制台便于调试。
        // eslint-disable-next-line no-console
        console.error('[windsurfSwitch]', formatted);
    }
}

export function disposeOutput(): void {
    disposed = true;
    channel?.dispose();
    channel = undefined;
}