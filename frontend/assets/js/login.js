/**
 * MADMIN - Login page
 *
 * Classic script (not a module): the page runs before authentication and has
 * no access to the app's ES modules. Kept out of login.html so the CSP can
 * forbid inline scripts.
 */

// --- Minimal i18n (pre-authentication) ---
const _loginI18n = (function () {
    const SUPPORTED = ['en', 'it'];
    const DEFAULT = 'en';
    let _tr = {};

    function detectLang() {
        const stored = localStorage.getItem('madmin_lang');
        if (stored && SUPPORTED.includes(stored)) return stored;
        const browser = (navigator.language || '').split('-')[0];
        if (SUPPORTED.includes(browser)) return browser;
        return DEFAULT;
    }

    const _lang = detectLang();

    async function loadLocale() {
        try {
            const resp = await fetch(`/static/locales/${_lang}.json`);
            if (resp.ok) _tr = await resp.json();
        } catch (e) {
            console.warn('Failed to load locale:', e);
        }
    }

    function t(key) {
        const parts = key.split('.');
        let val = _tr;
        for (const p of parts) {
            if (val && typeof val === 'object') val = val[p];
            else return key;
        }
        return (typeof val === 'string') ? val : key;
    }

    function translateDOM() {
        document.querySelectorAll('[data-i18n]').forEach(el => {
            const key = el.getAttribute('data-i18n');
            const translated = t(key);
            if (translated !== key) el.textContent = translated;
        });
        document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
            const key = el.getAttribute('data-i18n-placeholder');
            const translated = t(key);
            if (translated !== key) el.placeholder = translated;
        });
        document.querySelectorAll('[data-i18n-title]').forEach(el => {
            const key = el.getAttribute('data-i18n-title');
            const translated = t(key);
            if (translated !== key) {
                el.title = translated;
                el.setAttribute('aria-label', translated);
            }
        });
    }

    // Created here rather than through data-bs-strength: tabler.js would
    // build it on load, before the labels are translated.
    function initStrengthMeter() {
        const el = document.getElementById('new-password-strength');
        if (!el || !window.tabler) return;
        new window.tabler.Strength(el, {
            input: '#new-password',
            messages: {
                weak: t('password.weak'),
                fair: t('password.fair'),
                good: t('password.good'),
                strong: t('password.strong'),
            },
        });
        el.setAttribute('aria-label', t('password.strengthLabel'));
    }

    loadLocale().then(() => {
        translateDOM();
        initStrengthMeter();
    });

    return { t, lang: _lang };
})();

document.getElementById('copyright-year').textContent = new Date().getFullYear();

// --- Login flow ---

// Check if already logged in
if (localStorage.getItem('madmin_token')) {
    window.location.href = '/';
}

// Elements
const form = document.getElementById('login-form');
const alertBox = document.getElementById('login-alert');
const errorSpan = document.getElementById('login-error');
const loginBtn = document.getElementById('login-btn');
const twoFaSection = document.getElementById('2fa-section');
const verify2faBtn = document.getElementById('verify-2fa-btn');
const backToLoginBtn = document.getElementById('back-to-login');
const otpInput = document.getElementById('otp-code');
const pwdChangeSection = document.getElementById('pwd-change-section');
const setPasswordBtn = document.getElementById('set-password-btn');
const newPwdInput = document.getElementById('new-password');
const newPwdConfirmInput = document.getElementById('new-password-confirm');
const twoFaSetupSection = document.getElementById('2fa-setup-section');
const complete2faSetupBtn = document.getElementById('complete-2fa-setup-btn');
const setupOtpInput = document.getElementById('setup-otp-code');
const backToLoginSetupBtn = document.getElementById('back-to-login-setup');

// State for 2FA / password-change flows
let tempToken = null;

// Error body of a failed call. nginx answers its own 429 (login rate limit)
// with an HTML page: without this, parsing it threw and the page reported a
// connection error instead of "too many attempts".
async function errorBody(response) {
    try {
        return await response.json();
    } catch (e) {
        return { detail: response.status === 429 ? _t('auth.tooManyAttempts') : null };
    }
}

function _t(key) {
    return _loginI18n.t(key) || key;
}

// Tabler OtpInput redraws its slots on `input` events only
function clearSetupOtp() {
    setupOtpInput.value = '';
    setupOtpInput.dispatchEvent(new Event('input'));
}

function showError(message) {
    errorSpan.textContent = message;
    alertBox.classList.add('show');
}

function hideError() {
    alertBox.classList.remove('show');
}

function setLoading(btn, loading, loadingKey, defaultKey) {
    const btnText = btn.querySelector('.btn-text');
    const spinner = btn.querySelector('.spinner-border');

    if (loading) {
        btnText.textContent = _t(loadingKey);
        spinner.classList.remove('d-none');
        btn.disabled = true;
    } else {
        btnText.textContent = _t(defaultKey);
        spinner.classList.add('d-none');
        btn.disabled = false;
    }
}

function showLoginForm() {
    form.classList.remove('d-none');
    twoFaSection.classList.add('d-none');
    pwdChangeSection.classList.add('d-none');
    twoFaSetupSection.classList.add('d-none');
    tempToken = null;
    hideError();
}

function show2faForm() {
    form.classList.add('d-none');
    pwdChangeSection.classList.add('d-none');
    twoFaSetupSection.classList.add('d-none');
    twoFaSection.classList.remove('d-none');
    otpInput.value = '';
    otpInput.focus();
    hideError();
}

function showPwdChangeForm() {
    form.classList.add('d-none');
    twoFaSection.classList.add('d-none');
    twoFaSetupSection.classList.add('d-none');
    pwdChangeSection.classList.remove('d-none');
    newPwdInput.value = '';
    newPwdConfirmInput.value = '';
    newPwdInput.focus();
    hideError();
}

function show2faSetupForm() {
    form.classList.add('d-none');
    twoFaSection.classList.add('d-none');
    pwdChangeSection.classList.add('d-none');
    twoFaSetupSection.classList.remove('d-none');
    clearSetupOtp();
    setupOtpInput.focus();
    hideError();
}

// Central dispatch on token_type for both /token and /token/2fa responses.
// Returns true if a follow-up step was shown, false on final login.
async function handleTokenResponse(data) {
    if (data.token_type === '2fa_required') {
        tempToken = data.access_token;
        show2faForm();
        return true;
    }
    if (data.token_type === 'password_change_required') {
        tempToken = data.access_token;
        showPwdChangeForm();
        return true;
    }
    if (data.token_type === '2fa_setup_required') {
        // Pending token: kept in memory only. Writing it to localStorage would
        // make every authenticated call 401 and bounce the user back to login.
        tempToken = data.access_token;
        // Awaited so the caller's spinner stays up while the QR is fetched
        await start2faSetup();
        return true;
    }
    // Final login
    localStorage.setItem('madmin_token', data.access_token);
    window.location.href = '/';
    return false;
}

// Login form submit
form.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideError();
    setLoading(loginBtn, true, 'auth.signingIn', 'auth.login');

    const formData = new URLSearchParams();
    formData.append('username', document.getElementById('username').value);
    formData.append('password', document.getElementById('password').value);

    try {
        const response = await fetch('/api/auth/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: formData
        });

        if (response.ok) {
            await handleTokenResponse(await response.json());
        } else {
            const error = await errorBody(response);
            showError(error.detail || _t('auth.invalidCredentials'));
        }
    } catch (error) {
        showError(_t('auth.connectionError'));
        console.error('Login error:', error);
    } finally {
        setLoading(loginBtn, false, 'auth.signingIn', 'auth.login');
    }
});

// 2FA verification
verify2faBtn.addEventListener('click', async () => {
    const code = otpInput.value.trim();

    if (!code) {
        showError(_t('auth.enterCode'));
        return;
    }

    hideError();
    setLoading(verify2faBtn, true, 'auth.verifying', 'auth.verify');

    try {
        // Code in the body, never in the URL: URLs end up in access logs
        const response = await fetch('/api/auth/token/2fa', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${tempToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ code })
        });

        if (response.ok) {
            // May return a password_change_required step after 2FA succeeds
            await handleTokenResponse(await response.json());
        } else {
            const error = await errorBody(response);
            showError(error.detail || _t('auth.invalidCode'));
            otpInput.value = '';
            otpInput.focus();
        }
    } catch (error) {
        showError(_t('auth.connectionError'));
        console.error('2FA error:', error);
    } finally {
        setLoading(verify2faBtn, false, 'auth.verifying', 'auth.verify');
    }
});

// Forced password change
async function submitPasswordChange() {
    const newPwd = newPwdInput.value;
    const confirmPwd = newPwdConfirmInput.value;

    if (!newPwd || !confirmPwd) {
        showError(_t('auth.fillAllFields'));
        return;
    }
    if (newPwd !== confirmPwd) {
        showError(_t('auth.passwordsDoNotMatch'));
        return;
    }

    hideError();
    setLoading(setPasswordBtn, true, 'auth.settingPassword', 'auth.setPassword');

    try {
        const response = await fetch('/api/auth/token/password-change', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${tempToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ new_password: newPwd })
        });

        if (response.ok) {
            const data = await response.json();
            localStorage.setItem('madmin_token', data.access_token);
            window.location.href = '/';
        } else {
            const error = await errorBody(response);
            showError(error.detail || _t('auth.passwordChangeFailed'));
        }
    } catch (error) {
        showError(_t('auth.connectionError'));
        console.error('Password change error:', error);
    } finally {
        setLoading(setPasswordBtn, false, 'auth.settingPassword', 'auth.setPassword');
    }
}

setPasswordBtn.addEventListener('click', submitPasswordChange);
newPwdConfirmInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') submitPasswordChange();
});

// Enforced 2FA enrollment: generate the secret with the pending token,
// then exchange a valid code for a full session.
async function start2faSetup() {
    hideError();

    try {
        const response = await fetch('/api/auth/me/2fa/setup', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${tempToken}`,
                'Content-Type': 'application/json'
            },
            body: '{}'
        });

        if (!response.ok) {
            const error = await errorBody(response);
            showError(error.detail || _t('auth.setup2faFailed'));
            return;
        }

        const data = await response.json();
        document.getElementById('setup-qr-code').src = `data:image/png;base64,${data.qr_code}`;
        document.getElementById('setup-secret').value = data.secret;
        const codesEl = document.getElementById('setup-backup-codes');
        codesEl.replaceChildren(...data.backup_codes.flatMap((c, i) => {
            const col = document.createElement('div');
            col.className = 'col-6';
            const code = document.createElement('code');
            code.textContent = c;
            col.append(code);
            // One code per line in textContent: the copy button copies it as is
            return i ? [document.createTextNode('\n'), col] : [col];
        }));

        show2faSetupForm();
    } catch (error) {
        showError(_t('auth.connectionError'));
        console.error('2FA setup error:', error);
    }
}

async function submit2faSetup() {
    const code = setupOtpInput.value.trim();

    if (!code) {
        showError(_t('auth.enterCode'));
        return;
    }

    hideError();
    setLoading(complete2faSetupBtn, true, 'auth.verifying', 'auth.activate2fa');

    try {
        const response = await fetch('/api/auth/token/2fa-setup', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${tempToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ code })
        });

        if (response.ok) {
            // May return a password_change_required step after 2FA is activated
            await handleTokenResponse(await response.json());
        } else {
            const error = await errorBody(response);
            showError(error.detail || _t('auth.invalidCode'));
            clearSetupOtp();
            setupOtpInput.focus();
        }
    } catch (error) {
        showError(_t('auth.connectionError'));
        console.error('2FA setup error:', error);
    } finally {
        setLoading(complete2faSetupBtn, false, 'auth.verifying', 'auth.activate2fa');
    }
}

complete2faSetupBtn.addEventListener('click', submit2faSetup);
setupOtpInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') submit2faSetup();
});
backToLoginSetupBtn.addEventListener('click', showLoginForm);

// Handle Enter key on OTP input
otpInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') verify2faBtn.click();
});

// Back to login button
backToLoginBtn.addEventListener('click', showLoginForm);
