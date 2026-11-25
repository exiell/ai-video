import { contextBridge, ipcRenderer } from 'electron';
import type {
  AniGuideDesktopAPI,
  CacheMediaOptions,
  CacheMediaResult,
  NativeHttpRequest,
  NativeHttpResponse,
  SaveBinaryOptions,
  SaveBinaryResult,
  ThemeChromeOptions,
} from '../src/platform/types';

const appVersion =
  process.argv
    .find((arg) => arg.startsWith('--aniguide-version='))
    ?.slice('--aniguide-version='.length) ?? '0.1.0';

const platform: AniGuideDesktopAPI['platform'] =
  process.platform === 'darwin'
    ? 'darwin'
    : process.platform === 'linux'
      ? 'linux'
      : 'win32';

const api: AniGuideDesktopAPI = {
  isDesktop: true,
  platform,
  appVersion,
  http: {
    request: (req: NativeHttpRequest): Promise<NativeHttpResponse> =>
      ipcRenderer.invoke('aniguide:http:request', req),
    abort: (requestId: string): void => {
      ipcRenderer.send('aniguide:http:abort', requestId);
    },
  },
  file: {
    saveBinary: (opts: SaveBinaryOptions): Promise<SaveBinaryResult> =>
      ipcRenderer.invoke('aniguide:file:saveBinary', opts),
    cacheMedia: (opts: CacheMediaOptions): Promise<CacheMediaResult> =>
      ipcRenderer.invoke('aniguide:file:cacheMedia', opts),
    revealInFolder: (filePath: string): Promise<void> =>
      ipcRenderer.invoke('aniguide:file:revealInFolder', filePath),
    openUserDataDir: (): Promise<void> =>
      ipcRenderer.invoke('aniguide:file:openUserDataDir'),
  },
  secrets: {
    isAvailable: (): Promise<boolean> => ipcRenderer.invoke('aniguide:secrets:isAvailable'),
    get: (key: string): Promise<string | null> => ipcRenderer.invoke('aniguide:secrets:get', key),
    set: (key: string, value: string): Promise<boolean> =>
      ipcRenderer.invoke('aniguide:secrets:set', key, value),
    delete: (key: string): Promise<boolean> => ipcRenderer.invoke('aniguide:secrets:delete', key),
  },
  window: {
    syncThemeChrome: (opts: ThemeChromeOptions): void => {
      ipcRenderer.send('aniguide:window:syncThemeChrome', opts);
    },
  },
  shell: {
    openExternal: (url: string): Promise<void> => ipcRenderer.invoke('aniguide:shell:openExternal', url),
  },
};

contextBridge.exposeInMainWorld('aniguideDesktop', api);
