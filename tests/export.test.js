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

test('version 1 backupを往復し未知versionを拒否する', () => {
  const json = backupJson([], settings, '2026-08-19T00:00:00.000Z');
  const value = validateBackup(JSON.parse(json));
  assert.equal(value.schemaVersion, 1);
  assert.throws(() => validateBackup({ ...value, schemaVersion: 2 }), /対応していません/);
});
