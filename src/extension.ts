import * as vscode from 'vscode';
import { ScreenshotPanel } from './screenshotPanel';

export function activate(context: vscode.ExtensionContext): void {
  const open = vscode.commands.registerCommand('adbScreenshot.open', () => {
    ScreenshotPanel.createOrShow(context.extensionUri);
  });

  const capture = vscode.commands.registerCommand('adbScreenshot.capture', () => {
    const panel = ScreenshotPanel.createOrShow(context.extensionUri);
    panel.requestCapture();
  });

  const connect = vscode.commands.registerCommand('adbScreenshot.connect', () => {
    const panel = ScreenshotPanel.createOrShow(context.extensionUri);
    panel.requestDeviceModal();
  });

  context.subscriptions.push(open, capture, connect);
}

export function deactivate(): void {
  // no-op
}
