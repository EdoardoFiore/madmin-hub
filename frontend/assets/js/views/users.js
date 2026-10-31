/**
 * MADMIN - Users View
 */

import { apiGet, apiPost, apiPatch, apiDelete, apiDeleteWithBody, apiPut } from '../api.js';
import {
    showToast, confirmDialog, formatDate, emptyState, escapeHtml, escapeAttr, statusBadge,
    copyButton, strengthMeter, clearOtpInput, refreshStrengthMeters
} from '../utils.js';
import { setPageActions, checkPermission, getUser } from '../app.js';
import { t } from '../i18n.js';

let users = [];
let permissions = [];
let editingUser = null;

/**
 * Permission slugs held by the logged-in user ('*' for superusers).
 */
function ownPermissions() {
    return new Set(getUser()?.permissions || []);
}

/**
 * Mirrors the backend guard (_assert_can_manage_target in core/auth/router.py):
 * a non-superuser may only act on accounts whose permissions are a subset of theirs.
 */
function canManageTarget(target) {
    if (getUser()?.is_superuser) return true;
    if (target.is_superuser) return false;

    const own = ownPermissions();
    return (target.permissions || []).every(slug => own.has(slug));
}

/**
 * Render the users view
 */
export async function render(container) {
    if (checkPermission('users.manage')) {
        setPageActions(`
            <button class="btn btn-primary" id="btn-add-user">
                <i class="ti ti-user-plus me-2"></i>${t('users.newUser')}
            </button>
        `);
    }

    container.innerHTML = `
        <!-- My Profile Security Section -->
        <div class="card mb-3">
            <div class="card-header">
                <h3 class="card-title"><i class="ti ti-user-cog me-2"></i>${t('users.myProfile')}</h3>
            </div>
            <div class="card-body">
                <div class="row g-4">
                    <!-- Change Password -->
                    <div class="col-lg-6">
                        <h4><i class="ti ti-lock me-2"></i>${t('users.changePassword')}</h4>
                        <form id="change-password-form" class="mt-3">
                            <div class="row g-2">
                                <div class="col-12">
                                    <input type="password" class="form-control" id="current-password"
                                           placeholder="${t('users.currentPassword')}" required>
                                </div>
                                <div class="col-md-6">
                                    <input type="password" class="form-control" id="new-password"
                                           placeholder="${t('users.newPassword')}" required minlength="8"
                                           autocomplete="new-password">
                                    ${strengthMeter('#new-password')}
                                </div>
                                <div class="col-md-6">
                                    <input type="password" class="form-control" id="confirm-password"
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
                        <div id="2fa-status-container" class="mt-3">
                            <div class="d-flex justify-content-center py-3">
                                <div class="spinner-border spinner-border-sm text-primary"></div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <!-- Users Table Card -->
        <div class="card">
            <div class="card-header">
                <h3 class="card-title">
                    <i class="ti ti-users me-2"></i>${t('users.registeredUsers')}
                </h3>
            </div>
            <div class="table-responsive">
                <table class="table table-vcenter card-table">
                    <thead>
                        <tr>
                            <th>${t('users.user')}</th>
                            <th>${t('users.email')}</th>
                            <th>${t('users.role')}</th>
                            <th>2FA</th>
                            <th>${t('users.status')}</th>
                            <th>${t('users.lastLogin')}</th>
                            <th class="w-1"></th>
                        </tr>
                    </thead>
                    <tbody id="users-table-body">
                        <tr><td colspan="7" class="text-center py-4">
                            <div class="spinner-border spinner-border-sm"></div>
                        </td></tr>
                    </tbody>
                </table>
            </div>
        </div>
        
        <!-- 2FA Setup Modal -->
        <div class="modal modal-blur fade" id="2fa-setup-modal" tabindex="-1">
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
                                <div id="qr-code-container" class="mb-3 p-3 bg-white rounded d-inline-block">
                                    <img id="qr-code-img" src="" alt="QR Code" style="width: 180px; height: 180px;">
                                </div>
                                <p class="text-muted small">Google Authenticator, Authy, etc.</p>
                            </div>
                            <div class="col-md-6">
                                <h5 class="mb-3">${t('users.orManually')}</h5>
                                <div class="input-group mb-3">
                                    <input type="text" class="form-control font-monospace text-center" id="secret-key" readonly>
                                    ${copyButton('#secret-key', 'btn btn-icon')}
                                </div>
                                <hr>
                                <h5 class="mb-3">${t('users.verifyCode')}</h5>
                                <div class="text-center mb-3">
                                    <div class="otp" data-bs-toggle="otp">
                                        <input type="text" id="verify-setup-code" maxlength="6"
                                               autocomplete="one-time-code" aria-label="${t('users.verifyCode')}">
                                    </div>
                                </div>
                                <button class="btn btn-primary w-100" id="btn-verify-2fa">
                                    <i class="ti ti-check me-1"></i>${t('users.activate2fa')}
                                </button>
                            </div>
                        </div>
                        <hr>
                        <div class="d-flex justify-content-between align-items-center">
                            <h5 class="mb-0"><i class="ti ti-key me-2"></i>${t('users.backupCodes')}</h5>
                            <div class="btn-list">
                                ${copyButton('#backup-codes-list', 'btn btn-sm btn-icon btn-outline-primary')}
                                <button type="button" class="btn btn-sm btn-outline-primary" id="btn-download-setup-codes">
                                    <i class="ti ti-download me-1"></i>${t('common.download')}
                                </button>
                            </div>
                        </div>
                        <div id="backup-codes-list" class="row g-2 mt-2"></div>
                    </div>
                </div>
            </div>
        </div>
        
        <!-- User Modal -->
        <div class="modal modal-blur fade" id="user-modal" tabindex="-1">
            <div class="modal-dialog modal-lg">
                <div class="modal-content">
                    <div class="modal-header">
                        <h5 class="modal-title" id="user-modal-title">${t('users.newUser')}</h5>
                        <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                    </div>
                    <form id="user-form">
                        <div class="modal-body">
                            <div class="row g-3">
                                <div class="col-md-6">
                                    <label class="form-label required">Username</label>
                                    <input type="text" class="form-control" id="user-username" required 
                                           minlength="3" maxlength="50" pattern="[a-zA-Z0-9_-]+">
                                    <small class="form-hint">${t('users.lettersNumbersDashes')}</small>
                                </div>
                                <div class="col-md-6">
                                    <label class="form-label">Email</label>
                                    <input type="email" class="form-control" id="user-email">
                                </div>
                                <div class="col-md-6" id="user-password-col">
                                    <label class="form-label" id="password-label">Password</label>
                                    <input type="password" class="form-control" id="user-password" minlength="8"
                                           autocomplete="new-password">
                                    ${strengthMeter('#user-password')}
                                    <small class="form-hint" id="password-hint">${t('users.passwordHintNew')}</small>
                                </div>
                                <div class="col-md-6" id="user-password-confirm-col">
                                    <label class="form-label" id="password-confirm-label">${t('users.confirmPassword')}</label>
                                    <input type="password" class="form-control" id="user-password-confirm" minlength="8">
                                    <small class="form-hint text-danger d-none" id="password-mismatch">${t('users.passwordsDoNotMatch')}</small>
                                </div>
                                <div class="col-12 d-none" id="superuser-container">
                                    <label class="form-check form-switch">
                                        <input class="form-check-input" type="checkbox" id="user-superuser">
                                        <span class="form-check-label"><strong>Superuser</strong> ${t('users.superuserNote')}</span>
                                    </label>
                                </div>
                                <div class="col-6">
                                    <label class="form-check form-switch">
                                        <input class="form-check-input" type="checkbox" id="user-active" checked>
                                        <span class="form-check-label">${t('users.activeLabel')}</span>
                                    </label>
                                    <small class="form-hint text-muted">${t('users.disabledUsersNote')}</small>
                                </div>
                                <div class="col-6 d-none" id="force-2fa-container">
                                    <label class="form-check form-switch">
                                        <input class="form-check-input" type="checkbox" id="user-totp-enforced">
                                        <span class="form-check-label"><i class="ti ti-shield-check me-1"></i>${t('users.force2fa')}</span>
                                    </label>
                                    <small class="form-hint text-muted">${t('users.force2faNote')}</small>
                                </div>
                                <div class="col-12 d-none" id="pwd-policy-container">
                                    <div class="row g-3">
                                        <div class="col-md-6">
                                            <label class="form-check form-switch">
                                                <input class="form-check-input" type="checkbox" id="user-must-change-password">
                                                <span class="form-check-label"><i class="ti ti-key me-1"></i>${t('users.forcePasswordChange')}</span>
                                            </label>
                                            <small class="form-hint text-muted">${t('users.forcePasswordChangeNote')}</small>
                                        </div>
                                        <div class="col-md-6">
                                            <label class="form-label">${t('users.passwordExpiresAt')}</label>
                                            <input type="datetime-local" class="form-control" id="user-password-expires-at">
                                            <small class="form-hint text-muted" id="password-expires-hint">${t('users.passwordExpiresAtNote')}</small>
                                        </div>
                                    </div>
                                </div>
                                <div class="col-12" id="permissions-section">
                                    <div class="d-flex align-items-center flex-wrap gap-2 mb-2">
                                        <label class="form-label mb-0 flex-fill">${t('users.permissions')}</label>
                                        <div class="form-selectgroup" id="permission-presets">
                                            <label class="form-selectgroup-item">
                                                <input type="radio" name="perm-preset" value="readonly" class="form-selectgroup-input perm-preset">
                                                <span class="form-selectgroup-label"><i class="ti ti-eye me-1"></i>${t('users.presetReadonly')}</span>
                                            </label>
                                            <label class="form-selectgroup-item">
                                                <input type="radio" name="perm-preset" value="netop" class="form-selectgroup-input perm-preset">
                                                <span class="form-selectgroup-label"><i class="ti ti-tool me-1"></i>${t('users.presetNetop')}</span>
                                            </label>
                                            <label class="form-selectgroup-item">
                                                <input type="radio" name="perm-preset" value="custom" class="form-selectgroup-input perm-preset" checked>
                                                <span class="form-selectgroup-label"><i class="ti ti-adjustments me-1"></i>${t('users.presetCustom')}</span>
                                            </label>
                                        </div>
                                    </div>
                                    <div class="d-flex align-items-center gap-2 mb-3">
                                        <div class="text-muted small flex-fill">
                                            <i class="ti ti-info-circle me-1"></i>${t('users.manageImpliesView')}
                                        </div>
                                        <button type="button" class="btn btn-sm btn-ghost-secondary flex-shrink-0"
                                                id="btn-toggle-perm-detail">
                                            <i class="ti ti-chevron-down me-1"></i>${t('users.showDetail')}
                                        </button>
                                    </div>
                                    <div id="permissions-detail" class="d-none">
                                        <div id="permissions-list" class="row g-3">
                                            <!-- Permissions will be loaded here grouped -->
                                        </div>
                                    </div>
                                    <div id="module-defaults" class="mt-3 d-none"></div>
                                    <div class="alert alert-secondary mt-3 mb-0 py-2 px-3">
                                        <div class="small fw-bold mb-1"><i class="ti ti-crown me-1"></i>${t('users.superuserOnlyTitle')}</div>
                                        <div class="small text-muted">${t('users.superuserOnlyList')}</div>
                                    </div>
                                </div>
                            </div>
                        </div>
                        <div class="modal-footer">
                            <button type="button" class="btn btn-danger me-auto d-none" id="btn-reset-user-2fa">
                                <i class="ti ti-shield-off me-1"></i>${t('users.reset2fa')}
                            </button>
                            <button type="button" class="btn btn-link" data-bs-dismiss="modal">${t('common.cancel')}</button>
                            <button type="submit" class="btn btn-primary">${t('common.save')}</button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
        
        <!-- Password Input Modal -->
        <div class="modal modal-blur fade" id="password-input-modal" tabindex="-1">
            <div class="modal-dialog modal-sm">
                <div class="modal-content">
                    <div class="modal-header">
                        <h5 class="modal-title">${t('users.confirmPasswordTitle')}</h5>
                        <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                    </div>
                    <div class="modal-body">
                        <p class="text-muted">${t('users.confirmPasswordDesc')}</p>
                        <input type="password" class="form-control" id="modal-password-input"
                               placeholder="${t('auth.password')}" autofocus>
                    </div>
                    <div class="modal-footer">
                        <button type="button" class="btn btn-link" data-bs-dismiss="modal">${t('common.cancel')}</button>
                        <button type="button" class="btn btn-danger" id="modal-password-confirm">${t('common.confirm')}</button>
                    </div>
                </div>
            </div>
        </div>
        
        <!-- OTP Input Modal -->
        <div class="modal modal-blur fade" id="otp-input-modal" tabindex="-1">
            <div class="modal-dialog modal-sm">
                <div class="modal-content">
                    <div class="modal-header">
                        <h5 class="modal-title">${t('users.verify2fa')}</h5>
                        <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                    </div>
                    <div class="modal-body">
                        <p class="text-muted">${t('users.verify2faDesc')}</p>
                        <input type="text" class="form-control form-control-lg text-center font-monospace"
                               id="modal-otp-input" maxlength="12" pattern="[0-9A-Za-z]{6,12}"
                               placeholder="000000" inputmode="numeric" autofocus>
                    </div>
                    <div class="modal-footer">
                        <button type="button" class="btn btn-link" data-bs-dismiss="modal">${t('common.cancel')}</button>
                        <button type="button" class="btn btn-primary" id="modal-otp-confirm">${t('common.confirm')}</button>
                    </div>
                </div>
            </div>
        </div>
        
        <!-- Backup Codes Display Modal -->
        <div class="modal modal-blur fade" id="backup-codes-display-modal" tabindex="-1">
            <div class="modal-dialog">
                <div class="modal-content">
                    <div class="modal-header">
                        <h5 class="modal-title"><i class="ti ti-key me-2"></i>${t('users.newBackupCodes')}</h5>
                        <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                    </div>
                    <div class="modal-body">
                        <div class="alert alert-warning">
                            <i class="ti ti-alert-triangle me-2"></i>
                            ${t('users.backupCodesWarning')}
                        </div>
                        <div id="backup-codes-display" class="row g-2"></div>
                    </div>
                    <div class="modal-footer">
                        ${copyButton('#backup-codes-display', 'btn btn-icon btn-outline-primary')}
                        <button type="button" class="btn btn-outline-primary" id="download-displayed-codes">
                            <i class="ti ti-download me-1"></i>${t('common.download')}
                        </button>
                        <button type="button" class="btn btn-primary" data-bs-dismiss="modal">${t('users.savedCodes')}</button>
                    </div>
                </div>
            </div>
        </div>
    `;

    setupEventListeners();
    await loadData();
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
    a.download = `madmin-backup-codes-${new Date().toISOString().slice(0,10)}.txt`;
    document.body.appendChild(a);
    a.click();
    URL.revokeObjectURL(url);
    document.body.removeChild(a);
}

function setupEventListeners() {
    const addBtn = document.getElementById('btn-add-user');
    if (addBtn) {
        addBtn.addEventListener('click', () => openUserModal());
    }

    const form = document.getElementById('user-form');
    if (form) {
        form.addEventListener('submit', handleUserSubmit);
    }

    document.querySelectorAll('.perm-preset').forEach(radio => {
        radio.addEventListener('change', (e) => {
            applyPreset(e.target.value);
            // Choosing "custom" means you intend to edit the detail; a preset
            // does not close it again, so you can check what it just did.
            if (e.target.value === 'custom') setPermissionDetail(true);
        });
    });

    document.getElementById('btn-toggle-perm-detail')?.addEventListener('click', () => {
        const detail = document.getElementById('permissions-detail');
        setPermissionDetail(detail?.classList.contains('d-none'));
    });

    const superuserCheck = document.getElementById('user-superuser');
    if (superuserCheck) {
        superuserCheck.addEventListener('change', (e) => {
            const permSection = document.getElementById('permissions-section');
            const hide = e.target.checked || !checkPermission('permissions.manage');
            permSection.style.display = hide ? 'none' : 'block';
        });
    }

    // Password confirmation check
    const passwordConfirm = document.getElementById('user-password-confirm');
    if (passwordConfirm) {
        passwordConfirm.addEventListener('input', validatePasswordMatch);
    }

    const password = document.getElementById('user-password');
    if (password) {
        password.addEventListener('input', validatePasswordMatch);
    }

    // Setup password change form
    setupPasswordChangeForm();

    // Load 2FA status
    load2FAStatus();
}

function validatePasswordMatch() {
    const password = document.getElementById('user-password').value;
    const confirm = document.getElementById('user-password-confirm').value;
    const mismatch = document.getElementById('password-mismatch');

    if (confirm && password !== confirm) {
        mismatch.classList.remove('d-none');
        return false;
    } else {
        mismatch.classList.add('d-none');
        return true;
    }
}

async function loadData() {
    try {
        [users, permissions] = await Promise.all([
            apiGet('/auth/users'),
            checkPermission('permissions.manage')
                ? apiGet('/auth/permissions').catch(() => [])
                : Promise.resolve([])
        ]);
        renderUsers();
    } catch (error) {
        showToast(t('common.errorPrefix') + error.message, 'error');
    }
}

function renderUsers() {
    const tbody = document.getElementById('users-table-body');
    const canManage = checkPermission('users.manage');
    const currentUser = getUser();

    if (users.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7">${emptyState('ti-users', t('users.noUsers'))}</td></tr>`;
        return;
    }

    tbody.innerHTML = users.map(user => {
        // Determine if we should show action buttons
        const isSelf = user.username === currentUser?.username;

        // Protected user (first setup user): no one else can edit or delete.
        // A more privileged target is off limits too — the backend would reject it anyway.
        const showActions = canManage && !isSelf && !user.is_protected && canManageTarget(user);

        // Password status badge: force-change takes priority, then expired
        const pwdExpired = user.password_expires_at && new Date(user.password_expires_at) < new Date();
        const pwdBadge = user.must_change_password
            ? `<span class="badge bg-orange-lt ms-1" title="${t('users.forcePasswordChange')}"><i class="ti ti-key"></i></span>`
            : pwdExpired
                ? `<span class="badge bg-red-lt ms-1" title="${t('users.passwordExpired')}"><i class="ti ti-clock-exclamation"></i></span>`
                : '';

        // 2FA status icon
        const twoFaIcon = user.totp_locked
            ? `<span class="badge bg-orange-lt" title="${t('users.2faActive')} — Reset"><i class="ti ti-shield-x"></i></span>`
            : user.totp_enabled
                ? `<span class="badge bg-green-lt" title="${t('users.2faActive')}"><i class="ti ti-shield-check"></i></span>`
                : `<span class="badge bg-secondary-lt" title="${t('users.2faNotActive')}"><i class="ti ti-shield-off"></i></span>`;

        return `
            <tr>
                <td>
                    <div class="d-flex align-items-center">
                        <span class="avatar avatar-sm bg-${user.is_superuser ? 'red' : 'blue'}-lt me-2">
                            <i class="ti ti-${user.is_superuser ? 'crown' : 'user'}"></i>
                        </span>
                        <div>
                            <div class="font-weight-medium">${escapeHtml(user.username)}${pwdBadge}</div>
                            ${user.is_superuser ? '<small class="text-muted">Superuser</small>' : ''}
                        </div>
                    </div>
                </td>
                <td>${user.email ? escapeHtml(user.email) : '<span class="text-muted">-</span>'}</td>
                <td>${user.is_superuser ? '<span class="badge bg-red-lt">Admin</span>' : `<span class="badge bg-blue-lt">${t('users.user')}</span>`}</td>
                <td>${twoFaIcon}</td>
                <td>${statusBadge(user.is_active)}</td>
                <td>${user.last_login ? formatDate(user.last_login) : `<span class="text-muted">${t('users.never')}</span>`}</td>
                <td>
                    ${showActions ? `
                        <div class="btn-group btn-group-sm">
                            <button class="btn btn-ghost-primary btn-edit" data-username="${escapeAttr(user.username)}" title="${t('common.edit')}">
                                <i class="ti ti-edit"></i>
                            </button>
                            <button class="btn btn-ghost-danger btn-delete" data-username="${escapeAttr(user.username)}" title="${t('common.delete')}">
                                <i class="ti ti-trash"></i>
                            </button>
                        </div>
                    ` : ''}
                </td>
            </tr>
        `;
    }).join('');

    tbody.querySelectorAll('.btn-edit').forEach(btn => {
        btn.addEventListener('click', () => {
            const user = users.find(u => u.username === btn.dataset.username);
            if (user) openUserModal(user);
        });
    });

    tbody.querySelectorAll('.btn-delete').forEach(btn => {
        btn.addEventListener('click', async () => {
            const confirmed = await confirmDialog(t('users.deleteUser'), t('users.deleteUserConfirm'), t('common.delete'), 'btn-danger');
            if (confirmed) {
                try {
                    await apiDelete(`/auth/users/${btn.dataset.username}`);
                    showToast(t('users.userDeleted'), 'success');
                    await loadData();
                } catch (error) {
                    showToast(t('common.errorPrefix') + error.message, 'error');
                }
            }
        });
    });
}

/**
 * Permission areas, in the order they are offered.
 *
 * An "area" is the slug prefix. Inside one, `.view` and `.manage` are levels on
 * a single control rather than independent checkboxes — managing implies seeing
 * (User.effective_permission_slugs on the backend), so offering them separately
 * only ever produced nonsense combinations. Anything else in the area is a
 * capability: an extra power granted on top of the level.
 */
const AREA_META = {
    users: { icon: 'ti-users', order: 10 },
    firewall: { icon: 'ti-shield', order: 20 },
    network: { icon: 'ti-network', order: 30 },
    settings: { icon: 'ti-palette', order: 40 },
    smtp: { icon: 'ti-mail', order: 50 },
    backup: { icon: 'ti-database', order: 60 },
    cron: { icon: 'ti-clock', order: 70 },
    services: { icon: 'ti-server-cog', order: 80 },
    modules: { icon: 'ti-puzzle', order: 90 },
    logs: { icon: 'ti-file-text', order: 100 },
};

// Capabilities that hand over more than the area they sit in
const DANGEROUS_CAPS = new Set(['backup.restore']);

// permissions.manage has no area of its own: it only modifies user management,
// and showing it as a separate "Permessi" card made it look independent.
const FOLDED_INTO_USERS = 'permissions.manage';

/**
 * Group the grantable permissions into areas with a level and capabilities.
 */
function buildPermissionAreas(grantable) {
    const areas = {};

    for (const perm of grantable) {
        const [prefix, ...rest] = perm.slug.split('.');
        const action = rest.join('.');

        // Fold permissions.manage into the Users area as a capability
        const areaKey = perm.slug === FOLDED_INTO_USERS ? 'users' : prefix;
        const area = areas[areaKey] || (areas[areaKey] = {
            key: areaKey,
            hasView: false,
            hasManage: false,
            caps: [],
        });

        if (perm.slug === FOLDED_INTO_USERS) {
            area.caps.push(perm);
        } else if (action === 'view') {
            area.hasView = true;
        } else if (action === 'manage') {
            area.hasManage = true;
        } else {
            area.caps.push(perm);
        }
    }

    return Object.values(areas).sort((a, b) => {
        const ao = AREA_META[a.key]?.order ?? 500;
        const bo = AREA_META[b.key]?.order ?? 500;
        return ao - bo || a.key.localeCompare(b.key);
    });
}

function areaLabel(key) {
    const translated = t(`users.areaLabels.${key}`);
    if (translated !== `users.areaLabels.${key}`) return translated;
    return key.charAt(0).toUpperCase() + key.slice(1);
}

function capLabel(slug) {
    const translated = t(`users.capLabels.${slug}`);
    if (translated !== `users.capLabels.${slug}`) return translated;
    // Module capabilities have no translation: prettify the slug's action part
    const action = slug.split('.').slice(1).join('.');
    return action.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
}

function renderGroupedPermissions(userPerms) {
    const permList = document.getElementById('permissions-list');
    if (!permList) return;

    // A non-superuser can only grant what they hold (backend: _assert_can_grant),
    // so never offer a control that would come back 403.
    const isSuperuser = getUser()?.is_superuser || false;
    const own = ownPermissions();
    const grantable = isSuperuser ? permissions : permissions.filter(p => own.has(p.slug));
    const held = new Set(userPerms);

    const areas = buildPermissionAreas(grantable);

    const cards = areas.map(area => {
        const meta = AREA_META[area.key] || {};
        const icon = meta.icon || 'ti-puzzle-2';
        const level = held.has(`${area.key}.manage`) ? 'manage'
            : held.has(`${area.key}.view`) ? 'view'
                : 'none';

        // Areas with no .manage slug (cron, logs) are read-or-nothing
        const levels = [
            { value: 'none', label: t('users.levelNone'), icon: 'ti-minus' },
            ...(area.hasView ? [{ value: 'view', label: t('users.levelView'), icon: 'ti-eye' }] : []),
            ...(area.hasManage ? [{ value: 'manage', label: t('users.levelManage'), icon: 'ti-pencil' }] : []),
        ];

        const levelHtml = levels.map(l => `
            <label class="form-selectgroup-item flex-fill">
                <input type="radio" name="lvl-${escapeHtml(area.key)}" value="${escapeHtml(l.value)}"
                       class="form-selectgroup-input perm-level" data-area="${escapeHtml(area.key)}"
                       ${level === l.value ? 'checked' : ''}>
                <span class="form-selectgroup-label d-block text-center py-1 px-2">
                    <i class="ti ${escapeHtml(l.icon)} me-1"></i>${escapeHtml(l.label)}
                </span>
            </label>
        `).join('');

        const capsHtml = area.caps.length === 0 ? '' : `
            <div class="mt-3 pt-2 border-top perm-caps" data-area="${escapeHtml(area.key)}">
                <div class="text-muted small mb-2">${t('users.permCapabilities')}</div>
                ${area.caps.map(cap => {
            const danger = DANGEROUS_CAPS.has(cap.slug);
            return `
                    <label class="form-check form-switch mb-1 d-flex align-items-center">
                        <input class="form-check-input perm-cap" type="checkbox" value="${escapeAttr(cap.slug)}"
                               data-area="${escapeHtml(area.key)}" ${held.has(cap.slug) ? 'checked' : ''}
                               ${level === 'none' ? 'disabled' : ''}>
                        <span class="form-check-label flex-fill">
                            ${escapeHtml(capLabel(cap.slug))}
                            ${danger ? `<span class="badge bg-red-lt ms-1">${t('users.capRisk')}</span>` : ''}
                        </span>
                        <i class="ti ti-info-circle text-muted ms-2" data-bs-toggle="tooltip"
                           title="${escapeAttr(cap.description || cap.slug)}"></i>
                    </label>
                `;
        }).join('')}
            </div>
        `;

        // Say out loud why an area offers no "manage" instead of leaving a gap
        const note = !area.hasManage && area.key === 'cron'
            ? `<div class="text-muted small mt-2"><i class="ti ti-lock me-1"></i>${t('users.cronWriteNote')}</div>`
            : '';

        return `
            <div class="col-md-6">
                <div class="card card-sm h-100">
                    <div class="card-body p-3">
                        <div class="d-flex align-items-center mb-2">
                            <i class="ti ${icon} me-2 text-muted"></i>
                            <strong class="flex-fill">${escapeHtml(areaLabel(area.key))}</strong>
                        </div>
                        <div class="form-selectgroup w-100 d-flex gap-1">${levelHtml}</div>
                        ${capsHtml}
                        ${note}
                    </div>
                </div>
            </div>
        `;
    }).join('');

    permList.innerHTML = cards || `<div class="col-12 text-muted small">${t('users.noGrantablePerms')}</div>`;

    // Capabilities make no sense without at least read access to their area
    permList.querySelectorAll('.perm-level').forEach(radio => {
        radio.addEventListener('change', (e) => {
            const area = e.target.dataset.area;
            const off = e.target.value === 'none';
            permList.querySelectorAll(`.perm-cap[data-area="${area}"]`).forEach(cap => {
                cap.disabled = off;
                if (off) cap.checked = false;
            });
            markPresetCustom();
        });
    });
    permList.querySelectorAll('.perm-cap').forEach(cap => {
        cap.addEventListener('change', markPresetCustom);
    });

    permList.querySelectorAll('[data-bs-toggle="tooltip"]').forEach(el => {
        new bootstrap.Tooltip(el);
    });
}

/**
 * Read the picker back into a flat slug list.
 *
 * "Gestione" emits only `<area>.manage`: `.view` is implied by the backend, and
 * storing both would make the editor's own state ambiguous on reload.
 */
function collectPermissions() {
    const slugs = [];

    document.querySelectorAll('.perm-level:checked').forEach(radio => {
        const area = radio.dataset.area;
        if (radio.value === 'view') slugs.push(`${area}.view`);
        else if (radio.value === 'manage') slugs.push(`${area}.manage`);
    });

    document.querySelectorAll('.perm-cap:checked').forEach(cap => {
        if (!cap.disabled) slugs.push(cap.value);
    });

    return slugs;
}

/**
 * Apply a preset to the picker.
 *
 * readonly — read every area, change nothing.
 * netop    — read everything, plus run the day-to-day operational areas:
 *            firewall, network, modules and the installed modules themselves.
 *            Deliberately excludes user management, backups, SMTP and branding,
 *            i.e. everything that could reconfigure the box or hand it to
 *            someone else.
 */
function applyPreset(preset) {
    if (preset === 'custom') return;

    const MANAGED_CORE = new Set(['firewall', 'network', 'modules']);
    const coreAreas = new Set(Object.keys(AREA_META));

    document.querySelectorAll('.perm-level').forEach(radio => {
        const area = radio.dataset.area;
        const isModuleArea = !coreAreas.has(area);
        let want = 'view';

        if (preset === 'netop' && (MANAGED_CORE.has(area) || isModuleArea)) {
            want = 'manage';
        }

        // An area with no such level falls back to the strongest one it has
        const available = new Set(
            [...document.querySelectorAll(`.perm-level[data-area="${area}"]`)].map(r => r.value)
        );
        if (!available.has(want)) want = available.has('view') ? 'view' : 'none';

        radio.checked = radio.value === want;
    });

    document.querySelectorAll('.perm-cap').forEach(cap => {
        const area = cap.dataset.area;
        const isModuleArea = !coreAreas.has(area);
        const level = document.querySelector(`.perm-level[data-area="${area}"]:checked`)?.value;

        cap.disabled = level === 'none';
        // Module capabilities come with the module; dangerous ones never do
        cap.checked = preset === 'netop' && isModuleArea && !DANGEROUS_CAPS.has(cap.value);
    });
}

/**
 * Show or hide the per-area detail.
 *
 * Collapsed by default: most accounts are opened with a preset, and the full
 * grid of areas buries the choice that actually matters.
 */
function setPermissionDetail(open) {
    const detail = document.getElementById('permissions-detail');
    const btn = document.getElementById('btn-toggle-perm-detail');
    if (!detail) return;

    detail.classList.toggle('d-none', !open);
    if (btn) {
        btn.innerHTML = open
            ? `<i class="ti ti-chevron-up me-1"></i>${t('users.hideDetail')}`
            : `<i class="ti ti-chevron-down me-1"></i>${t('users.showDetail')}`;
    }
}

/**
 * Render the policy for modules activated later.
 *
 * A module's slugs do not exist when the account is created, so an operator who
 * can activate a module would otherwise be unable to manage what they installed.
 * Superuser-only: it grants permissions on things nobody has reviewed yet.
 */
function renderModuleDefaults(user) {
    const wrap = document.getElementById('module-defaults');
    if (!wrap) return;

    if (!getUser()?.is_superuser) {
        wrap.classList.add('d-none');
        wrap.innerHTML = '';
        return;
    }
    wrap.classList.remove('d-none');

    const level = user?.module_default_level || 'none';
    const caps = user?.module_default_capabilities || false;
    const levels = [
        { value: 'none', label: t('users.levelNone'), icon: 'ti-minus' },
        { value: 'view', label: t('users.levelView'), icon: 'ti-eye' },
        { value: 'manage', label: t('users.levelManage'), icon: 'ti-pencil' },
    ];

    wrap.innerHTML = `
        <div class="card card-sm">
            <div class="card-body p-3">
                <div class="d-flex align-items-center mb-1">
                    <i class="ti ti-package me-2 text-muted"></i>
                    <strong class="flex-fill">${t('users.moduleDefaultsTitle')}</strong>
                </div>
                <div class="text-muted small mb-2">${t('users.moduleDefaultsHint')}</div>
                <div class="form-selectgroup d-flex gap-1" style="max-width: 24rem;">
                    ${levels.map(l => `
                    <label class="form-selectgroup-item flex-fill">
                        <input type="radio" name="module-default-level" value="${escapeHtml(l.value)}"
                               class="form-selectgroup-input" id="mdl-${l.value}"
                               ${level === l.value ? 'checked' : ''}>
                        <span class="form-selectgroup-label d-block text-center py-1 px-2">
                            <i class="ti ${escapeHtml(l.icon)} me-1"></i>${escapeHtml(l.label)}
                        </span>
                    </label>
                    `).join('')}
                </div>
                <label class="form-check form-switch mt-2 mb-0">
                    <input class="form-check-input" type="checkbox" id="module-default-caps"
                           ${caps ? 'checked' : ''} ${level === 'manage' ? '' : 'disabled'}>
                    <span class="form-check-label">${t('users.moduleDefaultsCaps')}</span>
                </label>
            </div>
        </div>
    `;

    // Capabilities are powers on top of managing the module
    wrap.querySelectorAll('input[name="module-default-level"]').forEach(radio => {
        radio.addEventListener('change', (e) => {
            const capsInput = document.getElementById('module-default-caps');
            if (!capsInput) return;
            capsInput.disabled = e.target.value !== 'manage';
            if (capsInput.disabled) capsInput.checked = false;
        });
    });
}

/**
 * The module default policy, or null when the card is not on screen
 * (non-superuser, or the permissions section is hidden).
 */
function collectModuleDefaults() {
    const wrap = document.getElementById('module-defaults');
    if (!wrap || wrap.classList.contains('d-none')) return null;

    const level = wrap.querySelector('input[name="module-default-level"]:checked')?.value || 'none';
    const caps = document.getElementById('module-default-caps');
    return {
        module_default_level: level,
        module_default_capabilities: level === 'manage' && !!caps?.checked,
    };
}

function markPresetCustom() {
    const custom = document.querySelector('.perm-preset[value="custom"]');
    if (custom) custom.checked = true;
}

function openUserModal(user = null) {
    editingUser = user;
    const currentUser = getUser();
    const isSuperuser = currentUser?.is_superuser || false;

    document.getElementById('user-modal-title').textContent = user ? t('users.editUser') : t('users.newUser');
    document.getElementById('user-username').value = user?.username || '';
    document.getElementById('user-username').disabled = !!user;
    document.getElementById('user-email').value = user?.email || '';
    document.getElementById('user-password').value = '';
    document.getElementById('user-password-confirm').value = '';
    refreshStrengthMeters(document.getElementById('user-form'));
    document.getElementById('user-password').required = !user;
    document.getElementById('user-password-confirm').required = !user;
    document.getElementById('password-label').classList.toggle('required', !user);
    document.getElementById('password-confirm-label').classList.toggle('required', !user);
    document.getElementById('password-hint').textContent = user ? t('users.passwordHintEdit') : t('users.passwordHintNew');
    document.getElementById('password-mismatch').classList.add('d-none');
    // Your own password changes from the profile, which asks for the current
    // one: the backend refuses it here, where a stolen session could set it.
    const isSelf = !!user && user.username === currentUser?.username;
    document.getElementById('user-password-col').classList.toggle('d-none', isSelf);
    document.getElementById('user-password-confirm-col').classList.toggle('d-none', isSelf);
    document.getElementById('user-superuser').checked = user?.is_superuser || false;
    document.getElementById('user-active').checked = user?.is_active ?? true;
    document.getElementById('user-totp-enforced').checked = user?.totp_enforced || false;

    // Password policy — offered on creation too: handing someone a temporary
    // password and forcing a change at first login is the normal way to open an
    // account, and it is applied as the account is created.
    const pwdPolicyContainer = document.getElementById('pwd-policy-container');
    document.getElementById('user-must-change-password').checked = user?.must_change_password || false;
    // datetime-local needs "YYYY-MM-DDTHH:mm"; API returns a naive ISO timestamp
    document.getElementById('user-password-expires-at').value =
        user?.password_expires_at ? user.password_expires_at.slice(0, 16) : '';
    pwdPolicyContainer.classList.remove('d-none');
    // "leave empty to keep" makes no sense on a form that has nothing to keep
    const expiresHint = document.getElementById('password-expires-hint');
    if (expiresHint) {
        expiresHint.textContent = user
            ? t('users.passwordExpiresAtNote')
            : t('users.passwordExpiresAtNoteNew');
    }

    // "Force 2FA" is a superuser lever, and nobody sets it on themselves
    const force2faContainer = document.getElementById('force-2fa-container');
    const canForce2fa = isSuperuser && (!user || user.username !== currentUser?.username);
    force2faContainer.classList.toggle('d-none', !canForce2fa);

    // Show "Reset 2FA" button for superusers editing users with 2FA enabled or locked
    const reset2faBtn = document.getElementById('btn-reset-user-2fa');
    if (isSuperuser && user && (user.totp_enabled || user.totp_locked) && user.username !== currentUser?.username && !user.is_protected) {
        reset2faBtn.classList.remove('d-none');
        // Remove old listeners by cloning
        const newBtn = reset2faBtn.cloneNode(true);
        reset2faBtn.parentNode.replaceChild(newBtn, reset2faBtn);
        newBtn.addEventListener('click', () => handleReset2FA(user.username));
    } else {
        reset2faBtn.classList.add('d-none');
    }

    // Superuser toggle is a superuser-only lever: granting it is rejected by the backend
    const superuserRow = document.getElementById('superuser-container');
    if (superuserRow) superuserRow.classList.toggle('d-none', !isSuperuser);

    // permissions.manage is a modifier of users.manage: without it the section is read-only noise
    const permSection = document.getElementById('permissions-section');
    const canEditPerms = checkPermission('permissions.manage');
    permSection.style.display = (user?.is_superuser || !canEditPerms) ? 'none' : 'block';

    const userPerms = user?.permissions || [];
    if (canEditPerms) {
        // The stored set is what it is; a preset is only ever an entry point
        const custom = document.querySelector('.perm-preset[value="custom"]');
        if (custom) custom.checked = true;
        renderGroupedPermissions(userPerms);
        renderModuleDefaults(user);
        setPermissionDetail(false);
    }

    new bootstrap.Modal(document.getElementById('user-modal')).show();
}

async function handleUserSubmit(e) {
    e.preventDefault();

    const username = document.getElementById('user-username').value;
    const password = document.getElementById('user-password').value;
    const passwordConfirm = document.getElementById('user-password-confirm').value;

    // Validate password match
    if (password && password !== passwordConfirm) {
        showToast(t('users.passwordMismatch'), 'error');
        return;
    }

    try {
        if (editingUser) {
            const updateData = {
                email: document.getElementById('user-email').value || null,
                is_superuser: document.getElementById('user-superuser').checked,
                is_active: document.getElementById('user-active').checked,
                must_change_password: document.getElementById('user-must-change-password').checked
            };

            // Only send totp_enforced if the container is visible (superuser editing another user)
            const force2faContainer = document.getElementById('force-2fa-container');
            if (!force2faContainer.classList.contains('d-none')) {
                updateData.totp_enforced = document.getElementById('user-totp-enforced').checked;
            }

            // Manual password expiry override (empty = leave unchanged)
            const expiresAt = document.getElementById('user-password-expires-at').value;
            if (expiresAt) updateData.password_expires_at = expiresAt;

            Object.assign(updateData, collectModuleDefaults() || {});

            if (password) updateData.password = password;

            await apiPatch(`/auth/users/${editingUser.username}`, updateData);

            // Only send permissions when they were editable, otherwise the PUT 403s
            // on a save that never touched them.
            if (!document.getElementById('user-superuser').checked && checkPermission('permissions.manage')) {
                const selectedPerms = collectPermissions();
                await apiPut(`/auth/users/${editingUser.username}/permissions`, selectedPerms);
            }

            showToast(t('users.userUpdated'), 'success');
        } else {
            // Create new user — the account policy travels with the creation so
            // the account never exists in a state the admin did not ask for
            const createData = {
                username,
                password,
                email: document.getElementById('user-email').value || null,
                is_superuser: document.getElementById('user-superuser').checked,
                must_change_password: document.getElementById('user-must-change-password').checked
            };

            const force2faContainer = document.getElementById('force-2fa-container');
            if (!force2faContainer.classList.contains('d-none')) {
                createData.totp_enforced = document.getElementById('user-totp-enforced').checked;
            }

            const newExpiresAt = document.getElementById('user-password-expires-at').value;
            if (newExpiresAt) createData.password_expires_at = newExpiresAt;

            Object.assign(createData, collectModuleDefaults() || {});

            await apiPost('/auth/users', createData);

            // Save permissions if not superuser and they were editable
            if (!document.getElementById('user-superuser').checked && checkPermission('permissions.manage')) {
                const selectedPerms = collectPermissions();
                await apiPut(`/auth/users/${username}/permissions`, selectedPerms);
            }

            showToast(t('users.userCreated'), 'success');
        }

        bootstrap.Modal.getInstance(document.getElementById('user-modal')).hide();
        await loadData();
    } catch (error) {
        showToast(t('common.errorPrefix') + error.message, 'error');
    }
}


// ========== PASSWORD CHANGE & 2FA MANAGEMENT ==========

let twoFaSetupData = null;

/**
 * Setup password change form handler
 */
function setupPasswordChangeForm() {
    const form = document.getElementById('change-password-form');
    form?.addEventListener('submit', async (e) => {
        e.preventDefault();

        const currentPassword = document.getElementById('current-password').value;
        const newPassword = document.getElementById('new-password').value;
        const confirmPassword = document.getElementById('confirm-password').value;

        if (newPassword !== confirmPassword) {
            showToast(t('users.passwordsDoNotMatch'), 'error');
            return;
        }

        if (newPassword.length < 8) {
            showToast(t('users.passwordMinLength'), 'error');
            return;
        }

        const btn = form.querySelector('button[type="submit"]');
        const originalText = btn.innerHTML;
        btn.innerHTML = `<span class="spinner-border spinner-border-sm me-1"></span>${t('users.saving')}`;
        btn.disabled = true;

        try {
            await apiPost('/auth/me/password', {
                current_password: currentPassword,
                new_password: newPassword
            });
            showToast(t('users.passwordUpdated'), 'success');
            form.reset();
        } catch (error) {
            showToast(t('common.errorPrefix') + error.message, 'error');
        } finally {
            btn.innerHTML = originalText;
            btn.disabled = false;
        }
    });
}

/**
 * Load and render 2FA status
 */
async function load2FAStatus() {
    const container = document.getElementById('2fa-status-container');
    if (!container) return;

    try {
        const status = await apiGet('/auth/me/2fa/status');
        const currentUser = getUser();
        const isSuperuser = currentUser?.is_superuser || false;
        const isEnforced = status.enforced || false;

        if (status.enabled) {
            // Show disable button only if: superuser OR not enforced
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
                    <button class="btn btn-outline-danger btn-sm" id="btn-disable-2fa">
                        <i class="ti ti-shield-off me-1"></i>${t('users.disable2fa')}
                    </button>
                ` : ''}
                <button class="btn btn-outline-secondary btn-sm ${canDisable ? 'ms-2' : ''}" id="btn-regenerate-codes">
                    <i class="ti ti-key me-1"></i>${t('users.regenerateCodes')}
                </button>
            `;
            if (canDisable) setupDisable2FA();
            setupRegenerateCodes();
        } else {
            // 2FA not enabled — the backend enforced flag is the only source of truth
            const isRequired = isEnforced;

            container.innerHTML = `
                <div class="alert ${isRequired || isEnforced ? 'alert-danger' : 'alert-warning'} mb-3">
                    <div class="d-flex align-items-center">
                        <i class="ti ti-${isRequired || isEnforced ? 'alert-triangle' : 'shield-exclamation'} me-2" style="font-size: 1.5rem;"></i>
                        <div>
                            <strong>${isRequired || isEnforced ? t('users.2faMandatory') : t('users.2faNotActive')}</strong>
                            <div class="text-muted small">${isRequired || isEnforced ? t('users.mustActivate2fa') : t('users.addSecurity')}</div>
                        </div>
                    </div>
                </div>
                <button class="btn btn-primary btn-sm" id="btn-setup-2fa">
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

/**
 * Setup enable 2FA button
 */
function setupEnable2FA() {
    document.getElementById('btn-setup-2fa')?.addEventListener('click', async () => {
        const btn = document.getElementById('btn-setup-2fa');
        const originalText = btn.innerHTML;
        btn.innerHTML = `<span class="spinner-border spinner-border-sm me-1"></span>${t('app.generating')}`;
        btn.disabled = true;

        try {
            twoFaSetupData = await apiPost('/auth/me/2fa/setup', {});

            // Populate modal
            document.getElementById('qr-code-img').src = `data:image/png;base64,${twoFaSetupData.qr_code}`;
            document.getElementById('secret-key').value = twoFaSetupData.secret;
            clearOtpInput(document.getElementById('verify-setup-code'));

            // Show backup codes, one per line in textContent: the copy button copies it as is
            const codesList = document.getElementById('backup-codes-list');
            codesList.innerHTML = twoFaSetupData.backup_codes.map(c =>
                `<div class="col-6 col-md-4"><span class="badge bg-secondary-lt font-monospace w-100 py-2">${escapeHtml(c)}</span></div>`
            ).join('\n');

            // Download button for setup backup codes
            document.getElementById('btn-download-setup-codes').onclick = () => {
                downloadBackupCodes(twoFaSetupData.backup_codes);
            };

            // Setup modal event listeners
            setup2FAModalListeners();

            // Show modal
            const modal = new bootstrap.Modal(document.getElementById('2fa-setup-modal'));
            modal.show();
        } catch (error) {
            showToast(t('common.errorPrefix') + error.message, 'error');
        } finally {
            btn.innerHTML = originalText;
            btn.disabled = false;
        }
    });
}

/**
 * Setup 2FA modal listeners
 */
function setup2FAModalListeners() {
    // Copy button removed

    // Verify and enable 2FA
    const verifyBtn = document.getElementById('btn-verify-2fa');
    if (verifyBtn) {
        // Remove old listeners
        const newVerifyBtn = verifyBtn.cloneNode(true);
        verifyBtn.parentNode.replaceChild(newVerifyBtn, verifyBtn);

        newVerifyBtn.addEventListener('click', async () => {
            const code = document.getElementById('verify-setup-code').value;
            if (!code || code.length !== 6) {
                showToast(t('users.enterValidCode'), 'error');
                return;
            }

            const originalText = verifyBtn.innerHTML;
            verifyBtn.innerHTML = `<span class="spinner-border spinner-border-sm me-1"></span>${t('app.verificationInProgress')}`;
            verifyBtn.disabled = true;

            try {
                await apiPost('/auth/me/2fa/enable', { code });
                showToast(t('app.2faActivatedSuccess'), 'success');

                // Close modal and refresh
                const modal = bootstrap.Modal.getInstance(document.getElementById('2fa-setup-modal'));
                modal?.hide();
                await load2FAStatus();
                await loadData(); // Refresh users table
            } catch (error) {
                showToast(t('common.errorPrefix') + error.message, 'error');
            } finally {
                verifyBtn.innerHTML = originalText;
                verifyBtn.disabled = false;
            }
        });

        // Enter key on verification code
        document.getElementById('verify-setup-code')?.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                document.getElementById('btn-verify-2fa')?.click();
            }
        });
    }
}

/**
 * Setup disable 2FA button
 */
function setupDisable2FA() {
    document.getElementById('btn-disable-2fa')?.addEventListener('click', async () => {
        const confirmed = await confirmDialog(
            t('users.disable2fa'),
            t('users.disable2faConfirm'),
            t('users.disable2fa'),
            'btn-danger'
        );
        if (!confirmed) return;

        // Show password input modal
        const passwordModal = new bootstrap.Modal(document.getElementById('password-input-modal'));
        const passwordInput = document.getElementById('modal-password-input');
        const confirmBtn = document.getElementById('modal-password-confirm');

        passwordInput.value = '';
        passwordModal.show();

        // Wait for modal to be shown before focusing
        document.getElementById('password-input-modal').addEventListener('shown.bs.modal', () => {
            passwordInput.focus();
        }, { once: true });

        // Handle confirm button click
        const handleConfirm = async () => {
            const password = passwordInput.value;
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
                await loadData();
            } catch (error) {
                showToast(t('common.errorPrefix') + error.message, 'error');
            } finally {
                confirmBtn.disabled = false;
                confirmBtn.innerHTML = t('common.confirm');
            }
        };

        // Remove old listener and add new one
        const newConfirmBtn = confirmBtn.cloneNode(true);
        confirmBtn.parentNode.replaceChild(newConfirmBtn, confirmBtn);
        newConfirmBtn.addEventListener('click', handleConfirm);

        // Enter key support
        passwordInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') handleConfirm();
        }, { once: true });
    });
}

/**
 * Setup regenerate backup codes button
 */
function setupRegenerateCodes() {
    document.getElementById('btn-regenerate-codes')?.addEventListener('click', async () => {
        // Show OTP input modal
        const otpModal = new bootstrap.Modal(document.getElementById('otp-input-modal'));
        const otpInput = document.getElementById('modal-otp-input');
        const confirmBtn = document.getElementById('modal-otp-confirm');

        otpInput.value = '';
        otpModal.show();

        // Wait for modal to be shown before focusing
        document.getElementById('otp-input-modal').addEventListener('shown.bs.modal', () => {
            otpInput.focus();
        }, { once: true });

        // Handle confirm button click
        const handleConfirm = async () => {
            const code = otpInput.value.trim();
            if (!code || (code.length !== 6 && code.length !== 8)) {
                showToast(t('users.enterValidCodeOtp'), 'error');
                return;
            }

            confirmBtn.disabled = true;
            confirmBtn.innerHTML = `<span class="spinner-border spinner-border-sm me-1"></span>${t('app.generating')}`;

            try {
                const result = await apiPost('/auth/me/2fa/backup-codes', { code });
                otpModal.hide();

                // Show backup codes in Tabler modal
                const codesContainer = document.getElementById('backup-codes-display');
                codesContainer.innerHTML = result.backup_codes.map(c =>
                    `<div class="col-6"><code class="fs-4">${escapeHtml(c)}</code></div>`
                ).join('\n');

                // Download button
                document.getElementById('download-displayed-codes').onclick = () => {
                    downloadBackupCodes(result.backup_codes);
                };

                new bootstrap.Modal(document.getElementById('backup-codes-display-modal')).show();
                showToast(t('users.newCodesGenerated'), 'success');
            } catch (error) {
                showToast(t('common.errorPrefix') + error.message, 'error');
            } finally {
                confirmBtn.disabled = false;
                confirmBtn.innerHTML = t('common.confirm');
            }
        };

        // Remove old listener and add new one
        const newConfirmBtn = confirmBtn.cloneNode(true);
        confirmBtn.parentNode.replaceChild(newConfirmBtn, confirmBtn);
        newConfirmBtn.addEventListener('click', handleConfirm);

        // Enter key support
        otpInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') handleConfirm();
        }, { once: true });
    });
}

/**
 * Handle admin reset of user 2FA
 */
async function handleReset2FA(username) {
    const confirmed = await confirmDialog(
        t('users.reset2fa'),
        t('users.reset2faConfirm', { username }),
        t('users.reset2fa'),
        'btn-danger'
    );

    if (!confirmed) return;

    try {
        await apiDelete(`/auth/users/${username}/2fa`);
        showToast(t('users.2faDisabledSuccess'), 'success');

        // Hide modal and refresh
        const modal = bootstrap.Modal.getInstance(document.getElementById('user-modal'));
        modal.hide();
        await loadData();
    } catch (error) {
        showToast(t('common.errorPrefix') + error.message, 'error');
    }
}
