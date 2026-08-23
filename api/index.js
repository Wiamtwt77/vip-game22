export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const { action } = req.body;

  // ------------------------------------------------------------------
  // أدوات مساعدة
  // ------------------------------------------------------------------

  // اختيار عشوائي مرجَّح: كل ما زادت سمعة اللاعب، زاد احتمال اختياره
  // (يُستخدم لمعاقبة صاحب أعلى سمعة تلقائياً بدون احتكار)
  function weightedPickByReputation(players, excludeIdx = null) {
    const pool = players
      .map((p, idx) => ({ p, idx }))
      .filter(({ p, idx }) => p.reputation > 0 && idx !== excludeIdx);

    if (pool.length === 0) return null;

    const total = pool.reduce((s, x) => s + x.p.reputation, 0);
    if (total <= 0) return pool[Math.floor(Math.random() * pool.length)];

    let r = Math.random() * total;
    for (const x of pool) {
      if (r < x.p.reputation) return x;
      r -= x.p.reputation;
    }
    return pool[pool.length - 1];
  }

  // ------------------------------------------------------------------
  // أ) حسم الجولة: تطبيق البطاقات + حدث عشوائي + بناء قضية المحكمة
  // ------------------------------------------------------------------
  if (action === 'resolve_round') {
    let { players, actions, pendingMessages } = req.body;
    let newMessages = { ...pendingMessages };
    let detectedCrimes = [];

    // 1. تطبيق أثر كل بطاقة لُعبت هذه الجولة
    actions.forEach(act => {
      const p = players[act.playerIdx];
      if (p.reputation <= 0) return;

      if (act.card.id === 'SECRET_MSG' && act.targetIdx !== null) {
        if (!newMessages[act.targetIdx]) newMessages[act.targetIdx] = [];
        newMessages[act.targetIdx].push({ senderName: p.name, text: act.customText || 'رسالة غامضة...' });
      }
      else if (act.card.id === 'ATTACK' && act.targetIdx !== null) {
        let target = players[act.targetIdx];
        target.reputation = Math.max(0, target.reputation - 3);
        detectedCrimes.push({ type: 'ATTACK', culpritIdx: act.playerIdx, targetName: target.name });
      }
      else if (act.card.id === 'STEAL' && act.targetIdx !== null) {
        let target = players[act.targetIdx];
        let amount = Math.min(2, target.reputation);
        target.reputation -= amount;
        p.reputation += amount;
        detectedCrimes.push({ type: 'STEAL', culpritIdx: act.playerIdx, targetName: target.name });
      }
      else if (act.card.id === 'BOOST') {
        p.reputation += 2;
      }
    });

    // 2. حدث عشوائي مرجَّح — يضرب غالباً صاحب أعلى سمعة، لكن ليس دائماً
    let randomEvent = null;
    const eventTarget = weightedPickByReputation(players);
    if (eventTarget) {
      const target = eventTarget.p;
      const activeReps = players.filter(pl => pl.reputation > 0).map(pl => pl.reputation);
      const maxRep = Math.max(...activeReps);
      const isHighest = target.reputation === maxRep && maxRep > 0;
      const roll = Math.random();

      if (roll < 0.12 && isHighest) {
        const amount = Math.floor(target.reputation / 2);
        target.reputation -= amount;
        randomEvent = { type: 'HALVE', targetIdx: eventTarget.idx,
          description: `👑 تراكمت الشكوك حول [${target.name}] بسبب نفوذه الكبير جداً... تم تقسيم سمعته إلى النصف! (-${amount})` };
      } else if (roll < 0.45) {
        const amount = 2;
        target.reputation = Math.max(0, target.reputation - amount);
        randomEvent = { type: 'LOSE_REP', targetIdx: eventTarget.idx,
          description: `👀 تصرفات [${target.name}] بدت مريبة لبعض الحاضرين... خسر ${amount} سمعة.` };
      } else if (roll < 0.7) {
        const keys = Object.keys(target.inventory || {}).filter(k => target.inventory[k] > 0);
        if (keys.length > 0) {
          const lostCard = keys[Math.floor(Math.random() * keys.length)];
          target.inventory[lostCard]--;
          randomEvent = { type: 'LOSE_CARD', targetIdx: eventTarget.idx,
            description: `📉 تعرض [${target.name}] لموقف محرج وفقد إحدى بطاقاته السرية!` };
        } else {
          randomEvent = { type: 'NOTHING', targetIdx: null, description: `🌙 مرت هذه الجولة بهدوء دون أي حادثة تُذكر.` };
        }
      } else {
        randomEvent = { type: 'NOTHING', targetIdx: null, description: `🌙 مرت هذه الجولة بهدوء دون أي حادثة تُذكر.` };
      }
    }

    // 3. بناء قضية الجولة + دليل مضلِّل بنسبة دقة 65%
    let courtCase = { title: '', clueText: '', trueCulpritIdx: null };

    if (detectedCrimes.length > 0) {
      const crime = detectedCrimes[Math.floor(Math.random() * detectedCrimes.length)];
      courtCase.trueCulpritIdx = crime.culpritIdx;

      courtCase.title = crime.type === 'ATTACK'
        ? `⚖️ قضية الجولة: تعرض [${crime.targetName}] لإدانة وهجوم سري! من الفاعل؟`
        : `⚖️ قضية الجولة: تمت سرقة نفوذ وسمعة من [${crime.targetName}]! من السارق؟`;

      const accurate = Math.random() < 0.65;
      let suspectIdx = crime.culpritIdx;
      if (!accurate) {
        const redHerring = weightedPickByReputation(players, crime.culpritIdx);
        if (redHerring) suspectIdx = redHerring.idx;
      }
      const suspectName = players[suspectIdx]?.name;
      if (suspectName) {
        courtCase.clueText = `🔍 دليل غامض: يبدو أن سمعة [${suspectName}] كانت مرتفعة بشكل لافت وقت الحادثة... (الدليل قد يكون مضللاً)`;
      }
    } else {
      courtCase.title = `⚖️ قضية الجولة: تسود المحكمة أجواء هادئة... هل يوجد مجرم خفي أم لا أحد؟`;
    }

    return res.status(200).json({ players, pendingMessages: newMessages, randomEvent, courtCase });
  }

  // ------------------------------------------------------------------
  // ب) حسم التصويت السري الفردي لكل لاعب
  // ------------------------------------------------------------------
  if (action === 'resolve_votes') {
    const { players, votes, trueCulpritIdx } = req.body;
    const WRONG_VOTE_PENALTY = 2;
    const CULPRIT_CAUGHT_PENALTY = 4;

    // 1. كل لاعب صوّت خطأ (لا يطابق الجاني الحقيقي) يخسر نقاط بنفسه
    votes.forEach(v => {
      const voter = players[v.voterIdx];
      if (!voter || voter.reputation <= 0) return;
      const correct = v.accusedIdx === trueCulpritIdx;
      if (!correct) {
        voter.reputation = Math.max(0, voter.reputation - WRONG_VOTE_PENALTY);
      }
    });

    // 2. حكم الأغلبية (إعلان رسمي، منفصل عن عقوبة كل مصوّت)
    const tally = {};
    votes.forEach(v => {
      const key = v.accusedIdx === null ? 'NONE' : String(v.accusedIdx);
      tally[key] = (tally[key] || 0) + 1;
    });

    let majorityKey = null, majorityCount = -1, tie = false;
    Object.entries(tally).forEach(([k, c]) => {
      if (c > majorityCount) { majorityKey = k; majorityCount = c; tie = false; }
      else if (c === majorityCount) { tie = true; }
    });

    let verdictMsg = '';
    if (tie || majorityKey === null) {
      verdictMsg = '🤷 تعادلت الأصوات ولم تُحسم القضية رسمياً هذه الجولة.';
    } else {
      const majorityAccused = majorityKey === 'NONE' ? null : parseInt(majorityKey);
      if (trueCulpritIdx === null) {
        verdictMsg = majorityAccused === null
          ? '🎯 حكم الأغلبية: لم يرتكب أحد جرماً هذه الجولة، وأصابت الأغلبية!'
          : `❌ اتهام باطل بالأغلبية! [${players[majorityAccused].name}] بريء تماماً، ولم تكن هناك جريمة أصلاً.`;
      } else if (majorityAccused === trueCulpritIdx) {
        const culprit = players[trueCulpritIdx];
        culprit.reputation = Math.max(0, culprit.reputation - CULPRIT_CAUGHT_PENALTY);
        verdictMsg = `⚖️ حكم عادل! اتضح أن [${culprit.name}] هو الفاعل الحقيقي، وصدرت بحقه عقوبة إضافية (-${CULPRIT_CAUGHT_PENALTY} سمعة)!`;
      } else {
        verdictMsg = majorityAccused === null
          ? '🕊️ نجا الجاني الحقيقي بلا عقاب... اختارت الأغلبية "لا أحد"!'
          : `😱 اتهام باطل بالأغلبية! [${players[majorityAccused].name}] بريء من هذه التهمة تحديداً.`;
      }
    }

    return res.status(200).json({ players, verdictMsg, tally });
  }

  return res.status(400).json({ error: 'Unknown action' });
}
