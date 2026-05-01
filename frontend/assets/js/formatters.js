/**
 * Command result formatters for hub→instance command responses.
 */

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
