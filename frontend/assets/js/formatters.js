/**
 * Command result formatters for hub→instance command responses.
 * Also: describeAuditPath — human-readable label for audit log paths.
 */

const _UUID_RE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const _PATH_LABELS = [
  [new RegExp(`/instances/${_UUID_RE}/exec/backup\\.run`),      'Backup avviato'],
  [new RegExp(`/instances/${_UUID_RE}/exec/backup\\.restore`),  'Ripristino backup'],
  [new RegExp(`/instances/${_UUID_RE}/exec/backup\\.list`),     'Lista backup locali'],
  [new RegExp(`/instances/${_UUID_RE}/backups/${_UUID_RE}/restore`), 'Ripristino avviato'],
  [new RegExp(`/instances/${_UUID_RE}/backups/upload`),         'Backup caricato'],
  [new RegExp(`/instances/${_UUID_RE}/exec/info`),              'Info aggiornata'],
  [new RegExp(`/instances/${_UUID_RE}/exec/ssh\\.push`),        'Chiave SSH inviata'],
  [new RegExp(`/instances/${_UUID_RE}/exec/ssh\\.revoke`),      'Chiave SSH revocata'],
  [new RegExp(`/instances/${_UUID_RE}/exec/service\\.start`),   'Servizio avviato'],
  [new RegExp(`/instances/${_UUID_RE}/exec/service\\.stop`),    'Servizio fermato'],
  [new RegExp(`/instances/${_UUID_RE}/exec/service\\.restart`), 'Servizio riavviato'],
  [new RegExp(`/instances/${_UUID_RE}/exec/firewall\\.reload`), 'Firewall aggiornato'],
  [new RegExp(`/instances/${_UUID_RE}/exec/`),                  null],  // generic exec fallback
  [/\/instances\/enroll$/,                                      'Istanza registrata'],
  [new RegExp(`/instances/${_UUID_RE}$`),                       null],  // instance CRUD fallback
  [/\/instances$/,                                              'Istanza creata'],
  [/\/auth\/login$/,                                            'Accesso'],
  [/\/auth\/logout$/,                                           'Uscita'],
  [/\/users$/,                                                  'Utente creato'],
  [new RegExp(`/users/[^/]+$`),                                 'Utente modificato'],
  [/\/ssh\/keys$/,                                              'Chiave SSH creata'],
  [new RegExp(`/ssh/assignments/${_UUID_RE}$`),                 'Assegnazione SSH'],
  [/\/enrollment\/tokens$/,                                     'Token creato'],
  [/\/backups\/repos$/,                                         'Repository creato'],
  [/\/backups\/schedules$/,                                     'Schedule creato'],
];

export function describeAuditPath(path) {
  if (!path) return null;
  for (const [re, label] of _PATH_LABELS) {
    if (re.test(path)) {
      if (label === null) {
        const m = path.match(/\/exec\/([^?/]+)/);
        return m ? `Comando: ${m[1]}` : null;
      }
      return label;
    }
  }
  return null;
}


export function formatCommandResult(result) {
  if (!result) return 'Completato';

  const r = result.result || {};
  const action = result.action || '';

  if (action === 'info' || result.snapshots) {
    const snaps = r.snapshots || result.snapshots || [];
    const snap = snaps[snaps.length - 1] || r;
    if (snap.cpu_percent !== undefined) {
      return `Info aggiornata · CPU ${snap.cpu_percent?.toFixed(1)}% · RAM ${snap.ram_percent?.toFixed(1)}% · Disco ${snap.disk_percent?.toFixed(1)}%`;
    }
  }

  if (action === 'backup.run' || action === 'backup') {
    if (result.status === 'queued') return 'Backup accodato (agente offline)';
    const dur = r.duration_seconds ? ` in ${r.duration_seconds}s` : '';
    return r.path ? `Backup completato${dur}: ${r.path}` : `Backup completato${dur}`;
  }

  return r.message || result.error || result.detail || 'Completato';
}
