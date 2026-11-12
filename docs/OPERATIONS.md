# Operations

How to run a MADMIN Manager and its instances day to day. The wire protocol is in `PROTOCOL.md`, the plan in `ROADMAP.md`, how a release is built in the MADMIN repository (`docs/RELEASING.md`).

## 1. Manager

### Install

```bash
sudo MADMIN_MANAGER_ADMIN_PASSWORD='...' bash scripts/setup-manager.sh --host manager.example.com \
     [--ip 10.0.0.5] -u <admin> --ui-allow 10.0.0.0/24,192.0.2.10
```

- `--host/--ip`: what instances use to reach the manager (in the endpoint certificate and in every token).
- `--ui-allow`: source addresses allowed on the UI (nginx, `/etc/nginx/snippets/madmin-manager-ui-allow.conf`). Required in production. To change it later: rerun with `--ui-allow`, or edit the file and `nginx -t && systemctl reload nginx`. The agent port stays open to the instances.
- Rerunning the installer over an existing manager keeps database, `SECRET_KEY` and PKI: it is how the manager is updated (`git pull` then rerun). Schema steps run at startup (`backend/core/migrations/`).

Open towards the manager: UI port (operators, filtered), agent port 8443 (instances), support ports 9100–9119 (operators; each session admits one IP).

### Backup and restore

```bash
# backup (encrypted with the passphrase file; store it offline with the passphrase)
sudo bash scripts/manager-backup.sh --out /root/manager-$(date +%F).bak --passphrase-file /root/pass [--no-instance-backups]
# restore onto a manager installed with setup-manager.sh (same --host/--ip)
sudo bash scripts/manager-restore.sh --in /root/manager.bak --passphrase-file /root/pass
```

The archive holds the database, `DATA_DIR` (CA keys, release files, instance backups) and `SECRET_KEY`: whoever has it and the passphrase controls every instance. The instances reconnect by themselves after a restore (same CA, same address). Losing `SECRET_KEY` makes the PKI and the backup passphrases unreadable: keep a backup offline.

### Users

- Superusers only: support, enrollment, releases, updates and OS actions, rollouts of those, settings, logs. Every superuser should have TOTP (support needs it).
- LDAP/AD (Settings → Utenti LDAP): mappings from LDAP group DNs to role/access/group. Test with "Prova un login" before enabling. The directory's certificate must match the host name in the URL (use a DNS name, not an IP) and its CA goes in the CA field unless it is a public one. Keep at least one local superuser.

## 2. Instances

### Install and enroll

On the new VM (Ubuntu 24.04), as root, with a token from Enrollment (or `POST /api/provisioning/tokens`):

```bash
MADMIN_ADMIN_PASSWORD='...' bash scripts/setup-madmin.sh -u admin --manager-token-file /root/token
```

A reinstall keeps the instance's identity with a re-enroll token (instance page → Token re-enroll), then restore its last backup from the manager. **A reinstall over SSH loses the SSH access until the backup is restored**: the fresh firewall admits no new inbound connection. Run it from the console, or rely on the restore through the manager (the instance connects outbound).

### Releases and updates

1. Build on an Ubuntu 24.04 machine: `bash scripts/build-release.sh` (a critical OSV advisory in the wheels stops it; see `scripts/osv-waivers.txt`).
2. Sign on the offline machine: `bash scripts/sign-release.sh dist/<file>.unsigned.tar <key.pem>`.
3. Upload in Release (candidate). Try it on one instance (instance page → Aggiorna).
4. Promote to stable, then a rollout (below).

A failed update rolls back by itself (release, database, units). The instance page shows the journal and the log tail; an e-mail goes to the superusers.

### Rollouts

Rollout → Nuovo rollout: action (MADMIN update, package upgrade, reboot, backup), selection (group, labels, "skip who already has"), concurrency, canary, wait after the canary (0 = confirmation), stop threshold, maintenance windows, expiry.

- Canary: the instances labelled `canary=true` go first. Keep a few low-risk instances with that label.
- Only online instances are started; an offline one waits while the rollout lasts.
- Halted (threshold or canary failure): look at the failed targets, then Riprendi (the failures seen are accepted) or Riprova falliti.
- Maintenance windows: group edit → Finestra di manutenzione (manager's local time; a customer without one uses its partner's).

### OS updates and reboots

Instance page → Sistema: Aggiorna liste, Aggiornamenti di sicurezza (unattended-upgrade), Aggiorna tutto (apt upgrade, holds respected), Riavvia, Annulla riavvio. Or a rollout of the same.

A reboot with a newer kernel installed boots it **on trial**: the old kernel stays the GRUB default until the instance reconnects to the manager; otherwise after 15 minutes it reboots into the old kernel and the trial is reported as failed (e-mail). A kernel panic reboots after 10 s (`panic=10`) into the default one.

### Vulnerabilities

Vulnerabilità: by advisory, by instance (reboot required, pending security updates), by version; CSV export. The scan runs daily and after every package change. "Correzione disponibile" means the fix is in the Ubuntu archive: a security upgrade (and a reboot for the kernel) removes it. Advisories without a fix are Ubuntu's own triage (needs-triage, deferred).

### When MADMIN does not start (rescue)

The instance page shows a Rescue card (unit state, log, update journal) while `madmin-rescue` reports, every 5 minutes. Actions: restart, rollback to the previous release, install a release. From the console: `/opt/madmin/updater/madmin-update status|rollback|recover`.

## 3. Support access

1. Profile: enable TOTP.
2. Supporto → Le mie chiavi SSH: add your public key; another superuser approves it after checking the fingerprint with you on another channel (single superuser: `sudo -u madmin-manager /opt/madmin-manager/venv/bin/python -m manager.keys approve <user> <fingerprint>` from `/opt/madmin-manager/backend`).
3. Instance → Supporto → Accesso UI / Accesso SSH: duration (max 1 day), reason, your IP, a fresh TOTP code.

At most 4 open sessions per user. The sshd log of the instance names the user and the key fingerprint.

## 4. Keys and certificates

- Release signing keys: two Ed25519 keys (vault + second method). Rotation: ship the new public key in a release signed by the old one (`scripts/release-keys/`), then sign with the new one.
- Manager CA rotation: `python -m manager.pki rotate-ca status|prepare|activate|retire` (see `PROTOCOL.md`, CA rotation).
- Manager address change: instance page → Cambia indirizzo (keep the old address reachable until it is confirmed).

## 5. Notifications

Settings → Notifiche e-mail: SMTP server, sender, recipients (empty = every superuser with an e-mail), test button. Without SMTP only the menu badges remain.
