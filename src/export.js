import {
  APP_VERSION, DAILY_SYMPTOM_KEYS, SCHEMA_VERSION, SUPPORTED_SCHEMA_VERSIONS, dailyScores,
  deriveMetrics, doseStatusForDay, medicationClassesOf, minutesBetween
} from './model.js';

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

// 日次記録の生データ。医師に渡す前提なので列名も値も英語コードにする。
export const DAILY_COLUMNS = [
  'date', 'slit_status', 'sneezing', 'rhinorrhoea', 'congestion', 'nasal_itch', 'ocular_itch',
  'watery_eyes', 'dss', 'tnss', 'medication_classes', 'dms', 'csms', 'vas_global',
  'medications_detail', 'note', 'entry_timestamp', 'is_retrospective'
];

export function dailyCsv(records, sessions = []) {
  const round = (value) => (value === undefined ? undefined : Number(value.toFixed(3)));
  const rows = [...records]
    .sort((a, b) => (a.localDate < b.localDate ? -1 : 1))
    .map((record) => {
      const scores = dailyScores(record);
      const classes = medicationClassesOf(record);
      return [
        record.localDate,
        doseStatusForDay(record, sessions, record.localDate),
        ...DAILY_SYMPTOM_KEYS.map((key) => record[key]),
        round(scores.dss), scores.tnss,
        classes.length ? classes.join('|') : undefined,
        scores.dms, round(scores.csms),
        record.vasGlobal, record.medicationsDetail, record.note,
        record.entryTimestamp, record.isRetrospective ? 1 : 0
      ];
    });
  return csv([DAILY_COLUMNS, ...rows]);
}

export function backupJson(sessions, settings, dailyRecords = [], exportedAt = new Date().toISOString()) {
  return JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    exportedAt,
    appVersion: APP_VERSION,
    sessions,
    dailyRecords,
    settings
  }, null, 2);
}

export function validateBackup(value) {
  if (!value || typeof value !== 'object') throw new Error('バックアップ形式が正しくありません。');
  if (!SUPPORTED_SCHEMA_VERSIONS.includes(value.schemaVersion)) throw new Error('このバックアップのバージョンには対応していません。');
  if (!Array.isArray(value.sessions) || !value.settings || typeof value.settings !== 'object') {
    throw new Error('バックアップに必要なデータがありません。');
  }
  for (const session of value.sessions) {
    if (!session?.id || !session?.doseTimestamp || !Array.isArray(session.symptomRecords)) {
      throw new Error('セッションデータが正しくありません。');
    }
    if (!['open', 'closed'].includes(session.lifecycle)) throw new Error('状態データが正しくありません。');
  }
  const dailyRecords = Array.isArray(value.dailyRecords) ? value.dailyRecords : [];
  for (const record of dailyRecords) {
    if (!record?.localDate) throw new Error('日次記録が正しくありません。');
  }
  // 日次記録を持たない旧版のバックアップも、空で補って受け入れる
  return { ...value, dailyRecords };
}
