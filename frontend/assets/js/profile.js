/**
 * MADMIN - My Profile modal
 *
 * Self-service modal opened from the user dropdown ("Profile").
 * Lets the current user edit contact info, change password and manage 2FA.
 * Reuses the same backend endpoints as the My Profile section of the users view.
 */

import { apiGet, apiPost, apiPatch, apiDeleteWithBody } from './api.js';
import { showToast, confirmDialog, copyButton, strengthMeter, clearOtpInput, refreshStrengthMeters } from './utils.js';
import { getUser } from './app.js';
import { t } from './i18n.js';

let modalBuilt = false;
let twoFaSetupData = null;

/**
 * Public entry point: build (once) and show the profile modal.
 */
export function openProfileModal() {
    if (!modalBuilt) {
        buildModal();
        modalBuilt = true;
    }

    const user = getUser();
    document.getElementById('profile-username').value = user?.username || '';
    document.getElementById('profile-email').value = user?.email || '';

    // Reset password fields
    document.getElementById('profile-current-password').value = '';
    document.getElementById('profile-new-password').value = '';
    document.getElementById('profile-confirm-password').value = '';
    refreshStrengthMeters(document.getElementById('profile-password-form'));

    new bootstrap.Modal(document.getElementById('profile-modal')).show();
    load2FAStatus();
}

function buildModal() {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = `
        <!-- Profile Modal -->
        <div class="modal modal-blur fade" id="profile-modal" tabindex="-1">
            <div class="modal-dialog modal-lg modal-dialog-centered modal-dialog-scrollable">
                <div class="modal-content">
                    <div class="modal-header">
                        <h5 class="modal-title"><i class="ti ti-user-cog me-2"></i>${t('users.myProfile')}</h5>
                        <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                    </div>
                    <div class="modal-body">
                        <!-- Contact info -->
                        <h4><i class="ti ti-id me-2"></i>${t('profile.contactInfo')}</h4>
                        <form id="profile-info-form" class="mt-3 mb-4">
                            <div class="row g-2">
                                <div class="col-md-6">
                                    <label class="form-label">${t('users.user')}</label>
                                    <input type="text" class="form-control" id="profile-username" disabled>
                                </div>
                                <div class="col-md-6">
                                    <label class="form-label">${t('users.email')}</label>
                                    <input type="email" class="form-control" id="profile-email"
                                           placeholder="${t('profile.emailPlaceholder')}">
                                </div>
                                <div class="col-12">
                                    <button type="submit" class="btn btn-primary">
                                        <i class="ti ti-check me-1"></i>${t('profile.saveProfile')}
                                    </button>
                                </div>
                            </div>
                        </form>
                        <hr>

                        <div class="row g-4">
                            <!-- Change Password -->
                            <div class="col-lg-6">
                                <h4><i class="ti ti-lock me-2"></i>${t('users.changePassword')}</h4>
                                <form id="profile-password-form" class="mt-3">
                                    <div class="row g-2">
                                        <div class="col-12">
                                            <input type="password" class="form-control" id="profile-current-password"
                                                   placeholder="${t('users.currentPassword')}" required>
                                        </div>
                                        <div class="col-12">
                                            <input type="password" class="form-control" id="profile-new-password"
                                                   placeholder="${t('users.newPassword')}" required minlength="8"
                                                   autocomplete="new-password">
                                            ${strengthMeter('#profile-new-password')}
                                        </div>
                                        <div class="col-12">
                                            <input type="password" class="form-control" id="profile-confirm-password"
                                                   placeholder="${t('users.confirmPassword')}" required>
                                        </div>
                                        <div class="col-12">
                                            <button type="submit" class="btn btn-primary">
                                                <i class="ti ti-check me-1"></i>${t('users.changePasswordBtn')}
                                            </button>
                                        </div>
                                    </div>
                                </form>
                            </div>

                            <!-- 2FA Management -->
                            <div class="col-lg-6">
                                <h4><i class="ti ti-shield-lock me-2"></i>${t('users.auth2fa')}</h4>
                                <div id="profile-2fa-status" class="mt-3">
                                    <div class="d-flex justify-content-center py-3">
                                        <div class="spinner-border spinner-border-sm text-primary"></div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <!-- 2FA Setup Modal -->
        <div class="modal modal-blur fade" id="profile-2fa-setup-modal" tabindex="-1">
            <div class="modal-dialog modal-lg">
                <div class="modal-content">
                    <div class="modal-header">
                        <h5 class="modal-title">${t('users.configure2fa')}</h5>
                        <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                    </div>
                    <div class="modal-body">
                        <div class="row">
                            <div class="col-md-6 text-center">
                                <h5 class="mb-3">${t('users.scanQrCode')}</h5>
                                <div class="mb-3 p-3 bg-white rounded d-inline-block">
                                    <img id="profile-qr-code-img" src="" alt="QR Code" style="width: 180px; height: 180px;">
                                </div>
                                <p class="text-muted small">Google Authenticator, Authy, etc.</p>
                            </div>
                            <div class="col-md-6">
                                <h5 class="mb-3">${t('users.orManually')}</h5>
                                <div class="input-group mb-3">
                                    <input type="text" class="form-control font-monospace text-center" id="profile-secret-key" readonly>
                                    ${copyButton('#profile-secret-key', 'btn btn-icon')}
                                </div>
                                <hr>
                                <h5 class="mb-3">${t('users.verifyCode')}</h5>
                                <div class="text-center mb-3">
                                    <div class="otp" data-bs-toggle="otp">
                                        <input type="text" id="profile-verify-setup-code" maxlength="6"
                                               autocomplete="one-time-code" aria-label="${t('users.verifyCode')}">
                                    </div>
                                </div>
                                <button class="btn btn-primary w-100" id="profile-btn-verify-2fa">
                                    <i class="ti ti-check me-1"></i>${t('users.activate2fa')}
                                </button>
                            </div>
                        </div>
                        <hr>
                        <div class="d-flex justify-content-between align-items-center">
                            <h5 class="mb-0"><i class="ti ti-key me-2"></i>${t('users.backupCodes')}</h5>
                            <div class="btn-list">
                                ${copyButton('#profile-backup-codes-list', 'btn btn-sm btn-icon btn-outline-primary')}
                                <button type="button" class="btn btn-sm btn-outline-primary" id="profile-btn-download-setup-codes">
                                    <i class="ti ti-download me-1"></i>${t('common.download')}
                                </button>
                            </div>
                        </div>
                        <div id="profile-backup-codes-list" class="row g-2 mt-2"></div>
                    </div>
                </div>
            </div>
        </div>

        <!-- Password Input Modal (disable 2FA) -->
        <div class="modal modal-blur fade" id="profile-password-input-modal" tabindex="-1">
            <div class="modal-dialog modal-sm">
                <div class="modal-content">
                    <div class="modal-header">
                        <h5 class="modal-title">${t('users.confirmPasswordTitle')}</h5>
                        <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                    </div>
                    <div class="modal-body">
                        <p class="text-muted">${t('users.confirmPasswordDesc')}</p>
                        <input type="password" class="form-control" id="profile-modal-password-input"
                               placeholder="${t('auth.password')}">
                    </div>
                    <div class="modal-footer">
                        <button type="button" class="btn btn-link" data-bs-dismiss="modal">${t('common.cancel')}</button>
                        <button type="button" class="btn btn-danger" id="profile-modal-password-confirm">${t('common.confirm')}</button>
                    </div>
                </div>
            </div>
        </div>

        <!-- OTP Input Modal (regenerate codes) -->
        <div class="modal modal-blur fade" id="profile-otp-input-modal" tabindex="-1">
            <div class="modal-dialog modal-sm">
                <div class="modal-content">
                    <div class="modal-header">
                        <h5 class="modal-title">${t('users.verify2fa')}</h5>
                        <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                    </div>
                    <div class="modal-body">
                        <p class="text-muted">${t('users.verify2faDesc')}</p>
                        <input type="text" class="form-control form-control-lg text-center font-monospace"
                               id="profile-modal-otp-input" maxlength="12" pattern="[0-9A-Za-z]{6,12}"
                               placeholder="000000" inputmode="numeric">
                    </div>
                    <div class="modal-footer">
                        <button type="button" class="btn btn-link" data-bs-dismiss="modal">${t('common.cancel')}</button>
                        <button type="button" class="btn btn-primary" id="profile-modal-otp-confirm">${t('common.confirm')}</button>
                    </div>
                </div>
            </div>
        </div>

        <!-- Backup Codes Display Modal -->
        <div class="modal modal-blur fade" id="profile-backup-codes-display-modal" tabindex="-1">
            <div class="modal-dialog">
                <div class="modal-content">
                    <div class="modal-header">
                        <h5 class="modal-title"><i class="ti ti-key me-2"></i>${t('users.newBackupCodes')}</h5>
                        <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                    </div>
                    <div class="modal-body">
                        <div class="alert alert-warning">
                            <i class="ti ti-alert-triangle me-2"></i>${t('users.backupCodesWarning')}
                        </div>
                        <div id="profile-backup-codes-display" class="row g-2"></div>
                    </div>
                    <div class="modal-footer">
                        ${copyButton('#profile-backup-codes-display', 'btn btn-icon btn-outline-primary')}
                        <button type="button" class="btn btn-outline-primary" id="profile-download-displayed-codes">
                            <i class="ti ti-download me-1"></i>${t('common.download')}
                        </button>
                        <button type="button" class="btn btn-primary" data-bs-dismiss="modal">${t('users.savedCodes')}</button>
                    </div>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(wrapper);

    // Contact info save
    document.getElementById('profile-info-form').addEventListener('submit', handleProfileSave);

    // Password change
    document.getElementById('profile-password-form').addEventListener('submit', handlePasswordChange);
}

async function handleProfileSave(e) {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    const original = btn.innerHTML;
    btn.innerHTML = `<span class="spinner-border spinner-border-sm me-1"></span>${t('users.saving')}`;
    btn.disabled = true;

    try {
        const updated = await apiPatch('/auth/me/profile', {
            email: document.getElementById('profile-email').value.trim() || null
        });
        // Keep cached user + sidebar name in sync
        const user = getUser();
        if (user) user.email = updated.email;
        showToast(t('profile.profileUpdated'), 'success');
    } catch (error) {
        showToast(t('common.errorPrefix') + error.message, 'error');
    } finally {
        btn.innerHTML = original;
        btn.disabled = false;
    }
}

async function handlePasswordChange(e) {
    e.preventDefault();

    const currentPassword = document.getElementById('profile-current-password').value;
    const newPassword = document.getElementById('profile-new-password').value;
    const confirmPassword = document.getElementById('profile-confirm-password').value;

    if (newPassword !== confirmPassword) {
        showToast(t('users.passwordsDoNotMatch'), 'error');
        return;
    }
    if (newPassword.length < 8) {
        showToast(t('users.passwordMinLength'), 'error');
        return;
    }

    const btn = e.target.querySelector('button[type="submit"]');
    const original = btn.innerHTML;
    btn.innerHTML = `<span class="spinner-border spinner-border-sm me-1"></span>${t('users.saving')}`;
    btn.disabled = true;

    try {
        await apiPost('/auth/me/password', {
            current_password: currentPassword,
            new_password: newPassword
        });
        showToast(t('users.passwordUpdated'), 'success');
        e.target.reset();
    } catch (error) {
        showToast(t('common.errorPrefix') + error.message, 'error');
    } finally {
        btn.innerHTML = original;
        btn.disabled = false;
    }
}

// ========== 2FA ==========

async function load2FAStatus() {
    const container = document.getElementById('profile-2fa-status');
    if (!container) return;

    try {
        const status = await apiGet('/auth/me/2fa/status');
        const user = getUser();
        const isSuperuser = user?.is_superuser || false;
        const isEnforced = status.enforced || false;

        if (status.enabled) {
            const canDisable = isSuperuser || !isEnforced;
            container.innerHTML = `
                <div class="alert alert-success mb-3">
                    <div class="d-flex align-items-center">
                        <i class="ti ti-shield-check me-2" style="font-size: 1.5rem;"></i>
                        <div>
                            <strong>${t('users.2faActive')}</strong>
                            <div class="text-muted small">${isEnforced ? t('users.accountProtectedEnforced') : t('users.accountProtected')}</div>
                        </div>
                    </div>
                </div>
                ${canDisable ? `
                    <button class="btn btn-outline-danger btn-sm" id="profile-btn-disable-2fa">
                        <i class="ti ti-shield-off me-1"></i>${t('users.disable2fa')}
                    </button>
                ` : ''}
                <button class="btn btn-outline-secondary btn-sm ${canDisable ? 'ms-2' : ''}" id="profile-btn-regenerate-codes">
                    <i class="ti ti-key me-1"></i>${t('users.regenerateCodes')}
                </button>
            `;
            if (canDisable) setupDisable2FA();
            setupRegenerateCodes();
        } else {
            container.innerHTML = `
                <div class="alert ${isEnforced ? 'alert-danger' : 'alert-warning'} mb-3">
                    <div class="d-flex align-items-center">
                        <i class="ti ti-${isEnforced ? 'alert-triangle' : 'shield-exclamation'} me-2" style="font-size: 1.5rem;"></i>
                        <div>
                            <strong>${isEnforced ? t('users.2faMandatory') : t('users.2faNotActive')}</strong>
                            <div class="text-muted small">${isEnforced ? t('users.mustActivate2fa') : t('users.addSecurity')}</div>
                        </div>
                    </div>
                </div>
                <button class="btn btn-primary btn-sm" id="profile-btn-setup-2fa">
                    <i class="ti ti-shield-plus me-1"></i>${t('users.activate2faBtn')}
                </button>
            `;
            setupEnable2FA();
        }
    } catch (error) {
        container.innerHTML = `
            <div class="alert alert-danger">
                <i class="ti ti-alert-circle me-2"></i>${t('users.2faStatusLoadError')}
            </div>
        `;
    }
}

function setupEnable2FA() {
    document.getElementById('profile-btn-setup-2fa')?.addEventListener('click', async () => {
        const btn = document.getElementById('profile-btn-setup-2fa');
        const original = btn.innerHTML;
        btn.innerHTML = `<span class="spinner-border spinner-border-sm me-1"></span>${t('app.generating')}`;
        btn.disabled = true;

        try {
            twoFaSetupData = await apiPost('/auth/me/2fa/setup', {});
            document.getElementById('profile-qr-code-img').src = `data:image/png;base64,${twoFaSetupData.qr_code}`;
            document.getElementById('profile-secret-key').value = twoFaSetupData.secret;
            clearOtpInput(document.getElementById('profile-verify-setup-code'));

            // One code per line in textContent: the copy button copies it as is
            document.getElementById('profile-backup-codes-list').innerHTML = twoFaSetupData.backup_codes.map(c =>
                `<div class="col-6 col-md-4"><span class="badge bg-secondary-lt font-monospace w-100 py-2">${c}</span></div>`
            ).join('\n');

            document.getElementById('profile-btn-download-setup-codes').onclick = () => {
                downloadBackupCodes(twoFaSetupData.backup_codes);
            };

            setupVerify2FA();
            new bootstrap.Modal(document.getElementById('profile-2fa-setup-modal')).show();
        } catch (error) {
            showToast(t('common.errorPrefix') + error.message, 'error');
        } finally {
            btn.innerHTML = original;
            btn.disabled = false;
        }
    });
}

function setupVerify2FA() {
    const verifyBtn = document.getElementById('profile-btn-verify-2fa');
    if (!verifyBtn) return;
    const fresh = verifyBtn.cloneNode(true);
    verifyBtn.parentNode.replaceChild(fresh, verifyBtn);

    fresh.addEventListener('click', async () => {
        const code = document.getElementById('profile-verify-setup-code').value;
        if (!code || code.length !== 6) {
            showToast(t('users.enterValidCode'), 'error');
            return;
        }
        const original = fresh.innerHTML;
        fresh.innerHTML = `<span class="spinner-border spinner-border-sm me-1"></span>${t('app.verificationInProgress')}`;
        fresh.disabled = true;

        try {
            await apiPost('/auth/me/2fa/enable', { code });
            showToast(t('app.2faActivatedSuccess'), 'success');
            bootstrap.Modal.getInstance(document.getElementById('profile-2fa-setup-modal'))?.hide();
            await load2FAStatus();
        } catch (error) {
            showToast(t('common.errorPrefix') + error.message, 'error');
        } finally {
            fresh.innerHTML = original;
            fresh.disabled = false;
        }
    });

    document.getElementById('profile-verify-setup-code')?.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') fresh.click();
    });
}

function setupDisable2FA() {
    document.getElementById('profile-btn-disable-2fa')?.addEventListener('click', async () => {
        const confirmed = await confirmDialog(
            t('users.disable2fa'), t('users.disable2faConfirm'), t('users.disable2fa'), 'btn-danger'
        );
        if (!confirmed) return;

        const passwordModal = new bootstrap.Modal(document.getElementById('profile-password-input-modal'));
        const input = document.getElementById('profile-modal-password-input');
        const confirmBtn = document.getElementById('profile-modal-password-confirm');
        input.value = '';
        passwordModal.show();

        const handleConfirm = async () => {
            const password = input.value;
            if (!password) {
                showToast(t('users.enterPassword'), 'error');
                return;
            }
            confirmBtn.disabled = true;
            confirmBtn.innerHTML = `<span class="spinner-border spinner-border-sm me-1"></span>${t('app.verificationInProgress')}`;
            try {
                await apiDeleteWithBody('/auth/me/2fa/disable', { password });
                passwordModal.hide();
                showToast(t('users.2faDisabled'), 'success');
                await load2FAStatus();
            } catch (error) {
                showToast(t('common.errorPrefix') + error.message, 'error');
            } finally {
                confirmBtn.disabled = false;
                confirmBtn.innerHTML = t('common.confirm');
            }
        };

        const fresh = confirmBtn.cloneNode(true);
        confirmBtn.parentNode.replaceChild(fresh, confirmBtn);
        fresh.addEventListener('click', handleConfirm);
        input.addEventListener('keypress', (e) => { if (e.key === 'Enter') handleConfirm(); }, { once: true });
    });
}

function setupRegenerateCodes() {
    document.getElementById('profile-btn-regenerate-codes')?.addEventListener('click', async () => {
        const otpModal = new bootstrap.Modal(document.getElementById('profile-otp-input-modal'));
        const input = document.getElementById('profile-modal-otp-input');
        const confirmBtn = document.getElementById('profile-modal-otp-confirm');
        input.value = '';
        otpModal.show();

        const handleConfirm = async () => {
            const code = input.value.trim();
            if (!code || (code.length !== 6 && code.length !== 8)) {
                showToast(t('users.enterValidCodeOtp'), 'error');
                return;
            }
            confirmBtn.disabled = true;
            confirmBtn.innerHTML = `<span class="spinner-border spinner-border-sm me-1"></span>${t('app.generating')}`;
            try {
                const result = await apiPost('/auth/me/2fa/backup-codes', { code });
                otpModal.hide();
                document.getElementById('profile-backup-codes-display').innerHTML = result.backup_codes.map(c =>
                    `<div class="col-6"><code class="fs-4">${c}</code></div>`
                ).join('\n');
                document.getElementById('profile-download-displayed-codes').onclick = () => {
                    downloadBackupCodes(result.backup_codes);
                };
                new bootstrap.Modal(document.getElementById('profile-backup-codes-display-modal')).show();
                showToast(t('users.newCodesGenerated'), 'success');
            } catch (error) {
                showToast(t('common.errorPrefix') + error.message, 'error');
            } finally {
                confirmBtn.disabled = false;
                confirmBtn.innerHTML = t('common.confirm');
            }
        };

        const fresh = confirmBtn.cloneNode(true);
        confirmBtn.parentNode.replaceChild(fresh, confirmBtn);
        fresh.addEventListener('click', handleConfirm);
        input.addEventListener('keypress', (e) => { if (e.key === 'Enter') handleConfirm(); }, { once: true });
    });
}

function downloadBackupCodes(codes) {
    const content = [
        t('users.2faBackupTitle'),
        t('users.2faBackupSeparator'),
        t('users.2faBackupGenerated', { date: new Date().toLocaleString(undefined) }),
        '',
        t('users.2faBackupKeepSafe'),
        t('users.2faBackupSingleUse'),
        '',
        ...codes
    ].join('\n');
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `madmin-backup-codes-${new Date().toISOString().slice(0, 10)}.txt`;
    document.body.appendChild(a);
    a.click();
    URL.revokeObjectURL(url);
    document.body.removeChild(a);
}
