import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, addSymptomRecord, createSession } from '../src/model.js';
import {
  DAILY_COLUMNS, SUMMARY_COLUMNS, TIME_SERIES_COLUMNS, backupJson, dailyCsv, summaryCsv, timeSeriesCsv, validateBackup
} from '../src/export.js';

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

test('日次CSVの列名と値', () => {
  const day = '2026-09-14';
  const records = [{
    localDate: day, sneezing: 1, rhinorrhoea: 2, congestion: 0, nasalItch: 1, ocularItch: 0, wateryEyes: 2,
    medicationClasses: [1, 2], note: '引用"と,カンマ', entryTimestamp: '2026-09-14T21:00:00.000+01:00',
    isRetrospective: false
  }];
  const text = dailyCsv(records, []);
  assert.ok(text.startsWith(`﻿${DAILY_COLUMNS.join(',')}\r\n`));

  // note にカンマが入るため、それより前の列だけを単純分割で確認する
  const values = text.split('\r\n')[1].split(',');
  assert.equal(values[DAILY_COLUMNS.indexOf('date')], day);
  assert.equal(values[DAILY_COLUMNS.indexOf('slit_status')], '');
  assert.equal(values[DAILY_COLUMNS.indexOf('sneezing')], '1');
  assert.equal(values[DAILY_COLUMNS.indexOf('dss')], '1');
  assert.equal(values[DAILY_COLUMNS.indexOf('tnss')], '4');
  assert.equal(values[DAILY_COLUMNS.indexOf('medication_classes')], '1|2');
  assert.equal(values[DAILY_COLUMNS.indexOf('dms')], '2');
  assert.equal(values[DAILY_COLUMNS.indexOf('csms')], '3');
  assert.match(text, /"引用""と,カンマ"/);

  // 服用記録のある日は taken になる
  const withSession = dailyCsv(records, [{ localDate: day }]).split('\r\n')[1].split(',');
  assert.equal(withSession[DAILY_COLUMNS.indexOf('slit_status')], 'taken');

  // 症状が揃っていない日は dss と csms を空欄にする
  const partial = dailyCsv([{ localDate: day, sneezing: 1, medicationClasses: [0] }], []).split('\r\n')[1].split(',');
  assert.equal(partial[DAILY_COLUMNS.indexOf('dss')], '');
  assert.equal(partial[DAILY_COLUMNS.indexOf('csms')], '');
  assert.equal(partial[DAILY_COLUMNS.indexOf('dms')], '0');
});

test('backupを往復し、旧版を受け入れて未知versionを拒否する', () => {
  const json = backupJson([], settings, [{ localDate: '2026-08-19', sneezing: 1 }], '2026-08-19T00:00:00.000Z');
  const value = validateBackup(JSON.parse(json));
  assert.equal(value.schemaVersion, 2);
  assert.equal(value.dailyRecords.length, 1);

  // 日次記録を持たない v1 のバックアップは、空で補って受け入れる
  const v1 = { schemaVersion: 1, exportedAt: value.exportedAt, appVersion: '0.4.0', sessions: [], settings };
  assert.deepEqual(validateBackup(v1).dailyRecords, []);

  assert.throws(() => validateBackup({ ...value, schemaVersion: 3 }), /対応していません/);
});
