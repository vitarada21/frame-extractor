const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

let ffmpegPath = require('ffmpeg-static');
if (app.isPackaged && ffmpegPath) {
  ffmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked');
}

let mainWindow = null;
const tempFiles = new Set();

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#f5f5f7',
    title: 'Frame Extractor',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  mainWindow.loadFile('index.html');
  mainWindow.setMenuBarVisibility(false);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  cleanupTempFiles();
  if (process.platform !== 'darwin') app.quit();
});

function cleanupTempFiles() {
  for (const f of tempFiles) {
    try { fs.unlinkSync(f); } catch {}
  }
  tempFiles.clear();
}

ipcMain.handle('open-video-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Vyber video',
    filters: [
      { name: 'Video', extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v', 'ogv', 'mts', 'wmv', 'hevc', '3gp', 'flv'] },
      { name: 'Všechny soubory', extensions: ['*'] },
    ],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const filePath = result.filePaths[0];
  return {
    path: filePath,
    name: path.basename(filePath),
    size: fs.statSync(filePath).size,
  };
});

ipcMain.handle('convert-video', async (event, { inputPath }) => {
  if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
    throw new Error('FFmpeg binárka nebyla nalezena.');
  }
  const baseName = path.basename(inputPath, path.extname(inputPath));
  const outputPath = path.join(os.tmpdir(), `${baseName}_${Date.now()}_converted.mp4`);
  tempFiles.add(outputPath);

  return new Promise((resolve, reject) => {
    const args = [
      '-i', inputPath,
      '-vf', 'scale=in_color_matrix=bt2020nc:out_color_matrix=bt709:in_range=tv:out_range=tv:flags=full_chroma_int+accurate_rnd,format=yuv420p',
      '-c:v', 'libx264',
      '-crf', '17',
      '-preset', 'fast',
      '-color_primaries', 'bt709',
      '-color_trc', 'bt709',
      '-colorspace', 'bt709',
      '-color_range', 'tv',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-y',
      outputPath,
    ];

    const ff = spawn(ffmpegPath, args);
    let duration = 0;
    let lastProgress = -1;
    let stderrBuffer = '';

    ff.stderr.on('data', (data) => {
      const line = data.toString();
      stderrBuffer += line;
      if (stderrBuffer.length > 8192) stderrBuffer = stderrBuffer.slice(-4096);

      if (!duration) {
        const m = line.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
        if (m) {
          duration = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3] + '.' + m[4]);
        }
      }
      const t = line.match(/time=(\d+):(\d+):(\d+)\.(\d+)/);
      if (t && duration) {
        const cur = (+t[1]) * 3600 + (+t[2]) * 60 + parseFloat(t[3] + '.' + t[4]);
        const prog = Math.min(1, Math.max(0, cur / duration));
        if (prog - lastProgress >= 0.005) {
          lastProgress = prog;
          if (mainWindow) mainWindow.webContents.send('convert-progress', prog);
        }
      }
    });

    ff.on('close', (code) => {
      if (code === 0) {
        if (mainWindow) mainWindow.webContents.send('convert-progress', 1);
        resolve({ path: outputPath, url: 'file:///' + outputPath.replace(/\\/g, '/') });
      } else {
        reject(new Error(`FFmpeg skončil s kódem ${code}: ${stderrBuffer.slice(-500)}`));
      }
    });

    ff.on('error', (err) => reject(err));
  });
});

ipcMain.handle('save-frame', async (event, { dataUrl, defaultName }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Uložit snímek',
    defaultPath: defaultName,
    filters: [{ name: 'PNG obrázek', extensions: ['png'] }],
  });
  if (result.canceled || !result.filePath) return null;
  const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
  fs.writeFileSync(result.filePath, base64, 'base64');
  return result.filePath;
});

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const ff = spawn(ffmpegPath, args);
    let stderr = '';
    ff.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 8192) stderr = stderr.slice(-4096);
    });
    ff.on('close', (code) => {
      if (code === 0) resolve(stderr);
      else reject(new Error(`FFmpeg exit ${code}: ${stderr.slice(-500)}`));
    });
    ff.on('error', reject);
  });
}

function probeVideoIsHDR(inputPath) {
  return new Promise((resolve) => {
    const ff = spawn(ffmpegPath, ['-hide_banner', '-i', inputPath]);
    let stderr = '';
    ff.stderr.on('data', (d) => { stderr += d.toString(); });
    ff.on('close', () => {
      const hlg = /arib-std-b67/i.test(stderr);
      const pq = /smpte2084/i.test(stderr);
      const bt2020 = /bt2020(nc|c)?/i.test(stderr);
      resolve({ isHDR: hlg || pq, hlg, pq, bt2020, stderr });
    });
    ff.on('error', () => resolve({ isHDR: false, hlg: false, pq: false, bt2020: false, stderr: '' }));
  });
}

function buildFilterChain(isHDR, eq) {
  const baseHDR = 'zscale=t=bt709:m=bt709:p=bt709:r=tv,format=rgb24';
  const baseSDR = 'scale=in_color_matrix=auto:out_color_matrix=bt709:flags=full_chroma_int+accurate_rnd,format=rgb24';
  const base = isHDR ? baseHDR : baseSDR;
  return eq ? `${base},${eq}` : base;
}

function adjustmentsToEq(adj) {
  if (!adj) return null;
  const sat = typeof adj.saturation === 'number' ? adj.saturation : 1;
  const con = typeof adj.contrast === 'number' ? adj.contrast : 1;
  const bri = typeof adj.brightness === 'number' ? adj.brightness : 0;
  if (sat === 1 && con === 1 && bri === 0) return null;
  return `eq=saturation=${sat}:contrast=${con}:brightness=${bri}`;
}

async function extractFrameWithFilter(inputPath, timeSec, outputPath, adjustments) {
  const probe = await probeVideoIsHDR(inputPath);
  const probeInfo = { isHDR: probe.isHDR, hlg: probe.hlg, pq: probe.pq, bt2020: probe.bt2020 };
  console.log('[probe]', probeInfo);
  if (mainWindow) mainWindow.webContents.send('probe-info', probeInfo);

  const eq = adjustmentsToEq(adjustments);
  const t = Math.max(0, timeSec).toFixed(6);
  const baseArgs = ['-ss', t, '-i', inputPath, '-frames:v', '1', '-y'];

  const primary = buildFilterChain(probe.isHDR, eq);
  const secondary = buildFilterChain(!probe.isHDR, eq);

  try {
    await runFFmpeg([...baseArgs, '-vf', primary, outputPath]);
  } catch (e1) {
    console.warn('Primary filter failed, trying secondary:', e1.message);
    try {
      await runFFmpeg([...baseArgs, '-vf', secondary, outputPath]);
    } catch (e2) {
      console.warn('Secondary filter failed, trying raw:', e2.message);
      await runFFmpeg([...baseArgs, outputPath]);
    }
  }
}

ipcMain.handle('extract-frame-preview', async (event, { inputPath, timeSec }) => {
  const tempPath = path.join(os.tmpdir(), `frame_preview_${Date.now()}.png`);
  tempFiles.add(tempPath);
  await extractFrameWithFilter(inputPath, timeSec, tempPath, null);
  return 'file:///' + tempPath.replace(/\\/g, '/');
});

ipcMain.handle('extract-frame', async (event, { inputPath, timeSec, defaultName, adjustments }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Uložit snímek',
    defaultPath: defaultName,
    filters: [{ name: 'PNG obrázek', extensions: ['png'] }],
  });
  if (result.canceled || !result.filePath) return null;

  try {
    await extractFrameWithFilter(inputPath, timeSec, result.filePath, adjustments);
  } catch (err) {
    throw new Error(`Extrakce snímku selhala: ${err.message}`);
  }
  return result.filePath;
});

ipcMain.handle('show-in-folder', (event, filePath) => {
  if (filePath && fs.existsSync(filePath)) {
    shell.showItemInFolder(filePath);
  }
});
