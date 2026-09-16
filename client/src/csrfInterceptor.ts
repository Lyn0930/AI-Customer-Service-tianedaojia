/**
 * 注入 CSRF token 到 miaoda axiosForBackend
 *
 * miaoda 网关要求所有 /api/* 请求同时满足：
 *   1. cookie 中存在 suda-csrf-token（浏览器自动带）
 *   2. header 中存在 X-Suda-Csrf-Token（SDK 不会自动加，需拦截器注入）
 *
 * token 值由 miaoda 注入到 `window.csrfToken`。这个文件必须在
 * index.tsx 顶部 import（早于任何 api/ 模块）。
 *
 * 兜底逻辑：如果 window.csrfToken 不存在（如公开页面用户未登录时），
 * 尝试从 document.cookie 中读取 suda-csrf-token。
 *
 * 自动恢复：如果浏览器缓存了 HTML 页面导致 cookie 过期，
 * 网关返回 403 CSRF 错误时自动刷新页面获取新 cookie。
 */
import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';

declare global {
  interface Window {
    csrfToken?: string;
  }
}

/** 从 cookie 中读取指定 name 的值 */
function getCookie(name: string): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const match = document.cookie.match(
    new RegExp('(^| )' + name + '=([^;]+)'),
  );
  return match ? decodeURIComponent(match[2]) : undefined;
}

/**
 * 获取 CSRF token：优先 window.csrfToken（妙搭注入），
 * 兜底从 cookie 读取 suda-csrf-token（公开页面未登录场景）。
 */
function getCsrfToken(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  if (window.csrfToken) return window.csrfToken;
  // 兜底：从 cookie 读（公开页面 / 未登录场景）
  return getCookie('suda-csrf-token') || undefined;
}

let csrfReloading = false;

const requestInterceptor = (config: any) => {
  const token = getCsrfToken();
  if (token) {
    config.headers = config.headers || {};
    if (typeof config.headers.set === 'function') {
      config.headers.set('X-Suda-Csrf-Token', token);
    } else {
      config.headers['X-Suda-Csrf-Token'] = token;
    }
  }
  config.withCredentials = true;
  return config;
};

const responseErrorInterceptor = (err: any) => {
  const status = err?.response?.status;
  const body = typeof err?.response?.data === 'string' ? err.response.data : '';
  if (
    status === 403 &&
    body.includes('csrf') &&
    typeof window !== 'undefined' &&
    !csrfReloading
  ) {
    csrfReloading = true;
    window.location.reload();
  }
  return Promise.reject(err);
};

const interceptors = (axiosForBackend as any).interceptors;
if (interceptors?.request?.use) {
  interceptors.request.use(requestInterceptor);
}
if (interceptors?.response?.use) {
  interceptors.response.use(null, responseErrorInterceptor);
}
