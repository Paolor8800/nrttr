import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ABANDONED_ROOM_TTL_MS, LEADER_AWAY_GRACE_MS, normalizePlayerName, PLAYER_AWAY_GRACE_MS, Room, RoomError } from '../../server/room';
import type { PlayerAction } from '../../server/shared-types';
import { MAX_PLAYERS } from '@/lib/roomLimits';

function roomWithPlayers(count: number, code = 'BIG001') {
  const room = new Room(code);
  for (let index = 1; index <= count; index += 1) {
    room.addOrUpdatePlayer(`p${index}`, `Игрок ${index}`, index === 1, index % 2 === 0 ? 'female' : 'male');
  }
  return room;
}

function act(room: Room, playerId: string, action: Omit<PlayerAction, 'playerId'>) {
  return room.processAction(playerId, { ...action, playerId } as PlayerAction);
}

function leaderId(room: Room) {
  const state = room.gameState!;
  return state.players[state.currentLeaderIndex].id;
}

function submitAll(room: Room, except: string[] = []) {
  for (const player of room.gameState!.players) {
    if (except.includes(player.id)) continue;
    act(room, player.id, { type: 'submit_answer', payload: { text: `ответ ${player.id}` } });
  }
}

describe('large rooms (13–16 players)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-22T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it(`accepts ${MAX_PLAYERS} players and rejects the next one with a room_full code`, () => {
    const room = roomWithPlayers(MAX_PLAYERS);
    expect(room.players.size).toBe(MAX_PLAYERS);
    expect(MAX_PLAYERS).toBeGreaterThanOrEqual(15);

    let error: unknown;
    try {
      room.addOrUpdatePlayer('extra', 'Лишний', false, 'male');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RoomError);
    expect((error as RoomError).code).toBe('room_full');
    // Already joined players can still reconnect into a full room.
    expect(() => room.addOrUpdatePlayer('p5', 'Игрок 5', false, 'male')).not.toThrow();
  });

  it('plays a full 15-player round', () => {
    const room = roomWithPlayers(15);
    room.startGame();
    const leader = leaderId(room);

    submitAll(room);
    const state = room.gameState!;
    expect(state.phase).toBe('judging');
    expect(state.answers).toHaveLength(14);
    expect(state.funnyVotesRequiredCount).toBe(14);

    const voters = state.players.filter((player) => player.id !== leader);
    voters.forEach((player) => act(room, player.id, { type: 'vote_funniest', payload: { answerId: state.answers[0].id } }));
    expect(room.gameState!.mostFunnyAnswerId).toBe(state.answers[0].id);

    act(room, leader, { type: 'select_most_correct', payload: { answerId: state.answers[1].id } });
    state.answers.forEach((answer, index) => {
      act(room, leader, { type: 'guess_author', payload: { answerId: answer.id, guessedPlayerId: voters[index].id } });
    });
    act(room, leader, { type: 'finish_judging' });
    expect(room.gameState!.phase).toBe('roundResults');

    act(room, leader, { type: 'next_round' });
    expect(room.gameState!.phase).toBe('answering');
    expect(room.gameState!.currentLeaderIndex).toBe(1);
  });

  it('passes the turn to the next player when the leader leaves mid-round', () => {
    const room = roomWithPlayers(6);
    room.startGame();
    const players = room.gameState!.players.map((player) => player.id);

    // Make the third player the leader, then remove them.
    room.gameState!.currentLeaderIndex = 2;
    room.removePlayer(players[2]);

    expect(leaderId(room)).toBe(players[3]);
    expect(room.gameState!.phase).toBe('answering');
  });

  it('keeps the turn order when the leader leaves on the results screen', () => {
    const room = roomWithPlayers(5);
    room.startGame();
    const players = room.gameState!.players.map((player) => player.id);
    room.gameState!.currentLeaderIndex = 1;
    room.gameState!.phase = 'roundResults';

    room.removePlayer(players[1]);
    act(room, room.ownerId!, { type: 'next_round' });

    expect(leaderId(room)).toBe(players[2]);
  });

  it('does not restart a running game on a repeated start', () => {
    const room = roomWithPlayers(4);
    room.startGame();
    const questionId = room.gameState!.questionId;
    act(room, 'p2', { type: 'submit_answer', payload: { text: 'мой ответ' } });

    expect(() => room.startGame()).toThrow();
    expect(room.gameState!.questionId).toBe(questionId);
    expect(room.gameState!.submittedPlayerIds).toEqual(['p2']);

    room.gameState!.phase = 'gameOver';
    expect(() => room.startGame()).not.toThrow();
  });

  it('stops waiting for a player who has been offline longer than the grace period', () => {
    const room = roomWithPlayers(15);
    room.startGame();
    const offline = room.gameState!.players.find((player) => player.id !== leaderId(room))!.id;

    room.markDisconnected(offline);
    submitAll(room, [offline]);
    expect(room.gameState!.phase).toBe('answering');

    vi.advanceTimersByTime(PLAYER_AWAY_GRACE_MS - 1000);
    expect(room.refreshPresence()).toBe(false);
    expect(room.gameState!.phase).toBe('answering');

    vi.advanceTimersByTime(1000);
    expect(room.refreshPresence()).toBe(true);
    const state = room.gameState!;
    expect(state.phase).toBe('judging');
    expect(state.answers).toHaveLength(13);
    expect(state.awayPlayerIds).toEqual([offline]);
    expect(state.funnyVotesRequiredCount).toBe(13);

    const voters = state.players.filter((player) => player.id !== leaderId(room) && player.id !== offline);
    voters.forEach((player) => act(room, player.id, { type: 'vote_funniest', payload: { answerId: state.answers[0].id } }));
    expect(room.gameState!.mostFunnyAnswerId).toBe(state.answers[0].id);
  });

  it('waits for a returning player again', () => {
    const room = roomWithPlayers(4);
    room.startGame();
    const leader = leaderId(room);
    const offline = room.gameState!.players.find((player) => player.id !== leader)!.id;
    room.markDisconnected(offline);
    vi.advanceTimersByTime(PLAYER_AWAY_GRACE_MS);
    submitAll(room, [offline]);
    expect(room.gameState!.phase).toBe('judging');

    const voters = room.gameState!.players.filter((player) => player.id !== leader && player.id !== offline);
    voters.forEach((player) => act(room, player.id, { type: 'vote_funniest', payload: { answerId: room.gameState!.answers[0].id } }));
    expect(room.gameState!.mostFunnyAnswerId).not.toBeNull();

    room.addOrUpdatePlayer(offline, 'Игрок', false, 'male');
    room.refreshPresence();
    expect(room.gameState!.awayPlayerIds).toEqual([]);
    expect(room.gameState!.mostFunnyAnswerId).toBeNull();
  });

  it('skips the turn of a leader who stays offline', () => {
    const room = roomWithPlayers(5);
    room.startGame();
    const players = room.gameState!.players.map((player) => player.id);
    const round = room.gameState!.round;

    room.markDisconnected(players[0]);
    vi.advanceTimersByTime(PLAYER_AWAY_GRACE_MS);
    room.refreshPresence();
    expect(leaderId(room)).toBe(players[0]);

    vi.advanceTimersByTime(LEADER_AWAY_GRACE_MS - PLAYER_AWAY_GRACE_MS);
    expect(room.refreshPresence()).toBe(true);
    expect(leaderId(room)).toBe(players[1]);
    expect(room.gameState!.round).toBe(round + 1);
    expect(room.gameState!.phase).toBe('answering');
  });

  it('lets anyone continue from the results screen when the leader and the host are offline', () => {
    const room = roomWithPlayers(4);
    room.startGame();
    room.gameState!.phase = 'roundResults';
    const leader = leaderId(room);
    expect(leader).toBe(room.ownerId);
    const other = room.gameState!.players.find((player) => player.id !== leader)!.id;

    act(room, other, { type: 'next_round' });
    expect(room.gameState!.phase).toBe('roundResults');

    room.markDisconnected(leader);
    vi.advanceTimersByTime(PLAYER_AWAY_GRACE_MS);
    act(room, other, { type: 'next_round' });
    expect(room.gameState!.phase).toBe('answering');
  });

  it('ignores actions that arrive after their round is over', () => {
    const room = roomWithPlayers(3);
    room.startGame();
    const { round, questionId } = room.gameState!;
    act(room, 'p2', { type: 'submit_answer', payload: { text: 'старый' }, round: round + 1 } as Omit<PlayerAction, 'playerId'>);
    act(room, 'p2', { type: 'submit_answer', payload: { text: 'старый' }, questionId: 'other-question' } as Omit<PlayerAction, 'playerId'>);
    expect(room.gameState!.submittedPlayerIds).toEqual([]);

    act(room, 'p2', { type: 'submit_answer', payload: { text: 'свежий' }, round, questionId } as Omit<PlayerAction, 'playerId'>);
    expect(room.gameState!.submittedPlayerIds).toEqual(['p2']);
  });

  it('keeps a tied funniest pick stable across presence re-checks', () => {
    const room = roomWithPlayers(5);
    room.startGame();
    submitAll(room);
    const state = room.gameState!;
    const voters = state.players.filter((player) => player.id !== leaderId(room));
    voters.forEach((player, index) => act(room, player.id, { type: 'vote_funniest', payload: { answerId: state.answers[index % 2].id } }));
    const picked = room.gameState!.mostFunnyAnswerId;
    expect(picked).not.toBeNull();

    const random = vi.spyOn(Math, 'random');
    try {
      for (const value of [0, 0.99, 0.5, 0.01]) {
        random.mockReturnValue(value);
        room.refreshPresence();
        act(room, leaderId(room), { type: 'finish_judging' });
        expect(room.gameState!.mostFunnyAnswerId).toBe(picked);
      }
    } finally {
      random.mockRestore();
    }
  });

  it('drops the vote of a player who leaves even without an answer of their own', () => {
    const room = roomWithPlayers(5);
    room.startGame();
    const leader = leaderId(room);
    const offline = room.gameState!.players.find((player) => player.id !== leader)!.id;
    room.markDisconnected(offline);
    vi.advanceTimersByTime(PLAYER_AWAY_GRACE_MS);
    submitAll(room, [offline]);
    expect(room.gameState!.phase).toBe('judging');

    room.addOrUpdatePlayer(offline, 'Игрок', false, 'male');
    act(room, offline, { type: 'vote_funniest', payload: { answerId: room.gameState!.answers[0].id } });
    expect(room.gameState!.funnyVotesSubmittedCount).toBe(1);

    room.removePlayer(offline);
    expect(room.gameState!.funnyVotesSubmittedCount).toBe(0);
  });

  it('normalizes names and makes duplicates distinguishable', () => {
    expect(normalizePlayerName('   ')).toBe('Игрок');
    expect(normalizePlayerName('  Саша \n  Петров ')).toBe('Саша Петров');
    expect(Array.from(normalizePlayerName('😀'.repeat(40)))).toHaveLength(24);

    const room = new Room('NAMES1');
    room.addOrUpdatePlayer('a', 'Саша', true);
    room.addOrUpdatePlayer('b', 'саша', false);
    room.addOrUpdatePlayer('c', 'Саша', false);
    expect(room.getLobbyPlayers().map((player) => player.name).sort()).toEqual(['Саша', 'саша 2', 'Саша 3'].sort());
    // Reconnecting keeps the player's own name.
    room.addOrUpdatePlayer('a', 'Саша', true);
    expect(room.players.get('a')?.name).toBe('Саша');
  });

  it('bounds the remembered action ids', () => {
    const room = roomWithPlayers(3);
    room.startGame();
    for (let index = 0; index < 2500; index += 1) {
      act(room, 'p2', { type: 'toggle_answer_reaction', payload: { answerId: 'none', reaction: 'joy' }, actionId: `a${index}` });
    }
    expect(room.processedActionIds.size).toBe(2000);
  });

  it('marks silent HTTP-only players offline and back online when they poll again', () => {
    const room = roomWithPlayers(3);
    const noSocket = () => false;
    vi.advanceTimersByTime(19_000);
    expect(room.expireSilentPlayers(noSocket, 20_000)).toBe(false);
    vi.advanceTimersByTime(2_000);
    expect(room.expireSilentPlayers(noSocket, 20_000)).toBe(true);
    expect(room.players.get('p2')?.connected).toBe(false);

    expect(room.markSeen('p2')).toBe(true);
    expect(room.players.get('p2')?.connected).toBe(true);
  });

  it('keeps a paused game through a long break but cleans it up eventually', () => {
    const room = roomWithPlayers(3);
    room.startGame();
    ['p1', 'p2', 'p3'].forEach((id) => room.markDisconnected(id));
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(room.isStale()).toBe(false);
    vi.advanceTimersByTime(ABANDONED_ROOM_TTL_MS - 60 * 60 * 1000 - 60 * 1000);
    expect(room.isStale()).toBe(false);
    vi.advanceTimersByTime(60 * 1000);
    expect(room.isStale()).toBe(true);
  });
});
