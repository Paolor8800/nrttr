import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CASINO_FORCED_LOSS_COUNT,
  CASINO_FORCED_LOSS_FROM_SCORE,
  CASINO_SPIN_COOLDOWN_MS,
  PLAYER_AWAY_GRACE_MS,
  Room,
  TARGET_SCORE,
} from '../../server/room';
import type { CasinoBetType, PlayerAction } from '../../server/shared-types';

// Math.random → 0.03 даёт номер 1 (красное): ставка на красное выигрывает, если исход не подстроен.
const RED_WIN_RANDOM = 0.03;

function setupRoom(count = 4) {
  const room = new Room('RULES1');
  for (let index = 1; index <= count; index += 1) {
    room.addOrUpdatePlayer(`p${index}`, `Игрок ${index}`, index === 1, index % 2 ? 'male' : 'female');
  }
  room.startGame();
  return room;
}

function act(room: Room, playerId: string, action: Omit<PlayerAction, 'playerId'>) {
  return room.processAction(playerId, { ...action, playerId } as PlayerAction);
}

const leaderOf = (room: Room) => room.gameState!.players[room.gameState!.currentLeaderIndex].id;
const scoreOf = (room: Room, playerId: string) => room.gameState!.players.find((player) => player.id === playerId)!.score;

function setScore(room: Room, playerId: string, score: number) {
  room.gameState!.players = room.gameState!.players.map((player) => (player.id === playerId ? { ...player, score } : player));
}

function spin(room: Room, playerId: string, betType: CasinoBetType = 'red') {
  act(room, playerId, { type: 'casino_spin', payload: { betType } });
  vi.advanceTimersByTime(CASINO_SPIN_COOLDOWN_MS);
  return room.gameState!.casinoLastSpins[playerId];
}

/** Полный раунд: все отвечают и голосуют за первый ответ, ведущий отмечает его и назначает авторов. */
function playRound(room: Room) {
  const state = room.gameState!;
  const leader = leaderOf(room);
  for (const player of state.players) act(room, player.id, { type: 'submit_answer', payload: { text: `ответ ${player.id}` } });
  const answers = room.gameState!.answers;
  const others = room.gameState!.players.filter((player) => player.id !== leader);
  others.forEach((player) => act(room, player.id, { type: 'vote_funniest', payload: { answerId: answers[0].id } }));
  act(room, leader, { type: 'select_most_correct', payload: { answerId: answers[0].id } });
  answers.forEach((answer, index) => act(room, leader, { type: 'guess_author', payload: { answerId: answer.id, guessedPlayerId: others[index].id } }));
  act(room, leader, { type: 'finish_judging' });
  expect(room.gameState!.phase).toBe('roundResults');
  act(room, leader, { type: 'next_round' });
}

describe('game rules', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-22T12:00:00Z'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('wins at 35 points, not earlier', () => {
    expect(TARGET_SCORE).toBe(35);
    const room = setupRoom();
    expect(room.gameState!.targetScore).toBe(35);

    setScore(room, 'p2', 34);
    room.gameState!.phase = 'roundResults';
    act(room, leaderOf(room), { type: 'next_round' });
    expect(room.gameState!.phase).toBe('answering');

    setScore(room, 'p2', 35);
    room.gameState!.phase = 'roundResults';
    act(room, leaderOf(room), { type: 'next_round' });
    expect(room.gameState!.phase).toBe('gameOver');
    expect(room.gameState!.winnerId).toBe('p2');
  });

  it('declares a draw when the best scores are equal and otherwise picks the highest', () => {
    const room = setupRoom();
    setScore(room, 'p2', 36);
    setScore(room, 'p3', 36);
    room.gameState!.phase = 'roundResults';
    act(room, leaderOf(room), { type: 'next_round' });
    expect(room.gameState!.phase).toBe('gameOver');
    expect(room.gameState!.winnerId).toBeNull();

    const second = setupRoom();
    setScore(second, 'p2', 35);
    setScore(second, 'p3', 38);
    second.gameState!.phase = 'roundResults';
    act(second, leaderOf(second), { type: 'next_round' });
    expect(second.gameState!.winnerId).toBe('p3');
  });

  it('plays a whole game to the target and then starts the next one from zero', () => {
    const room = setupRoom(6);
    let rounds = 0;
    while (room.gameState!.phase !== 'gameOver' && rounds < 200) {
      playRound(room);
      rounds += 1;
    }
    const state = room.gameState!;
    expect(state.phase).toBe('gameOver');
    const best = Math.max(...state.players.map((player) => player.score));
    expect(best).toBeGreaterThanOrEqual(TARGET_SCORE);
    if (state.winnerId) expect(scoreOf(room, state.winnerId)).toBe(best);

    room.startGame();
    expect(room.gameState!.phase).toBe('answering');
    expect(room.gameState!.round).toBe(0);
    expect(room.gameState!.players.every((player) => player.score === 0)).toBe(true);
  });

  it('forces the casino streak from 32 points', () => {
    expect(CASINO_FORCED_LOSS_FROM_SCORE).toBe(32);
    for (const start of [32, 33, 34]) {
      const room = setupRoom();
      setScore(room, 'p2', start);
      vi.spyOn(Math, 'random').mockReturnValue(RED_WIN_RANDOM);
      for (let index = 0; index < CASINO_FORCED_LOSS_COUNT; index += 1) {
        expect(spin(room, 'p2').won).toBe(false);
      }
      expect(scoreOf(room, 'p2')).toBe(start - CASINO_FORCED_LOSS_COUNT);
      expect(spin(room, 'p2').won).toBe(true);
      vi.restoreAllMocks();
    }
  });

  it('keeps spins random below 32 points', () => {
    const room = setupRoom();
    setScore(room, 'p2', 31);
    vi.spyOn(Math, 'random').mockReturnValue(RED_WIN_RANDOM);
    expect(spin(room, 'p2').won).toBe(true);
    expect(scoreOf(room, 'p2')).toBe(33);
    // A random win into the zone starts the streak.
    expect(spin(room, 'p2').won).toBe(false);
  });

  it('does not force losses on a player who already reached the target', () => {
    const room = setupRoom();
    setScore(room, 'p2', 33);
    vi.spyOn(Math, 'random').mockReturnValue(RED_WIN_RANDOM);
    expect(spin(room, 'p2').won).toBe(false);
    // The streak is still running when round points push the player over the target.
    setScore(room, 'p2', 36);
    expect(spin(room, 'p2').won).toBe(true);
    expect(scoreOf(room, 'p2')).toBe(38);
  });

  it('rejects a second spin while the wheel is still turning', () => {
    const room = setupRoom();
    setScore(room, 'p2', 10);
    act(room, 'p2', { type: 'casino_spin', payload: { betType: 'red' } });
    const first = room.gameState!.casinoLastSpins.p2;
    expect(() => act(room, 'p2', { type: 'casino_spin', payload: { betType: 'red' } })).toThrow(/крутится/);
    expect(room.gameState!.casinoLastSpins.p2.id).toBe(first.id);

    vi.advanceTimersByTime(CASINO_SPIN_COOLDOWN_MS);
    act(room, 'p2', { type: 'casino_spin', payload: { betType: 'red' } });
    expect(room.gameState!.casinoLastSpins.p2.id).not.toBe(first.id);
  });

  it('passes the next turn over a player who is offline', () => {
    const room = setupRoom(5);
    const players = room.gameState!.players.map((player) => player.id);
    expect(leaderOf(room)).toBe(players[0]);

    room.markDisconnected(players[1]);
    vi.advanceTimersByTime(PLAYER_AWAY_GRACE_MS);
    room.gameState!.phase = 'roundResults';
    act(room, players[0], { type: 'next_round' });

    expect(leaderOf(room)).toBe(players[2]);
    expect(room.gameState!.round).toBe(1);
  });
});
