import * as vscode from 'vscode';
import {
  AdbConfig,
  AdbDevice,
  connectDevice,
  dumpUiHierarchy,
  listDevices,
  screenshot,
  tapPoint
} from './adb';
import { buildCropName, buildFullName, CropInfo } from './naming';

interface PluginConfig {
  adbPath: string;
  cropSize: number;
  filenamePrefix: string;
  magnifierPixels: number;
  commandTimeout: number;
}

interface IncomingMessage {
  id?: number;
  type: string;
  serial?: string;
  address?: string;
  data?: string;
  defaultName?: string;
  text?: string;
  path?: string;
  kind?: 'point' | 'rect';
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  color?: string;
  toFolder?: boolean;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export class ScreenshotPanel {
  public static current: ScreenshotPanel | undefined;
  private static readonly viewType = 'adbScreenshotHelper';

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private readonly disposables: vscode.Disposable[] = [];
  private lastSaveDir: vscode.Uri | undefined;
  private batchSaveDir: vscode.Uri | undefined;
  private disposed = false;

  public static createOrShow(extensionUri: vscode.Uri): ScreenshotPanel {
    const column = vscode.window.activeTextEditor?.viewColumn;
    if (ScreenshotPanel.current) {
      ScreenshotPanel.current.panel.reveal(column);
      return ScreenshotPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      ScreenshotPanel.viewType,
      '图色助手',
      column ?? vscode.ViewColumn.One,
      {
        retainContextWhenHidden: true,
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
      }
    );
    ScreenshotPanel.current = new ScreenshotPanel(panel, extensionUri);
    return ScreenshotPanel.current;
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.panel.webview.html = this.buildHtml();

    this.panel.webview.onDidReceiveMessage(
      (m) => void this.onMessage(m),
      undefined,
      this.disposables
    );

    this.panel.onDidDispose(
      () => this.dispose(),
      undefined,
      this.disposables
    );

    vscode.workspace.onDidChangeConfiguration(
      (e) => {
        if (e.affectsConfiguration('adbScreenshot')) {
          void this.post({ type: 'configChanged', config: this.readConfig() });
        }
      },
      undefined,
      this.disposables
    );
  }

  /** 由外部命令触发：通知前端执行截屏 */
  public requestCapture(): void {
    void this.post({ type: 'doCapture' });
  }

  /** 由外部命令触发：通知前端打开设备弹窗 */
  public requestDeviceModal(): void {
    void this.post({ type: 'doOpenDevices' });
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    ScreenshotPanel.current = undefined;
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }

  // --------------------------------------------------------------- 配置

  private readConfig(): PluginConfig {
    const c = vscode.workspace.getConfiguration('adbScreenshot');
    return {
      adbPath: c.get<string>('adbPath') || 'adb',
      cropSize: c.get<number>('cropSize') ?? 64,
      filenamePrefix: c.get<string>('filenamePrefix') ?? 'crop',
      magnifierPixels: c.get<number>('magnifierPixels') ?? 15,
      commandTimeout: c.get<number>('commandTimeout') ?? 15000
    };
  }

  private adbConfig(): AdbConfig {
    const c = this.readConfig();
    return { adbPath: c.adbPath, timeout: c.commandTimeout };
  }

  // --------------------------------------------------------------- 消息

  private async onMessage(m: IncomingMessage): Promise<void> {
    const resolve = (result: unknown) =>
      this.post({ id: m.id, ok: true, result });
    const reject = (error: string) =>
      this.post({ id: m.id, ok: false, error });

    try {
      switch (m.type) {
        case 'getConfig':
          await resolve(this.readConfig());
          break;

        case 'listDevices': {
          const devices: AdbDevice[] = await listDevices(this.adbConfig());
          await resolve({ devices });
          break;
        }

        case 'connect': {
          if (!m.address) {
            throw new Error('请输入设备地址，例如 127.0.0.1:1093');
          }
          const message = await connectDevice(this.adbConfig(), m.address);
          await resolve({ message });
          break;
        }

        case 'capture': {
          if (!m.serial) {
            throw new Error('请先在「搜索设备」中选择一台设备');
          }
          const buf = await screenshot(this.adbConfig(), m.serial);
          await resolve({ data: buf.toString('base64') });
          break;
        }

        case 'loadImage': {
          const picked = await vscode.window.showOpenDialog({
            canSelectMany: false,
            filters: { 图片: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] },
            title: '载入设备截图'
          });
          if (!picked || picked.length === 0) {
            await resolve({ cancelled: true });
            break;
          }
          const buf = await vscode.workspace.fs.readFile(picked[0]);
          const name = picked[0].path.split('/').pop() || 'image';
          await resolve({ data: Buffer.from(buf).toString('base64'), name });
          break;
        }

        case 'saveFullImage': {
          if (!m.data) {
            throw new Error('没有可保存的图片');
          }
          const buf = Buffer.from(m.data, 'base64');
          this.assertPng(buf);
          const startDir = this.dialogStartDir();
          const target = await vscode.window.showSaveDialog({
            filters: { 'PNG 图片': ['png'] },
            defaultUri: startDir
              ? vscode.Uri.joinPath(startDir, m.defaultName || buildFullName(''))
              : undefined
          });
          if (!target) {
            await resolve({ cancelled: true });
            break;
          }
          this.lastSaveDir = vscode.Uri.joinPath(target, '..');
          await vscode.workspace.fs.writeFile(target, buf);
          await resolve({ path: target.fsPath });
          break;
        }

        case 'chooseSaveFolder': {
          const picked = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            title: '选择小图保存目录',
            openLabel: '选择此目录',
            defaultUri: this.dialogStartDir()
          });
          if (!picked || picked.length === 0) {
            await resolve({ cancelled: true });
            break;
          }
          this.batchSaveDir = picked[0];
          this.lastSaveDir = picked[0];
          await resolve({ path: picked[0].fsPath });
          break;
        }

        case 'saveCrop': {
          if (!m.data) {
            throw new Error('没有可保存的小图');
          }
          const buf = Buffer.from(m.data, 'base64');
          this.assertPng(buf);
          const cfg = this.readConfig();
          const info: CropInfo = {
            kind: m.kind ?? 'point',
            x: Math.max(0, Math.floor(m.x ?? 0)),
            y: Math.max(0, Math.floor(m.y ?? 0)),
            w: Math.max(1, Math.floor(m.w ?? 0)),
            h: Math.max(1, Math.floor(m.h ?? 0)),
            color: m.color
          };

          if (m.toFolder) {
            // 批量模式：目录由 chooseSaveFolder 预先选定，自动命名，重名追加序号
            if (!this.batchSaveDir) {
              throw new Error('请先选择保存目录');
            }
            let name = buildCropName(cfg.filenamePrefix, info);
            let target = vscode.Uri.joinPath(this.batchSaveDir, name);
            let dup = 1;
            while (await this.fileExists(target)) {
              name = buildCropName(cfg.filenamePrefix, info, dup++);
              target = vscode.Uri.joinPath(this.batchSaveDir, name);
            }
            await vscode.workspace.fs.writeFile(target, buf);
            await resolve({ path: target.fsPath, name });
            break;
          }

          // 单张：弹出另存为对话框（已自动填好文件名，可改目录/文件名）
          const startDir = this.dialogStartDir();
          const initial = buildCropName(cfg.filenamePrefix, info);
          const target = await vscode.window.showSaveDialog({
            filters: { 'PNG 图片': ['png'] },
            defaultUri: startDir ? vscode.Uri.joinPath(startDir, initial) : undefined
          });
          if (!target) {
            await resolve({ cancelled: true });
            break;
          }
          this.lastSaveDir = vscode.Uri.joinPath(target, '..');
          await vscode.workspace.fs.writeFile(target, buf);
          const name = target.path.split('/').pop() || initial;
          await resolve({ path: target.fsPath, name });
          break;
        }

        case 'copyText': {
          await vscode.env.clipboard.writeText(m.text ?? '');
          await resolve({});
          break;
        }

        case 'dumpUi': {
          if (!m.serial) {
            throw new Error('请先在「搜索设备」中选择一台设备');
          }
          const xml = await dumpUiHierarchy(this.adbConfig(), m.serial);
          await resolve({ xml });
          break;
        }

        case 'tap': {
          if (!m.serial) {
            throw new Error('请先在「搜索设备」中选择一台设备');
          }
          await tapPoint(this.adbConfig(), m.serial, m.x ?? 0, m.y ?? 0);
          await resolve({});
          break;
        }

        case 'revealFolder': {
          if (m.path) {
            await vscode.commands.executeCommand(
              'revealFileInOS',
              vscode.Uri.file(m.path)
            );
          }
          await resolve({});
          break;
        }

        default:
          // 未知消息类型，静默忽略
          break;
      }
    } catch (err) {
      await reject(err instanceof Error ? err.message : String(err));
    }
  }

  // --------------------------------------------------------------- 保存对话框

  /** 对话框的起始目录：优先上次选择的目录，否则工作区根目录 */
  private dialogStartDir(): vscode.Uri | undefined {
    if (this.lastSaveDir) {
      return this.lastSaveDir;
    }
    return vscode.workspace.workspaceFolders?.[0].uri;
  }

  private async fileExists(uri: vscode.Uri): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(uri);
      return true;
    } catch {
      return false;
    }
  }

  private assertPng(buf: Buffer): void {
    if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
      throw new Error('图片数据不是有效的 PNG 文件');
    }
  }

  // --------------------------------------------------------------- HTML

  private post(message: unknown): Thenable<boolean> {
    return this.panel.webview.postMessage(message);
  }

  private buildHtml(): string {
    const webview = this.panel.webview;
    const nonce = getNonce();
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'style.css')
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'main.js')
    );
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data: blob:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${styleUri}" rel="stylesheet">
<title>图色助手</title>
</head>
<body>
<div id="app">
  <aside id="sidebar">
    <section class="device-card">
      <div class="device-card-head">
        <span class="dot" id="deviceDot"></span>
        <span>当前设备</span>
      </div>
      <div class="device-card-body" id="deviceName">未连接</div>
    </section>

    <button class="btn" id="btnDevices">搜索设备</button>
    <button class="btn" id="btnCapture">截取屏幕</button>
    <button class="btn" id="btnDumpUi">获取控件</button>
    <label class="chk-line"><input type="checkbox" id="uiShowAll">显示全部控件（含不可点击）</label>
    <button class="btn" id="btnLoad">载入图片</button>
    <button class="btn" id="btnSaveFull">保存图片</button>

    <section class="group">
      <div class="group-title">操作模式</div>
      <div class="segmented">
        <button class="seg active" id="modePick" data-mode="pick">点击标记</button>
        <button class="seg" id="modeRect" data-mode="rect">框选范围</button>
        <button class="seg" id="modePan" data-mode="pan">拖动画面</button>
      </div>
    </section>

    <section class="group" id="pointGroup">
      <div class="group-title">小图边长（以点为中心）</div>
      <input type="number" id="cropSize" min="8" max="2048" step="2">
    </section>

    <button class="btn primary" id="btnSaveCrop">截存小图</button>
    <button class="btn" id="btnSaveAll">批量截存全部标记</button>
    <button class="btn" id="btnClearSel">清除框选</button>
    <button class="btn danger" id="btnClear">清空标记</button>

    <section class="group">
      <div class="group-title">代码格式</div>
      <select id="codeFormat" class="fmt-select">
        <option value="adb">ADB 命令（input tap）</option>
        <option value="color">颜色点击 colorClickAdHandle</option>
        <option value="absolute">绝对坐标 clickAbsoluteLocation</option>
      </select>
    </section>
    <button class="btn" id="btnGenCode">生成代码</button>
    <textarea id="codeBox" placeholder="生成的代码将显示在这里" readonly></textarea>
    <button class="btn" id="btnCopyCode">复制代码</button>
  </aside>

  <main id="stage">
    <div id="emptyHint">
      <div class="hint-main">请点击左侧「搜索设备」选择设备，再「截取屏幕」</div>
      <div class="hint-sub">也可以「载入图片」对本地截图进行标记</div>
    </div>
    <canvas id="screen" class="hidden"></canvas>
    <div id="zoomBar">
      <button class="zbtn" id="zoomOut" title="缩小">−</button>
      <button class="zbtn zlabel" id="zoomLabel" title="点击恢复为 100%">100%</button>
      <button class="zbtn" id="zoomIn" title="放大">+</button>
      <button class="zbtn zfit" id="zoomFit" title="适配窗口">适配</button>
    </div>
    <div id="loupe" class="hidden">
      <canvas id="loupeCanvas"></canvas>
      <div id="loupeInfo">x 0 y 0 C #000000</div>
    </div>
    <div id="toast" class="hidden"></div>

    <div id="nodeCard" class="hidden">
      <div class="nc-head">
        <span class="nc-title" id="ncTitle">控件</span>
        <button class="nc-close" id="ncClose" title="关闭">×</button>
      </div>
      <div class="nc-row"><span class="nc-k">文本</span><span class="nc-v" id="ncText"></span></div>
      <div class="nc-row"><span class="nc-k">ID</span><span class="nc-v" id="ncId"></span></div>
      <div class="nc-row"><span class="nc-k">描述</span><span class="nc-v" id="ncDesc"></span></div>
      <div class="nc-row"><span class="nc-k">坐标</span><span class="nc-v" id="ncBounds"></span></div>
      <div class="nc-actions">
        <button class="nc-btn" id="ncCopyId">复制ID</button>
        <button class="nc-btn" id="ncCopyText">复制文本</button>
        <button class="nc-btn" id="ncCopyCoord">复制坐标</button>
        <button class="nc-btn primary" id="ncTap">点击控件</button>
      </div>
    </div>
  </main>

  <aside id="rightbar">
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th class="c-idx">序号</th>
            <th class="c-coord">坐标</th>
            <th class="c-color">颜色</th>
            <th class="c-op">操作</th>
          </tr>
        </thead>
        <tbody id="markerRows"></tbody>
      </table>
    </div>
  </aside>
</div>

<div id="modalMask" class="hidden">
  <div class="modal">
    <h3>设备选择</h3>
    <select id="deviceSelect" size="5"></select>
    <div class="connect-row">
      <input id="addrInput" placeholder="127.0.0.1:1093">
      <button class="btn" id="btnConnect">连接</button>
    </div>
    <div class="modal-actions">
      <button class="btn" id="btnRefresh">刷新</button>
      <button class="btn primary" id="btnSelectDevice">连接设备</button>
      <button class="btn" id="btnModalClose">关闭</button>
    </div>
  </div>
</div>

<div id="rowMenu" class="ctx-menu hidden">
  <div class="ctx-item" data-act="copyCoord">复制坐标</div>
  <div class="ctx-item" data-act="copyColor">复制颜色值</div>
  <div class="ctx-sep"></div>
  <div class="ctx-item danger" data-act="delete">删除选中行</div>
  <div class="ctx-item danger" data-act="clear">清空列表</div>
</div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
