/**
 * Electron 桌面端 Preload 桥接接口类型声明（DESK-001）
 *
 * 渲染进程严禁直接访问 Node.js API；所有原生能力均经由此窄接口通过 contextBridge 暴露。
 */

export interface NativeHttpRequest {
  requestId: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export interface NativeHttpResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  /** UTF-8 文本响应（JSON / 错误信息） */
  bodyText?: string;
  /** 二进制响应（图片/视频下载等）的 base64 编码 */
  bodyBase64?: string;
}

export interface NativeFileFilter {
  name: string;
  extensions: string[];
}

export interface SaveBinaryOptions {
  defaultName: string;
  filters?: NativeFileFilter[];
  bytes: Uint8Array;
}

export interface SaveBinaryResult {
  canceled: boolean;
  filePath?: string;
  error?: string;
}

export interface ThemeChromeOptions {
  bg: string;
  overlayColor: string;
  symbolColor: string;
}

export interface AniGuideDesktopAPI {
  readonly isDesktop: true;
  readonly platform: 'win32' | 'darwin' | 'linux';
  readonly appVersion: string;
  http: {
    request(req: NativeHttpRequest): Promise<NativeHttpResponse>;
    abort(requestId: string): void;
  };
  file: {
    saveBinary(opts: SaveBinaryOptions): Promise<SaveBinaryResult>;
    revealInFolder(filePath: string): Promise<void>;
    openUserDataDir(): Promise<void>;
  };
  secrets: {
    isAvailable(): Promise<boolean>;
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<boolean>;
    delete(key: string): Promise<boolean>;
  };
  window: {
    syncThemeChrome(opts: ThemeChromeOptions): void;
  };
  shell: {
    openExternal(url: string): Promise<void>;
  };
}

declare global {
  interface Window {
    aniguideDesktop?: AniGuideDesktopAPI;
  }
}
