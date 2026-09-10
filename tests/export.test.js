import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, addSymptomRecord, createSession } from '../src/model.js';
import { SUMMARY_COLUMNS, TIME_SERIES_COLUMNS, backupJson, summaryCsv, timeSeriesCsv, validateBackup } from '../src/export.js';

const settings = {
  ...DEFAULT_SETTINGS, medicationName: '薬,名称', medicationDose: '1',
  parentSymptomLabel: '症状', childSymptomLabel: 'のど', setupComplete: true
};

test('CSV列名・順序・BOM・引用規則を固定する', () => {
  let session = createSession(settings, 0, new Date('2026-08-19T12:00:00+09:00'));
  session.notes = '引用"と,カンマ\n改行';
  session = addSymptomRecord(session, 0, new Date('2026-08-19T12:02:00+09:00'));
  const summary = summaryCsv([session]);
  const series = timeSeriesCsv([session]);
  assert.ok(summary.startsWith(`\uFEFF${SUMMARY_COLUMNS.join(',')}\r\n`));
  assert.ok(series.startsWith(`\uFEFF${TIME_SERIES_COLUMNS.join(',')}\r\n`));
  assert.match(summary, /"薬,名称"/);
  assert.match(summary, /"引用""と,カンマ\n改行"/);
  assert.match(series, /,0\r\n$/);
});

test('未解決セッションの時間列を空欄にする', () => {
  let session = createSession({ ...settings, medicationName: '薬' }, undefined, new Date('2026-08-19T12:00:00+09:00'));
  session = addSymptomRecord(session, 2, new Date('2026-08-19T12:03:00+09:00'));
  const values = summaryCsv([session]).split('\r\n')[1].split(',');
  assert.equal(values[SUMMARY_COLUMNS.indexOf('outcome')], 'unresolved');
  assert.equal(values[SUMMARY_COLUMNS.indexOf('total_symptomatic_time_min')], '');
  assert.equal(values[SUMMARY_COLUMNS.indexOf('time_from_dose_to_last_resolution_min')], '');
});

test('0の記録は0、症状の記録なしは空欄で書き出す（推定値を入れない）', () => {
  const base = { ...settings, medicationName: '薬' };
  const noRecords = createSession(base, undefined, new Date('2026-08-19T12:00:00+09:00'));
  const zeroOnly = addSymptomRecord(noRecords, 0, new Date('2026-08-19T12:05:00+09:00'));
  const rows = summaryCsv([noRecords, zeroOnly]).split('\r\n');
  const maxIndex = SUMMARY_COLUMNS.indexOf('max_severity');
  const outcomeIndex = SUMMARY_COLUMNS.indexOf('outcome');

  // 症状の記録がない回: グラフでは0とみなすが、CSVには推定値を出さない
  assert.equal(rows[1].split(',')[outcomeIndex], 'noSymptomData');
  assert.equal(rows[1].split(',')[maxIndex], '');
  // 0を記録した回: 実測値なので0と書き出す
  assert.equal(rows[2].split(',')[outcomeIndex], 'noSymptomReported');
  assert.equal(rows[2].split(',')[maxIndex], '0');
});

test('version 1 backupを往復し未知versionを拒否する', () => {
  const json = backupJson([], settings, '2026-08-19T00:00:00.000Z');
  const value = validateBackup(JSON.parse(json));
  assert.equal(value.schemaVersion, 1);
  assert.throws(() => validateBackup({ ...value, schemaVersion: 2 }), /対応していません/);
});
