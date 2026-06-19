(() => {
  'use strict';

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));

  const screens = {
    home: $('#screenHome'),
    quiz: $('#screenQuiz'),
    result: $('#screenResult'),
    history: $('#screenHistory'),
    about: $('#screenAbout'),
  };

  const modePlans = {
    mini:   { label: 'ミニ確認', total: 5,  quotas: { '防犯': 1, '地震': 1, '火災': 2, '洪水': 1 }, hardQuotas: {} },
    // v13: 「高難度」「専門・複合」は独立モードではなく、通常/しっかり/ランダム模試へ統合する。
    normal: { label: '通常訓練', total: 10, quotas: { '防犯': 2, '地震': 3, '火災': 3, '洪水': 2 }, hardQuotas: { '防犯': 1, '地震': 1, '火災': 1, '洪水': 1 } },
    full:   { label: 'しっかり訓練', total: 20, quotas: { '防犯': 5, '地震': 5, '火災': 5, '洪水': 5 }, hardQuotas: { '防犯': 2, '地震': 2, '火災': 2, '洪水': 2 } },
    mock:   { label: 'ランダム模試', total: 30, quotas: { '防犯': 7, '地震': 8, '火災': 8, '洪水': 7 }, hardQuotas: { '防犯': 3, '地震': 3, '火災': 3, '洪水': 3 } },
  };

  const audienceText = {
    user: {
      label: '利用者向け',
      help: '本人が安全な行動を選ぶ練習です。',
    },
    staff: {
      label: '職員向け',
      help: '初動、通報、避難誘導、点呼、記録を判断する訓練です。',
    },
  };

  const state = {
    audience: 'user',
    mode: 'normal',
    questions: [],
    current: 0,
    answers: [],
    startedAt: 0,
    elapsedTimer: null,
  };

  const letters = ['A', 'B', 'C', 'D'];

  function showScreen(name) {
    Object.values(screens).forEach((screen) => screen.classList.remove('active'));
    screens[name].classList.add('active');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function shuffle(array) {
    const result = [...array];
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }

  function getPool() {
    return state.audience === 'staff' ? (window.STAFF_QUESTIONS || []) : (window.USER_QUESTIONS || []);
  }

  function normalizeText(value) {
    return String(value || '')
      .replace(/[\s　]+/g, ' ')
      .replace(/[「」]/g, '『')
      .replace(/[“”]/g, '"')
      .trim();
  }

  function contentKey(q) {
    // v9: 保存用の代表キー。
    // problemKeyはID体系の確認に使うが、本文が同じ別IDを弾くため、
    // 出題抽選では identityKeys() による複数キー判定を使う。
    return q.problemKey ? `problemKey:${normalizeText(q.problemKey)}` : `id:${normalizeText(q.id)}`;
  }

  function questionTextKey(q) {
    return `question:${normalizeText(q.question)}`;
  }

  function contextTextKey(q) {
    return `context:${normalizeText(q.category)}::${normalizeText(q.situation)}::${normalizeText(q.question)}`;
  }

  function identityKeys(q) {
    const keys = [];
    if (q.id) keys.push(`id:${normalizeText(q.id)}`);
    if (q.problemKey) keys.push(`problemKey:${normalizeText(q.problemKey)}`);
    keys.push(questionTextKey(q));
    keys.push(contextTextKey(q));
    return keys;
  }

  function addIdentityKeys(q, set) {
    identityKeys(q).forEach((key) => set.add(key));
  }

  function hasIdentityKey(q, set) {
    return identityKeys(q).some((key) => set.has(key));
  }

  function allValidIdentityKeys(pool) {
    const keys = new Set();
    pool.forEach((q) => addIdentityKeys(q, keys));
    return keys;
  }

  function recentIds() {
    try {
      const history = JSON.parse(localStorage.getItem('trainingHistory') || '[]');
      return new Set(history.slice(0, 20).flatMap((item) => item.questionIds || []));
    } catch (error) {
      return new Set();
    }
  }

  function recentContentKeys(pool) {
    const byId = new Map(pool.map((q) => [q.id, q]));
    const keys = new Set();
    try {
      const history = JSON.parse(localStorage.getItem('trainingHistory') || '[]');
      history.slice(0, 20).forEach((item) => {
        (item.questionKeys || []).forEach((key) => keys.add(key));
        (item.questionIds || []).forEach((id) => {
          const q = byId.get(id);
          if (q) addIdentityKeys(q, keys);
        });
      });
    } catch (error) {
      // ignore broken history
    }
    return keys;
  }

  function uniqueQuestions(pool) {
    const map = new Map();
    pool.forEach((q) => {
      if (q && q.id && !map.has(q.id)) map.set(q.id, q);
    });
    return Array.from(map.values());
  }

  function isHardQuestion(q) {
    return Number(q.difficulty || 1) >= 8 || ['advanced', 'professional'].includes(q.level);
  }

  function randomizeChoiceOrder(q) {
    // v9: 正解位置の偏りを消す。データ上の位置に関係なく、出題時に毎回並び替える。
    const pairs = q.choices.map((text, index) => ({ text, index }));
    const mixed = shuffle(pairs);
    return {
      ...q,
      choices: mixed.map((item) => item.text),
      answer: mixed.findIndex((item) => item.index === q.answer),
      originalAnswer: q.answer,
    };
  }

  function cycleKey() {
    // modeごとに対象プールが違うため、一巡管理もmode別にする。
    return `questionCycleSeenKeys:${state.audience}:${state.mode}`;
  }

  function legacyCycleKey() {
    return `questionCycleSeen:${state.audience}`;
  }

  function loadCycleSeen(pool) {
    const validKeys = allValidIdentityKeys(pool);
    try {
      const keys = JSON.parse(localStorage.getItem(cycleKey()) || '[]');
      return new Set(keys.filter((key) => validKeys.has(key)));
    } catch (error) {
      return new Set();
    }
  }

  function saveCycleSeen(seen, pool) {
    const validKeys = allValidIdentityKeys(pool);
    const keys = Array.from(seen).filter((key) => validKeys.has(key));
    localStorage.setItem(cycleKey(), JSON.stringify(keys));
  }

  function questionPoolForMode() {
    const basePool = uniqueQuestions(getPool());
    // v13: 高難度/専門・複合問題は独立抽選せず、通常/しっかり/ランダム模試へ統合する。
    // ミニ確認だけは導入用として難度5以下に限定する。
    if (state.mode === 'mini') return basePool.filter((q) => Number(q.difficulty || 1) <= 5);
    return basePool;
  }

  function selectFromCandidates(candidates, count, selectedIds, selectedKeys, recent, recentKeys) {
    if (count <= 0 || !candidates.length) return [];
    const clean = candidates.filter((q) => !selectedIds.has(q.id) && !hasIdentityKey(q, selectedKeys));
    if (!clean.length) return [];

    // 直近の履歴に出たID・problemKey・本文・状況込み本文は、可能なら避ける。
    const preferred = clean.filter((q) => !recent.has(q.id) && !hasIdentityKey(q, recentKeys));
    const source = preferred.length >= count ? preferred : clean;
    const picked = [];
    for (const q of shuffle(source)) {
      if (selectedIds.has(q.id) || hasIdentityKey(q, selectedKeys)) continue;
      picked.push(q);
      selectedIds.add(q.id);
      addIdentityKeys(q, selectedKeys);
      if (picked.length >= count) break;
    }
    return picked;
  }

  function drawQuestions() {
    const plan = modePlans[state.mode];
    const pool = questionPoolForMode();
    const recent = recentIds();
    const recentKeys = recentContentKeys(pool);
    let cycleSeen = loadCycleSeen(pool);
    let selected = [];
    const selectedIds = new Set();
    const selectedKeys = new Set();

    const availableFresh = (category = null) => pool.filter((q) => {
      if (category && q.category !== category) return false;
      return !hasIdentityKey(q, cycleSeen) && !selectedIds.has(q.id) && !hasIdentityKey(q, selectedKeys);
    });

    // 1) まず、同一モードの「未出題の問題文」だけから選ぶ。
    // v13: 通常・しっかり・ランダム模試に、カテゴリごとの高難度/専門複合枠を統合して混ぜる。
    for (const [category, count] of Object.entries(plan.quotas)) {
      const hardCount = Math.min(plan.hardQuotas?.[category] || 0, count);
      const hardPicked = hardCount > 0
        ? selectFromCandidates(
            availableFresh(category).filter(isHardQuestion),
            hardCount,
            selectedIds,
            selectedKeys,
            recent,
            recentKeys
          )
        : [];
      selected.push(...hardPicked);

      const remaining = count - hardPicked.length;
      const picked = selectFromCandidates(
        availableFresh(category),
        remaining,
        selectedIds,
        selectedKeys,
        recent,
        recentKeys
      );
      selected.push(...picked);
    }

    // 2) カテゴリ不足分は、他カテゴリの未出題問題文から補完する。
    if (selected.length < plan.total) {
      selected.push(...selectFromCandidates(
        availableFresh(),
        plan.total - selected.length,
        selectedIds,
        selectedKeys,
        recent,
        recentKeys
      ));
    }

    // 3) 未出題問題文が足りない場合だけ、新しい一巡を開始する。
    //    ただし、同じテスト内では同一ID・同一問題文は絶対に出さない。
    if (selected.length < plan.total) {
      cycleSeen = new Set();
      const newCyclePool = pool.filter((q) => !selectedIds.has(q.id) && !hasIdentityKey(q, selectedKeys));
      selected.push(...selectFromCandidates(
        newCyclePool,
        plan.total - selected.length,
        selectedIds,
        selectedKeys,
        recent,
        recentKeys
      ));
    }

    // 4) それでも足りない場合だけ、直近履歴は無視する。
    //    ただし、同一テスト中の重複は最後まで禁止する。
    if (selected.length < plan.total) {
      const fallback = pool.filter((q) => !selectedIds.has(q.id) && !hasIdentityKey(q, selectedKeys));
      selected.push(...selectFromCandidates(
        fallback,
        plan.total - selected.length,
        selectedIds,
        selectedKeys,
        new Set(),
        new Set()
      ));
    }

    const finalQuestions = shuffle(selected).slice(0, plan.total);

    // 念のため、最終段階でも同一ID・同一problemKey・同一問題文・同一状況込み本文を除去する。
    const finalKeys = new Set();
    const deduped = [];
    finalQuestions.forEach((q) => {
      if (hasIdentityKey(q, finalKeys)) return;
      deduped.push(q);
      addIdentityKeys(q, finalKeys);
    });

    // 通常はここで不足しない。もし不足した場合は、同一テスト中の重複なしで可能な限り補完する。
    if (deduped.length < plan.total) {
      for (const q of shuffle(pool)) {
        if (deduped.length >= plan.total) break;
        if (hasIdentityKey(q, finalKeys)) continue;
        deduped.push(q);
        addIdentityKeys(q, finalKeys);
      }
    }

    const result = deduped.slice(0, plan.total);
    result.forEach((q) => addIdentityKeys(q, cycleSeen));
    saveCycleSeen(cycleSeen, pool);
    return result.map(randomizeChoiceOrder);
  }

  function startQuiz(mode) {
    state.mode = modePlans[mode] ? mode : 'normal';
    state.questions = drawQuestions();
    if (!state.questions.length) {
      alert('このモードで出題できる問題がありません。問題データを確認してください。');
      return;
    }
    state.current = 0;
    state.answers = [];
    state.startedAt = Date.now();
    clearInterval(state.elapsedTimer);
    state.elapsedTimer = setInterval(updateTimer, 1000);
    updateTimer();
    $('#quizModeLabel').textContent = `${audienceText[state.audience].label} / ${modePlans[state.mode].label}`;
    showScreen('quiz');
    renderQuestion();
  }

  function updateTimer() {
    if (!state.startedAt) return;
    const sec = Math.floor((Date.now() - state.startedAt) / 1000);
    const mm = String(Math.floor(sec / 60)).padStart(2, '0');
    const ss = String(sec % 60).padStart(2, '0');
    $('#timerLabel').textContent = `${mm}:${ss}`;
  }

  function renderQuestion() {
    const q = state.questions[state.current];
    if (!q) return finishQuiz();

    $('#feedbackCard').classList.add('hidden');
    $('#progressLabel').textContent = `${state.current + 1} / ${state.questions.length}`;
    $('#progressFill').style.width = `${(state.current / state.questions.length) * 100}%`;
    $('#categoryChip').textContent = q.category;
    $('#situationChip').textContent = q.situation;
    $('#difficultyChip').textContent = `難度 ${q.difficulty}`;
    $('#questionText').textContent = q.question;

    const choices = $('#choices');
    choices.innerHTML = '';
    q.choices.forEach((choice, index) => {
      const button = document.createElement('button');
      button.className = 'choice';
      button.type = 'button';
      button.innerHTML = `<strong>${letters[index]}</strong><span>${escapeHtml(choice)}</span>`;
      button.addEventListener('click', () => selectAnswer(index));
      choices.appendChild(button);
    });
  }

  function selectAnswer(index) {
    const q = state.questions[state.current];
    const correct = index === q.answer;
    const answerRecord = {
      id: q.id,
      category: q.category,
      situation: q.situation,
      trap: q.trap,
      skills: q.skills || [],
      correct,
      selected: index,
      answer: q.answer,
    };
    state.answers.push(answerRecord);

    $$('.choice').forEach((button, i) => {
      button.disabled = true;
      if (i === q.answer) button.classList.add('correct');
      if (i === index && !correct) button.classList.add('incorrect');
    });

    $('#feedbackTitle').textContent = correct ? '正解' : `不正解：正解は ${letters[q.answer]}`;
    $('#feedbackReason').textContent = q.reason;
    $('#feedbackCard').classList.toggle('correct', correct);
    $('#feedbackCard').classList.toggle('incorrect', !correct);
    $('#feedbackCard').classList.remove('hidden');

    const tagArea = $('#feedbackTags');
    tagArea.innerHTML = '';
    [q.trap, ...(q.skills || [])].filter(Boolean).forEach((tag) => {
      const span = document.createElement('span');
      span.className = 'tag';
      span.textContent = tag;
      tagArea.appendChild(span);
    });
  }

  function finishQuiz() {
    clearInterval(state.elapsedTimer);
    $('#progressFill').style.width = '100%';
    const result = buildResult();
    saveResult(result);
    renderResult(result);
    showScreen('result');
  }

  function buildResult() {
    const total = state.answers.length;
    const correct = state.answers.filter((a) => a.correct).length;
    const elapsedSec = Math.floor((Date.now() - state.startedAt) / 1000);
    const byCategory = aggregateBy('category');
    const byTrap = aggregateMistakesBy('trap');
    return {
      id: `result_${Date.now()}`,
      date: new Date().toISOString(),
      audience: state.audience,
      mode: state.mode,
      modeLabel: modePlans[state.mode].label,
      audienceLabel: audienceText[state.audience].label,
      total,
      correct,
      percent: total ? Math.round((correct / total) * 100) : 0,
      elapsedSec,
      byCategory,
      byTrap,
      questionIds: state.questions.map((q) => q.id),
      questionKeys: state.questions.flatMap((q) => identityKeys(q)),
    };
  }

  function aggregateBy(key) {
    const map = {};
    state.answers.forEach((a) => {
      const k = a[key] || '不明';
      if (!map[k]) map[k] = { total: 0, correct: 0 };
      map[k].total += 1;
      if (a.correct) map[k].correct += 1;
    });
    return map;
  }

  function aggregateMistakesBy(key) {
    const map = {};
    state.answers.filter((a) => !a.correct).forEach((a) => {
      const k = a[key] || 'その他';
      map[k] = (map[k] || 0) + 1;
    });
    return map;
  }

  function renderResult(result) {
    const mm = Math.floor(result.elapsedSec / 60);
    const ss = String(result.elapsedSec % 60).padStart(2, '0');
    $('#resultTitle').textContent = `${result.audienceLabel}：${result.correct} / ${result.total}問 正解`;
    $('#resultSummary').textContent = result.audience === 'staff'
      ? '初動、通報、誘導、記録の判断傾向を確認してください。'
      : '点数よりも、安全な行動が選べたかを確認してください。';

    $('#scoreBlocks').innerHTML = [
      ['正答率', `${result.percent}%`],
      ['所要時間', `${mm}:${ss}`],
      ['モード', result.modeLabel],
    ].map(([label, value]) => `<div class="score-block"><span>${label}</span><b>${value}</b></div>`).join('');

    $('#categoryStats').innerHTML = renderCategoryStats(result.byCategory);
    $('#trapStats').innerHTML = renderTrapStats(result.byTrap);
    renderRecommendations(result);
  }

  function renderCategoryStats(byCategory) {
    const categories = ['防犯', '地震', '火災', '洪水'];
    return categories.map((category) => {
      const stat = byCategory[category] || { total: 0, correct: 0 };
      const percent = stat.total ? Math.round((stat.correct / stat.total) * 100) : 0;
      return `<div class="stat-row">
        <div class="stat-label"><span>${category}</span><b>${stat.correct}/${stat.total} (${percent}%)</b></div>
        <div class="bar"><div style="width:${percent}%"></div></div>
      </div>`;
    }).join('');
  }

  function renderTrapStats(byTrap) {
    const entries = Object.entries(byTrap).sort((a, b) => b[1] - a[1]);
    if (!entries.length) return '<p class="muted">大きな誤答傾向はありません。</p>';
    return entries.map(([trap, count]) => `<div class="stat-row"><div class="stat-label"><span>${trap}</span><b>${count}回</b></div></div>`).join('');
  }

  function renderRecommendations(result) {
    const list = $('#recommendations');
    list.innerHTML = '';
    const recs = [];
    const weakCategories = Object.entries(result.byCategory)
      .map(([category, stat]) => ({ category, rate: stat.total ? stat.correct / stat.total : 1 }))
      .filter((item) => item.rate < 0.75)
      .sort((a, b) => a.rate - b.rate);

    if (weakCategories.length) {
      recs.push(`${weakCategories[0].category}の判断を重点的に練習する。`);
    }
    const topTrap = Object.entries(result.byTrap).sort((a, b) => b[1] - a[1])[0];
    if (topTrap) {
      recs.push(`「${topTrap[0]}」の誤答が出ているため、実際の場面で確認する。`);
    }
    if (result.audience === 'staff') {
      recs.push('訓練後は、連絡先・避難場所・点呼方法・記録様式を確認する。');
      recs.push('応援職員でも動けるよう、ホーム固有ルールを短く共有する。');
    } else {
      recs.push('玄関、避難経路、集合場所、連絡カードを実物で確認する。');
      recs.push('間違えた問題は、責めずに「次はどうするか」を一緒に確認する。');
    }
    recs.slice(0, 4).forEach((rec) => {
      const li = document.createElement('li');
      li.textContent = rec;
      list.appendChild(li);
    });
  }

  function saveResult(result) {
    try {
      const history = JSON.parse(localStorage.getItem('trainingHistory') || '[]');
      history.unshift(result);
      localStorage.setItem('trainingHistory', JSON.stringify(history.slice(0, 50)));
    } catch (error) {
      console.warn('Could not save history', error);
    }
  }

  function renderHistory() {
    const container = $('#historyList');
    let history = [];
    try {
      history = JSON.parse(localStorage.getItem('trainingHistory') || '[]');
    } catch (error) {
      history = [];
    }
    if (!history.length) {
      container.innerHTML = '<p class="muted">まだ履歴はありません。</p>';
      return;
    }
    container.innerHTML = history.map((item) => {
      const date = new Date(item.date).toLocaleString('ja-JP');
      return `<div class="history-item">
        <b>${escapeHtml(item.audienceLabel)} / ${escapeHtml(item.modeLabel)} / ${item.percent}%</b><br>
        <span class="muted">${date}　${item.correct}/${item.total}問</span>
      </div>`;
    }).join('');
  }

  function escapeHtml(str) {
    return String(str)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function bindEvents() {
    $$('.segment').forEach((button) => {
      button.addEventListener('click', () => {
        state.audience = button.dataset.audience;
        $$('.segment').forEach((b) => b.classList.toggle('active', b === button));
        $('#audienceHelp').textContent = audienceText[state.audience].help;
      });
    });

    $$('.mode-button').forEach((button) => {
      button.addEventListener('click', () => startQuiz(button.dataset.mode));
    });

    $('#nextQuestion').addEventListener('click', () => {
      state.current += 1;
      if (state.current >= state.questions.length) finishQuiz();
      else renderQuestion();
    });

    $('#retrySame').addEventListener('click', () => startQuiz(state.mode));
    $('#backHome').addEventListener('click', () => showScreen('home'));
    $('#showHistory').addEventListener('click', () => { renderHistory(); showScreen('history'); });
    $('#showAbout').addEventListener('click', () => showScreen('about'));
    $$('.backToHome').forEach((button) => button.addEventListener('click', () => showScreen('home')));
    $('#clearHistory').addEventListener('click', () => {
      if (confirm('この端末の履歴を削除しますか？')) {
        localStorage.removeItem('trainingHistory');
        localStorage.removeItem('questionCycleSeen:user');
        localStorage.removeItem('questionCycleSeen:staff');
        Object.keys(localStorage)
          .filter((key) => key.startsWith('questionCycleSeenKeys:'))
          .forEach((key) => localStorage.removeItem(key));
        renderHistory();
      }
    });
  }

  function setupPwa() {
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('./service-worker.js').catch(() => {});
      });
    }
    let deferredPrompt = null;
    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault();
      deferredPrompt = event;
      $('#installButton').classList.remove('hidden');
    });
    $('#installButton').addEventListener('click', async () => {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      deferredPrompt = null;
      $('#installButton').classList.add('hidden');
    });
  }

  bindEvents();
  setupPwa();
})();
