import { describe, it, expect, beforeEach } from 'vitest';
import { saveGameSession, loadGameSession, clearGameSession, hasActiveSession } from '@/lib/gameCookies';
import { GameSession } from '@/lib/gameCookies';

describe('Game Cookies System', () => {
  beforeEach(() => {
    // Очищаем cookies перед каждым тестом
    clearGameSession();
  });

  it('should save and load game session', () => {
    const session: GameSession = {
      roomCode: 'ABC123',
      myId: 'player-1',
      playerName: 'Test Player',
      isHost: true,
      gameState: null,
      lobbyPlayers: [{ id: 'player-1', name: 'Test Player' }],
      timestamp: Date.now(),
    };

    saveGameSession(session);
    const loaded = loadGameSession();

    expect(loaded).not.toBeNull();
    expect(loaded?.roomCode).toBe('ABC123');
    expect(loaded?.playerName).toBe('Test Player');
    expect(loaded?.isHost).toBe(true);
  });

  it('should return null when no session exists', () => {
    const loaded = loadGameSession();
    expect(loaded).toBeNull();
  });

  it('should clear game session', () => {
    const session: GameSession = {
      roomCode: 'ABC123',
      myId: 'player-1',
      playerName: 'Test Player',
      isHost: false,
      gameState: null,
      lobbyPlayers: [{ id: 'player-1', name: 'Test Player' }],
      timestamp: Date.now(),
    };

    saveGameSession(session);
    expect(hasActiveSession()).toBe(true);

    clearGameSession();
    expect(hasActiveSession()).toBe(false);
  });

  it('should detect active session', () => {
    expect(hasActiveSession()).toBe(false);

    const session: GameSession = {
      roomCode: 'XYZ789',
      myId: 'player-2',
      playerName: 'Another Player',
      isHost: false,
      gameState: null,
      lobbyPlayers: [{ id: 'player-2', name: 'Another Player' }],
      timestamp: Date.now(),
    };

    saveGameSession(session);
    expect(hasActiveSession()).toBe(true);
  });

  it('should reject expired session', () => {
    const session: GameSession = {
      roomCode: 'OLD123',
      myId: 'player-3',
      playerName: 'Old Player',
      isHost: true,
      gameState: null,
      lobbyPlayers: [{ id: 'player-3', name: 'Old Player' }],
      timestamp: Date.now() - (25 * 60 * 60 * 1000), // 25 часов назад
    };

    saveGameSession(session);
    const loaded = loadGameSession();

    expect(loaded).toBeNull();
    expect(hasActiveSession()).toBe(false);
  });

  it('should handle corrupted cookie data', () => {
    // Устанавливаем поврежденный cookie
    document.cookie = 'uznai_game_session=corrupted_data; path=/';

    const loaded = loadGameSession();
    expect(loaded).toBeNull();
    expect(hasActiveSession()).toBe(false);
  });

  it('should validate session structure', () => {
    // Сохраняем сессию с неполными данными
    const invalidSession = {
      roomCode: 'TEST123',
      // Отсутствуют обязательные поля
    };

    const encoded = btoa(encodeURIComponent(JSON.stringify(invalidSession)));
    document.cookie = `uznai_game_session=${encoded}; path=/`;

    const loaded = loadGameSession();
    expect(loaded).toBeNull();
  });
});
