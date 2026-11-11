/**
 * MADMIN - Users View
 */

import { apiGet, apiPost, apiPatch, apiDelete, apiDeleteWithBody } from '../api.js';
import {
    showToast, confirmDialog, formatDate, emptyState, escapeHtml, escapeAttr, statusBadge,
    copyButton, strengthMeter, clearOtpInput, refreshStrengthMeters
} from '../utils.js';
import { setPageActions, checkPermission, getUser } from '../app.js';
import { t } from '../i18n.js';

let users = [];
let groups = [];      // groups in the caller's scope (GET /groups)
let editingUser = null;

const ROLE_LABELS = { superuser: 'Superuser', partner: 'Partner', customer: 'Cliente' };
const ACCESS_LABELS = { rw: 'Lettura e scrittura', ro: 'Sola lettura' };

/**
 * What a role and access level allow, shown under the selectors. Mirrors
 * core.auth.models.capabilities_for and the scope rules in manager/scope.py.
 */
function accessSummary(role, access) {
    const where = role === 'superuser' ? 'tutte le istanze del manager'
        : role === 'partner' ? 'le istanze del partner e dei suoi clienti'
        : 'le istanze del cliente';
    const items = [`Vede ${where}, con backup, licenze e storico.`];
    if (access === 'rw') {
        items.push('Modifica le istanze, avvia, scarica, elimina e ripristina i backup.');
        items.push(role === 'superuser'
            ? 'Gestisce tutti gli utenti.'
            : 'Crea e gestisce utenti partner o cliente dentro il proprio gruppo.');
    }
    if (role === 'superuser') {
        items.push(access === 'rw'
            ? 'Accesso di supporto, enrollment, licenze, gruppi, impostazioni, chiavi API e log; revoca ed elimina istanze.'
            : 'Consulta supporto, enrollment, impostazioni, chiavi API e log senza modificarli.');
    }
    return `<ul class="mb-0 ps-3">${items.map(x => `<li>${x}</li>`).join('')}</ul>`;
}

function accessBadges(user) {
    const color = user.role === 'superuser' ? 'red' : user.role === 'partner' ? 'purple' : 'blue';
    return `<span class="badge bg-${color}-lt">${escapeHtml(ROLE_LABELS[user.role] || user.role)}</span>
        <span class="badge bg-${user.access === 'rw' ? 'green' : 'secondary'}-lt ms-1">${user.access === 'rw' ? 'rw' : 'ro'}</span>
        ${user.group_path ? `<div class="small text-muted mt-1">${escapeHtml(user.group_path)}</div>` : ''}`;
}

/** Group options for a role: partner groups for partners, customer groups for customers. */
function fillGroupOptions(role, selected = '') {
    const select = document.getElementById('user-group');
    const kind = role === 'partner' ? 'partner' : 'customer';
    const options = groups.filter(g => g.kind === kind);
    select.innerHTML = options.length
        ? options.map(g => `<option value="${escapeAttr(g.id)}" ${g.id === selected ? 'selected' : ''}>${escapeHtml(g.path)}</option>`).join('')
        : `<option value="">Nessun gruppo ${kind === 'partner' ? 'partner' : 'cliente'} disponibile</option>`;
}

function refreshAccessFields(selectedGroup = null) {
    const role = document.getElementById('user-role').value;
    const access = document.getElementById('user-access').value;
    const groupCol = document.getElementById('user-group-col');
    groupCol.classList.toggle('d-none', role === 'superuser');
    if (role !== 'superuser') {
        const current = selectedGroup ?? document.getElementById('user-group').value;
        fillGroupOptions(role, current);
    }
    document.getElementById('access-summary').innerHTML = accessSummary(role, access);
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
                                <div class="col-12" id="access-section">
                                    <div class="row g-3">
                                        <div class="col-md-4">
                                            <label class="form-label required">Ruolo</label>
                                            <select class="form-select" id="user-role"></select>
                                        </div>
                                        <div class="col-md-4">
                                            <label class="form-label required">Accesso</label>
                                            <select class="form-select" id="user-access">
                                                <option value="ro">Sola lettura</option>
                                                <option value="rw">Lettura e scrittura</option>
                                            </select>
                                        </div>
                                        <div class="col-md-4" id="user-group-col">
                                            <label class="form-label required">Gruppo</label>
                                            <select class="form-select" id="user-group"></select>
                                        </div>
                                    </div>
                                    <div class="alert alert-secondary small mt-3 mb-0 py-2 px-3" id="access-summary"></div>
                                    <div class="form-hint d-none mt-2" id="access-self-hint">
                                        Ruolo, accesso e gruppo del tuo account li cambia un altro utente con accesso in scrittura.
                                    </div>
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

    document.getElementById('user-role')?.addEventListener('change', () => refreshAccessFields());
    document.getElementById('user-access')?.addEventListener('change', () => refreshAccessFields());

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
        [users, groups] = await Promise.all([
            apiGet('/auth/users'),
            apiGet('/groups').catch(() => []),
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
        // The backend lists only users in the caller's scope
        const showActions = canManage && !isSelf && !user.is_protected;

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
                            <i class="ti ti-${user.is_superuser ? 'crown' : user.role === 'partner' ? 'building' : 'user'}"></i>
                        </span>
                        <div>
                            <div class="font-weight-medium">${escapeHtml(user.username)}${pwdBadge}</div>
                        </div>
                    </div>
                </td>
                <td>${user.email ? escapeHtml(user.email) : '<span class="text-muted">-</span>'}</td>
                <td>${accessBadges(user)}</td>
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

function openUserModal(user = null) {
    editingUser = user;
    const currentUser = getUser();
    const isSuperuser = currentUser?.is_superuser || false;
    const canManage = checkPermission('users.manage');

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

    // Role, access, group. Only a superuser offers the superuser role; your
    // own are read-only (the backend refuses changing them).
    const roleSelect = document.getElementById('user-role');
    const roles = isSuperuser ? ['superuser', 'partner', 'customer'] : ['partner', 'customer'];
    if (user && !roles.includes(user.role)) roles.unshift(user.role);
    const defaultRole = user?.role || (currentUser?.role === 'customer' ? 'customer' : roles[roles.length - 1]);
    roleSelect.innerHTML = roles.map(r =>
        `<option value="${r}" ${r === defaultRole ? 'selected' : ''}>${ROLE_LABELS[r]}</option>`).join('');
    document.getElementById('user-access').value = user?.access || 'ro';
    const lockAccess = isSelf;
    roleSelect.disabled = lockAccess;
    document.getElementById('user-access').disabled = lockAccess;
    document.getElementById('user-group').disabled = lockAccess;
    document.getElementById('access-self-hint').classList.toggle('d-none', !lockAccess);
    refreshAccessFields(user?.group_id || '');
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

    // "Force 2FA": whoever manages the account, never on oneself
    const force2faContainer = document.getElementById('force-2fa-container');
    const canForce2fa = canManage && (!user || user.username !== currentUser?.username);
    force2faContainer.classList.toggle('d-none', !canForce2fa);

    // "Reset 2FA" for a manageable user with 2FA enabled or locked
    const reset2faBtn = document.getElementById('btn-reset-user-2fa');
    if (canManage && user && (user.totp_enabled || user.totp_locked) && user.username !== currentUser?.username && !user.is_protected) {
        reset2faBtn.classList.remove('d-none');
        // Remove old listeners by cloning
        const newBtn = reset2faBtn.cloneNode(true);
        reset2faBtn.parentNode.replaceChild(newBtn, reset2faBtn);
        newBtn.addEventListener('click', () => handleReset2FA(user.username));
    } else {
        reset2faBtn.classList.add('d-none');
    }

    new bootstrap.Modal(document.getElementById('user-modal')).show();
}

function accessFields() {
    const role = document.getElementById('user-role').value;
    return {
        role,
        access: document.getElementById('user-access').value,
        group_id: role === 'superuser' ? '' : (document.getElementById('user-group').value || ''),
    };
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

            if (editingUser.username !== getUser()?.username) Object.assign(updateData, accessFields());

            if (password) updateData.password = password;

            await apiPatch(`/auth/users/${editingUser.username}`, updateData);

            showToast(t('users.userUpdated'), 'success');
        } else {
            // Create new user — the account policy travels with the creation so
            // the account never exists in a state the admin did not ask for
            const createData = {
                username,
                password,
                email: document.getElementById('user-email').value || null,
                ...accessFields(),
                must_change_password: document.getElementById('user-must-change-password').checked
            };

            const force2faContainer = document.getElementById('force-2fa-container');
            if (!force2faContainer.classList.contains('d-none')) {
                createData.totp_enforced = document.getElementById('user-totp-enforced').checked;
            }

            const newExpiresAt = document.getElementById('user-password-expires-at').value;
            if (newExpiresAt) createData.password_expires_at = newExpiresAt;

            await apiPost('/auth/users', createData);

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
