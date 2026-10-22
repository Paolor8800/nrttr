import { describe, expect, it } from 'vitest';
import { Room } from '../../server/room';

describe('server session and delivery invariants', () => {
  it('keeps a valid session stable when identify is retried', () => {
    const room = new Room('RETRY1');
    room.addOrUpdatePlayer('p1', 'Host', true, 'male');

    const first = room.refreshSession(undefined, 'p1', 'Host', true);
    const retry = room.refreshSession(first, 'p1', 'Host', true);

    expect(retry).toBe(first);
    expect(room.sessions.size).toBe(1);
    expect(room.resolveSession(first)?.playerId).toBe('p1');
  });

  it('does not remove a player reservation during a reconnect', () => {
    const room = new Room('RECON1');
    room.addOrUpdatePlayer('p1', 'Host', true, 'male');
    room.markDisconnected('p1');
    expect(room.players.get('p1')?.connected).toBe(false);

    room.addOrUpdatePlayer('p1', 'Host', true, 'male');
    expect(room.players.get('p1')?.connected).toBe(true);
    expect(room.players.size).toBe(1);
  });

  it('treats a duplicate action id as an acknowledged no-op', () => {
    const room = new Room('ACTION1');
    room.addOrUpdatePlayer('p1', 'Host', true, 'male');
    room.addOrUpdatePlayer('p2', 'Player 2', false, 'male');
    room.addOrUpdatePlayer('p3', 'Player 3', false, 'female');
    room.startGame();

    const action = {
      type: 'submit_answer' as const,
      playerId: 'p1',
      actionId: 'same-action',
      payload: { text: 'answer' },
    };
    const first = room.processAction('p1', action);
    const retry = room.processAction('p1', action);

    expect(first.events).toHaveLength(1);
    expect(retry.events).toHaveLength(0);
    expect(room.gameState?.submittedPlayerIds).toEqual(['p1']);
  });
});
