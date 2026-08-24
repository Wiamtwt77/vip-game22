const DEFAULT_MODEL = process.env.OPENROUTER_MODEL || 'z-ai/glm-4.5-air:free';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const CARD_RULES = {
  ATTACK: { cost: 3, cooldown: 2, crime: true },
  STEAL: { cost: 2, cooldown: 3, crime: true },
  BOOST: { gain: 2, cooldown: 2 },
  INTERROGATE: { cooldown: 3 },
  FORCE_REVEAL: { cooldown: 4 },
  SECRET_MSG: { cooldown: 2 },
  AI_CARD: { cooldown: 2 }
};
const EVENTS = [
  { type: 'LOSE_REP', weight: 35, text: (p) => `تزايدت الشكوك حول ${p.name} وخسر نقطتي سمعة.`, apply: (p) => { p.reputation = Math.max(0, p.reputation - 2); } },
  { type: 'LOSE_CARD', weight: 25, text: (p) => `${p.name} فقد بطاقة من مخزونه بسبب فضيحة مفاجئة.`, apply: (p) => { const k = Object.keys(p.inventory || {}).find(k => p.inventory[k] > 0); if (k) p.inventory[k]--; } },
  { type: 'GAIN_REP', weight: 20, text: (p) => `${p.name} كسب نقطة سمعة بعد شهادة مؤيدة.`, apply: (p) => { p.reputation += 1; } },
  { type: 'NOTHING', weight: 20, text: () => 'مرت الجولة بهدوء دون حادثة عشوائية مؤثرة.', apply: () => {} }
];

function clone(x) { return JSON.parse(JSON.stringify(x)); }
function active(p) { return p && Number(p.reputation) > 0; }
function idMap(players) { return new Map(players.map((p, i) => [String(p.id), i])); }
function cleanState(players) {
  return players.map((p, i) => ({
    id: String(p.id ?? `p-${i}`), name: String(p.name || `لاعب ${i + 1}`).slice(0, 40),
    reputation: Math.max(0, Number(p.reputation) || 0),
    inventory: Object.fromEntries([...new Set([...Object.keys(CARD_RULES), ...Object.keys(p.inventory || {})])].map(k => [k, Math.max(0, Math.min(5, Number(p.inventory?.[k]) || 0))])),
    cooldowns: Object.fromEntries(Object.entries(p.cooldowns || {}).map(([k, v]) => [k, Math.max(0, Number(v) || 0)])),
    shopCooldown: Math.max(0, Number(p.shopCooldown) || 0), shieldRounds: Math.max(0, Number(p.shieldRounds) || 0),
    allyId: p.allyId == null ? null : String(p.allyId), allyRoundsLeft: Math.max(0, Number(p.allyRoundsLeft) || 0),
    allianceOffer: p.allianceOffer ? { fromId: String(p.allianceOffer.fromId), fromName: String(p.allianceOffer.fromName || '') } : null
  }));
}
function weighted(items) { const total = items.reduce((s, x) => s + x.weight, 0); let r = Math.random() * total; for (const x of items) { if ((r -= x.weight) < 0) return x; } return items.at(-1); }
function weightedTarget(players, excluded = new Set()) { const pool = players.map((p, i) => ({ p, i })).filter(x => active(x.p) && !excluded.has(x.i)); if (!pool.length) return null; return weighted(pool.map(x => ({ ...x, weight: Math.max(1, x.p.reputation) }))); }
function addMessage(messages, id, message) { const key = String(id); messages[key] ||= []; messages[key].push(message); }
function expireAndOffers(players) {
  players.forEach(p => { Object.keys(p.cooldowns).forEach(k => { p.cooldowns[k] = Math.max(0, p.cooldowns[k] - 1); }); p.shopCooldown = Math.max(0, p.shopCooldown - 1); });
  const eligible = players.map((p, i) => ({ p, i })).filter(x => active(x.p) && !x.p.allyId && !x.p.allianceOffer);
  if (eligible.length >= 2 && Math.random() < 0.7) { const a = eligible[Math.floor(Math.random() * eligible.length)]; const rest = eligible.filter(x => x.i !== a.i); const b = rest[Math.floor(Math.random() * rest.length)]; players[b.i].allianceOffer = { fromId: a.p.id, fromName: a.p.name }; }
}
function fallbackCard() { const types = ['REPUTATION_LOSS','STEAL','REPUTATION_GAIN','INVESTIGATE','MESSAGE','SHIELD']; const type = types[Math.floor(Math.random()*types.length)]; const names = {REPUTATION_LOSS:'ختم الشك',STEAL:'حبر النفوذ',REPUTATION_GAIN:'شهادة سرية',INVESTIGATE:'عين المحكمة',MESSAGE:'همسة مشفرة',SHIELD:'درع الشاهد'}; return { id: `AI-${Date.now()}-${Math.random().toString(36).slice(2,7)}`, name: names[type], description: 'بطاقة مولدة تلقائيًا بأثر فريد لهذه الجولة.', effectType: type, power: type==='STEAL'?2:type==='REPUTATION_LOSS'?2:type==='REPUTATION_GAIN'?2:1, targetRequired: !['REPUTATION_GAIN','SHIELD'].includes(type), cooldown: 2, rarity: 'عادية' }; }
async function generateCard(payload) { const key = process.env.OPENROUTER_KEY; if (!key) return fallbackCard(); const controller = new AbortController(); const timer=setTimeout(()=>controller.abort(),3500); try { const response=await fetch(OPENROUTER_URL,{method:'POST',signal:controller.signal,headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json','HTTP-Referer':process.env.APP_URL||'https://secret-court.local','X-Title':'Secret Court'},body:JSON.stringify({model:DEFAULT_MODEL,temperature:0.95,max_tokens:350,messages:[{role:'system',content:'أنت مصمم بطاقات للعبة المحكمة السرية. أعد JSON فقط. يجب أن يكون effectType واحدًا من REPUTATION_LOSS, STEAL, REPUTATION_GAIN, INVESTIGATE, MESSAGE, SHIELD. لا تخترع تأثيرات خارج القائمة.'},{role:'user',content:JSON.stringify(payload)}],response_format:{type:'json_object'}})}); if(!response.ok)return fallbackCard(); const data=await response.json(); const raw=data.choices?.[0]?.message?.content; const card=raw?JSON.parse(raw):null; const allowed=['REPUTATION_LOSS','STEAL','REPUTATION_GAIN','INVESTIGATE','MESSAGE','SHIELD']; if(!card||typeof card.name!=='string'||!allowed.includes(card.effectType))return fallbackCard(); return {id:`AI-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,name:String(card.name).slice(0,50),description:String(card.description||'بطاقة مولدة بالذكاء الاصطناعي.').slice(0,180),effectType:card.effectType,power:Math.max(1,Math.min(3,Number(card.power)||1)),targetRequired:Boolean(card.targetRequired),cooldown:Math.max(1,Math.min(4,Number(card.cooldown)||2)),rarity:String(card.rarity||'نادرة').slice(0,20)}; } catch { return fallbackCard(); } finally { clearTimeout(timer); } }
async function aiJudge(payload) {
  const key = process.env.OPENROUTER_KEY;
  if (!key) return null;
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 7000);
  try {
    const response = await fetch(OPENROUTER_URL, { method: 'POST', signal: controller.signal, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'HTTP-Referer': process.env.APP_URL || 'https://secret-court.local', 'X-Title': 'Secret Court' }, body: JSON.stringify({ model: DEFAULT_MODEL, temperature: 0.3, max_tokens: 500, messages: [{ role: 'system', content: 'أنت حكم محايد في لعبة المحكمة السرية. أعد JSON فقط دون Markdown.' }, { role: 'user', content: JSON.stringify(payload) }], response_format: { type: 'json_object' } }) });
    if (!response.ok) return null;
    const data = await response.json(); const text = data.choices?.[0]?.message?.content; return text ? JSON.parse(text) : null;
  } catch { return null; } finally { clearTimeout(timer); }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
  const body = req.body || {}; const action = body.action;
  if (action === 'ai_status') return res.status(200).json({ enabled: Boolean(process.env.OPENROUTER_KEY), model: DEFAULT_MODEL });
  if (action === 'generate_card') { const player = body.player || {}; if (Number(player.reputation) < 3 || Number(player.shopCooldown) > 0) return res.status(400).json({error:'CARD_PURCHASE_NOT_ALLOWED'}); const card = await generateCard({ round: body.round || 1, existingCards: body.existingCards || [], reputation: player.reputation }); return res.status(200).json({ card, aiUsed: Boolean(process.env.OPENROUTER_KEY) }); }
  if (action === 'resolve_round') {
    let players = cleanState(body.players || []); const map = idMap(players); const messages = clone(body.pendingMessages || {}); const actions = Array.isArray(body.actions) ? body.actions : []; const publicReveals = []; const crimes = []; const before = players.map(p => p.reputation);
    for (const raw of actions) {
      const pi = map.get(String(raw.playerId)); const ti = raw.targetId == null ? null : map.get(String(raw.targetId)); const p = players[pi]; const card = String(raw.cardId || ''); const rule = CARD_RULES[card]; const generated = raw.generatedCard || {}; const inventoryKey = card === 'AI_CARD' ? String(generated.id || '') : card;
      if (pi == null || !active(p) || !rule || !inventoryKey || p.cooldowns[inventoryKey] > 0 || (p.inventory[inventoryKey] || 0) <= 0) continue;
      if (card !== 'BOOST' && card !== 'SECRET_MSG' && card !== 'INTERROGATE' && card !== 'FORCE_REVEAL' && !(card === 'AI_CARD' && ['REPUTATION_GAIN','SHIELD'].includes(generated.effectType)) && (ti == null || ti === pi || !active(players[ti]))) continue;
      if ((card === 'SECRET_MSG' || card === 'INTERROGATE' || card === 'FORCE_REVEAL' || rule.crime) && ti == null) continue;
      p.inventory[inventoryKey]--; p.cooldowns[inventoryKey] = rule.cooldown;
      if (card === 'SECRET_MSG') addMessage(messages, players[ti].id, { kind: 'message', senderId: p.id, senderName: p.name, text: String(raw.text || 'رسالة غامضة').slice(0, 300) });
      if (card === 'ATTACK') { players[ti].reputation = Math.max(0, players[ti].reputation - 3); crimes.push({ culpritId: p.id, type: card, targetName: players[ti].name }); }
      if (card === 'STEAL') { const amount = Math.min(2, players[ti].reputation); players[ti].reputation -= amount; p.reputation += amount; crimes.push({ culpritId: p.id, type: card, targetName: players[ti].name }); }
      if (card === 'BOOST') p.reputation += rule.gain;
      if (card === 'AI_CARD') { const power=Math.max(1,Math.min(3,Number(generated.power)||1)); if(generated.effectType==='SHIELD')p.shieldRounds=1; if(generated.effectType==='REPUTATION_LOSS') players[ti].reputation=Math.max(0,players[ti].reputation-power); if(generated.effectType==='STEAL'){const amount=Math.min(power,players[ti].reputation);players[ti].reputation-=amount;p.reputation+=amount;} if(generated.effectType==='REPUTATION_GAIN')p.reputation+=power; if(generated.effectType==='MESSAGE')addMessage(messages,players[ti].id,{kind:'ai-card',senderName:p.name,text:String(generated.description||'وصل أثر بطاقة مولدة.').slice(0,300)}); if(generated.effectType==='INVESTIGATE')addMessage(messages,p.id,{kind:'ai-card',senderName:'نتيجة بطاقة مولدة',text:`الهدف ${players[ti].name} يملك ${players[ti].reputation} سمعة.`}); }
      if (card === 'INTERROGATE') { const targetAct = actions.find(a => String(a.playerId) === String(players[ti].id) && ['ATTACK', 'STEAL'].includes(a.cardId)); addMessage(messages, p.id, { kind: 'intel', senderName: 'نتيجة الاستجواب', text: targetAct ? `نعم، ${players[ti].name} ارتكب جريمة هذا الدور.` : `لا، لم يرتكب ${players[ti].name} جريمة هذا الدور.`, warning: 'هذه معلومة سرية.' }); }
      if (card === 'FORCE_REVEAL') publicReveals.push({ askerName: p.name, targetName: players[ti].name, inventory: clone(players[ti].inventory) });
    }
    const target = weightedTarget(players); let randomEvent = null;
    if (target) { const event = weighted(EVENTS); event.apply(target.p); randomEvent = { type: event.type, targetId: target.p.id, description: event.text(target.p) }; }
    for (let i = 0; i < players.length; i++) { const p = players[i]; if (!p.allyId || i > (map.get(String(p.allyId)) ?? 999)) continue; const j = map.get(String(p.allyId)); const ally = players[j]; if (!ally || ally.allyId !== p.id) continue; const delta = p.reputation - before[i], allyDelta = ally.reputation - before[j]; if (delta < 0) ally.reputation = Math.max(0, ally.reputation + delta); if (allyDelta < 0) p.reputation = Math.max(0, p.reputation + allyDelta); if (delta > 0) ally.reputation += Math.floor(delta / 2); if (allyDelta > 0) p.reputation += Math.floor(allyDelta / 2); const usedCrime = actions.some(a => [p.id, ally.id].includes(String(a.playerId)) && ['ATTACK', 'STEAL'].includes(a.cardId)); if (!usedCrime) { p.reputation++; ally.reputation++; } }
    players.forEach(p => { if (p.reputation <= 0 && p.allyId) { const ally = players[map.get(String(p.allyId))]; if (ally) { ally.allyId = null; ally.allyRoundsLeft = 0; } p.allyId = null; p.allyRoundsLeft = 0; } if (p.allyId && --p.allyRoundsLeft <= 0) p.allyId = null; });
    expireAndOffers(players);
    let courtCase = { title: 'قضية هادئة: هل يوجد مجرم خفي؟', trueCulpritId: null, clue: 'لا توجد جريمة مؤكدة.', confidence: 80 };
    if (crimes.length) { const crime = crimes[Math.floor(Math.random() * crimes.length)]; const accurate = Math.random() < 0.65; const suspect = accurate ? crime.culpritId : weightedTarget(players, new Set([map.get(String(crime.culpritId))])); const suspectName = suspect?.p?.name || players[map.get(String(suspect))]?.name || 'شخص مجهول'; courtCase = { title: crime.type === 'ATTACK' ? `قضية: هجوم سري على ${crime.targetName}` : `قضية: سرقة نفوذ من ${crime.targetName}`, trueCulpritId: crime.culpritId, clue: `الدليل يشير إلى ${suspectName}، لكنه قد يكون مضللًا.`, confidence: accurate ? 65 : 35 }; const ai = await aiJudge({ case: courtCase.title, suspect: suspectName, players: players.map(p => ({ name: p.name, reputation: p.reputation })) }); if (ai?.clue) { courtCase.clue = String(ai.clue).slice(0, 500); courtCase.confidence = Math.max(1, Math.min(99, Number(ai.confidence) || courtCase.confidence)); } }
    return res.status(200).json({ players, pendingMessages: messages, randomEvent, publicReveals, courtCase, ai: { enabled: Boolean(process.env.OPENROUTER_KEY), used: Boolean(process.env.OPENROUTER_KEY) } });
  }
  if (action === 'resolve_votes') { const players = cleanState(body.players || []); const culprit = body.trueCulpritId == null ? null : String(body.trueCulpritId); const votes = Array.isArray(body.votes) ? body.votes : []; const tally = {}; for (const v of votes) { const voter = players.find(p => p.id === String(v.voterId)); if (!active(voter)) continue; const accused = v.accusedId == null ? 'NONE' : String(v.accusedId); tally[accused] = (tally[accused] || 0) + 1; if (accused !== culprit) voter.reputation = Math.max(0, voter.reputation - 2); } const winner = Object.entries(tally).sort((a, b) => b[1] - a[1])[0]?.[0] || 'NONE'; let verdictMsg = winner === culprit ? 'أصابت الأغلبية الجاني الحقيقي.' : 'لم تصب الأغلبية الجاني الحقيقي.'; if (winner === culprit && culprit !== 'NONE') { const p = players.find(x => x.id === culprit); if (p) p.reputation = Math.max(0, p.reputation - 4); } const finalEvidence = { confidence: culprit ? 65 : 80, conclusion: culprit ? `الجاني الحقيقي هو ${players.find(p => p.id === culprit)?.name || 'غير معروف'}.` : 'لم تثبت جريمة في هذه الجولة.', note: 'الصحة نسبية وليست يقينًا مطلقًا.' }; return res.status(200).json({ players, tally, verdictMsg, finalEvidence }); }
  return res.status(400).json({ error: 'Unknown action' });
}
