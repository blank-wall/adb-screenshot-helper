import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface AdbDevice {
  serial: string;
  state: string;
}

export interface AdbConfig {
  adbPath: string;
  timeout: number;
}

/** 截图允许的最小超时（毫秒），云手机 / 网络 adb 链路较慢 */
const MIN_SCREENSHOT_TIMEOUT = 60_000;

function run(
  adbPath: string,
  args: string[],
  timeout: number,
  label = 'adb 命令'
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      adbPath,
      args,
      {
        timeout,
        maxBuffer: 128 * 1024 * 1024,
        windowsHide: true,
        encoding: 'buffer'
      },
      (err, stdout, stderr) => {
        if (err) {
          const ee = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
          const detail = stderr.length ? stderr.toString('utf8').trim() : '';
          let message = detail || err.message;
          if (ee.killed || ee.signal === 'SIGTERM' || /timed out/i.test(err.message)) {
            message =
              `${label}超时（${timeout / 1000} 秒）。` +
              (label.includes('截图')
                ? '云手机或网络设备画面传输较慢，可在设置中调大 adbScreenshot.commandTimeout 后重试。'
                : '设备响应过慢，请检查连接状态，或在设置中调大 adbScreenshot.commandTimeout。') +
              (detail ? `\n${detail}` : '');
          }
          const error = new Error(message);
          (error as NodeJS.ErrnoException).code = ee.code;
          reject(error);
          return;
        }
        resolve(stdout);
      }
    );
  });
}

/** 把 ENOENT 等错误转成对用户友好的提示 */
function friendly(err: unknown): Error {
  const e = err as NodeJS.ErrnoException;
  if (e?.code === 'ENOENT') {
    return new Error('未找到 adb，请确认已安装 platform-tools，或在设置中配置 adbScreenshot.adbPath');
  }
  return err instanceof Error ? err : new Error(String(err));
}

/** 解析 `adb devices` 输出 */
export async function listDevices(cfg: AdbConfig): Promise<AdbDevice[]> {
  try {
    const out = (await run(cfg.adbPath, ['devices'], cfg.timeout)).toString('utf8');
    const list: AdbDevice[] = [];
    const lines = out.split(/\r?\n/);
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('List of devices')) {
        continue;
      }
      // 形如：127.0.0.1:1093\tdevice
      const parts = line.split(/\s+/);
      if (parts.length >= 2) {
        list.push({ serial: parts[0], state: parts[1] });
      }
    }
    return list;
  } catch (err) {
    throw friendly(err);
  }
}

/** `adb connect host:port`，返回 adb 的原始输出 */
export async function connectDevice(cfg: AdbConfig, address: string): Promise<string> {
  const addr = address.trim();
  if (!/^[\w.\-]+:\d+$/.test(addr)) {
    throw new Error('设备地址格式不正确，应为 IP:端口，例如 127.0.0.1:1093');
  }
  try {
    const out = (await run(cfg.adbPath, ['connect', addr], cfg.timeout)).toString('utf8').trim();
    if (/failed|cannot|unable|refused/i.test(out)) {
      throw new Error(out);
    }
    return out;
  } catch (err) {
    throw friendly(err);
  }
}

function assertPng(buf: Buffer): void {
  if (buf.length < 8 || buf.toString('ascii', 1, 4) !== 'PNG') {
    throw new Error('设备返回的截图数据不是有效的 PNG，请确认设备已正常连接并授权 USB 调试');
  }
}

/**
 * 方式一：在设备端 screencap 存为文件，再 adb pull 拉取，最后清理。
 * 在云手机 / 网络 adb 链路上，exec-out 走 shell 流吞吐极低（实测 2.4MB 需 16 秒），
 * 而 pull 走 sync 协议只需 3~4 秒，因此优先使用本方式。
 */
async function screenshotViaPull(cfg: AdbConfig, serial: string, timeout: number): Promise<Buffer> {
  const remote = '/sdcard/.tuse_shot.png';
  const local = join(tmpdir(), `tuse-shot-${process.pid}-${Date.now()}.png`);
  try {
    await run(cfg.adbPath, ['-s', serial, 'shell', 'screencap', '-p', remote], timeout, '截图');
    await run(cfg.adbPath, ['-s', serial, 'pull', remote, local], timeout, '截图传输');
    const buf = await fs.readFile(local);
    assertPng(buf);
    return buf;
  } finally {
    await fs.rm(local, { force: true }).catch(() => undefined);
    run(cfg.adbPath, ['-s', serial, 'shell', 'rm', '-f', remote], 10_000, '清理临时截图').catch(
      () => undefined
    );
  }
}

/** 方式二：exec-out 直接输出 PNG（USB 真机快，云手机慢） */
async function screenshotViaExecOut(cfg: AdbConfig, serial: string, timeout: number): Promise<Buffer> {
  const buf = await run(
    cfg.adbPath,
    ['-s', serial, 'exec-out', 'screencap', '-p'],
    timeout,
    '截图'
  );
  assertPng(buf);
  return buf;
}

/**
 * 截取设备屏幕，返回 PNG 的 Buffer。
 * 优先「设备存文件 + pull」（对云手机/网络设备快数倍），失败时回退 exec-out。
 */
export async function screenshot(cfg: AdbConfig, serial: string): Promise<Buffer> {
  const timeout = Math.max(cfg.timeout, MIN_SCREENSHOT_TIMEOUT);
  let firstErr: unknown;
  try {
    return await screenshotViaPull(cfg, serial, timeout);
  } catch (err) {
    firstErr = err;
  }
  try {
    return await screenshotViaExecOut(cfg, serial, timeout);
  } catch (secondErr) {
    const a = firstErr instanceof Error ? firstErr.message : String(firstErr);
    const b = secondErr instanceof Error ? secondErr.message : String(secondErr);
    throw new Error(`截图失败（两种方式均未成功）：\n1) 设备存图拉取：${a}\n2) exec-out：${b}`);
  }
}

/**
 * 获取当前界面控件树：uiautomator dump 到设备文件，再 pull 拉取 XML。
 * 界面持续播放动画（如游戏）时 uiautomator 可能等不到空闲而报错，可重试。
 */
export async function dumpUiHierarchy(cfg: AdbConfig, serial: string): Promise<string> {
  const timeout = Math.max(cfg.timeout, MIN_SCREENSHOT_TIMEOUT);
  const remote = '/sdcard/.tuse_ui.xml';
  const local = join(tmpdir(), `tuse-ui-${process.pid}-${Date.now()}.xml`);
  try {
    const out = await run(
      cfg.adbPath,
      ['-s', serial, 'shell', 'uiautomator', 'dump', remote],
      timeout,
      '获取控件'
    );
    const dumped = out.toString('utf8');
    if (/error|cannot|failed/i.test(dumped) && !/dumped to/i.test(dumped)) {
      throw new Error(dumped.trim());
    }
    await run(cfg.adbPath, ['-s', serial, 'pull', remote, local], timeout, '控件数据传输');
    const xml = await fs.readFile(local, 'utf8');
    if (!xml.includes('<hierarchy')) {
      throw new Error('控件数据解析失败，未找到 hierarchy 节点');
    }
    return xml;
  } finally {
    await fs.rm(local, { force: true }).catch(() => undefined);
    run(cfg.adbPath, ['-s', serial, 'shell', 'rm', '-f', remote], 10_000, '清理控件临时文件').catch(
      () => undefined
    );
  }
}

/** 对设备坐标执行一次点击（input tap） */
export async function tapPoint(cfg: AdbConfig, serial: string, x: number, y: number): Promise<void> {
  const timeout = Math.max(cfg.timeout, 15_000);
  await run(
    cfg.adbPath,
    ['-s', serial, 'shell', 'input', 'tap', String(Math.round(x)), String(Math.round(y))],
    timeout,
    '点击'
  );
}
