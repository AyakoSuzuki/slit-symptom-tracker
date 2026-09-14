import {
  DEFAULT_SETTINGS, addSymptomRecord, autoCloseSessions, closeSession, confirmNoSymptoms,
  createSession, dashboardSummary, deleteSymptomRecord, deriveMetrics, formatJapaneseMinutes,
  doseTimerPhase, isValidTimerMinutes, localIso, minutesBetween, reopenSession,
  selectedSeverityForDay, shouldAutoClose, updateSymptomRecord, validateSettings,
  DAILY_SEVERITIES, DAILY_SYMPTOM_KEYS, MEDICATION_CLASSES, createDailyRecord, dailyScores,
  doseStatusForDay, recentDays, shiftDay
} from './model.js';
import {
  deleteAllData, deleteDailyRecord, deleteSession, getDailyRecords, getMeta, getSessions,
  getSettings, putMeta, putDailyRecord, putSession, putSettings, replaceAllData
} from './db.js';
import { backupJson, summaryCsv, timeSeriesCsv, validateBackup } from './export.js';
import { comparisonChart, lineChart } from './charts.js';

const app = document.querySelector('#app');
const toastRegion = document.querySelector('#toast-region');
const state = {
  mode: 'child',
  parentTab: 'dashboard',
  period: 14,
  settings: { ...DEFAULT_SETTINGS },
  sessions: [],
  dailyRecords: [],
  dailyDate: null,
  dailyDraft: null,
  pendingWorry: undefined,
  worrySkipped: false,
  undo: null,
  undoTimer: null,
  saveError: false,
  retryAction: null,
  formDirty: false,
  timerInterval: null,
  timerPhase: undefined,
  wakeLock: null,
  wakeLockPending: false,
  wakeLockWanted: false,
  storageStatus: 'checking',
  lastBackupAt: null,
  importPreview: null,
  updateWaiting: false,
  swRegistration: null,
  reloadingForUpdate: false,
  uiDate: null
};

// 日付が変わったら、画面に残っている選択（心配度）を持ち越さない。
function syncDayChange() {
  const today = localDateToday();
  if (state.uiDate === today) return;
  state.uiDate = today;
  state.pendingWorry = undefined;
  state.worrySkipped = false;
}

const outcomeLabels = {
  resolved: 'おさまった記録あり',
  unresolved: 'おさまった記録なし',
  noSymptomReported: '症状なし',
  noSymptomData: '記録なし'
};

const severityLabels = ['きにならない', 'ほんのすこし', 'すこし', 'まあまあ', 'けっこう', 'とても'];

function esc(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[character]);
}

function displayDate(timestamp) {
  if (!timestamp) return '—';
  return new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(timestamp));
}

function displayTime(timestamp) {
  if (!timestamp) return '';
  return timestamp.slice(11, 16);
}

function inputTime(timestamp) {
  return timestamp ? timestamp.slice(11, 16) : '';
}

// 記録の日付は保ったまま、時刻だけを差し替える。日をまたいだ記録の日付を壊さない。
function replaceTime(timestamp, time) {
  const [hours, minutes] = time.split(':');
  const date = new Date(timestamp);
  date.setHours(Number(hours), Number(minutes), 0, 0);
  return localIso(date);
}

function monthLabel(localDate) {
  return `${localDate.slice(0, 4)}年${Number(localDate.slice(5, 7))}月`;
}

// セッションの自由記述は、旧「メモ」と「その他の体調」を1つにまとめて表示する。
// 保存時に conditionOtherText へ寄せ、notes は空にする（既存の記述を失わないため）。
function sessionFreeText(session) {
  return [session.conditionOtherText, session.notes]
    .filter((value) => value && String(value).trim())
    .join('\n');
}

function percent(value) {
  return value === undefined ? '—' : `${Math.round(value * 100)}%`;
}

function numberOrDash(value, suffix = '') {
  return value === undefined ? '—' : `${Number.isInteger(value) ? value : value.toFixed(1)}${suffix}`;
}

function severityIcon(level) {
  const positions = [10, 18, 26, 34, 42];
  const dots = positions.map((x, index) => `<circle cx="${x}" cy="19" r="3.3"
    fill="${index < level ? '#2d6658' : '#ffffff'}" stroke="#2d6658" stroke-width="1.8"/>`).join('');
  return `<svg viewBox="0 0 52 38" aria-hidden="true"><rect x="2" y="2" width="48" height="34" rx="17" fill="#eef7f3" stroke="#6b9287" stroke-width="2"/>${dots}</svg>`;
}

function cloudShape(cx, cy, filled) {
  const puffs = [[-1.4, 0.5, 1.4], [0.2, -0.7, 1.8], [1.7, 0.7, 1.1]];
  const silhouette = puffs.map(([dx, dy, r]) =>
    `<circle cx="${cx + dx}" cy="${cy + dy}" r="${r + 1.0}" fill="#526b88"/>`).join('');
  const body = puffs.map(([dx, dy, r]) =>
    `<circle cx="${cx + dx}" cy="${cy + dy}" r="${r}" fill="#ffffff"/>`).join('');
  return silhouette + (filled ? '' : body);
}

function worryIcon(level) {
  const positions = [9, 17.5, 26, 34.5, 43];
  const clouds = positions.map((x, index) => cloudShape(x, 19, index < level)).join('');
  return `<svg viewBox="0 0 52 38" aria-hidden="true"><rect x="2" y="2" width="48" height="34" rx="17" fill="#eef1fa" stroke="#7c8db0" stroke-width="2"/>${clouds}</svg>`;
}

function scalePicker({ action, ariaKind, icon, selected }) {
  return `<div class="scale-grid" role="radiogroup" aria-label="${ariaKind}">${severityLabels.map((label, level) => `
    <button class="scale-button" type="button" role="radio" aria-checked="${selected === level}"
      tabindex="${(selected ?? 0) === level ? 0 : -1}"
      aria-label="${ariaKind} ${level} ${label}" data-action="${action}" data-value="${level}">
      ${icon(level)}<span class="scale-number">${level}</span><span class="scale-label">${label}</span>
    </button>`).join('')}</div>`;
}

function severityPicker(selected) {
  return scalePicker({ action: 'record-severity', ariaKind: '症状の強さ', icon: severityIcon, selected });
}

function worryPicker() {
  return scalePicker({ action: 'select-worry', ariaKind: '心配の強さ', icon: worryIcon, selected: state.pendingWorry });
}

function childHeader() {
  return `<header class="topbar"><h1 class="brand">🌿 きょうの きろく</h1>
    <button class="adult-link" type="button" data-action="adult-gate">おとな</button></header>`;
}

function saveErrorCard() {
  if (!state.saveError) return '';
  return `<section class="card error-card" role="alert"><p class="child-title">きろく できなかったみたい</p>
    <div class="button-row"><button class="secondary" type="button" data-action="retry-save">もういちど</button>
    <button class="secondary" type="button" data-action="adult-gate">おとなを よぶ</button></div></section>`;
}

function renderChild() {
  if (!state.settings.setupComplete || !validateSettings(state.settings)) {
    return `<div class="shell child-shell">${childHeader()}<section class="card mint">
      <p class="eyebrow">はじめの せってい</p><h2 class="child-title">おとなと いっしょに<br>せっていしてね</h2>
      <button class="primary" type="button" data-action="adult-gate">おとなの がめんへ</button>
    </section>${saveErrorCard()}</div>`;
  }

  if (!state.settings.childModeEnabled) {
    return `<div class="shell child-shell">${childHeader()}<section class="card mint">
      <h2 class="child-title">おとなの がめんを<br>つかってね</h2>
      <button class="primary" type="button" data-action="adult-gate">おとなの がめんへ</button>
    </section></div>`;
  }

  const openSession = state.sessions.find((session) => session.lifecycle === 'open');
  const todaySessions = state.sessions.filter((session) => session.localDate === localDateToday());
  if (openSession) return renderActiveChild(openSession);
  if (todaySessions.length) return renderClosedToday(todaySessions[0]);
  return `<div class="shell child-shell">${childHeader()}<section class="card mint">
    <p class="eyebrow">きょうのおくすり</p>
    <h2 class="child-title">${esc(state.settings.medicationName)}</h2>
    ${state.settings.askPreDoseWorry ? `<p class="question">いま どのくらい しんぱい？</p>${worryPicker()}
      <button class="quiet-button" type="button" data-action="skip-worry">${state.worrySkipped ? 'とばしたよ' : 'とばす'}</button><hr>` : ''}
    <button class="primary" type="button" data-action="start-dose">おくすり のんだよ</button>
  </section>${saveErrorCard()}${renderUndo()}</div>`;
}

function renderActiveChild(session) {
  const metrics = deriveMetrics(session);
  let result = '';
  if (metrics.outcome === 'resolved') {
    result = `<div class="result-card" role="status"><strong>いまは きにならないよ</strong>${state.settings.showResolutionDurationInChildMode
      ? `<br>${formatJapaneseMinutes(Math.max(1, metrics.lastEpisodeDuration))}くらいで きにならなくなったよ` : ''}</div>
      <button class="quiet-button" type="button" data-action="focus-severity">また きになった</button>`;
  } else if (metrics.outcome === 'noSymptomReported') {
    result = '<div class="result-card" role="status"><strong>きにならない きろくが あるよ</strong></div>';
  } else if (metrics.outcome === 'unresolved') {
    result = `<div class="result-card" role="status"><strong>さいごの きろくは ${metrics.lastRecordedSeverity} ${severityLabels[metrics.lastRecordedSeverity]}</strong></div>`;
  }
  return `<div class="shell child-shell">${childHeader()}<section class="card lavender">
    <p class="eyebrow">おくすり のんだよ</p><p class="dose-time">${esc(displayTime(session.doseTimestamp))}</p>
    <p class="helper">${esc(session.medication.name)}</p>${doseTimerMarkup(session)}${result}
  </section><section class="card mint" id="severity-card">
    <p class="question">いま ${esc(session.symptom.childLabel)}は<br>どんなかんじ？</p>
    ${severityPicker(selectedSeverityForDay(session, localDateToday()))}
    <p class="helper">かわったときだけ おしてね</p>
  </section>${saveErrorCard()}${renderUndo()}</div>`;
}

const TIMER_RING_CIRCUMFERENCE = 2 * Math.PI * 26;

const timerMessages = {
  hold: 'したの したに おいたまま まってね',
  wait: 'のみこんでね',
  done: 'たべたり のんだり していいよ'
};

function doseTimerMarkup(session) {
  const timer = doseTimerPhase(session, state.settings);
  if (!timer) return '';
  if (timer.phase === 'done') return `<p class="timer-done">${timerMessages.done}</p>`;
  if (timer.phase === 'hold') {
    return `<div id="dose-timer" class="dose-timer" data-session-id="${esc(session.id)}">
      <svg class="timer-ring" viewBox="0 0 64 64" aria-hidden="true">
        <circle class="ring-track" cx="32" cy="32" r="26"/>
        <circle class="ring-fill" cx="32" cy="32" r="26" stroke-dasharray="${TIMER_RING_CIRCUMFERENCE.toFixed(2)}"
          stroke-dashoffset="${ringOffset(timer.progress)}"/>
      </svg>
      <p class="timer-text">${timerMessages.hold}</p></div>`;
  }
  return `<div id="dose-timer" class="dose-timer wait" data-session-id="${esc(session.id)}">
    <p class="timer-lead">${timerMessages.wait}</p>
    <p class="timer-text">たべたり のんだりは あと <span data-timer-remaining>${formatJapaneseMinutes(timer.remainingMinutes)}</span> まってね</p></div>`;
}

function ringOffset(progress) {
  return (TIMER_RING_CIRCUMFERENCE * (1 - Math.min(1, Math.max(0, progress)))).toFixed(2);
}

// タイマーは該当部分だけを書き換え、段階が変わったときだけ全体を描き直す。
// 毎秒 render() すると、入力中のフォーカスや undo バーを壊すため。
function syncDoseTimer() {
  clearInterval(state.timerInterval);
  state.timerInterval = null;
  const element = state.mode === 'child' ? document.querySelector('#dose-timer, .timer-done') : null;
  const session = element?.id === 'dose-timer'
    ? state.sessions.find((item) => item.id === element.dataset.sessionId)
    : state.sessions.find((item) => item.lifecycle === 'open');
  const timer = element ? doseTimerPhase(session, state.settings) : undefined;
  if (timer?.phase && state.timerPhase && timer.phase !== state.timerPhase) announce(timerMessages[timer.phase]);
  state.timerPhase = timer?.phase;
  const running = timer?.phase === 'hold' || timer?.phase === 'wait';
  updateWakeLock(running);
  if (!running) return;
  state.timerInterval = setInterval(() => {
    const current = doseTimerPhase(session, state.settings);
    if (current?.phase !== state.timerPhase) { render(); return; }
    paintDoseTimer(current);
  }, 1000);
}

function paintDoseTimer(timer) {
  if (timer.phase === 'hold') {
    document.querySelector('#dose-timer .ring-fill')?.setAttribute('stroke-dashoffset', ringOffset(timer.progress));
  } else if (timer.phase === 'wait') {
    const remaining = document.querySelector('[data-timer-remaining]');
    const text = formatJapaneseMinutes(timer.remainingMinutes);
    if (remaining && remaining.textContent !== text) remaining.textContent = text;
  }
}

function announce(message) {
  const region = document.querySelector('#timer-announcer');
  if (!region) return;
  // 同じ文言が続いても読み上げられるよう、いったん空にしてから入れる
  region.textContent = '';
  setTimeout(() => { region.textContent = message; }, 50);
}

// タイマーの間だけ画面を消さない。取得できない端末でも、段階は服用時刻から計算するので表示は崩れない。
async function updateWakeLock(wanted) {
  state.wakeLockWanted = wanted;
  if (!('wakeLock' in navigator)) return;
  if (!wanted) {
    const lock = state.wakeLock;
    state.wakeLock = null;
    if (lock) lock.release().catch(() => {});
    return;
  }
  if (state.wakeLock || state.wakeLockPending || document.hidden) return;
  state.wakeLockPending = true;
  try {
    const lock = await navigator.wakeLock.request('screen');
    lock.addEventListener('release', () => { if (state.wakeLock === lock) state.wakeLock = null; });
    if (state.wakeLockWanted) state.wakeLock = lock;
    else lock.release().catch(() => {});
  } catch (error) {
    console.warn('Screen wake lock unavailable', error);
  } finally {
    state.wakeLockPending = false;
  }
}

function renderClosedToday(session) {
  const metrics = deriveMetrics(session);
  const text = metrics.outcome === 'noSymptomData'
    ? 'しょうじょうの きろくは ないよ'
    : metrics.outcome === 'noSymptomReported'
      ? 'きにならない きろくが あるよ'
      : metrics.outcome === 'resolved' ? 'いまは きにならないよ' : 'おとなと きろくを みてね';
  return `<div class="shell child-shell">${childHeader()}<section class="card sky">
    <p class="eyebrow">きょうの きろく</p><h2 class="child-title">${text}</h2>
    <p class="helper">${esc(displayTime(session.doseTimestamp))}</p>
  </section>${saveErrorCard()}${renderUndo()}</div>`;
}

function renderUndo() {
  return state.undo ? `<div class="undo-bar" role="status"><span>きろくしたよ</span>
    <button type="button" data-action="undo">まちがえた</button></div>` : '';
}

function renderParentGate() {
  return `<div class="shell parent-gate"><section class="card">
    <h1>保護者画面</h1><p>履歴、設定、データ管理、安全情報を表示します。</p>
    <form data-form="parent-gate"><label class="check"><input type="checkbox" name="confirm" required>
      <span>保護者として詳細画面を開きます</span></label>
      ${state.settings.parentPinHash ? '<label class="field"><span>PIN</span><input name="pin" type="password" inputmode="numeric" autocomplete="off" required></label>' : ''}
      <div class="button-row"><button class="primary small" type="submit">開く</button>
      <button class="secondary" type="button" data-action="back-child">戻る</button></div>
    </form></section></div>`;
}

function renderParent() {
  const tabs = [
    ['dashboard', '概要'],
    ...(state.settings.dailyDiaryEnabled ? [['daily', '日々の記録']] : []),
    ['history', '服用の記録'], ['settings', '設定'], ['data', 'データ'], ['safety', '安全について']
  ];
  return `<div class="shell parent-shell"><header class="topbar"><div><p class="eyebrow">Parent Mode</p>
    <h1 class="brand">SLIT Symptom Tracker</h1></div><button class="secondary" type="button" data-action="back-child">こども画面へ</button></header>
    <nav class="tabs" aria-label="保護者画面">${tabs.map(([id, label]) => `<button class="tab" type="button" role="tab"
      aria-selected="${state.parentTab === id}" data-action="parent-tab" data-tab="${id}">${label}</button>`).join('')}</nav>
    ${state.updateWaiting ? `<div class="notice update-notice"><span>新しい版が用意できています。記録はそのまま残ります。</span>
      <button class="secondary" type="button" data-action="apply-update">更新して再起動</button></div>` : ''}
    ${parentPanel()}</div>`;
}

function parentPanel() {
  if (state.parentTab === 'daily') {
    return state.settings.dailyDiaryEnabled ? renderDaily() : renderDashboard();
  }
  if (state.parentTab === 'history') return renderHistory();
  if (state.parentTab === 'settings') return renderSettings();
  if (state.parentTab === 'data') return renderData();
  if (state.parentTab === 'safety') return renderSafety();
  return renderDashboard();
}

function filteredSessions() {
  return state.period === 0 ? state.sessions : state.sessions.slice(0, state.period);
}

function renderDashboard() {
  const sessions = filteredSessions();
  const summary = dashboardSummary(sessions);
  const backupAge = state.lastBackupAt ? (Date.now() - new Date(state.lastBackupAt)) / 86400000 : Infinity;
  return `<section aria-labelledby="dashboard-title"><div class="card">
    <div class="topbar"><h2 id="dashboard-title" class="panel-title">記録の概要</h2>
      <label class="field"><span class="visually-hidden">対象期間</span><select id="period-select" data-action="period">
        ${[[7,'直近7回'],[14,'直近14回'],[30,'直近30回'],[0,'全期間']].map(([value,label]) => `<option value="${value}" ${state.period===value?'selected':''}>${label}</option>`).join('')}
      </select></label></div>
    ${backupAge >= 30 ? '<p class="notice">バックアップがまだないか、最後のバックアップから30日以上経過しています。データ画面から記録をバックアップできます。</p>' : ''}
    <div class="stats">
      ${stat('服用回数', summary.count)}${stat('症状なしと記録', percent(summary.noSymptomRate))}
      ${stat('症状あり', percent(summary.symptomaticRate))}${stat('症状の記録なし', percent(summary.noDataRate))}
      ${stat('最大強度の中央値', numberOrDash(summary.medianMaximumSeverity))}${stat('持続時間の中央値', numberOrDash(summary.medianDuration, '分'))}
      ${stat('最初の記録までの中央値', numberOrDash(summary.medianFirstLatency, '分'))}${stat('おさまった記録なし', summary.unresolvedCount)}
    </div><p class="privacy">記録操作の時刻に基づく観察データです。実際の発症・消失時刻や医学的な緊急度を示すものではありません。<br>
      「最大強度の中央値」は、症状のあった回だけでなく全ての回を対象にしています。症状の記録がない回は0として数えています。</p>
    <div class="chart-grid"><article class="chart-card"><h3>症状時間の推移</h3><div id="duration-chart"></div>
      <p class="privacy">症状が続いたまま受付が終了した回は、時間が確定しないため表示しません。</p></article>
      <article class="chart-card"><h3>最大強度の推移</h3><div id="maximum-chart"></div><p id="inferred-note" class="privacy"></p></article>
      <article class="chart-card"><h3>心配度と最大強度</h3><div id="worry-chart"></div><p id="worry-missing" class="privacy"></p></article></div>
  </div></section>`;
}

function stat(label, value) {
  return `<div class="stat"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`;
}

function renderHistory() {
  const open = state.sessions.find((session) => session.lifecycle === 'open');
  const todayCount = state.sessions.filter((session) => session.localDate === localDateToday()).length;
  return `<section><div class="card"><div class="topbar"><h2 class="panel-title">履歴</h2>
    <button class="primary small" type="button" data-action="parent-start-dose" ${open ? 'disabled' : ''}>${todayCount ? '同日の新しい服用記録' : '新しい服用記録'}</button></div>
    ${open ? '<p class="notice">記録受付中のセッションがあります。新しい服用記録を作るには、先にそのセッションを閉じてください。</p>' : ''}
    ${state.sessions.length ? monthGroups(state.sessions).map((group, index) => `<details class="month-group" ${index === 0 ? 'open' : ''}>
      <summary>${esc(monthLabel(group.key))}<span class="month-count">${group.sessions.length}回</span></summary>
      ${group.sessions.map(historyItem).join('')}</details>`).join('') : '<p>まだ記録がありません。</p>'}</div></section>`;
}

// 記録が増えても一覧が長くなりすぎないよう、月ごとにまとめて最新の月だけ開く。
function monthGroups(sessions) {
  const groups = [];
  for (const session of sessions) {
    const key = session.localDate.slice(0, 7);
    if (groups.at(-1)?.key !== key) groups.push({ key, sessions: [] });
    groups.at(-1).sessions.push(session);
  }
  return groups;
}

function historyItem(session) {
  const metrics = deriveMetrics(session);
  const open = session.lifecycle === 'open';
  return `<details class="history-item"><summary>${Number(session.localDate.slice(8, 10))}日 ${esc(displayTime(session.doseTimestamp))}
    ${open ? '<span class="badge open">記録受付中</span>' : ''}<span class="badge">${esc(outcomeLabels[metrics.outcome])}</span></summary>
    <div class="history-body">
      <dl class="state-pair">
        <div><dt>記録の受付</dt><dd>${open ? '受付中' : '終了'}</dd></div>
        <div><dt>症状の結果</dt><dd>${esc(outcomeLabels[metrics.outcome])}</dd></div>
      </dl>
      <p><strong>${esc(session.medication.name)} ${esc(session.medication.dose)}</strong><br>
      服用前の心配度: ${session.preDoseWorry === undefined ? '記録なし' : `${session.preDoseWorry} ${esc(severityLabels[session.preDoseWorry])}`}<br>
      最初の症状記録: ${esc(displayDate(metrics.firstRecordedSymptomAt))}<br>最大強度: ${numberOrDash(metrics.maximumSeverity)} / episode: ${metrics.episodeCount}<br>
      症状時間合計: ${metrics.outcome === 'unresolved' ? 'おさまった記録がないため空欄' : numberOrDash(metrics.totalSymptomaticTime, '分')}</p>
      <div id="session-chart-${esc(session.id)}" class="chart-card"></div><hr>
      <div class="button-row">${open
        ? `<button class="secondary" type="button" data-action="close-session" data-id="${esc(session.id)}">セッションを閉じる</button>`
        : `<button class="secondary" type="button" data-action="reopen-session" data-id="${esc(session.id)}">セッションを再開</button>`}
        ${metrics.outcome === 'noSymptomData' ? `<button class="secondary" type="button" data-action="confirm-no-symptom" data-id="${esc(session.id)}">症状なしを確認</button>` : ''}
        <button class="secondary danger" type="button" data-action="delete-session" data-id="${esc(session.id)}">セッションを削除</button></div>
      <h3>症状記録</h3>${session.symptomRecords.length ? session.symptomRecords.map((record) => recordEditor(session, record)).join('') : '<p>記録なし</p>'}
      ${session.lifecycle === 'open' ? `<form class="record-row" data-form="record-add" data-session-id="${esc(session.id)}">
        <label class="field"><span>時刻（空欄なら今）</span><input type="time" name="time"></label>
        <label class="field"><span>強度</span><select name="severity">${[0,1,2,3,4,5].map((value) => `<option>${value}</option>`).join('')}</select></label>
        <div class="record-actions"><button class="secondary" type="submit">記録を追加</button></div></form>` : ''}
      <form data-form="session-edit" data-id="${esc(session.id)}"><div class="form-grid">
        <label class="field"><span>服用前の心配度</span><select name="preDoseWorry">
          <option value="" ${session.preDoseWorry === undefined ? 'selected' : ''}>記録なし</option>
          ${[0,1,2,3,4,5].map((value) => `<option value="${value}" ${session.preDoseWorry === value ? 'selected' : ''}>${value} ${esc(severityLabels[value])}</option>`).join('')}
        </select></label>
        <fieldset class="field full"><legend>体調</legend><div class="button-row">${conditionChecks(session)}</div></fieldset>
        <label class="field full"><span>その他</span><textarea name="conditionOtherText">${esc(sessionFreeText(session))}</textarea></label>
      </div><button class="secondary form-submit" type="submit">セッション情報を保存</button></form>
    </div></details>`;
}

function recordEditor(session, record) {
  // 同じ日の記録は時刻だけで足りる。日をまたいだ記録のときだけ日付を添える。
  const otherDay = record.timestamp.slice(0, 10) !== session.localDate;
  return `<form class="record-row" data-form="record-edit" data-session-id="${esc(session.id)}" data-record-id="${esc(record.id)}">
    <label class="field"><span>時刻${otherDay ? `（${Number(record.timestamp.slice(5, 7))}/${Number(record.timestamp.slice(8, 10))}）` : ''}</span><input type="time" name="time" value="${esc(inputTime(record.timestamp))}" required></label>
    <label class="field"><span>強度</span><select name="severity">${[0,1,2,3,4,5].map((value) => `<option ${record.severity===value?'selected':''}>${value}</option>`).join('')}</select></label>
    <div class="record-actions button-row"><button class="secondary" type="submit">保存</button><button class="secondary danger" type="button" data-action="delete-record" data-session-id="${esc(session.id)}" data-record-id="${esc(record.id)}">削除</button></div>
  </form>`;
}

function conditionChecks(session) {
  const labels = { normal: '普通', cold: '風邪', cough: '咳', fever: '発熱', other: 'その他' };
  return Object.entries(labels).map(([value, label]) => `<label class="check"><input type="checkbox" name="conditions" value="${value}"
    ${(session.conditionCodes || []).includes(value) ? 'checked' : ''}><span>${label}</span></label>`).join('');
}

const dailySymptomLabels = {
  sneezing: 'くしゃみ',
  rhinorrhoea: '鼻水',
  congestion: '鼻づまり',
  nasalItch: '鼻のかゆみ',
  ocularItch: '目のかゆみ・充血',
  wateryEyes: '涙目'
};

// 判定基準がぶれると1年分のデータが比較できなくなるため、入力欄の上に常時表示する
const dailyCriteria = [
  [0, 'なし', '症状を自覚しない'],
  [1, '軽度', '症状はあるが気にならず、日常生活に支障がない'],
  [2, '中等度', '症状が気になるが、日常生活は何とかこなせる'],
  [3, '重度', '症状が耐えがたく、日常生活や睡眠に明らかな支障がある']
];

const medicationLabels = ['使用なし', '抗ヒスタミン薬（飲み薬・点鼻）', '点鼻ステロイド', '飲み薬のステロイド'];

function dailyDayLabel(day, today) {
  const label = `${Number(day.slice(5, 7))}月${Number(day.slice(8, 10))}日`;
  if (day === today) return `${label}（今日）`;
  if (day === shiftDay(today, -1)) return `${label}（昨日）`;
  return label;
}

function renderDaily() {
  const today = localDateToday();
  const day = state.dailyDate || today;
  const stored = state.dailyRecords.find((record) => record.localDate === day);
  const draft = state.dailyDraft?.day === day ? state.dailyDraft.values : null;
  const values = draft || stored || {};
  const scores = dailyScores(values);
  const session = state.sessions.find((item) => item.localDate === day);
  const days = recentDays(today, 14);
  const filled = days.filter((item) => state.dailyRecords.some((record) => record.localDate === item)).length;

  return `<section><div class="card">
    <h2 class="panel-title">日々の記録</h2>
    <p class="privacy">鼻と目の症状を1日1回記録します。服用後ののどの記録（服用の記録）とは別のものです。</p>

    <div class="daily-nav">
      <button class="secondary" type="button" data-action="daily-prev" aria-label="前の日">‹</button>
      <label class="field"><span class="visually-hidden">日付</span>
        <input type="date" data-action="daily-date" value="${esc(day)}" max="${esc(today)}"></label>
      <button class="secondary" type="button" data-action="daily-next" ${day >= today ? 'disabled' : ''} aria-label="次の日">›</button>
    </div>
    <p class="daily-day">${esc(dailyDayLabel(day, today))}</p>

    <div class="daily-strip" role="group" aria-label="直近14日の入力状況">${days.map((item) => {
      const has = state.dailyRecords.some((record) => record.localDate === item);
      return `<button class="strip-day${has ? ' filled' : ''}${item === day ? ' current' : ''}" type="button"
        data-action="daily-pick" data-day="${esc(item)}"
        aria-label="${esc(item)} ${has ? '記録あり' : '記録なし'}">${Number(item.slice(8, 10))}</button>`;
    }).join('')}</div>
    <p class="privacy">直近14日のうち ${filled}日 入力しました。未入力の日を0で埋めることはしません。</p>

    <form data-form="daily" data-day="${esc(day)}">
      <table class="criteria"><caption>0〜3のめやす</caption><tbody>
        ${dailyCriteria.map(([value, name, note]) => `<tr><th scope="row">${value}</th><td>${name}</td><td>${note}</td></tr>`).join('')}
      </tbody></table>

      <div class="daily-grid">${DAILY_SYMPTOM_KEYS.map((key) => `
        <div class="daily-row"><span class="daily-label" id="daily-label-${key}">${esc(dailySymptomLabels[key])}</span>
          <div class="daily-choices" role="group" aria-labelledby="daily-label-${key}">${DAILY_SEVERITIES.map((value) => `
            <label class="daily-choice"><input type="radio" name="${key}" value="${value}" ${values[key] === value ? 'checked' : ''}
              aria-label="${esc(dailySymptomLabels[key])} ${value} ${esc(dailyCriteria[value][1])}"><span>${value}</span></label>`).join('')}
          </div></div>`).join('')}
      </div>

      <fieldset class="field full"><legend>その日に使った薬（いちばん強いもの）</legend>
        <div class="daily-medication">${MEDICATION_CLASSES.map((value) => `
          <label class="daily-choice wide"><input type="radio" name="medicationClass" value="${value}" ${values.medicationClass === value ? 'checked' : ''}>
            <span>${esc(medicationLabels[value])}</span></label>`).join('')}
        </div></fieldset>

      ${session
        ? `<p class="daily-dose">舌下錠: 服用の記録があります（${esc(displayTime(session.doseTimestamp))}）</p>`
        : `<label class="check"><input type="checkbox" name="slitMissed" ${values.slitStatus === 'missed' ? 'checked' : ''}><span>この日は舌下錠を飲まなかった</span></label>
           <p class="privacy">チェックしないときは「記録なし」として扱い、飲み忘れとは区別します。</p>`}

      <details class="extra"><summary>詳しく記録する（任意）</summary>
        <label class="field"><span>その日のつらさ全体（0〜100）</span>
          <input type="number" name="vasGlobal" inputmode="numeric" min="0" max="100" step="1" value="${values.vasGlobal === undefined ? '' : esc(values.vasGlobal)}"></label>
        <label class="field"><span>使った薬の名前</span><input name="medicationsDetail" value="${esc(values.medicationsDetail || '')}"></label>
        <label class="field"><span>メモ</span><textarea name="note">${esc(values.note || '')}</textarea></label>
      </details>

      ${scores.complete ? '<p class="daily-complete">6つの症状と薬の記録がそろっています。</p>' : ''}
      ${stored?.isRetrospective ? '<p class="privacy">この記録は後日入力されたものとして保存されています。</p>' : ''}

      <div class="button-row form-submit">
        <button class="primary small" type="submit">保存</button>
        <button class="secondary" type="button" data-action="daily-copy">前日と同じ</button>
        ${stored ? `<button class="secondary danger" type="button" data-action="daily-delete" data-day="${esc(day)}">この日の記録を削除</button>` : ''}
      </div>
    </form>
  </div></section>`;
}

function setDailyDate(day) {
  if (!day || day > localDateToday()) return;
  state.dailyDate = day;
  state.dailyDraft = null;
  render();
}

// 前日の値は自動では入れない。惰性の入力を避けるため、押したときだけ写す。
function copyPreviousDay() {
  const day = state.dailyDate || localDateToday();
  const previous = state.dailyRecords.find((record) => record.localDate === shiftDay(day, -1));
  if (!previous) { toast('前日の記録がありません。'); return; }
  const values = {};
  for (const key of [...DAILY_SYMPTOM_KEYS, 'medicationClass', 'medicationsDetail']) {
    if (previous[key] !== undefined) values[key] = previous[key];
  }
  state.dailyDraft = { day, values };
  render();
  toast('前日の値を入れました。確認して保存してください。');
}

async function saveDaily(form) {
  const data = new FormData(form);
  const day = form.dataset.day;
  const existing = state.dailyRecords.find((record) => record.localDate === day);
  const record = { ...(existing || createDailyRecord(day)) };
  for (const key of DAILY_SYMPTOM_KEYS) {
    const raw = data.get(key);
    record[key] = raw === null || raw === '' ? undefined : Number(raw);
  }
  const medication = data.get('medicationClass');
  record.medicationClass = medication === null || medication === '' ? undefined : Number(medication);
  const vas = String(data.get('vasGlobal') || '').trim();
  if (vas !== '' && !(Number.isInteger(Number(vas)) && Number(vas) >= 0 && Number(vas) <= 100)) {
    toast('つらさ全体は0〜100の整数で入力してください。');
    return;
  }
  record.vasGlobal = vas === '' ? undefined : Number(vas);
  record.medicationsDetail = String(data.get('medicationsDetail') || '').trim() || undefined;
  record.note = String(data.get('note') || '').trim() || undefined;
  record.slitStatus = data.has('slitMissed') ? 'missed' : undefined;
  record.updatedAt = localIso();
  // 未入力の項目はキーごと消す。0と未入力を混同しないため
  for (const [key, value] of Object.entries(record)) if (value === undefined) delete record[key];

  if (await saveWithFeedback(() => putDailyRecord(record))) {
    state.dailyRecords = await getDailyRecords();
    state.dailyDraft = null;
    toast('記録を保存しました。');
    render();
  }
}

async function removeDailyRecord(day) {
  if (!confirm(`${day} の記録を削除しますか？`)) return;
  if (await saveWithFeedback(() => deleteDailyRecord(day))) {
    state.dailyRecords = await getDailyRecords();
    state.dailyDraft = null;
    toast('削除しました。');
    render();
  }
}

function renderSettings() {
  const s = state.settings;
  return `<section class="card"><h2 class="panel-title">${s.setupComplete ? '設定' : '初回セットアップ'}</h2>
    <form data-form="settings"><div class="form-grid">
      <label class="field"><span>薬剤名</span><input name="medicationName" value="${esc(s.medicationName)}" required></label>
      <label class="field"><span>用量・強度</span><input name="medicationDose" value="${esc(s.medicationDose)}" required></label>
      <label class="field full"><span>記録する症状（ひらがな）</span><input name="symptomLabel" value="${esc(s.childSymptomLabel || s.parentSymptomLabel)}" required>
        <small class="helper">子ども画面の「いま ○○は どんなかんじ？」の○○に入る、短いことばを入力してください。保護者画面にも同じ名前を表示します。</small></label>
      <label class="field"><span>新しいPIN（数字4〜8桁、空欄なら変更なし）</span><input name="parentPin" type="password" inputmode="numeric" pattern="[0-9]{4,8}" autocomplete="new-password"></label>
      <label class="field"><span>緊急連絡先のラベル（任意）</span><input name="emergencyContactLabel" value="${esc(s.emergencyContactLabel)}"></label>
      <label class="field"><span>緊急連絡先の値（任意）</span><input name="emergencyContactValue" value="${esc(s.emergencyContactValue)}"></label>
      <label class="check field full"><input type="checkbox" name="childModeEnabled" ${s.childModeEnabled?'checked':''}><span>子ども画面を使用する</span></label>
      <label class="check field full"><input type="checkbox" name="dailyDiaryEnabled" ${s.dailyDiaryEnabled?'checked':''}><span>「日々の記録」（鼻・目の症状）を使用する</span></label>
      <label class="check field full"><input type="checkbox" name="askPreDoseWorry" ${s.askPreDoseWorry?'checked':''}><span>服用前の心配度を任意で尋ねる</span></label>
      <label class="check field full"><input type="checkbox" name="showResolutionDurationInChildMode" ${s.showResolutionDurationInChildMode?'checked':''}><span>Child Modeの終了時に所要時間を表示する（既定OFF）</span></label>
      <fieldset class="field full"><legend>服用手順のタイマー（任意）</legend>
        <label class="check"><input type="checkbox" name="doseTimerEnabled" ${s.doseTimerEnabled?'checked':''}><span>子ども画面に、服用後の待ち時間を表示する（既定OFF）</span></label>
        <div class="form-grid">
          <label class="field"><span>舌の下に置いておく時間（分）</span><input name="holdMinutes" type="number" inputmode="numeric" min="1" max="30" step="1" value="${esc(s.holdMinutes)}"></label>
          <label class="field"><span>飲み込んだ後、飲食を控える時間（分）</span><input name="waitMinutes" type="number" inputmode="numeric" min="1" max="30" step="1" value="${esc(s.waitMinutes)}"></label>
        </div>
        <small class="helper">処方医の指示や薬の説明書に書かれた時間を入力してください。アプリは入力された時間を計って表示するだけで、服用方法を決めるものではありません。アプリを閉じている間は知らせられません。</small>
      </fieldset>
    </div><p class="privacy">設定変更後も、過去セッションに保存された薬剤名・用量・症状表示名は変わりません。</p>
    <button class="primary small" type="submit">設定を保存</button></form></section>`;
}

function renderData() {
  const preview = state.importPreview;
  return `<section><div class="card"><h2 class="panel-title">データ管理</h2>
    <p class="privacy">記録はこの端末内に保存され、このアプリによってサーバーへ送信されません。端末、ブラウザ、Webサイトデータの削除等により失われることがあります。定期的にバックアップしてください。</p>
    <p><span class="storage-status">端末への保存: ${esc(storageLabel())}</span></p>
    <p class="privacy">${esc(storageHelp())}</p>
    ${state.storageStatus === 'persistent' ? '' : `<p class="privacy">下のボタンを押すと、ブラウザに「この記録を自動で削除しないでほしい」と要求します。端末の空き容量が少ないときに記録が消えるのを防ぎやすくなります。ブラウザが断ることもあります。</p>
      <div class="button-row"><button class="secondary" type="button" data-action="request-persist">記録の自動削除を防ぐ</button></div>`}
    <hr><h3>記録をバックアップする</h3>
    <p>最後にバックアップした日時: ${state.lastBackupAt ? esc(displayDate(state.lastBackupAt)) : 'まだバックアップしていません'}</p>
    <p class="privacy">別の端末へ記録を移すときや、端末を買い替えるときは、このファイルを保存してください。下の「バックアップから記録を戻す」で読み込めます。</p>
    <div class="button-row"><button class="primary small" type="button" data-action="export-backup">記録をバックアップ</button></div>
    <details class="extra"><summary>CSVで書き出す</summary>
      <p class="privacy">バックアップとは別の形式です。ExcelやNumbersで見るためのもので、このファイルから記録を戻すことはできません。</p>
      <div class="button-row"><button class="secondary" type="button" data-action="export-summary">記録の一覧表（CSV）</button>
        <button class="secondary" type="button" data-action="export-series">詳しい経過（CSV）</button></div></details>
    <hr><h3>バックアップから記録を戻す</h3>
    <p class="privacy">読み込むと、<strong>この端末にある記録と設定はすべて置き換わります</strong>。この端末にも残しておきたい記録がある場合は、先に上のバックアップを保存してください。</p>
    <label class="field"><span>保存してあるバックアップファイル</span><input type="file" accept="application/json,.json" data-action="import-file"></label>
    ${preview ? `<div class="notice"><strong>復元前の確認</strong><br>件数: ${preview.sessions.length}<br>期間: ${esc(importPeriod(preview.sessions))}<br>schemaVersion: ${preview.schemaVersion}<br>現在の全データを置換します。</div>
      <button class="secondary" type="button" data-action="confirm-import">確認して全置換</button>` : ''}
    <hr><h3>すべての記録を削除</h3><form data-form="delete-all"><label class="check"><input type="checkbox" name="confirm" required><span>${state.sessions.length}件を削除し、バックアップがなければ復元できないことを確認しました</span></label>
      <label class="field"><span>確認のため「すべて削除」と入力</span><input name="phrase" required></label>
      <button class="secondary danger" type="submit">すべて削除</button></form>
  </div></section>`;
}

function storageLabel() {
  return ({
    checking: '確認中です',
    persistent: '保護を強化しています',
    bestEffort: '通常どおり保存しています',
    unavailable: '保存の保護状態を確認できません',
    denied: '通常どおり保存しています'
  })[state.storageStatus] || '確認できません';
}

function storageHelp() {
  return ({
    checking: '端末内の保存状態を確認しています。',
    persistent: 'この端末では、ブラウザによる記録の自動削除が起こりにくい保存方法を使用しています。それでも定期的なバックアップをおすすめします。',
    bestEffort: '記録はこの端末内に保存されています。ただし、端末の空き容量不足やブラウザデータの削除で失われる可能性があります。',
    unavailable: '記録はこの端末内に保存されますが、このブラウザでは保存を消えにくくできるか確認できません。',
    denied: '保存方法は変更されませんでした。記録は端末内に保存されますので、定期的にバックアップしてください。'
  })[state.storageStatus] || '記録はこの端末内に保存されます。';
}

function renderSafety() {
  return `<section class="card"><h2 class="panel-title">安全について</h2>
    <p class="notice"><strong>このアプリは診断や緊急度判定を行いません。</strong> 症状の強さ0〜5は主観的な量であり、医学的な緊急度とは別です。</p>
    <p>呼吸が苦しい、声が急に変わった、喉が締まる感じ、舌や喉の急な腫れ、強い咳や喘鳴が続く、ぐったりしている等がある場合は、アプリで経過記録を続けず、処方医から指示された緊急時対応に従ってください。</p>
    ${state.settings.emergencyContactValue ? `<p><strong>${esc(state.settings.emergencyContactLabel || '設定された連絡先')}</strong><br>${esc(state.settings.emergencyContactValue)}<br><small>利用者が入力した値です。アプリが検証した公的番号ではありません。</small></p>` : '<p>緊急連絡先は設定されていません。</p>'}
  </section>`;
}

function localDateToday() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;
}

function importPeriod(sessions) {
  if (!sessions.length) return '記録なし';
  const dates = sessions.map((session) => session.localDate).sort();
  return `${dates[0]}〜${dates.at(-1)}`;
}

async function hashPin(pin) {
  const data = new TextEncoder().encode(pin);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function saveWithFeedback(action, child = false, retry = null) {
  try {
    await action();
    state.saveError = false;
    state.retryAction = null;
    return true;
  } catch (error) {
    console.error(error);
    state.saveError = child;
    state.retryAction = retry || action;
    if (!child) toast('保存できませんでした。もう一度お試しください。');
    render();
    return false;
  }
}

async function refreshSessions() {
  const loaded = await getSessions();
  const closed = autoCloseSessions(loaded);
  const changed = closed.filter((session, index) => session !== loaded[index]);
  for (const session of changed) await putSession(session);
  state.sessions = closed;
}

function setUndo(undo) {
  clearTimeout(state.undoTimer);
  state.undo = undo;
  state.undoTimer = setTimeout(() => {
    state.undo = null;
    render();
  }, 30000);
}

function toast(message) {
  toastRegion.innerHTML = `<div class="toast">${esc(message)}</div>`;
  setTimeout(() => { toastRegion.replaceChildren(); }, 3500);
}

function render() {
  syncDayChange();
  state.formDirty = false;
  app.innerHTML = state.mode === 'child' ? renderChild() : state.mode === 'gate' ? renderParentGate() : renderParent();
  if (state.mode === 'parent') mountCharts();
  syncDoseTimer();
}

function mountCharts() {
  if (state.parentTab === 'dashboard') {
    const sessions = [...filteredSessions()].reverse();
    const summary = dashboardSummary(sessions);
    const dated = sessions.map((session, index) => ({ session, metrics: deriveMetrics(session), index }));
    const pointLabel = (item) => `${item.session.localDate.slice(5)}${item.metrics.maximumSeverityIsInferred ? '（症状の記録なし）' : ''}`;
    lineChart(document.querySelector('#duration-chart'), dated.filter((item) => item.metrics.outcome !== 'unresolved').map((item) => ({
      x: item.index, y: item.metrics.totalSymptomaticTime,
      inferred: item.metrics.maximumSeverityIsInferred, label: pointLabel(item)
    })), { ariaLabel: '症状時間合計の推移', emptyText: '表示できる記録がありません。' });
    lineChart(document.querySelector('#maximum-chart'), dated.map((item) => ({
      x: item.index, y: item.metrics.effectiveMaximumSeverity,
      inferred: item.metrics.maximumSeverityIsInferred, label: pointLabel(item)
    })), { yMax: 5, ariaLabel: '最大症状強度の推移' });
    const inferredNote = document.querySelector('#inferred-note');
    if (inferredNote) {
      inferredNote.textContent = summary.inferredCount
        ? `◇ ${summary.inferredCount}件は、服用の記録はあるが症状の記録がない回です。症状はなかったものとして0に置いています。書き出すCSVには推定値を入れず、空欄のままにします。`
        : 'すべての回に症状の記録があります。';
    }
    const worry = dated.filter((item) => item.session.preDoseWorry !== undefined);
    comparisonChart(document.querySelector('#worry-chart'), [
      { name: '心配度', color: '#526b88', dash: '6 4', marker: 'square',
        points: worry.map((item, index) => ({ x: index, y: item.session.preDoseWorry, label: `${item.session.localDate.slice(5)} 心配度` })) },
      { name: '最大強度', color: '#2d6658', marker: 'circle',
        points: worry.map((item, index) => ({ x: index, y: item.metrics.effectiveMaximumSeverity,
          inferred: item.metrics.maximumSeverityIsInferred, label: `${item.session.localDate.slice(5)} 最大強度` })) }
    ], { yMax: 5, ariaLabel: '記録された心配度と最大症状強度の比較', emptyText: `比較できる記録がありません。欠測 ${sessions.length - worry.length}件` });
    const missing = document.querySelector('#worry-missing');
    if (missing) missing.textContent = `欠測 ${sessions.length - worry.length}件。因果関係や評価を示すグラフではありません。`;
  }
  if (state.parentTab === 'history') {
    state.sessions.forEach((session) => {
      const records = [...session.symptomRecords].sort((a,b) => new Date(a.timestamp)-new Date(b.timestamp));
      lineChart(document.querySelector(`#session-chart-${CSS.escape(session.id)}`), records.map((record) => ({
        x: minutesBetween(record.timestamp, session.doseTimestamp), y: record.severity,
        label: `${minutesBetween(record.timestamp, session.doseTimestamp)}分`
      })), { yMax: 5, ariaLabel: `${session.localDate}の個別症状記録`, emptyText: '症状記録がありません。' });
    });
  }
}

app.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  if (action === 'adult-gate') { state.mode = 'gate'; render(); return; }
  if (action === 'back-child') { state.mode = 'child'; render(); return; }
  if (action === 'parent-tab') { state.parentTab = button.dataset.tab; render(); return; }
  if (action === 'select-worry') { state.pendingWorry = Number(button.dataset.value); state.worrySkipped = false; render(); return; }
  if (action === 'skip-worry') { state.pendingWorry = undefined; state.worrySkipped = true; render(); return; }
  if (action === 'focus-severity') { document.querySelector('#severity-card')?.scrollIntoView({ behavior: 'smooth' }); return; }
  if (action === 'start-dose') {
    // 画面ロック防止はタップの直後に要求しておく（端末によっては操作直後でないと取得できないため）
    if (state.settings.doseTimerEnabled) updateWakeLock(true);
    await startDose(true);
    return;
  }
  if (action === 'parent-start-dose') { await startDose(false); return; }
  if (action === 'record-severity') { await recordSeverity(Number(button.dataset.value)); return; }
  if (action === 'undo') { await undoLast(); return; }
  if (action === 'retry-save') { await retrySave(); return; }
  if (action === 'close-session') { await mutateSession(button.dataset.id, (session) => closeSession(session)); return; }
  if (action === 'reopen-session') { await reopenSelected(button.dataset.id); return; }
  if (action === 'confirm-no-symptom') { await mutateSession(button.dataset.id, (session) => confirmNoSymptoms(session)); return; }
  if (action === 'delete-session') { await removeSession(button.dataset.id); return; }
  if (action === 'delete-record') { await removeRecord(button.dataset.sessionId, button.dataset.recordId); return; }
  if (action === 'export-summary') { await exportFile('slit-summary.csv', summaryCsv(state.sessions), 'text/csv;charset=utf-8'); return; }
  if (action === 'export-series') { await exportFile('slit-time-series.csv', timeSeriesCsv(state.sessions), 'text/csv;charset=utf-8'); return; }
  if (action === 'export-backup') { await exportBackup(); return; }
  if (action === 'confirm-import') { await importConfirmed(); return; }
  if (action === 'request-persist') { await requestPersistence(); return; }
  if (action === 'apply-update') { applyUpdate(); return; }
  if (action === 'daily-prev') { setDailyDate(shiftDay(state.dailyDate || localDateToday(), -1)); return; }
  if (action === 'daily-next') { setDailyDate(shiftDay(state.dailyDate || localDateToday(), 1)); return; }
  if (action === 'daily-pick') { setDailyDate(button.dataset.day); return; }
  if (action === 'daily-copy') { copyPreviousDay(); return; }
  if (action === 'daily-delete') { await removeDailyRecord(button.dataset.day); return; }
});

app.addEventListener('change', async (event) => {
  const target = event.target;
  if (target.dataset.action === 'period') { state.period = Number(target.value); render(); return; }
  if (target.dataset.action === 'daily-date') { setDailyDate(target.value); return; }
  if (target.dataset.action === 'import-file') await readImportFile(target.files?.[0]);
});

app.addEventListener('input', (event) => {
  if (state.mode === 'parent' && event.target.closest('form[data-form]')) state.formDirty = true;
});

app.addEventListener('keydown', (event) => {
  // 矢印キーはフォーカス移動のみとする。radio の慣例どおり選択まで行うと、
  // 症状ピッカーでは移動のたびに記録が保存されてしまうため、決定は Enter / Space に限定する。
  const offsets = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
  const offset = offsets[event.key];
  if (!offset) return;
  const radio = event.target.closest('[role="radio"]');
  const group = radio?.closest('[role="radiogroup"]');
  if (!group) return;
  const radios = [...group.querySelectorAll('[role="radio"]')];
  const next = radios[(radios.indexOf(radio) + offset + radios.length) % radios.length];
  radios.forEach((item) => item.setAttribute('tabindex', item === next ? '0' : '-1'));
  next.focus();
  event.preventDefault();
});

app.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target;
  const kind = form.dataset.form;
  if (kind === 'parent-gate') await enterParent(form);
  if (kind === 'settings') await saveSettings(form);
  if (kind === 'record-add') await addRecordFromParent(form);
  if (kind === 'record-edit') await saveRecord(form);
  if (kind === 'session-edit') await saveSessionInfo(form);
  if (kind === 'daily') await saveDaily(form);
  if (kind === 'delete-all') await removeAll(form);
});

async function startDose(child) {
  if (state.sessions.some((session) => session.lifecycle === 'open')) return;
  const worry = child ? state.pendingWorry : undefined;
  const worrySkipped = state.worrySkipped;
  const session = createSession(state.settings, worry);
  const success = await saveWithFeedback(() => putSession(session), child, () => startDose(child));
  if (!success) return;
  state.sessions = [session, ...state.sessions];
  state.pendingWorry = undefined;
  state.worrySkipped = false;
  setUndo({ kind: 'dose', sessionId: session.id, worry, worrySkipped });
  render();
}

async function recordSeverity(severity) {
  const current = state.sessions.find((session) => session.lifecycle === 'open');
  if (!current || shouldAutoClose(current)) {
    await refreshSessions();
    render();
    toast('きろくの うけつけは おわったよ。おとなと みてね');
    return;
  }
  const updated = addSymptomRecord(current, severity);
  const success = await saveWithFeedback(() => putSession(updated), true, () => recordSeverity(severity));
  if (!success) return;
  state.sessions = state.sessions.map((session) => session.id === current.id ? updated : session);
  setUndo({ kind: 'record', sessionId: current.id, previous: current });
  render();
}

async function undoLast() {
  const undo = state.undo;
  if (!undo) return;
  let success;
  if (undo.kind === 'dose') success = await saveWithFeedback(() => deleteSession(undo.sessionId), true);
  else success = await saveWithFeedback(() => putSession(undo.previous), true);
  if (!success) return;
  if (undo.kind === 'dose') {
    state.pendingWorry = undo.worry;
    state.worrySkipped = undo.worrySkipped;
  }
  state.undo = null;
  clearTimeout(state.undoTimer);
  await refreshSessions();
  render();
}

async function retrySave() {
  const retry = state.retryAction;
  if (!retry) return;
  state.retryAction = null;
  state.saveError = false;
  await retry();
  render();
}

async function mutateSession(id, transform) {
  const current = state.sessions.find((session) => session.id === id);
  if (!current) return;
  try {
    const updated = transform(current);
    if (updated.lifecycle === 'open' && state.sessions.some((session) => session.id !== id && session.lifecycle === 'open')) {
      toast('別の記録受付中セッションがあります。'); return;
    }
    if (await saveWithFeedback(() => putSession(updated))) {
      state.sessions = state.sessions.map((session) => session.id === id ? updated : session);
      render();
    }
  } catch (error) { toast(error.message === 'positive_records_exist' ? '症状記録があるため「症状なし」にはできません。' : '操作できませんでした。'); }
}

async function reopenSelected(id) {
  await mutateSession(id, reopenSession);
}

async function removeSession(id) {
  if (!confirm('このセッションを削除しますか？この操作はバックアップなしでは元に戻せません。')) return;
  if (await saveWithFeedback(() => deleteSession(id))) {
    state.sessions = state.sessions.filter((session) => session.id !== id);
    render();
  }
}

async function removeRecord(sessionId, recordId) {
  if (!confirm('この症状記録を削除しますか？')) return;
  await mutateSession(sessionId, (session) => deleteSymptomRecord(session, recordId));
}

async function enterParent(form) {
  const data = new FormData(form);
  if (state.settings.parentPinHash) {
    const hash = await hashPin(data.get('pin') || '');
    if (hash !== state.settings.parentPinHash) { toast('PINが違います。'); return; }
  }
  state.mode = 'parent';
  state.parentTab = state.settings.setupComplete ? 'dashboard' : 'settings';
  render();
}

async function saveSettings(form) {
  const data = new FormData(form);
  const childLabel = String(data.get('symptomLabel') || '').trim();
  if (!/^[ぁ-ゖー\s]+$/u.test(childLabel)) { toast('記録する症状はひらがなで入力してください。'); return; }
  const pin = String(data.get('parentPin') || '');
  const doseTimerEnabled = data.has('doseTimerEnabled');
  const holdMinutes = String(data.get('holdMinutes') || '').trim();
  const waitMinutes = String(data.get('waitMinutes') || '').trim();
  if (doseTimerEnabled && !(isValidTimerMinutes(holdMinutes) && isValidTimerMinutes(waitMinutes))) {
    toast('服用手順のタイマーを使う場合は、2つの時間を1〜30分の整数で入力してください。');
    return;
  }
  const settings = {
    ...state.settings,
    medicationName: String(data.get('medicationName')).trim(),
    medicationDose: String(data.get('medicationDose')).trim(),
    symptomTypeCode: state.settings.symptomTypeCode || 'symptom',
    parentSymptomLabel: childLabel,
    childSymptomLabel: childLabel,
    childModeEnabled: data.has('childModeEnabled'),
    dailyDiaryEnabled: data.has('dailyDiaryEnabled'),
    askPreDoseWorry: data.has('askPreDoseWorry'),
    showResolutionDurationInChildMode: data.has('showResolutionDurationInChildMode'),
    doseTimerEnabled,
    holdMinutes: holdMinutes === '' ? '' : Number(holdMinutes),
    waitMinutes: waitMinutes === '' ? '' : Number(waitMinutes),
    emergencyContactLabel: String(data.get('emergencyContactLabel') || '').trim(),
    emergencyContactValue: String(data.get('emergencyContactValue') || '').trim(),
    setupComplete: true,
    ...(pin ? { parentPinHash: await hashPin(pin) } : {})
  };
  if (!validateSettings(settings)) { toast('必須項目を入力してください。'); return; }
  if (await saveWithFeedback(() => putSettings(settings))) {
    state.settings = settings;
    toast('設定を保存しました。');
    render();
  }
}

async function saveRecord(form) {
  const data = new FormData(form);
  const time = String(data.get('time') || '');
  if (!/^\d{1,2}:\d{2}$/.test(time)) { toast('時刻が正しくありません。'); return; }
  const record = state.sessions.find((session) => session.id === form.dataset.sessionId)
    ?.symptomRecords.find((item) => item.id === form.dataset.recordId);
  if (!record) return;
  await mutateSession(form.dataset.sessionId, (session) => updateSymptomRecord(session, form.dataset.recordId, {
    timestamp: replaceTime(record.timestamp, time), severity: Number(data.get('severity'))
  }));
}

async function addRecordFromParent(form) {
  const data = new FormData(form);
  const time = String(data.get('time') || '');
  const date = new Date();
  if (time) {
    if (!/^\d{1,2}:\d{2}$/.test(time)) { toast('時刻が正しくありません。'); return; }
    const [hours, minutes] = time.split(':');
    date.setHours(Number(hours), Number(minutes), 0, 0);
  }
  await mutateSession(form.dataset.sessionId, (session) => addSymptomRecord(session, Number(data.get('severity')), date));
}

async function saveSessionInfo(form) {
  const data = new FormData(form);
  const worry = String(data.get('preDoseWorry') ?? '');
  await mutateSession(form.dataset.id, (session) => {
    const updated = {
      ...session,
      // 自由記述は「その他」に一本化する。旧メモは表示時に統合済みなのでここで空にする。
      notes: '',
      conditionCodes: data.getAll('conditions'),
      conditionOtherText: String(data.get('conditionOtherText') || ''),
      updatedAt: localIso()
    };
    // 未入力の心配度と0を区別するため、記録なしのときはキーごと消す。
    if (worry === '') delete updated.preDoseWorry;
    else updated.preDoseWorry = Number(worry);
    return updated;
  });
  toast('セッション情報を保存しました。');
}

// iOS / iPadOS ではダウンロードの導線が分かりにくいため共有シートを第一手段とする。
// デスクトップの Chrome 等も canShare({files}) が true を返すことがあるが、そこで
// 共有APIを使うと何も起きずに終わるため、プラットフォーム判定と併用する（§17.1）。
function isAppleTouchDevice() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function downloadFile(file, name) {
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function exportFile(name, content, type) {
  const file = new File([content], name, { type });
  if (isAppleTouchDevice() && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      return true;
    } catch (error) {
      if (error.name === 'AbortError') return false;
      console.warn('Web Share failed, falling back to download', error);
    }
  }
  try {
    downloadFile(file, name);
    toast(`${name} を書き出しました。保存先を確認してください。`);
    return true;
  } catch (error) {
    console.error(error);
    toast('ファイルを保存できませんでした。もう一度お試しいただくか、別のブラウザでお試しください。');
    return false;
  }
}

async function exportBackup() {
  const saved = await exportFile(`slit-backup-${localDateToday()}.json`, backupJson(state.sessions, state.settings, state.dailyRecords), 'application/json');
  if (!saved) return;
  const timestamp = new Date().toISOString();
  await putMeta('lastBackupAt', timestamp);
  state.lastBackupAt = timestamp;
  render();
}

async function readImportFile(file) {
  if (!file) return;
  try {
    state.importPreview = validateBackup(JSON.parse(await file.text()));
    render();
  } catch (error) { state.importPreview = null; toast(error.message); }
}

async function importConfirmed() {
  if (!state.importPreview) return;
  if (!confirm('現在の全データを置換します。実行前のバックアップを保存しましたか？')) return;
  const preview = state.importPreview;
  if (await saveWithFeedback(() => replaceAllData(preview.sessions, { ...DEFAULT_SETTINGS, ...preview.settings }, preview.dailyRecords))) {
    state.importPreview = null;
    state.settings = { ...DEFAULT_SETTINGS, ...preview.settings };
    state.dailyRecords = await getDailyRecords();
    await refreshSessions();
    toast('バックアップを復元しました。');
    render();
  }
}

async function removeAll(form) {
  const data = new FormData(form);
  if (data.get('phrase') !== 'すべて削除') { toast('確認語句が一致しません。'); return; }
  if (!confirm(`${state.sessions.length}件を完全に削除しますか？`)) return;
  const count = state.sessions.length;
  if (await saveWithFeedback(deleteAllData)) {
    state.sessions = [];
    state.settings = { ...DEFAULT_SETTINGS };
    state.lastBackupAt = null;
    toast(`${count}件を削除しました。`);
    state.parentTab = 'settings';
    render();
  }
}

async function checkPersistence() {
  if (!navigator.storage?.persisted) { state.storageStatus = 'unavailable'; return; }
  state.storageStatus = await navigator.storage.persisted() ? 'persistent' : 'bestEffort';
}

async function requestPersistence() {
  if (!navigator.storage?.persist) { state.storageStatus = 'unavailable'; render(); return; }
  const granted = await navigator.storage.persist();
  state.storageStatus = granted ? 'persistent' : 'denied';
  render();
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.register('./sw.js');
    state.swRegistration = registration;
    // 新しい版が待機したままにならないよう、起動時に更新の有無を確認する
    registration.update().catch(() => {});
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (state.reloadingForUpdate) return;
      state.reloadingForUpdate = true;
      location.reload();
    });
    const noteWaiting = () => {
      // 初回インストールでも一瞬 waiting を通るため、既に前の版が動いている場合だけ更新とみなす。
      // controller が無いページ（初回読み込み）で通知を出すと、新規なのに更新扱いになってしまう。
      if (!registration.waiting || !navigator.serviceWorker.controller || state.updateWaiting) return;
      state.updateWaiting = true;
      render();
    };
    noteWaiting();
    registration.addEventListener('updatefound', () => {
      registration.installing?.addEventListener('statechange', noteWaiting);
    });
  } catch (error) { console.warn('Service Worker registration failed', error); }
}

// 待機中の新しい版へ、利用者の操作で切り替える。押されるまで古い版のまま動かす。
function applyUpdate() {
  const waiting = state.swRegistration?.waiting;
  if (!waiting) {
    toast('更新の準備ができていません。アプリを閉じて開き直してください。');
    return;
  }
  toast('更新しています…');
  waiting.postMessage({ type: 'SKIP_WAITING' });
}

async function boot() {
  try {
    [state.settings, state.lastBackupAt, state.dailyRecords] = await Promise.all([
      getSettings(), getMeta('lastBackupAt'), getDailyRecords()
    ]);
    await refreshSessions();
    await checkPersistence();
    render();
    await registerServiceWorker();
  } catch (error) {
    console.error(error);
    app.innerHTML = `<div class="shell child-shell"><section class="card error-card" role="alert"><h1 class="child-title">きろくを ひらけなかったみたい</h1><p>おとなを よんでね</p><button class="secondary" type="button" onclick="location.reload()">もういちど</button></section></div>`;
  }
}

document.addEventListener('visibilitychange', async () => {
  if (document.hidden) return;
  // 戻ってきたときにも新しい版の有無を確認する
  state.swRegistration?.update().catch(() => {});
  await refreshSessions();
  if (state.mode === 'parent' && state.formDirty) return;
  render();
});

setInterval(async () => {
  const openIds = new Set(state.sessions.filter((session) => session.lifecycle === 'open').map((session) => session.id));
  if (!openIds.size) return;
  await refreshSessions();
  if (state.mode === 'parent' && state.formDirty) return;
  if (state.sessions.some((session) => openIds.has(session.id) && session.lifecycle === 'closed')) render();
}, 60000);

boot();
