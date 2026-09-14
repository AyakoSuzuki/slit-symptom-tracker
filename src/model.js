export const APP_VERSION = '0.4.6';
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
  doseTimerEnabled: false,
  holdMinutes: '',
  waitMinutes: '',
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
  // 0だけを記録した回や保護者が症状なしを確認した回も、最大強度0の実測値として扱う。
  // 症状のあった回だけを対象にすると、中央値やグラフが実際より高く出る。
  const maximumSeverity = records.length
    ? Math.max(...records.map((record) => record.severity))
    : (session.noSymptomConfirmedAt ? 0 : undefined);
  // 服用の記録はあるが症状の記録が一度もない回は、局所反応がなかったものとして0とみなす。
  // 実測値ではないため isInferred で区別し、CSV / JSON には推定値を出さない。
  return {
    outcome: deriveOutcome(session),
    firstRecordedSymptomAt: positives[0]?.timestamp,
    firstRecordedLatency: positives[0] ? minutesBetween(positives[0].timestamp, session.doseTimestamp) : undefined,
    maximumSeverity,
    effectiveMaximumSeverity: maximumSeverity ?? 0,
    maximumSeverityIsInferred: maximumSeverity === undefined,
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
  const symptomatic = metrics.filter((item) => item.metrics.maximumSeverity > 0);
  // 未解決の回は症状時間が確定しないため中央値から外す。それ以外（症状なしを含む）は対象にする。
  const withDuration = metrics.filter((item) => item.metrics.outcome !== 'unresolved');
  return {
    count,
    noSymptomRate: count ? outcomes('noSymptomReported') / count : undefined,
    symptomaticRate: count ? symptomatic.length / count : undefined,
    noDataRate: count ? outcomes('noSymptomData') / count : undefined,
    medianMaximumSeverity: median(metrics.map((item) => item.metrics.effectiveMaximumSeverity)),
    medianDuration: median(withDuration.map((item) => item.metrics.totalSymptomaticTime)),
    medianFirstLatency: median(symptomatic.map((item) => item.metrics.firstRecordedLatency)),
    unresolvedCount: outcomes('unresolved'),
    inferredCount: metrics.filter((item) => item.metrics.maximumSeverityIsInferred).length
  };
}

export function formatJapaneseMinutes(value) {
  const n = Math.max(0, Math.round(Number(value)));
  const lastTwo = n % 100;
  const last = n % 10;
  const pun = lastTwo === 10 || [1, 3, 6, 8].includes(last);
  return `${n}${pun ? 'ぷん' : 'ふん'}`;
}

// 服用手順のタイマー。分数は保護者が処方医の指示や説明書に従って設定した値を使い、
// アプリが服用方法を決めることはしない。段階は服用時刻から毎回計算し、保存しない。
export function doseTimerPhase(session, settings, now = new Date()) {
  if (!session || !settings?.doseTimerEnabled) return undefined;
  const hold = Number(settings.holdMinutes);
  const wait = Number(settings.waitMinutes);
  if (!(hold > 0) || !(wait > 0)) return undefined;
  const elapsed = new Date(now).getTime() - new Date(session.doseTimestamp).getTime();
  if (!Number.isFinite(elapsed) || elapsed < 0) return undefined;
  const holdEnd = hold * 60000;
  const waitEnd = holdEnd + wait * 60000;
  if (elapsed < holdEnd) return { phase: 'hold', progress: elapsed / holdEnd };
  if (elapsed < waitEnd) return { phase: 'wait', remainingMinutes: Math.ceil((waitEnd - elapsed) / 60000) };
  return { phase: 'done' };
}

export function isValidTimerMinutes(value) {
  if (value === '' || value === null || value === undefined) return false;
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 30;
}

export function validateSettings(settings) {
  return Boolean(
    settings && typeof settings.medicationName === 'string' && settings.medicationName.trim() &&
    typeof settings.medicationDose === 'string' && settings.medicationDose.trim() &&
    typeof settings.parentSymptomLabel === 'string' && settings.parentSymptomLabel.trim() &&
    typeof settings.childSymptomLabel === 'string' && settings.childSymptomLabel.trim()
  );
}
