/**
 * MADMIN - API Client Module
 * 
 * Provides authenticated fetch wrapper and common API utilities.
 * All API requests pass through this module for consistent auth handling.
 */

const API_BASE = '/api';

/**
 * Extract a human-readable message from a FastAPI error response body.
 * Handles both string detail (4xx generic) and array detail (422 Pydantic).
 * Exported for callers that read the Response themselves (streams, downloads).
 */
export function _extractDetail(error) {
    const detail = error?.detail;
    if (!detail) return 'Request failed';
    if (Array.isArray(detail)) {
        return detail.map(e => e.msg?.replace(/^Value error, /, '') ?? JSON.stringify(e)).join('; ');
    }
    return String(detail);
}

/**
 * Get the stored authentication token
 * @returns {string|null} JWT token or null
 */
export function getToken() {
    return localStorage.getItem('madmin_token');
}

/**
 * Set the authentication token
 * @param {string} token - JWT token
 */
export function setToken(token) {
    localStorage.setItem('madmin_token', token);
}

/**
 * Clear the authentication token (logout)
 */
export function clearToken() {
    localStorage.removeItem('madmin_token');
}

/**
 * Check if user is authenticated
 * @returns {boolean}
 */
export function isAuthenticated() {
    return !!getToken();
}

/**
 * Redirect to login page
 */
export function redirectToLogin() {
    clearToken();
    window.location.href = '/login';
}

/**
 * Authenticated fetch wrapper
 * 
 * @param {string} endpoint - API endpoint (without /api prefix)
 * @param {Object} options - Fetch options
 * @returns {Promise<Response>}
 */
export async function apiFetch(endpoint, options = {}) {
    const token = getToken();

    if (!token && !endpoint.includes('/auth/token')) {
        redirectToLogin();
        throw new Error('Not authenticated');
    }

    const headers = {
        ...options.headers,
    };

    // Set default Content-Type if not present and body is not FormData
    if (!headers['Content-Type'] && !(options.body instanceof FormData)) {
        headers['Content-Type'] = 'application/json';
    }

    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    }

    const response = await fetch(`${API_BASE}${endpoint}`, {
        ...options,
        headers,
    });

    // Handle 401 Unauthorized
    if (response.status === 401) {
        redirectToLogin();
        throw new Error('Session expired');
    }

    return response;
}

/**
 * GET request helper
 * @param {string} endpoint 
 * @returns {Promise<any>}
 */
export async function apiGet(endpoint) {
    const response = await apiFetch(endpoint, { method: 'GET' });

    if (!response.ok) {
        const error = await response.json().catch(() => ({ detail: 'Request failed' }));
        throw Object.assign(new Error(_extractDetail(error)), { status: response.status });
    }

    return response.json();
}

/**
 * POST request helper
 * @param {string} endpoint 
 * @param {Object} data 
 * @returns {Promise<any>}
 */
export async function apiPost(endpoint, data) {
    const response = await apiFetch(endpoint, {
        method: 'POST',
        body: JSON.stringify(data),
    });

    if (!response.ok) {
        const error = await response.json().catch(() => ({ detail: 'Request failed' }));
        throw new Error(_extractDetail(error));
    }

    // Handle 204 No Content
    if (response.status === 204) {
        return null;
    }

    return response.json();
}

/**
 * PATCH request helper
 * @param {string} endpoint 
 * @param {Object} data 
 * @returns {Promise<any>}
 */
export async function apiPatch(endpoint, data) {
    const response = await apiFetch(endpoint, {
        method: 'PATCH',
        body: JSON.stringify(data),
    });

    if (!response.ok) {
        const error = await response.json().catch(() => ({ detail: 'Request failed' }));
        throw new Error(_extractDetail(error));
    }

    return response.json();
}

/**
 * PUT request helper
 * @param {string} endpoint 
 * @param {Object} data 
 * @returns {Promise<any>}
 */
export async function apiPut(endpoint, data) {
    const response = await apiFetch(endpoint, {
        method: 'PUT',
        body: JSON.stringify(data),
    });

    if (!response.ok) {
        const error = await response.json().catch(() => ({ detail: 'Request failed' }));
        throw new Error(_extractDetail(error));
    }

    return response.json();
}

/**
 * DELETE request helper
 * @param {string} endpoint 
 * @returns {Promise<void>}
 */
export async function apiDelete(endpoint) {
    const response = await apiFetch(endpoint, { method: 'DELETE' });

    if (!response.ok) {
        const error = await response.json().catch(() => ({ detail: 'Request failed' }));
        throw new Error(_extractDetail(error));
    }

    return null;
}

/**
 * DELETE request with JSON body
 * @param {string} endpoint 
 * @param {Object} data 
 * @returns {Promise<Object>}
 */
export async function apiDeleteWithBody(endpoint, data = {}) {
    const response = await apiFetch(endpoint, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    });

    if (!response.ok) {
        const error = await response.json().catch(() => ({ detail: 'Request failed' }));
        throw new Error(_extractDetail(error));
    }

    return response.json().catch(() => null);
}

/**
 * Get current user info
 * @returns {Promise<Object>}
 */
export async function getCurrentUser() {
    return apiGet('/auth/me');
}
