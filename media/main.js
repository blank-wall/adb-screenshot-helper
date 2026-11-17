'use strict';

(function () {
  // @ts-check
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);

  const els = {
    deviceDot: $('deviceDot'),
    deviceName: $('deviceName'),
    btnDevices: $('btnDevices'),
    btnCapture: $('btnCapture'),
    btnLoad: $('btnLoad'),
    btnSaveFull: $('btnSaveFull'),
    modePick: $('modePick'),
    modeRect: $('modeRect'),
    modePan: $('modePan'),
    cropSize: $('cropSize'),
    btnSaveCrop: $('btnSaveCrop'),
    btnSaveAll: $('btnSaveAll'),
    btnClearSel: $('btnClearSel'),
    btnClear: $('btnClear'),
    btnGenCode: $('btnGenCode'),
    codeFormat: $('codeFormat'),
    codeBox: $('codeBox'),
    btnCopyCode: $('btnCopyCode'),
    stage: $('stage'),
    emptyHint: $('emptyHint'),
    screen: $('screen'),
    zoomOut: $('zoomOut'),
    zoomLabel: $('zoomLabel'),
    zoomIn: $('zoomIn'),
    zoomFit: $('zoomFit'),
    loupe: $('loupe'),
    loupeCanvas: $('loupeCanvas'),
    loupeInfo: $('loupeInfo'),
    toast: $('toast'),
    markerRows: $('markerRows'),
    modalMask: $('modalMask'),
    deviceSelect: $('deviceSelect'),
    addrInput: $('addrInput'),
    btnConnect: $('btnConnect'),
    btnRefresh: $('btnRefresh'),
    btnSelectDevice: $('btnSelectDevice'),
    btnModalClose: $('btnModalClose'),
    rowMenu: $('rowMenu'),
    btnDumpUi: $('btnDumpUi'),
    uiShowAll: $('uiShowAll'),
    nodeCard: $('nodeCard'),
    ncTitle: $('ncTitle'),
    ncText: $('ncText'),
    ncId: $('ncId'),
    ncDesc: $('ncDesc'),
    ncBounds: $('ncBounds'),
    ncClose: $('ncClose'),
    ncCopyId: $('ncCopyId'),
    ncCopyText: $('ncCopyText'),
    ncCopyCoord: $('ncCopyCoord'),
    ncTap: $('ncTap')
  };

  // ---------------- 状态 ----------------

  let cfg = {
    cropSize: 64,
    magnifierPixels: 15,
    filenamePrefix: 'crop'
  };

  let orig = null; // 离屏 canvas，保持原图分辨率
  let origCtx = null;
  let imgW = 0;
  let imgH = 0;
  let serial = '';
  let imageLabel = '';

  let markers = [];
  let nextId = 1;
  let mode = 'pick';
  let selection = null;
  let selectedId = null;

  // 视图相机：scale 缩放，ox/oy 为 canvas 左上角在 stage 中的位置
  const view = { scale: 1, ox: 0, oy: 0 };
  let minScale = 0.05;
  let maxScale = 30;

  let press = null;
  let dragging = false;
  let mouse = null;
  let panning = null;
  let spaceDown = false;
  let menuMarkerId = null;

  // 控件树
  let uiNodes = [];
  let uiShowAllNodes = false;
  let hoverNodeIdx = -1;
  let selectedNodeIdx = -1;

  const DPR = window.devicePixelRatio || 1;
  const ctx = els.screen.getContext('2d');
  const loupeCtx = els.loupeCanvas.getContext('2d');

  // ---------------- 工具函数 ----------------

  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

  function toHex(r, g, b) {
    return (
      '#' +
      [r, g, b]
        .map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0'))
        .join('')
    );
  }

  function nowStamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return (
      `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
      `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
    );
  }

  let toastTimer = null;
  function showToast(msg, kind) {
    const t = els.toast;
    t.textContent = msg;
    t.className = kind === 'error' ? 'error' : kind === 'ok' ? 'ok' : '';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), 2800);
  }

  function b64ToBlob(b64) {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      u8[i] = bin.charCodeAt(i);
    }
    return new Blob([u8]);
  }

  function blobToB64(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result).split(',')[1]);
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(blob);
    });
  }

  // ---------------- 与扩展端通信 ----------------

  let reqSeq = 0;
  const pending = new Map();

  function request(type, payload) {
    return new Promise((resolve, reject) => {
      const id = ++reqSeq;
      pending.set(id, { resolve, reject });
      vscode.postMessage(Object.assign({ id, type }, payload || {}));
    });
  }

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.ok) {
        p.resolve(m.result);
      } else {
        p.reject(new Error(m.error));
      }
      return;
    }
    if (m.type === 'configChanged') {
      applyConfig(m.config);
    } else if (m.type === 'doCapture') {
      void doCapture();
    } else if (m.type === 'doOpenDevices') {
      void openDeviceModal();
    }
  });

  function applyConfig(c) {
    cfg = Object.assign({}, cfg, c);
    els.cropSize.value = cfg.cropSize;
    if (mouse && orig) {
      drawLoupe();
    }
  }

  async function init() {
    bindEvents();
    try {
      applyConfig(await request('getConfig'));
    } catch (e) {
      showToast(e.message, 'error');
    }
  }

  // ---------------- 图片载入 ----------------

  async function loadFromData(data, label) {
    const bmp = await createImageBitmap(b64ToBlob(data));
    imgW = bmp.width;
    imgH = bmp.height;

    orig = document.createElement('canvas');
    orig.width = imgW;
    orig.height = imgH;
    origCtx = orig.getContext('2d', { willReadFrequently: true });
    origCtx.drawImage(bmp, 0, 0);
    bmp.close && bmp.close();

    imageLabel = label || '';
    // 右侧坐标列表保留（便于连续截图累积采集），仅隐藏画面上的旧标记点并清空框选
    for (const m of markers) {
      m.visible = false;
    }
    selection = null;
    selectedId = null;
    mouse = null;
    closeRowMenu();
    // 界面已变化，控件树失效，清空控件框与卡片
    uiNodes = [];
    hoverNodeIdx = -1;
    closeNodeCard();

    els.emptyHint.classList.add('hidden');
    els.screen.classList.remove('hidden');
    els.loupe.classList.add('hidden');

    fit();
    renderTable();
  }

  // ---------------- 布局与渲染 ----------------

  function fit() {
    if (!orig) {
      return;
    }
    const pad = 24;
    const sw = (els.stage.clientWidth - pad * 2) / imgW;
    const sh = (els.stage.clientHeight - pad * 2) / imgH;
    view.scale = Math.min(sw, sh);
    view.ox = (els.stage.clientWidth - imgW * view.scale) / 2;
    view.oy = (els.stage.clientHeight - imgH * view.scale) / 2;
    // 限制最大缩放，避免超出浏览器 canvas 尺寸上限
    maxScale = Math.min(30, 12000 / imgW, 12000 / imgH);
    applyView();
  }

  function applyView() {
    const w = Math.round(imgW * view.scale);
    const h = Math.round(imgH * view.scale);
    els.screen.style.left = view.ox + 'px';
    els.screen.style.top = view.oy + 'px';
    els.screen.style.width = w + 'px';
    els.screen.style.height = h + 'px';
    els.screen.width = Math.round(w * DPR);
    els.screen.height = Math.round(h * DPR);
    els.zoomLabel.textContent = Math.round(view.scale * 100) + '%';
    render();
  }

  /** 以 stage 坐标 (mx,my) 为锚点按 factor 缩放 */
  function zoomAt(mx, my, factor) {
    const ix = (mx - view.ox) / view.scale;
    const iy = (my - view.oy) / view.scale;
    const ns = clamp(view.scale * factor, minScale, maxScale);
    view.scale = ns;
    view.ox = mx - ix * ns;
    view.oy = my - iy * ns;
    applyView();
  }

  window.addEventListener('resize', () => {
    if (orig) {
      fit();
    }
  });

  function eventToImage(e) {
    const r = els.screen.getBoundingClientRect();
    const cx = e.clientX - r.left;
    const cy = e.clientY - r.top;
    const x = clamp(Math.floor((cx / r.width) * imgW), 0, imgW - 1);
    const y = clamp(Math.floor((cy / r.height) * imgH), 0, imgH - 1);
    return { x, y, cx: clamp(cx, 0, r.width), cy: clamp(cy, 0, r.height) };
  }

  function pixelAt(x, y) {
    const d = origCtx.getImageData(x, y, 1, 1).data;
    return { r: d[0], g: d[1], b: d[2] };
  }

  function render() {
    if (!orig) {
      return;
    }
    const vw = imgW * view.scale;
    const vh = imgH * view.scale;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, vw, vh);
    ctx.imageSmoothingEnabled = view.scale < 1;
    ctx.drawImage(orig, 0, 0, imgW, imgH, 0, 0, vw, vh);

    // 控件框（紫色，位于最底层，避免遮挡标记与框选）
    drawUiNodes();

    // 已确认的框选
    if (selection) {
      drawRect(selection.x, selection.y, selection.w, selection.h);
    }

    // 拖拽中的框
    if (mode === 'rect' && press && dragging && mouse) {
      const x = Math.min(press.x, mouse.x);
      const y = Math.min(press.y, mouse.y);
      const w = Math.abs(mouse.x - press.x) + 1;
      const h = Math.abs(mouse.y - press.y) + 1;
      drawRect(x, y, w, h);
    }

    // 标记点（重新截图后旧点默认隐藏；在右侧表格选中某行时临时显示其位置）
    for (const m of markers) {
      if (!m.visible && m.id !== selectedId) {
        continue;
      }
      const px = m.x * view.scale;
      const py = m.y * view.scale;
      const active = m.id === selectedId;
      const radius = active ? 9 : 7;
      ctx.beginPath();
      ctx.arc(px, py, radius, 0, Math.PI * 2);
      ctx.fillStyle = active ? 'rgba(255,214,10,0.25)' : 'rgba(54,240,107,0.22)';
      ctx.fill();
      ctx.lineWidth = active ? 2 : 1.5;
      ctx.strokeStyle = active ? '#ffd60a' : '#36f06b';
      ctx.stroke();
      ctx.fillStyle = active ? '#ffd60a' : '#36f06b';
      ctx.font = `${active ? 11 : 10}px var(--vscode-font-family, sans-serif)`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(m.seq), px, py + 0.5);
    }

    // 十字线
    if (mouse) {
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(mouse.cx + 0.5, 0);
      ctx.lineTo(mouse.cx + 0.5, vh);
      ctx.moveTo(0, mouse.cy + 0.5);
      ctx.lineTo(vw, mouse.cy + 0.5);
      ctx.stroke();
    }
  }

  function drawRect(x, y, w, h) {
    const rx = x * view.scale;
    const ry = y * view.scale;
    const rw = w * view.scale;
    const rh = h * view.scale;
    ctx.fillStyle = 'rgba(54,240,107,0.12)';
    ctx.fillRect(rx, ry, rw, rh);
    ctx.strokeStyle = '#36f06b';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(rx + 0.5, ry + 0.5, rw - 1, rh - 1);
  }

  // ---------------- 放大镜 ----------------

  function drawLoupe() {
    if (!mouse || !orig) {
      return;
    }
    let N = cfg.magnifierPixels | 0;
    if (N % 2 === 0) {
      N += 1;
    }
    const cell = 14;
    const size = N * cell;
    if (els.loupeCanvas.width !== size) {
      els.loupeCanvas.width = size;
      els.loupeCanvas.height = size;
    }
    const half = (N - 1) / 2;

    const sw = Math.min(N, imgW);
    const sh = Math.min(N, imgH);
    const sx = clamp(mouse.x - half, 0, imgW - sw);
    const sy = clamp(mouse.y - half, 0, imgH - sh);
    const src = origCtx.getImageData(sx, sy, sw, sh).data;

    const out = loupeCtx.createImageData(N, N);
    for (let yy = 0; yy < N; yy++) {
      for (let xx = 0; xx < N; xx++) {
        const gx = mouse.x - half + xx;
        const gy = mouse.y - half + yy;
        const di = (yy * N + xx) * 4;
        if (gx >= 0 && gx < imgW && gy >= 0 && gy < imgH) {
          const si = ((gy - sy) * sw + (gx - sx)) * 4;
          out.data[di] = src[si];
          out.data[di + 1] = src[si + 1];
          out.data[di + 2] = src[si + 2];
          out.data[di + 3] = src[si + 3];
        } else {
          out.data[di + 3] = 0;
        }
      }
    }

    const tmp = document.createElement('canvas');
    tmp.width = N;
    tmp.height = N;
    tmp.getContext('2d').putImageData(out, 0, 0);

    loupeCtx.imageSmoothingEnabled = false;
    loupeCtx.clearRect(0, 0, size, size);
    loupeCtx.drawImage(tmp, 0, 0, N, N, 0, 0, size, size);

    loupeCtx.strokeStyle = 'rgba(140,140,140,0.35)';
    loupeCtx.lineWidth = 1;
    for (let i = 1; i < N; i++) {
      loupeCtx.beginPath();
      loupeCtx.moveTo(i * cell + 0.5, 0);
      loupeCtx.lineTo(i * cell + 0.5, size);
      loupeCtx.moveTo(0, i * cell + 0.5);
      loupeCtx.lineTo(size, i * cell + 0.5);
      loupeCtx.stroke();
    }

    // 中心像素绿色高亮框
    loupeCtx.strokeStyle = '#36f06b';
    loupeCtx.lineWidth = 2;
    loupeCtx.strokeRect(half * cell + 1, half * cell + 1, cell - 2, cell - 2);

    const c = pixelAt(mouse.x, mouse.y);
    els.loupeInfo.textContent = `x ${mouse.x} y ${mouse.y} C ${toHex(c.r, c.g, c.b)}`;
  }

  function positionLoupe(e) {
    const L = els.loupe;
    const w = L.offsetWidth;
    const h = L.offsetHeight;
    const sr = els.stage.getBoundingClientRect();
    let lx = e.clientX - sr.left + 26;
    let ly = e.clientY - sr.top + 26;
    if (lx + w > sr.width - 8) {
      lx = e.clientX - sr.left - w - 26;
    }
    if (ly + h > sr.height - 8) {
      ly = e.clientY - sr.top - h - 26;
    }
    L.style.left = Math.max(4, lx) + 'px';
    L.style.top = Math.max(4, ly) + 'px';
  }

  // ---------------- 标记 ----------------

  function addMarker(x, y) {
    const c = pixelAt(x, y);
    const m = {
      id: nextId++,
      seq: markers.length + 1,
      x,
      y,
      color: toHex(c.r, c.g, c.b),
      visible: true
    };
    markers.push(m);
    selectedId = m.id;
    renderTable();
  }

  function deleteMarker(id) {
    markers = markers.filter((m) => m.id !== id);
    markers.forEach((m, i) => {
      m.seq = i + 1;
    });
    if (selectedId === id) {
      selectedId = null;
    }
    render();
    renderTable();
  }

  function renderTable() {
    const tb = els.markerRows;
    tb.innerHTML = '';
    for (const m of markers) {
      const tr = document.createElement('tr');
      tr.dataset.id = String(m.id);
      if (m.id === selectedId) {
        tr.className = 'selected';
      }
      tr.innerHTML =
        `<td class="c-idx">${m.seq}</td>` +
        `<td>${m.x}, ${m.y}</td>` +
        `<td><span class="swatch" style="background:${m.color}"></span>${m.color}</td>` +
        `<td class="c-op"><button class="del" title="删除该标记">×</button></td>`;
      tr.addEventListener('click', (e) => {
        if (e.target && e.target.classList.contains('del')) {
          deleteMarker(m.id);
        } else {
          selectedId = m.id;
          render();
          renderTable();
        }
      });
      tb.appendChild(tr);
    }
  }

  // ---------------- 标记表右键菜单 ----------------

  function openRowMenu(e, id) {
    menuMarkerId = id;
    selectedId = id;
    render();
    renderTable();
    const menu = els.rowMenu;
    menu.classList.remove('hidden');
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    let x = e.clientX;
    let y = e.clientY;
    if (x + mw > window.innerWidth - 4) {
      x = window.innerWidth - mw - 4;
    }
    if (y + mh > window.innerHeight - 4) {
      y = window.innerHeight - mh - 4;
    }
    menu.style.left = Math.max(4, x) + 'px';
    menu.style.top = Math.max(4, y) + 'px';
  }

  function closeRowMenu() {
    menuMarkerId = null;
    els.rowMenu.classList.add('hidden');
  }

  async function copyViaHost(text, okMsg) {
    try {
      await request('copyText', { text });
      showToast(okMsg || '已复制到剪贴板', 'ok');
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  async function onRowMenuAction(act) {
    const m = markers.find((x) => x.id === menuMarkerId);
    if (act === 'copyCoord' && m) {
      await copyViaHost(`${m.x}, ${m.y}`, `已复制坐标 ${m.x}, ${m.y}`);
    } else if (act === 'copyColor' && m) {
      await copyViaHost(m.color, `已复制颜色值 ${m.color}`);
    } else if (act === 'delete') {
      if (m) {
        deleteMarker(m.id);
        showToast('已删除选中行', 'ok');
      }
    } else if (act === 'clear') {
      markers = [];
      nextId = 1;
      selectedId = null;
      selection = null;
      render();
      renderTable();
      showToast('标记列表已清空', 'ok');
    }
    closeRowMenu();
  }

  // ---------------- 设备控件 ----------------

  /** 解析 uiautomator dump 出的 XML 为控件数组 */
  function parseUiXml(xml) {
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    const out = [];
    const nodes = doc.getElementsByTagName('node');
    for (const node of nodes) {
      const g = node.getAttribute('bounds') || '';
      const mm = g.match(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);
      if (!mm) {
        continue;
      }
      const clickable = node.getAttribute('clickable') === 'true';
      const longClickable = node.getAttribute('long-clickable') === 'true';
      const scrollable = node.getAttribute('scrollable') === 'true';
      out.push({
        text: node.getAttribute('text') || '',
        resourceId: node.getAttribute('resource-id') || '',
        className: node.getAttribute('class') || '',
        pkg: node.getAttribute('package') || '',
        contentDesc: node.getAttribute('content-desc') || '',
        bounds: [Number(mm[1]), Number(mm[2]), Number(mm[3]), Number(mm[4])],
        clickable,
        longClickable,
        scrollable,
        interactive: clickable || longClickable || scrollable
      });
    }
    return out;
  }

  /** 命中检测：返回最内层（XML 中最后匹配的）控件下标 */
  function nodeAt(x, y) {
    let hit = -1;
    for (let i = 0; i < uiNodes.length; i++) {
      const n = uiNodes[i];
      if (!(uiShowAllNodes || n.interactive)) {
        continue;
      }
      const b = n.bounds;
      if (x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3]) {
        hit = i;
      }
    }
    return hit;
  }

  /** 在 canvas 上叠加控件框 */
  function drawUiNodes() {
    if (!uiNodes.length) {
      return;
    }
    for (let i = 0; i < uiNodes.length; i++) {
      const n = uiNodes[i];
      if (!(uiShowAllNodes || n.interactive)) {
        continue;
      }
      const isHover = i === hoverNodeIdx;
      const isSel = i === selectedNodeIdx;
      const b = n.bounds;
      const x = b[0] * view.scale;
      const y = b[1] * view.scale;
      const w = Math.max(1, (b[2] - b[0]) * view.scale);
      const h = Math.max(1, (b[3] - b[1]) * view.scale);
      if (isSel || isHover) {
        ctx.fillStyle = isSel ? 'rgba(139,92,246,0.22)' : 'rgba(139,92,246,0.12)';
        ctx.fillRect(x, y, w, h);
      }
      ctx.lineWidth = isSel || isHover ? 1.8 : 1;
      ctx.strokeStyle = isSel
        ? '#a78bfa'
        : isHover
          ? '#c4b5fd'
          : 'rgba(139,92,246,0.42)';
      ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);

      // 悬停标签：显示文本 / 描述 / 资源 ID
      if (isHover) {
        const label = n.text || n.contentDesc || n.resourceId.split('/').pop() || '';
        if (label) {
          ctx.font = '10px var(--vscode-font-family, sans-serif)';
          const tw = Math.min(ctx.measureText(label).width + 8, w);
          ctx.fillStyle = 'rgba(30,27,75,0.92)';
          ctx.fillRect(x, y - 15, tw, 14);
          ctx.fillStyle = '#ddd6fe';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(label.length > 24 ? label.slice(0, 23) + '…' : label, x + 4, y - 8);
        }
      }
    }
  }

  function selectNode(i) {
    selectedNodeIdx = i;
    showNodeCard(uiNodes[i]);
  }

  function closeNodeCard() {
    selectedNodeIdx = -1;
    els.nodeCard.classList.add('hidden');
  }

  /** 弹出控件信息卡并定位到控件旁 */
  function showNodeCard(n) {
    const card = els.nodeCard;
    els.ncTitle.textContent = n.className.split('.').pop() || 'node';
    els.ncText.textContent = n.text || '—';
    els.ncId.textContent = n.resourceId || '—';
    els.ncId.title = n.resourceId;
    els.ncDesc.textContent = n.contentDesc || '—';
    const b = n.bounds;
    const cx = Math.round((b[0] + b[2]) / 2);
    const cy = Math.round((b[1] + b[3]) / 2);
    els.ncBounds.textContent = `[${b[0]},${b[1]}][${b[2]},${b[3]}] 中心 ${cx},${cy}`;
    card.classList.remove('hidden');

    const cw = card.offsetWidth;
    const ch = card.offsetHeight;
    let left = b[0] * view.scale + view.ox;
    let top = b[3] * view.scale + view.oy + 8;
    if (left + cw > els.stage.clientWidth - 8) {
      left = els.stage.clientWidth - cw - 8;
    }
    if (top + ch > els.stage.clientHeight - 8) {
      top = b[1] * view.scale + view.oy - ch - 8;
    }
    card.style.left = Math.max(4, left) + 'px';
    card.style.top = Math.max(4, top) + 'px';
  }

  // ---------------- 裁剪与主色 ----------------

  function cropRegion(sx, sy, sw, sh) {
    const c = document.createElement('canvas');
    c.width = sw;
    c.height = sh;
    const cc = c.getContext('2d', { willReadFrequently: true });
    cc.drawImage(orig, sx, sy, sw, sh, 0, 0, sw, sh);
    const color = dominantColor(cc, sw, sh);
    return new Promise((resolve, reject) => {
      c.toBlob((b) => (b ? resolve({ blob: b, color }) : reject(new Error('裁剪失败'))), 'image/png');
    });
  }

  // 量化直方图（每通道 32 档）求主色，返回桶内平均色
  function dominantColor(cc, w, h) {
    const d = cc.getImageData(0, 0, w, h).data;
    const buckets = new Map();
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 128) {
        continue;
      }
      const key = ((d[i] >> 5) << 10) | ((d[i + 1] >> 5) << 5) | (d[i + 2] >> 5);
      let b = buckets.get(key);
      if (!b) {
        b = { n: 0, r: 0, g: 0, bl: 0 };
        buckets.set(key, b);
      }
      b.n++;
      b.r += d[i];
      b.g += d[i + 1];
      b.bl += d[i + 2];
    }
    let best = null;
    for (const b of buckets.values()) {
      if (!best || b.n > best.n) {
        best = b;
      }
    }
    if (!best) {
      return '#000000';
    }
    return toHex(best.r / best.n, best.g / best.n, best.bl / best.n);
  }

  async function saveOneCrop(target, toFolder) {
    let sx;
    let sy;
    let sw;
    let sh;
    let kind;
    if (target.kind === 'rect') {
      const s = target.selection;
      sx = s.x;
      sy = s.y;
      sw = s.w;
      sh = s.h;
      kind = 'rect';
    } else {
      const m = target.marker;
      let n = parseInt(els.cropSize.value, 10);
      if (!Number.isFinite(n) || n < 8) {
        n = cfg.cropSize;
      }
      n = Math.min(n, imgW, imgH);
      sw = n;
      sh = n;
      sx = clamp(m.x - Math.floor(n / 2), 0, imgW - n);
      sy = clamp(m.y - Math.floor(n / 2), 0, imgH - n);
      kind = 'point';
    }
    const r = await cropRegion(sx, sy, sw, sh);
    const data = await blobToB64(r.blob);
    return request('saveCrop', {
      kind,
      x: sx,
      y: sy,
      w: sw,
      h: sh,
      color: r.color,
      data,
      toFolder: !!toFolder
    });
  }

  // ---------------- 代码生成 ----------------

  function genCode() {
    if (!markers.length) {
      showToast('还没有标记点', 'error');
      return;
    }
    const fmt = els.codeFormat.value;
    const lines = markers.map((m) => {
      if (fmt === 'color') {
        return (
          `zzCommonFunc.colorClickAdHandle('${m.color}', true, ` +
          `{ threshold: 4, region: [${m.x}, ${m.y}, 50, 50] }, ` +
          `'${m.color}', tempImag, pkgName, 1000, true, false)`
        );
      }
      if (fmt === 'absolute') {
        return `zzCommonFunc.clickAbsoluteLocation(${m.x},${m.y}, '${m.seq}')`;
      }
      return `adb ${serial ? `-s ${serial} ` : ''}shell input tap ${m.x} ${m.y}`;
    });
    els.codeBox.value = lines.join('\n');
    showToast('代码已生成', 'ok');
  }

  // ---------------- ADB 动作 ----------------

  async function doCapture() {
    if (!serial) {
      await openDeviceModal();
      if (!serial) {
        return;
      }
    }
    try {
      showToast('正在截屏…');
      const r = await request('capture', { serial });
      await loadFromData(r.data, serial);
      showToast('截图成功', 'ok');
    } catch (e) {
      showToast(e.message, 'error');
    }
  }

  async function openDeviceModal() {
    els.modalMask.classList.remove('hidden');
    els.addrInput.value = '';
    await refreshDevices();
  }

  async function refreshDevices() {
    try {
      const r = await request('listDevices');
      const sel = els.deviceSelect;
      sel.innerHTML = '';
      if (!r.devices.length) {
        const o = document.createElement('option');
        o.textContent = '（未发现设备，可在下方输入地址连接）';
        o.disabled = true;
        sel.add(o);
        return;
      }
      for (const d of r.devices) {
        const o = document.createElement('option');
        o.value = d.serial;
        o.textContent = d.state === 'device' ? d.serial : `${d.serial}（${d.state}）`;
        o.disabled = d.state !== 'device';
        if (d.serial === serial) {
          o.selected = true;
        }
        sel.add(o);
      }
    } catch (e) {
      showToast(e.message, 'error');
    }
  }

  // ---------------- 事件绑定 ----------------

  function bindEvents() {
    els.btnDevices.addEventListener('click', () => void openDeviceModal());
    els.btnCapture.addEventListener('click', () => void doCapture());

    // 获取设备控件
    els.btnDumpUi.addEventListener('click', async () => {
      if (!serial) {
        await openDeviceModal();
        if (!serial) {
          return;
        }
      }
      try {
        showToast('正在获取控件…');
        const r = await request('dumpUi', { serial });
        uiNodes = parseUiXml(r.xml);
        hoverNodeIdx = -1;
        closeNodeCard();
        const interactive = uiNodes.filter((n) => n.interactive).length;
        showToast(`已获取 ${uiNodes.length} 个控件（可交互 ${interactive} 个）`, 'ok');
        render();
      } catch (e) {
        showToast(e.message, 'error');
      }
    });

    els.uiShowAll.addEventListener('change', () => {
      uiShowAllNodes = els.uiShowAll.checked;
      hoverNodeIdx = -1;
      render();
    });

    // 控件信息卡操作
    els.ncClose.addEventListener('click', () => closeNodeCard());

    els.ncCopyId.addEventListener('click', async () => {
      const n = uiNodes[selectedNodeIdx];
      if (!n) {
        return;
      }
      if (n.resourceId) {
        await copyViaHost(n.resourceId, '已复制资源 ID');
      } else {
        showToast('该控件没有资源 ID', 'error');
      }
    });

    els.ncCopyText.addEventListener('click', async () => {
      const n = uiNodes[selectedNodeIdx];
      if (!n) {
        return;
      }
      const t = n.text || n.contentDesc;
      if (t) {
        await copyViaHost(t, '已复制文本');
      } else {
        showToast('该控件没有文本或描述', 'error');
      }
    });

    els.ncCopyCoord.addEventListener('click', async () => {
      const n = uiNodes[selectedNodeIdx];
      if (!n) {
        return;
      }
      const b = n.bounds;
      const cx = Math.round((b[0] + b[2]) / 2);
      const cy = Math.round((b[1] + b[3]) / 2);
      await copyViaHost(`${cx}, ${cy}`, `已复制中心坐标 ${cx}, ${cy}`);
    });

    els.ncTap.addEventListener('click', async () => {
      const n = uiNodes[selectedNodeIdx];
      if (!n) {
        return;
      }
      const b = n.bounds;
      const cx = Math.round((b[0] + b[2]) / 2);
      const cy = Math.round((b[1] + b[3]) / 2);
      try {
        await request('tap', { serial, x: cx, y: cy });
        showToast(`已点击控件中心 ${cx}, ${cy}`, 'ok');
        closeNodeCard();
      } catch (e) {
        showToast(e.message, 'error');
      }
    });

    els.btnLoad.addEventListener('click', async () => {
      try {
        const r = await request('loadImage');
        if (r.cancelled) {
          return;
        }
        await loadFromData(r.data, r.name);
        showToast('图片已载入', 'ok');
      } catch (e) {
        showToast(e.message, 'error');
      }
    });

    els.btnSaveFull.addEventListener('click', async () => {
      if (!orig) {
        showToast('请先截取屏幕或载入图片', 'error');
        return;
      }
      try {
        const blob = await new Promise((res) => orig.toBlob(res, 'image/png'));
        const data = await blobToB64(blob);
        const label = (serial || imageLabel || 'screen').replace(/[\\/:*?"<>|\s]+/g, '_');
        const r = await request('saveFullImage', {
          data,
          defaultName: `full_${label}_${nowStamp()}.png`
        });
        if (!r.cancelled) {
          showToast('图片已保存', 'ok');
        }
      } catch (e) {
        showToast(e.message, 'error');
      }
    });

    els.modePick.addEventListener('click', () => setMode('pick'));
    els.modeRect.addEventListener('click', () => setMode('rect'));
    els.modePan.addEventListener('click', () => setMode('pan'));

    els.btnSaveCrop.addEventListener('click', async () => {
      if (!orig) {
        showToast('请先截取屏幕或载入图片', 'error');
        return;
      }
      try {
        let target;
        if (selection) {
          target = { kind: 'rect', selection };
        } else {
          const m = selectedId
            ? markers.find((x) => x.id === selectedId)
            : markers[markers.length - 1];
          if (!m) {
            throw new Error('请先在图上点击标记一个点，或切换到框选模式拖出范围');
          }
          target = { kind: 'point', marker: m };
        }
        const r = await saveOneCrop(target);
        if (r.cancelled) {
          return;
        }
        showToast(`已保存：${r.name}`, 'ok');
      } catch (e) {
        showToast(e.message, 'error');
      }
    });

    els.btnSaveAll.addEventListener('click', async () => {
      if (!orig) {
        showToast('请先截取屏幕或载入图片', 'error');
        return;
      }
      if (!markers.length) {
        showToast('还没有标记点', 'error');
        return;
      }
      // 批量保存：先弹一次目录选择，所有小图存入该目录
      const folder = await request('chooseSaveFolder');
      if (folder.cancelled) {
        return;
      }
      let okCount = 0;
      let lastErr = '';
      for (const m of markers) {
        try {
          await saveOneCrop({ kind: 'point', marker: m }, true);
          okCount++;
          showToast(`正在批量保存 ${okCount}/${markers.length}…`);
        } catch (e) {
          lastErr = e.message;
        }
      }
      if (okCount === markers.length) {
        showToast(`批量完成，共保存 ${okCount} 张小图`, 'ok');
      } else {
        showToast(`完成 ${okCount}/${markers.length}${lastErr ? '，错误：' + lastErr : ''}`, 'error');
      }
    });

    els.btnClearSel.addEventListener('click', () => {
      selection = null;
      render();
    });

    els.btnClear.addEventListener('click', () => {
      markers = [];
      nextId = 1;
      selectedId = null;
      render();
      renderTable();
    });

    els.btnGenCode.addEventListener('click', () => genCode());

    // 切换代码格式时，若已有标记则立即按新格式重新生成
    els.codeFormat.addEventListener('change', () => {
      if (markers.length && els.codeBox.value) {
        genCode();
      }
    });

    els.btnCopyCode.addEventListener('click', async () => {
      if (!els.codeBox.value) {
        showToast('没有可复制的代码', 'error');
        return;
      }
      try {
        await request('copyText', { text: els.codeBox.value });
        showToast('已复制到剪贴板', 'ok');
      } catch (e) {
        showToast(e.message, 'error');
      }
    });

    // 鼠标交互
    els.screen.addEventListener('mousemove', (e) => {
      if (!orig || panning) {
        return;
      }
      const p = eventToImage(e);
      mouse = p;
      if (mode === 'rect' && press) {
        dragging = true;
      }
      // 控件命中检测（拖拽过程中不更新）
      if (uiNodes.length && !press) {
        hoverNodeIdx = nodeAt(p.x, p.y);
        if (mode === 'pick') {
          els.screen.style.cursor =
            hoverNodeIdx >= 0 && uiNodes[hoverNodeIdx].clickable ? 'pointer' : 'default';
        }
      }
      render();
      drawLoupe();
      els.loupe.classList.remove('hidden');
      positionLoupe(e);
    });

    els.screen.addEventListener('mouseleave', () => {
      mouse = null;
      hoverNodeIdx = -1;
      els.loupe.classList.add('hidden');
      render();
    });

    els.screen.addEventListener('mousedown', (e) => {
      if (!orig) {
        return;
      }
      // 中键 / 右键 / 空格+左键 / 拖动画面模式 → 平移视图
      const wantPan =
        e.button === 1 ||
        e.button === 2 ||
        (e.button === 0 && (spaceDown || mode === 'pan'));
      if (wantPan) {
        e.preventDefault();
        panning = { sx: e.clientX, sy: e.clientY, ox: view.ox, oy: view.oy };
        els.screen.classList.add('grabbing');
        return;
      }
      if (e.button !== 0) {
        return;
      }
      const p = eventToImage(e);
      press = { x: p.x, y: p.y, sx: e.clientX, sy: e.clientY };
      dragging = false;
    });

    // 平移（鼠标可能移出 canvas，需在 window 上监听）
    window.addEventListener('mousemove', (e) => {
      if (!panning) {
        return;
      }
      view.ox = panning.ox + (e.clientX - panning.sx);
      view.oy = panning.oy + (e.clientY - panning.sy);
      applyView();
    });

    window.addEventListener('mouseup', (e) => {
      if (panning) {
        panning = null;
        els.screen.classList.remove('grabbing');
        return;
      }
      if (!press) {
        return;
      }
      const clickDist = Math.hypot(e.clientX - press.sx, e.clientY - press.sy);
      if (mode === 'rect') {
        if (clickDist >= 3) {
          const p = eventToImage(e);
          const x = Math.min(press.x, p.x);
          const y = Math.min(press.y, p.y);
          const w = Math.abs(p.x - press.x) + 1;
          const h = Math.abs(p.y - press.y) + 1;
          if (w >= 2 && h >= 2) {
            selection = { x, y, w, h };
            selectedId = null;
            renderTable();
          }
        }
      } else if (clickDist < 4) {
        const p = eventToImage(e);
        // 命中控件时查看控件信息，不打标记
        if (uiNodes.length && mode === 'pick') {
          const hit = nodeAt(p.x, p.y);
          if (hit >= 0) {
            selectNode(hit);
            press = null;
            dragging = false;
            render();
            return;
          }
        }
        addMarker(p.x, p.y);
      }
      press = null;
      dragging = false;
      render();
    });

    // 标记表右键菜单
    els.markerRows.addEventListener('contextmenu', (e) => {
      const tr = e.target && e.target.closest ? e.target.closest('tr') : null;
      if (!tr) {
        return;
      }
      e.preventDefault();
      openRowMenu(e, Number(tr.dataset.id));
    });

    els.rowMenu.addEventListener('click', (e) => {
      const item = e.target.closest ? e.target.closest('.ctx-item') : null;
      if (item) {
        void onRowMenuAction(item.dataset.act);
      }
    });

    // 菜单打开时，点击菜单外 / 窗口失焦 / 缩放窗口 → 关闭
    window.addEventListener('mousedown', (e) => {
      if (els.rowMenu.classList.contains('hidden')) {
        return;
      }
      if (e.target.closest && e.target.closest('#rowMenu')) {
        return;
      }
      closeRowMenu();
    });
    window.addEventListener('blur', closeRowMenu);
    window.addEventListener('resize', closeRowMenu);

    // 设备弹窗
    els.btnRefresh.addEventListener('click', () => void refreshDevices());

    els.btnConnect.addEventListener('click', async () => {
      const addr = els.addrInput.value.trim();
      if (!addr) {
        showToast('请输入设备地址，例如 127.0.0.1:1093', 'error');
        return;
      }
      try {
        const r = await request('connect', { address: addr });
        showToast(r.message || '连接成功', 'ok');
        els.addrInput.value = '';
        await refreshDevices();
      } catch (e) {
        showToast(e.message, 'error');
      }
    });

    els.addrInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        els.btnConnect.click();
      }
    });

    els.btnSelectDevice.addEventListener('click', () => {
      const o = els.deviceSelect.selectedOptions[0];
      if (!o || o.disabled) {
        showToast('请选择一台状态为 device 的设备', 'error');
        return;
      }
      serial = o.value;
      els.deviceName.textContent = serial;
      els.deviceDot.classList.add('on');
      els.modalMask.classList.add('hidden');
      showToast(`已选择设备 ${serial}`, 'ok');
    });

    els.btnModalClose.addEventListener('click', () => {
      els.modalMask.classList.add('hidden');
    });

    els.modalMask.addEventListener('click', (e) => {
      if (e.target === els.modalMask) {
        els.modalMask.classList.add('hidden');
      }
    });

    // 键盘
    window.addEventListener('keydown', (e) => {
      if (!els.modalMask.classList.contains('hidden')) {
        if (e.key === 'Escape') {
          els.modalMask.classList.add('hidden');
        }
        return;
      }
      if (!els.rowMenu.classList.contains('hidden')) {
        if (e.key === 'Escape') {
          closeRowMenu();
        }
        return;
      }
      const tag = e.target && e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId !== null) {
        deleteMarker(selectedId);
      } else if (e.key === 'Escape') {
        if (!els.nodeCard.classList.contains('hidden')) {
          closeNodeCard();
          return;
        }
        selection = null;
        selectedId = null;
        render();
        renderTable();
      }
    });

    // 滚轮缩放（以鼠标位置为锚点）
    els.stage.addEventListener(
      'wheel',
      (e) => {
        if (!orig) {
          return;
        }
        e.preventDefault();
        const sr = els.stage.getBoundingClientRect();
        const factor = Math.exp(-e.deltaY * 0.0015);
        zoomAt(e.clientX - sr.left, e.clientY - sr.top, factor);
      },
      { passive: false }
    );

    // 缩放工具条
    els.zoomIn.addEventListener('click', () => {
      if (orig) {
        zoomAt(els.stage.clientWidth / 2, els.stage.clientHeight / 2, 1.25);
      }
    });
    els.zoomOut.addEventListener('click', () => {
      if (orig) {
        zoomAt(els.stage.clientWidth / 2, els.stage.clientHeight / 2, 0.8);
      }
    });
    els.zoomFit.addEventListener('click', () => fit());
    els.zoomLabel.addEventListener('click', () => {
      if (orig) {
        zoomAt(els.stage.clientWidth / 2, els.stage.clientHeight / 2, 1 / view.scale);
      }
    });
    els.screen.addEventListener('dblclick', () => fit());

    // 右键用于平移，阻止默认右键菜单
    els.stage.addEventListener('contextmenu', (e) => {
      if (orig) {
        e.preventDefault();
      }
    });

    // 按住空格临时切换为抓手
    window.addEventListener('keydown', (e) => {
      const tag = e.target && e.target.tagName;
      if (e.code === 'Space' && tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') {
        spaceDown = true;
        els.screen.classList.add('grab');
        e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') {
        spaceDown = false;
        els.screen.classList.remove('grab');
      }
    });
  }

  function setMode(m) {
    mode = m;
    els.modePick.classList.toggle('active', m === 'pick');
    els.modeRect.classList.toggle('active', m === 'rect');
    els.modePan.classList.toggle('active', m === 'pan');
    els.screen.style.cursor =
      m === 'rect' ? 'crosshair' : m === 'pan' ? 'grab' : 'default';
  }

  void init();
})();
