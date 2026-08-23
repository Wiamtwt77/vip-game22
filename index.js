// api/index.js
import fetch from 'node-fetch';

// حالة اللعبة (يُفضل لاحقاً ربطها بقاعدة بيانات مثل Supabase لتفادي ضياعها مع Vercel Cold Starts)
let gameState = {
  players: [
    { name: "ايفا", rep: 10, inventory: ["ATTACK", "STEAL", "BOOST"] },
    { name: "لاعب_2", rep: 10, inventory: ["ATTACK", "STEAL", "BOOST"] },
    { name: "لاعب_3", rep: 10, inventory: ["ATTACK", "STEAL", "BOOST"] }
  ],
  currentRound: 1,
  alliances: {}, // { playerName: { ally: 'allyName', duration: 2 } }
  market: ["ATTACK", "STEAL", "BOOST", "SECRET_MSG", "REVEAL_HAND"],
  phase: "PLAY", // PLAY, VOTE, RESULTS
  votes: {},
  guiltyPlayer: "لاعب_2" // للعرض التجريبي
};

// دالة توليد الحدث المفاجئ عبر Z-AI (أو OpenRouter)
async function generateAIEvent(targetPlayer, highestRepPlayer) {
  const prompt = `أنت مدير لعبة استنتاج اجتماعي. اللاعب '${highestRepPlayer}' يمتلك أعلى سمعة ويحتكر اللعبة. واللاعب '${targetPlayer}' هو هدف الحدث. 
  قم بتأليف "حدث مفاجئ" قصير (سطر واحد) يضرب اللاعب الأعلى سمعة أو يغير مجرى اللعبة. 
  يجب أن يكون الحدث بصيغة درامية مبدعة باللغة العربية. لا تكتب أي مقدمات.`;

  try {
    const response = await fetch("https://api.z-ai.dev/v1/chat/completions", { // استبدلي الرابط برابط Z-AI الصحيح
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.Z_AI_KEY}`, // مفتاح Z AI
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "z-ai-model-name", // اسم النموذج
        messages: [{ role: "user", content: prompt }]
      })
    });
    
    const data = await response.json();
    return data.choices[0].message.content.trim();
  } catch (error) {
    console.error("AI API Error:", error);
    return `حدث غامض: عاصفة من الشائعات تضرب اللاعب ${targetPlayer}!`; 
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
      return res.status(200).json(gameState); // إرجاع الحالة الحالية إذا كان الطلب GET
  }

  const { action, payload } = req.body;

  switch (action) {
    case 'BUY_CARD':
      const buyer = gameState.players.find(p => p.name === payload.playerName);
      if (buyer && buyer.rep >= 3) {
        buyer.rep -= 3;
        const randomCard = gameState.market[Math.floor(Math.random() * gameState.market.length)];
        buyer.inventory.push(randomCard);
        res.json({ success: true, card: randomCard, newRep: buyer.rep, inventory: buyer.inventory });
      } else {
        res.status(400).json({ error: "رصيد غير كافٍ أو اللاعب غير موجود" });
      }
      break;

    case 'TRIGGER_RANDOM_EVENT':
      const totalRep = gameState.players.reduce((sum, p) => sum + p.rep, 0);
      let rand = Math.random() * totalRep;
      let target = null;
      let highestRepPlayer = gameState.players.reduce((prev, current) => (prev.rep > current.rep) ? prev : current);

      for (let p of gameState.players) {
        rand -= p.rep;
        if (rand <= 0) {
          target = p;
          break;
        }
      }

      const aiEventText = await generateAIEvent(target.name, highestRepPlayer.name);
      
      const isCardLoss = Math.random() > 0.5;
      if (isCardLoss && target.inventory.length > 0) {
          target.inventory.pop(); 
      } else {
          target.rep -= 2; 
      }

      res.json({ success: true, event: aiEventText, target: target.name });
      break;

    case 'FORM_ALLIANCE':
      const { player1, player2 } = payload;
      gameState.alliances[player1] = { ally: player2, duration: 2 };
      gameState.alliances[player2] = { ally: player1, duration: 2 };
      res.json({ success: true, message: `تم التحالف بين ${player1} و ${player2} لجولتين!` });
      break;

    case 'APPLY_REWARD_PENALTY':
      const { targetPlayer, amount, isReward } = payload;
      const p = gameState.players.find(x => x.name === targetPlayer);
      const alliance = gameState.alliances[targetPlayer];

      if (isReward) {
        if (alliance) {
           p.rep += (amount / 2); 
           let ally = gameState.players.find(x => x.name === alliance.ally);
           if (ally) ally.rep += (amount / 2);
        } else {
           p.rep += amount;
        }
      } else {
        p.rep -= amount;
        if (alliance) {
           let ally = gameState.players.find(x => x.name === alliance.ally);
           if (ally) ally.rep -= amount;
        }
      }
      res.json({ success: true, players: gameState.players });
      break;

    case 'SUBMIT_VOTE':
      const { voter, accused } = payload;
      gameState.votes[voter] = accused;
      
      if (Object.keys(gameState.votes).length === gameState.players.length) {
         for (let v in gameState.votes) {
            if (gameState.votes[v] !== gameState.guiltyPlayer) {
               let wrongVoter = gameState.players.find(x => x.name === v);
               if (wrongVoter) wrongVoter.rep -= 2; 
            }
         }
         gameState.phase = "RESULTS";
      }
      res.json({ success: true, votesCount: Object.keys(gameState.votes).length });
      break;

    case 'PLAY_REVEAL_CARD':
      const { attacker, victim } = payload;
      const victimData = gameState.players.find(x => x.name === victim);
      res.json({ success: true, victim: victim, cards: victimData.inventory });
      break;

    default:
      res.status(400).json({ error: "إجراء غير معروف" });
  }
}
