import { GameState, Gender } from '@/types/game';

const COOKIE_NAME = 'uznai_game_session';
const LOCAL_STORAGE_KEY = 'uznai_game_session_v3';
const COOKIE_MAX_AGE = 60 * 60 * 24; // 24 hours

export interface GameSession {
  roomCode: string;
  myId: string;
  playerName: string;
  isHost: boolean;
  sessionId?: string;
  gameState: GameState | null;
  lobbyPlayers?: { id: string; name: string; gender?: Gender }[];
  timestamp: number;
}

type StoredSessionMeta = Omit<GameSession, 'gameState' | 'lobbyPlayers'> & {
  lobbyPlayers?: { id: string; name: string; gender?: Gender }[];
};

function canUseLocalStorage(): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
  } catch {
    return false;
  }
}

function encodeValue(value: unknown): string {
  return btoa(encodeURIComponent(JSON.stringify(value)));
}

function decodeValue<T>(value: string): T {
  return JSON.parse(decodeURIComponent(atob(value))) as T;
}

function isValidSessionMeta(session: Partial<GameSession> | null | undefined): session is StoredSessionMeta {
  return Boolean(
    session &&
    typeof session.roomCode === 'string' &&
    typeof session.myId === 'string' &&
    typeof session.playerName === 'string' &&
    typeof session.isHost === 'boolean' &&
    typeof session.timestamp === 'number' &&
    (typeof session.sessionId === 'undefined' || typeof session.sessionId === 'string')
  );
}

function isExpired(timestamp: number): boolean {
  return Date.now() - timestamp > COOKIE_MAX_AGE * 1000;
}

function saveSessionCookie(session: StoredSessionMeta): void {
  const encoded = encodeValue(session);
  document.cookie = `${COOKIE_NAME}=${encoded}; max-age=${COOKIE_MAX_AGE}; path=/; SameSite=Strict`;
}

function loadSessionCookie(): StoredSessionMeta | null {
  const cookies = document.cookie.split(';');
  const rawCookie = cookies.find(cookie => cookie.trim().startsWith(`${COOKIE_NAME}=`));
  if (!rawCookie) {
    return null;
  }

  const encoded = rawCookie.split('=').slice(1).join('=');
  if (!encoded) {
    return null;
  }

  const session = decodeValue<StoredSessionMeta>(encoded);
  if (!isValidSessionMeta(session) || isExpired(session.timestamp)) {
    return null;
  }

  return session;
}

/**
 * Full session is stored in localStorage because gameState is too large for cookies.
 * Cookie keeps only lightweight metadata so the browser survives reloads and redirects.
 */
export function saveGameSession(session: GameSession): void {
  try {
    const meta: StoredSessionMeta = {
      roomCode: session.roomCode,
      myId: session.myId,
      playerName: session.playerName,
      isHost: session.isHost,
      sessionId: session.sessionId,
      lobbyPlayers: session.lobbyPlayers,
      timestamp: session.timestamp,
    };

    if (canUseLocalStorage()) {
      window.localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(session));
    }

    saveSessionCookie(meta);

    console.log('Game session saved:', {
      roomCode: session.roomCode,
      playerName: session.playerName,
      isHost: session.isHost,
      phase: session.gameState?.phase ?? null,
    });
  } catch (error) {
    console.error('Failed to save game session:', error);
  }
}

export function loadGameSession(): GameSession | null {
  try {
    let session: GameSession | null = null;

    if (canUseLocalStorage()) {
      const raw = window.localStorage.getItem(LOCAL_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as GameSession;
        if (isValidSessionMeta(parsed) && !isExpired(parsed.timestamp)) {
          session = {
            ...parsed,
            gameState: parsed.gameState ?? null,
          };
        }
      }
    }

    if (!session) {
      const cookieSession = loadSessionCookie();
      if (!cookieSession) {
        return null;
      }

      session = {
        ...cookieSession,
        gameState: null,
      };
    }

    if (!isValidSessionMeta(session) || isExpired(session.timestamp)) {
      clearGameSession();
      return null;
    }

    return session;
  } catch (error) {
    console.error('Failed to load game session:', error);
    clearGameSession();
    return null;
  }
}

export function clearGameSession(): void {
  try {
    if (canUseLocalStorage()) {
      window.localStorage.removeItem(LOCAL_STORAGE_KEY);
    }

    document.cookie = `${COOKIE_NAME}=; max-age=0; path=/; SameSite=Strict`;
  } catch (error) {
    console.error('Failed to clear game session:', error);
  }
}

export function hasActiveSession(): boolean {
  return loadGameSession() !== null;
}
