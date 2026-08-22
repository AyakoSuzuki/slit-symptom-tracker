export const APP_VERSION = '0.4.1';
export const SCHEMA_VERSION = 1;
export const AUTO_CLOSE_MINUTES = 60;
export const SEVERITIES = [0, 1, 2, 3, 4, 5];

export const DEFAULT_SETTINGS = Object.freeze({
  medicationName: '',
  medicationDose: '',
  symptomTypeCode: 'throat',
  parentSymptomLabel: '',
  childSymptomLabel: '',
  childModeEnabled: true,
  askPreDoseWorry: true,
  showResolutionDurationInChildMode: false,
  parentPinHash: '',
  emergencyContactLabel: '',
  emergencyContactValue: '',
  setupComplete: false
});

export function newId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function localIso(date = new Date()) {
  const pad = (value) => String(Math.abs(value)).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const hh = pad(Math.trunc(Math.abs(offset) / 60));
  const mm = pad(Math.abs(offset) % 60);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${String(date.getMilliseconds()).padStart(3, '0')}` +
    `${sign}${hh}:${mm}`;
}

export function localDate(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function minutesBetween(later, earlier) {
  return Math.max(0, Math.round((new Date(later).getTime() - new Date(earlier).getTime()) / 60000));
}

export function sortRecords(records = []) {
  return [...records].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
}

export function deriveOutcome(session) {
  const records = sortRecords(session.symptomRecords);
  const positives = records.filter((record) => record.severity > 0);
  if (positives.length) {
    return deriveEpisodes(session).at(-1)?.endedAt ? 'resolved' : 'unresolved';
  }
  if (records.some((record) => record.severity === 0) || session.noSymptomConfirmedAt) {
    return 'noSymptomReported';
  }
  return 'noSymptomData';
}

export function deriveEpisodes(session) {
  const episodes = [];
  let current = null;
  for (const record of sortRecords(session.symptomRecords)) {
    if (record.severity > 0 && !current) {
      current = { startedAt: record.timestamp, endedAt: null, records: [record] };
    } else if (record.severity > 0 && current) {
      current.records.push(record);
    } else if (record.severity === 0 && current) {
      current.records.push(record);
      current.endedAt = record.timestamp;
      episodes.push(current);
      current = null;
    }
  }
  if (current) episodes.push(current);
  return episodes;
}

export function deriveMetrics(session) {
  const records = sortRecords(session.symptomRecords);
  const positives = records.filter((record) => record.severity > 0);
  const episodes = deriveEpisodes(session);
  const closedEpisodes = episodes.filter((episode) => episode.endedAt);
  const lastResolution = closedEpisodes.at(-1)?.endedAt;
  const lastClosedEpisode = closedEpisodes.at(-1);
  return {
    outcome: deriveOutcome(session),
    firstRecordedSymptomAt: positives[0]?.timestamp,
    firstRecordedLatency: positives[0] ? minutesBetween(positives[0].timestamp, session.doseTimestamp) : undefined,
    maximumSeverity: positives.length ? Math.max(...positives.map((record) => record.severity)) : undefined,
    lastRecordedSeverity: records.at(-1)?.severity,
    lastEpisodeDuration: lastClosedEpisode
      ? minutesBetween(lastClosedEpisode.endedAt, lastClosedEpisode.startedAt)
      : undefined,
    episodeCount: episodes.length,
    totalSymptomaticTime: closedEpisodes.reduce(
      (sum, episode) => sum + minutesBetween(episode.endedAt, episode.startedAt), 0
    ),
    timeFromDoseToLastRecordedResolution: lastResolution
      ? minutesBetween(lastResolution, session.doseTimestamp)
      : undefined,
    lastResolution,
    episodes
  };
}

export function createSession(settings, preDoseWorry, now = new Date()) {
  const timestamp = localIso(now);
  return {
    id: newId(),
    localDate: localDate(now),
    doseTimestamp: timestamp,
    timezoneOffsetMinutes: -now.getTimezoneOffset(),
    medication: { name: settings.medicationName, dose: settings.medicationDose },
    symptom: {
      typeCode: settings.symptomTypeCode,
      parentLabel: settings.parentSymptomLabel,
      childLabel: settings.childSymptomLabel
    },
    ...(preDoseWorry === undefined ? {} : { preDoseWorry }),
    symptomRecords: [],
    lifecycle: 'open',
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export function addSymptomRecord(session, severity, now = new Date()) {
  if (session.lifecycle !== 'open') throw new Error('closed_session');
  if (!SEVERITIES.includes(Number(severity))) throw new Error('invalid_severity');
  const timestamp = localIso(now);
  return {
    ...session,
    noSymptomConfirmedAt: Number(severity) > 0 ? undefined : session.noSymptomConfirmedAt,
    symptomRecords: [...session.symptomRecords, {
      id: newId(),
      timestamp,
      symptomTypeCode: session.symptom.typeCode,
      severity: Number(severity),
      createdAt: timestamp,
      updatedAt: timestamp
    }],
    updatedAt: timestamp
  };
}

export function updateSymptomRecord(session, recordId, patch, now = new Date()) {
  const updatedAt = localIso(now);
  return {
    ...session,
    noSymptomConfirmedAt: Number(patch.severity) > 0 ? undefined : session.noSymptomConfirmedAt,
    symptomRecords: session.symptomRecords.map((record) => record.id === recordId ? {
      ...record,
      ...(patch.timestamp ? { timestamp: patch.timestamp } : {}),
      ...(patch.severity === undefined ? {} : { severity: Number(patch.severity) }),
      updatedAt
    } : record),
    updatedAt
  };
}

export function deleteSymptomRecord(session, recordId, now = new Date()) {
  return {
    ...session,
    symptomRecords: session.symptomRecords.filter((record) => record.id !== recordId),
    updatedAt: localIso(now)
  };
}

export function closeSession(session, now = new Date()) {
  const timestamp = localIso(now);
  return { ...session, lifecycle: 'closed', closedAt: timestamp, updatedAt: timestamp };
}

export function reopenSession(session, now = new Date()) {
  const { closedAt: _closedAt, ...rest } = session;
  return { ...rest, lifecycle: 'open', updatedAt: localIso(now) };
}

export function confirmNoSymptoms(session, now = new Date()) {
  if (session.symptomRecords.some((record) => record.severity > 0)) throw new Error('positive_records_exist');
  const timestamp = localIso(now);
  return { ...session, noSymptomConfirmedAt: timestamp, updatedAt: timestamp };
}

export function shouldAutoClose(session, now = new Date()) {
  if (session.lifecycle !== 'open') return false;
  const lastTimestamp = sortRecords(session.symptomRecords).at(-1)?.timestamp || session.doseTimestamp;
  return new Date(now).getTime() - new Date(lastTimestamp).getTime() >= AUTO_CLOSE_MINUTES * 60000;
}

export function autoCloseSessions(sessions, now = new Date()) {
  return sessions.map((session) => shouldAutoClose(session, now) ? closeSession(session, now) : session);
}

export function median(values) {
  const valid = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!valid.length) return undefined;
  const middle = Math.floor(valid.length / 2);
  return valid.length % 2 ? valid[middle] : (valid[middle - 1] + valid[middle]) / 2;
}

export function dashboardSummary(sessions) {
  const metrics = sessions.map((session) => ({ session, metrics: deriveMetrics(session) }));
  const count = sessions.length;
  const outcomes = (name) => metrics.filter((item) => item.metrics.outcome === name).length;
  const symptomatic = metrics.filter((item) => item.metrics.maximumSeverity !== undefined);
  const resolved = metrics.filter((item) => item.metrics.outcome === 'resolved');
  return {
    count,
    noSymptomRate: count ? outcomes('noSymptomReported') / count : undefined,
    symptomaticRate: count ? symptomatic.length / count : undefined,
    noDataRate: count ? outcomes('noSymptomData') / count : undefined,
    medianMaximumSeverity: median(symptomatic.map((item) => item.metrics.maximumSeverity)),
    medianDuration: median(resolved.map((item) => item.metrics.totalSymptomaticTime)),
    medianFirstLatency: median(symptomatic.map((item) => item.metrics.firstRecordedLatency)),
    unresolvedCount: outcomes('unresolved')
  };
}

export function formatJapaneseMinutes(value) {
  const n = Math.max(0, Math.round(Number(value)));
  const lastTwo = n % 100;
  const last = n % 10;
  const pun = lastTwo === 10 || [1, 3, 6, 8].includes(last);
  return `${n}${pun ? 'ぷん' : 'ふん'}`;
}

export function validateSettings(settings) {
  return Boolean(
    settings && typeof settings.medicationName === 'string' && settings.medicationName.trim() &&
    typeof settings.medicationDose === 'string' && settings.medicationDose.trim() &&
    typeof settings.parentSymptomLabel === 'string' && settings.parentSymptomLabel.trim() &&
    typeof settings.childSymptomLabel === 'string' && settings.childSymptomLabel.trim()
  );
}
