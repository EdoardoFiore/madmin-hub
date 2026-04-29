/**
 * Hub API client — JWT auto-inject, 401 redirect, base path /api.
 */
const TOKEN_KEY = 'hub_token';
const BASE = '/api';

function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

async function request(method, path, body = null, opts = {}) {
  const token = getToken();
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const init = { method, headers, ...opts };
  if (body !== null) init.body = JSON.stringify(body);

  const res = await fetch(`${BASE}${path}`, init);

  if (res.status === 401) {
    clearToken();
    window.location.href = '/login';
    return null;
  }
  return res;
}

export async function apiGet(path) {
  const res = await request('GET', path);
  if (!res) return null;
  if (!res.ok) throw await res.json();
  return res.json();
}

export async function apiPost(path, data) {
  const res = await request('POST', path, data);
  if (!res) return null;
  if (!res.ok) throw await res.json();
  return res.json();
}

export async function apiPatch(path, data) {
  const res = await request('PATCH', path, data);
  if (!res) return null;
  if (!res.ok) throw await res.json();
  return res.json();
}

export async function apiPut(path, data) {
  const res = await request('PUT', path, data);
  if (!res) return null;
  if (!res.ok) throw await res.json();
  return res.json();
}

export async function apiDelete(path) {
  const res = await request('DELETE', path);
  if (!res) return null;
  if (!res.ok) throw await res.json();
  return res.json();
}

export async function getCurrentUser() {
  return apiGet('/auth/me');
}

export function getToken2() {
  return getToken();
}

export function logout() {
  clearToken();
  window.location.href = '/login';
}
