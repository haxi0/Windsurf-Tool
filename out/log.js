"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.getOutputChannel = getOutputChannel;
exports.log = log;
exports.disposeOutput = disposeOutput;
const vscode = __importStar(require("vscode"));
let channel;
// 一旦 deactivate 触发 disposeOutput，这个标记永远为 true。
// 之后任何 log 调用都不会再 createOutputChannel —— 否则会触发
// "Trying to add a disposable to a DisposableStore that has already been disposed of"。
// 这种情况发生在扩展卸载（如切号导致 Windsurf 重新加载扩展宿主）时，
// 还在排队的异步回调（轮询 tick、Promise then、子进程 stdout）继续调用 log。
let disposed = false;
function getOutputChannel() {
    if (disposed) {
        return undefined;
    }
    if (!channel) {
        channel = vscode.window.createOutputChannel('Windsurf Switch');
    }
    return channel;
}
function log(...args) {
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
    }
    else {
        // OutputChannel 已 dispose（或扩展正在 deactivate） —— 静默 fallback 到 stderr，
        // 不再 createOutputChannel，避免泄漏 disposable。
        // 用 console.error 让消息进 Extension Host 控制台便于调试。
        // eslint-disable-next-line no-console
        console.error('[windsurfSwitch]', formatted);
    }
}
function disposeOutput() {
    disposed = true;
    channel?.dispose();
    channel = undefined;
}
//# sourceMappingURL=log.js.map