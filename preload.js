const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  platform: process.platform,
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return null;
    }
  },
  openVideoFile: () => ipcRenderer.invoke('open-video-file'),
  convertVideo: (inputPath) => ipcRenderer.invoke('convert-video', { inputPath }),
  saveFrame: (dataUrl, defaultName) =>
    ipcRenderer.invoke('save-frame', { dataUrl, defaultName }),
  extractFrame: (inputPath, timeSec, defaultName, adjustments) =>
    ipcRenderer.invoke('extract-frame', { inputPath, timeSec, defaultName, adjustments }),
  extractFramePreview: (inputPath, timeSec) =>
    ipcRenderer.invoke('extract-frame-preview', { inputPath, timeSec }),
  showInFolder: (filePath) => ipcRenderer.invoke('show-in-folder', filePath),
  onConvertProgress: (callback) => {
    const listener = (_, progress) => callback(progress);
    ipcRenderer.on('convert-progress', listener);
    return () => ipcRenderer.removeListener('convert-progress', listener);
  },
  onProbeInfo: (callback) => {
    const listener = (_, info) => callback(info);
    ipcRenderer.on('probe-info', listener);
    return () => ipcRenderer.removeListener('probe-info', listener);
  },
});
