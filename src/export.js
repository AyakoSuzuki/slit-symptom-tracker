import { APP_VERSION, SCHEMA_VERSION, deriveMetrics, minutesBetween } from './model.js';

export const SUMMARY_COLUMNS = [
  'session_id', 'local_date', 'dose_time', 'timezone_offset_minutes', 'medication_name', 'dose',
  'pre_dose_worry', 'lifecycle', 'outcome', 'first_recorded_symptom_at',
  'first_recorded_latency_min', 'max_severity', 'episode_count', 'total_symptomatic_time_min',
  'time_from_dose_to_last_resolution_min', 'condition_codes', 'condition_other_text', 'notes'
];

export const TIME_SERIES_COLUMNS = [
  'session_id', 'local_date', 'dose_time', 'timestamp', 'minutes_since_dose',
  'symptom_type_code', 'severity'
];

function csvCell(value) {
  if (value === undefined || value === null) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csv(rows) {
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

function doseTime(session) {
  return session.doseTimestamp.slice(11, 19);
}

export function summaryCsv(sessions) {
  const rows = sessions.map((session) => {
    const metrics = deriveMetrics(session);
    const unresolved = metrics.outcome === 'unresolved';
    return [
      session.id, session.localDate, doseTime(session), session.timezoneOffsetMinutes,
      session.medication.name, session.medication.dose, session.preDoseWorry,
      session.lifecycle, metrics.outcome, metrics.firstRecordedSymptomAt,
      metrics.firstRecordedLatency, metrics.maximumSeverity, metrics.episodeCount,
      unresolved ? undefined : metrics.totalSymptomaticTime,
      unresolved ? undefined : metrics.timeFromDoseToLastRecordedResolution,
      (session.conditionCodes || []).join('|'), session.conditionOtherText, session.notes
    ];
  });
  return csv([SUMMARY_COLUMNS, ...rows]);
}

export function timeSeriesCsv(sessions) {
  const rows = sessions.flatMap((session) => session.symptomRecords.map((record) => [
    session.id, session.localDate, doseTime(session), record.timestamp,
    minutesBetween(record.timestamp, session.doseTimestamp), record.symptomTypeCode, record.severity
  ]));
  return csv([TIME_SERIES_COLUMNS, ...rows]);
}

export function backupJson(sessions, settings, exportedAt = new Date().toISOString()) {
  return JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    exportedAt,
    appVersion: APP_VERSION,
    sessions,
    settings
  }, null, 2);
}

export function validateBackup(value) {
  if (!value || typeof value !== 'object') throw new Error('バックアップ形式が正しくありません。');
  if (value.schemaVersion !== SCHEMA_VERSION) throw new Error('このバックアップのバージョンには対応していません。');
  if (!Array.isArray(value.sessions) || !value.settings || typeof value.settings !== 'object') {
    throw new Error('バックアップに必要なデータがありません。');
  }
  for (const session of value.sessions) {
    if (!session?.id || !session?.doseTimestamp || !Array.isArray(session.symptomRecords)) {
      throw new Error('セッションデータが正しくありません。');
    }
    if (!['open', 'closed'].includes(session.lifecycle)) throw new Error('状態データが正しくありません。');
  }
  return value;
}
