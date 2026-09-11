import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS, addSymptomRecord, autoCloseSessions, closeSession, confirmNoSymptoms,
  createSession, dashboardSummary, deriveMetrics, deriveOutcome, doseTimerPhase, formatJapaneseMinutes,
  isValidTimerMinutes, reopenSession
} from '../src/model.js';

const settings = {
  ...DEFAULT_SETTINGS,
  medicationName: 'テスト薬', medicationDose: '1単位',
  parentSymptomLabel: 'テスト症状', childSymptomLabel: 'のど', setupComplete: true
};

function at(minutes) {
  return new Date(Date.UTC(2026, 7, 19, 3, minutes, 0));
}

test('記録なし、0のみ、陽性、解決を区別する', () => {
  const empty = createSession(settings, undefined, at(0));
  assert.equal(deriveOutcome(empty), 'noSymptomData');
  const zero = addSymptomRecord(empty, 0, at(2));
  assert.equal(deriveOutcome(zero), 'noSymptomReported');
  const positive = addSymptomRecord(zero, 2, at(4));
  assert.equal(deriveOutcome(positive), 'unresolved');
  const resolved = addSymptomRecord(positive, 0, at(9));
  assert.equal(deriveOutcome(resolved), 'resolved');
});

test('同一時刻の陽性と0も入力順で解決する', () => {
  let session = createSession(settings, undefined, at(0));
  session = addSymptomRecord(session, 2, at(2));
  session = addSymptomRecord(session, 0, at(2));
  assert.equal(deriveOutcome(session), 'resolved');
});

test('再出現を別episodeとして計算する', () => {
  let session = createSession(settings, 4, at(0));
  session = addSymptomRecord(session, 2, at(2));
  session = addSymptomRecord(session, 0, at(7));
  session = addSymptomRecord(session, 1, at(11));
  session = addSymptomRecord(session, 0, at(14));
  const metrics = deriveMetrics(session);
  assert.equal(metrics.outcome, 'resolved');
  assert.equal(metrics.episodeCount, 2);
  assert.equal(metrics.totalSymptomaticTime, 8);
  assert.equal(metrics.firstRecordedLatency, 2);
  assert.equal(metrics.maximumSeverity, 2);
  assert.equal(metrics.timeFromDoseToLastRecordedResolution, 14);
});

test('未解決episodeを合計時間へ加えない', () => {
  let session = createSession(settings, undefined, at(0));
  session = addSymptomRecord(session, 2, at(2));
  session = addSymptomRecord(session, 0, at(7));
  session = addSymptomRecord(session, 1, at(11));
  const metrics = deriveMetrics(session);
  assert.equal(metrics.outcome, 'unresolved');
  assert.equal(metrics.totalSymptomaticTime, 5);
});

test('自動クローズはoutcomeを変えず、再オープンでclosedAtを消す', () => {
  let session = createSession(settings, undefined, at(0));
  session = addSymptomRecord(session, 3, at(1));
  const [closed] = autoCloseSessions([session], at(61));
  assert.equal(closed.lifecycle, 'closed');
  assert.equal(deriveOutcome(closed), 'unresolved');
  assert.ok(closed.closedAt);
  const reopened = reopenSession(closed, at(32));
  assert.equal(reopened.lifecycle, 'open');
  assert.equal(reopened.closedAt, undefined);
});

test('自動クローズは最後の記録から60分で、記録のたびに測り直す', () => {
  const noRecords = createSession(settings, undefined, at(0));
  assert.equal(autoCloseSessions([noRecords], at(59))[0].lifecycle, 'open');
  assert.equal(autoCloseSessions([noRecords], at(60))[0].lifecycle, 'closed');

  const session = addSymptomRecord(noRecords, 2, at(10));
  assert.equal(autoCloseSessions([session], at(69))[0].lifecycle, 'open');
  assert.equal(autoCloseSessions([session], at(70))[0].lifecycle, 'closed');

  const continued = addSymptomRecord(session, 1, at(65));
  assert.equal(autoCloseSessions([continued], at(70))[0].lifecycle, 'open');
  assert.equal(autoCloseSessions([continued], at(125))[0].lifecycle, 'closed');
});

test('保護者確認は陽性記録がある場合に拒否する', () => {
  const empty = createSession(settings, undefined, at(0));
  assert.equal(deriveOutcome(confirmNoSymptoms(empty, at(3))), 'noSymptomReported');
  const positive = addSymptomRecord(empty, 1, at(2));
  assert.throws(() => confirmNoSymptoms(positive, at(3)), /positive_records_exist/);
});

test('最後に記録されたseverityを最大値と区別して導出する', () => {
  let session = createSession(settings, undefined, at(0));
  assert.equal(deriveMetrics(session).lastRecordedSeverity, undefined);
  session = addSymptomRecord(session, 3, at(2));
  session = addSymptomRecord(session, 1, at(4));
  assert.equal(deriveMetrics(session).lastRecordedSeverity, 1);
  assert.equal(deriveMetrics(session).maximumSeverity, 3);
  session = addSymptomRecord(session, 4, at(6));
  assert.equal(deriveMetrics(session).lastRecordedSeverity, 4);
  session = addSymptomRecord(session, 0, at(9));
  assert.equal(deriveMetrics(session).lastRecordedSeverity, 0);
});

test('終了表示用に最後のepisodeのdurationを導出する', () => {
  let session = createSession(settings, undefined, at(0));
  assert.equal(deriveMetrics(session).lastEpisodeDuration, undefined);
  session = addSymptomRecord(session, 2, at(2));
  session = addSymptomRecord(session, 0, at(7));
  session = addSymptomRecord(session, 1, at(11));
  session = addSymptomRecord(session, 0, at(14));
  const metrics = deriveMetrics(session);
  assert.equal(metrics.totalSymptomaticTime, 8);
  assert.equal(metrics.lastEpisodeDuration, 3);
  const reopened = addSymptomRecord(session, 2, at(16));
  assert.equal(deriveMetrics(reopened).lastEpisodeDuration, 3);
});

test('0だけの記録と保護者確認を最大強度0の実測値として扱う', () => {
  const empty = createSession(settings, undefined, at(0));
  assert.equal(deriveMetrics(empty).maximumSeverity, undefined);
  assert.equal(deriveMetrics(empty).effectiveMaximumSeverity, 0);
  assert.equal(deriveMetrics(empty).maximumSeverityIsInferred, true);

  const zeroOnly = addSymptomRecord(empty, 0, at(3));
  assert.equal(deriveMetrics(zeroOnly).maximumSeverity, 0);
  assert.equal(deriveMetrics(zeroOnly).maximumSeverityIsInferred, false);

  const confirmed = confirmNoSymptoms(empty, at(3));
  assert.equal(deriveMetrics(confirmed).maximumSeverity, 0);
  assert.equal(deriveMetrics(confirmed).maximumSeverityIsInferred, false);
});

test('中央値は症状のなかった回も分母に含める', () => {
  const build = (severities) => {
    let session = createSession(settings, undefined, at(0));
    severities.forEach((value, index) => { session = addSymptomRecord(session, value, at(index + 1)); });
    return session;
  };
  // 症状のあった回1つと、0だけの回3つ
  const sessions = [build([4, 0]), build([0]), build([0]), build([0])];
  const summary = dashboardSummary(sessions);
  assert.equal(summary.medianMaximumSeverity, 0);
  assert.equal(summary.symptomaticRate, 0.25);
  assert.equal(summary.inferredCount, 0);

  // 症状の記録がない回は0とみなし、推定件数として数える
  const withInferred = dashboardSummary([...sessions, createSession(settings, undefined, at(0))]);
  assert.equal(withInferred.inferredCount, 1);
  assert.equal(withInferred.noDataRate, 0.2);
});

test('服用手順タイマーは設定した分数で段階を切り替える', () => {
  const session = createSession(settings, undefined, at(0));
  const on = { ...settings, doseTimerEnabled: true, holdMinutes: 1, waitMinutes: 5 };
  const sec = (seconds) => new Date(at(0).getTime() + seconds * 1000);

  // 既定オフ、分数の未入力、時計の逆行ではタイマーを出さない
  assert.equal(doseTimerPhase(session, settings, sec(10)), undefined);
  assert.equal(doseTimerPhase(session, { ...on, waitMinutes: '' }, sec(10)), undefined);
  assert.equal(doseTimerPhase(session, on, sec(-5)), undefined);

  assert.deepEqual(doseTimerPhase(session, on, sec(0)), { phase: 'hold', progress: 0 });
  assert.equal(doseTimerPhase(session, on, sec(30)).progress, 0.5);
  // 保持時間が終わったら「のみこんでね」、そこから待ち時間を数える
  assert.deepEqual(doseTimerPhase(session, on, sec(60)), { phase: 'wait', remainingMinutes: 5 });
  assert.equal(doseTimerPhase(session, on, sec(359)).remainingMinutes, 1);
  // 飲食してよいのは保持＋待ちの合計（1＋5＝6分）から
  assert.deepEqual(doseTimerPhase(session, on, sec(360)), { phase: 'done' });
  assert.deepEqual(doseTimerPhase(session, on, sec(40 * 60)), { phase: 'done' });
});

test('タイマーの分数は1〜30の整数だけを受け付ける', () => {
  assert.ok(isValidTimerMinutes('1'));
  assert.ok(isValidTimerMinutes(30));
  assert.ok(!isValidTimerMinutes('0'));
  assert.ok(!isValidTimerMinutes('31'));
  assert.ok(!isValidTimerMinutes('1.5'));
  assert.ok(!isValidTimerMinutes(''));
});

test('明示的な分表記を使う', () => {
  assert.equal(formatJapaneseMinutes(1), '1ぷん');
  assert.equal(formatJapaneseMinutes(4), '4ふん');
  assert.equal(formatJapaneseMinutes(6), '6ぷん');
  assert.equal(formatJapaneseMinutes(8), '8ぷん');
  assert.equal(formatJapaneseMinutes(10), '10ぷん');
});
