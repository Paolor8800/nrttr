// Нагрузочный прогон сетевой части: N ботов играют несколько раундов через WebSocket.
//
//   npm run build && PLAYER_AWAY_GRACE_MS=3000 LEADER_AWAY_GRACE_MS=6000 npm run start
//   node scripts/load-test.mjs --players 15 --rounds 3 --chaos
//
// --chaos: в 1-м раунде один игрок обрывает связь и переподключается по своей сессии,
// во 2-м раунде один игрок пропадает насовсем (раунд должен продолжиться без него).
import WebSocket from 'ws';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] && !args[index + 1].startsWith('--') ? args[index + 1] : fallback;
};
const BASE_URL = option('url', process.env.LOAD_TEST_URL || 'http://127.0.0.1:8080').replace(/\/+$/, '');
const PLAYERS = Number(option('players', 15));
const ROUNDS = Number(option('rounds', 3));
const CHAOS = args.includes('--chaos');
const PHASE_TIMEOUT_MS = Number(option('timeout', 90_000));
const WS_URL = `${BASE_URL.replace(/^http/, 'ws')}/ws`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pick = (items) => items[Math.floor(Math.random() * items.length)];
const failures = [];
const fail = (message) => {
  failures.push(message);
  console.error(`✗ ${message}`);
};

class Bot {
  constructor(index, roomCode) {
    this.index = index;
    this.name = `Бот ${index + 1}`;
    this.roomCode = roomCode;
    this.id = null;
    this.sessionId = null;
    this.state = null;
    this.lobby = null;
    this.received = 0;
    this.bytes = 0;
    this.errors = [];
    this.waiters = new Set();
    this.gone = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(WS_URL);
      this.socket = socket;
      const timer = setTimeout(() => reject(new Error(`${this.name}: connect timeout`)), 15_000);
      socket.on('open', () => {
        socket.send(JSON.stringify({
          type: 'identify',
          roomCode: this.roomCode,
          playerName: this.name,
          gender: this.index % 2 ? 'female' : 'male',
          wantsHost: this.index === 0,
          playerId: this.id ?? undefined,
          sessionId: this.sessionId ?? undefined,
        }));
      });
      socket.on('message', (raw) => {
        this.received += 1;
        this.bytes += raw.length;
        const message = JSON.parse(raw.toString());
        if (message.type === 'connected') {
          this.id = message.playerId;
          this.sessionId = message.sessionId;
          clearTimeout(timer);
          resolve(this);
        } else if (message.type === 'lobby_state') {
          this.lobby = message;
        } else if (message.type === 'game_state') {
          this.state = message.state;
        } else if (message.type === 'error' || message.type === 'action_rejected') {
          this.errors.push(message.message || message.reason);
          if (!this.id) {
            clearTimeout(timer);
            reject(new Error(`${this.name}: ${message.message}`));
          }
        }
        for (const waiter of this.waiters) waiter();
      });
      socket.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  send(message) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  action(type, payload) {
    this.send({
      type: 'player_action',
      action: { type, payload, actionId: crypto.randomUUID(), round: this.state?.round, questionId: this.state?.questionId },
    });
  }

  waitFor(predicate, label, timeoutMs = PHASE_TIMEOUT_MS) {
    if (predicate(this)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const check = () => {
        if (!predicate(this)) return;
        clearTimeout(timer);
        this.waiters.delete(check);
        resolve();
      };
      const timer = setTimeout(() => {
        this.waiters.delete(check);
        reject(new Error(`${this.name}: timeout waiting for ${label}`));
      }, timeoutMs);
      this.waiters.add(check);
    });
  }

  drop() {
    this.socket?.terminate();
  }

  get isLeader() {
    const state = this.state;
    return Boolean(state && state.players[state.currentLeaderIndex]?.id === this.id);
  }
}

async function waitAll(bots, predicate, label) {
  const started = Date.now();
  await Promise.all(bots.map((bot) => bot.waitFor(predicate, label)));
  return Date.now() - started;
}

async function main() {
  console.log(`Load test: ${PLAYERS} players, ${ROUNDS} rounds, chaos=${CHAOS}, server=${BASE_URL}`);
  const health = await fetch(`${BASE_URL}/api/health`).then((response) => response.json());
  console.log(`health: ${JSON.stringify(health)}`);

  const { roomCode } = await fetch(`${BASE_URL}/api/rooms`, { method: 'POST' }).then((response) => response.json());
  const bots = Array.from({ length: PLAYERS }, (_, index) => new Bot(index, roomCode));

  const joinStarted = Date.now();
  const joined = await Promise.allSettled(bots.map((bot, index) => sleep(index * 40).then(() => bot.connect())));
  joined.forEach((result, index) => {
    if (result.status === 'rejected') fail(`${bots[index].name} could not join: ${result.reason.message}`);
  });
  if (failures.length > 0) return finish(bots);
  await waitAll(bots, (bot) => bot.lobby?.players.length === PLAYERS, `lobby with ${PLAYERS} players`);
  console.log(`✓ ${PLAYERS} players joined room ${roomCode} in ${Date.now() - joinStarted} ms`);

  const host = bots[0];
  host.send({ type: 'start_game' });
  host.send({ type: 'start_game' }); // двойной клик хоста не должен перезапускать партию
  await waitAll(bots, (bot) => bot.state?.phase === 'answering', 'game start');
  const firstQuestion = host.state.questionId;
  await sleep(200);
  if (host.state.questionId !== firstQuestion) fail('second start_game restarted the running game');
  console.log('✓ game started (double start ignored)');

  let vanished = null;
  for (let round = 0; round < ROUNDS; round += 1) {
    const active = bots.filter((bot) => !bot.gone);
    const roundStarted = Date.now();
    const roundNumber = host.state.round;
    const leader = active.find((bot) => bot.isLeader);
    if (!leader) {
      fail(`round ${round + 1}: no leader among connected bots`);
      break;
    }
    const others = active.filter((bot) => bot !== leader);

    if (CHAOS && round === 1) {
      vanished = others[others.length - 1];
      vanished.gone = true;
      vanished.drop();
      console.log(`  ${vanished.name} disappears for good before answering`);
    }
    const answering = active.filter((bot) => !bot.gone);

    await Promise.all(answering.map(async (bot, index) => {
      await sleep(index * 15);
      bot.action('submit_answer', { text: `Ответ ${bot.name} в раунде ${roundNumber + 1}` });
    }));

    if (CHAOS && round === 0) {
      const flaky = others[0];
      flaky.drop();
      await sleep(1500);
      await flaky.connect();
      console.log(`  ${flaky.name} dropped and reconnected with its session`);
    }

    const toJudging = await waitAll(answering, (bot) => bot.state?.phase === 'judging' && bot.state.round === roundNumber, 'judging');
    const answers = host.state.answers;
    const expectedAnswers = answering.length - 1;
    if (answers.length !== expectedAnswers) fail(`round ${round + 1}: ${answers.length} answers, expected ${expectedAnswers}`);

    const voters = answering.filter((bot) => bot !== leader);
    await Promise.all(voters.map(async (bot, index) => {
      await sleep(index * 10);
      bot.action('vote_funniest', { answerId: pick(answers).id });
      bot.action('toggle_answer_reaction', { answerId: pick(answers).id, reaction: pick(['joy', 'fire', 'clown', 'poop']) });
      const me = bot.state.players.find((player) => player.id === bot.id);
      if (me && me.score >= 1 && index % 3 === 0) bot.action('casino_spin', { betType: pick(['red', 'black', 'zero']) });
    }));

    leader.action('select_most_correct', { answerId: pick(answers).id });
    await leader.waitFor((bot) => Boolean(bot.state.mostCorrectAnswerId), 'most correct selection');
    const candidates = voters.map((bot) => bot.id);
    answers.forEach((answer, index) => leader.action('guess_author', { answerId: answer.id, guessedPlayerId: candidates[index] }));
    await leader.waitFor(
      (bot) => Boolean(bot.state.mostFunnyAnswerId) && Object.keys(bot.state.authorGuesses).length === answers.length,
      'all votes and guesses',
    );
    leader.action('finish_judging');
    const toResults = await waitAll(answering, (bot) => bot.state?.phase === 'roundResults', 'round results');

    const lobbySize = host.lobby.players.length;
    if (lobbySize !== PLAYERS) fail(`round ${round + 1}: lobby has ${lobbySize} players after reconnects, expected ${PLAYERS}`);

    if (round < ROUNDS - 1) {
      leader.action('next_round');
      await waitAll(answering, (bot) => bot.state?.phase === 'answering' || bot.state?.phase === 'gameOver', 'next round');
      if (host.state.phase === 'gameOver') {
        console.log('  game over reached');
        break;
      }
    }
    console.log(`✓ round ${round + 1}: leader ${leader.name}, ${answers.length} answers, judging after ${toJudging} ms, results visible to all ${toResults} ms after finish, round took ${Date.now() - roundStarted} ms`);
  }

  if (vanished) {
    const away = host.state.awayPlayerIds ?? [];
    if (!away.includes(vanished.id)) fail(`${vanished.name} is not reported as away`);
    else console.log(`✓ ${vanished.name} is reported as away and no longer blocks the round`);
  }
  return finish(bots);
}

function finish(bots) {
  const live = bots.filter((bot) => bot.received > 0);
  const messages = live.reduce((sum, bot) => sum + bot.received, 0);
  const bytes = live.reduce((sum, bot) => sum + bot.bytes, 0);
  const errors = live.flatMap((bot) => bot.errors.map((error) => `${bot.name}: ${error}`));
  if (live.length > 0) {
    console.log(`messages received: ${messages} total, ~${Math.round(messages / live.length)} per player, ${(bytes / 1024).toFixed(0)} KiB`);
  }
  if (errors.length > 0) console.log(`server errors/rejections seen by bots:\n  ${errors.slice(0, 10).join('\n  ')}`);
  for (const bot of bots) bot.socket?.close();
  if (failures.length > 0) {
    console.log(`FAILED: ${failures.length} problem(s)`);
    process.exit(1);
  }
  console.log('PASSED');
  process.exit(0);
}

main().catch((error) => {
  fail(error.message);
  process.exit(1);
});
