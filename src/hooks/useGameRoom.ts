import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { GameState, Gender, PlayerAction } from '@/types/game';
import { GameSession, clearGameSession, saveGameSession } from '@/lib/gameCookies';
import { toast } from 'sonner';

type LobbyPlayer = { id: string; name: string; gender?: Gender; isHost?: boolean; connected?: boolean };

type ConnectionMode = 'websocket' | 'polling' | 'offline';
type ConnectionStatus = 'connected' | 'connecting' | 'reconnecting' | 'polling' | 'disconnected';

type ServerEvent =
  | { type: 'connected'; playerId: string; roomCode: string; sessionId: string; isHost: boolean }
  | { type: 'lobby_state'; roomCode: string; players: LobbyPlayer[]; ownerId: string | null; gameInProgress: boolean }
  | { type: 'game_state'; state: GameState }
  | { type: 'action_rejected'; reason: string; actionType?: string }
  | { type: 'action_ack'; actionId: string }
  | { type: 'player_kicked'; roomCode: string }
  | { type: 'room_closed'; roomCode: string; reason: string }
  | { type: 'pong' }
  | { type: 'error'; message: string };

type ClientCommand =
  | { type: 'player_action'; action: Omit<PlayerAction, 'playerId'> }
  | { type: 'start_game'; is16Plus?: boolean }
  | { type: 'kick_player'; playerId: string }
  | { type: 'request_sync' }
  | { type: 'leave_room'; intentional?: boolean };

type PollingSnapshot = {
  lobby: {
    roomCode: string;
    players: LobbyPlayer[];
    ownerId: string | null;
    gameInProgress: boolean;
  };
  game: GameState | null;
};

type PollStateResult =
  | { ok: true; snapshot: PollingSnapshot }
  | { ok: false; status: number | null; error: string };

const SESSION_SAVE_MS = 1500;
const HEARTBEAT_INTERVAL_MS = 15000;
const HEARTBEAT_TIMEOUT_MS = 35000;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const POLLING_INTERVAL_MS = 2000;
const DISCONNECTS_WINDOW_MS = 60000;
const DISCONNECTS_THRESHOLD = 3;
const SYNCS_WINDOW_MS = 60000;
const SYNCS_THRESHOLD = 3;
const ACTION_QUEUE_MAX_SIZE = 20;
const HTTP_TIMEOUT_MS = 10000;

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = HTTP_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const parent = init.signal;
  const onAbort = () => controller.abort();
  if (parent) {
    if (parent.aborted) controller.abort();
    else parent.addEventListener('abort', onAbort, { once: true });
  }
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    window.clearTimeout(timeout);
    parent?.removeEventListener('abort', onAbort);
  }
}

function getServerBaseUrl(): string {
  const configured = import.meta.env.VITE_SERVER_URL?.trim();
  if (!configured) return window.location.origin.replace(/\/+$/, '');

  if (/^https?:\/\//i.test(configured)) return configured.replace(/\/+$/, '');

  return new URL(configured, window.location.origin).toString().replace(/\/+$/, '');
}

function getWebSocketUrl(): string {
  const explicitWs = import.meta.env.VITE_WEBSOCKET_URL?.trim();
  if (explicitWs) return explicitWs.replace(/\/+$/, '');

  let baseUrl: string;
  try {
    baseUrl = getServerBaseUrl();
  } catch (error) {
    console.warn('[ws] Failed to parse VITE_SERVER_URL, falling back to origin', error);
    baseUrl = window.location.origin;
  }

  const url = new URL('/ws', baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.search = '';
  url.hash = '';

  if ((url.protocol === 'wss:' && url.port === '443') || (url.protocol === 'ws:' && url.port === '80')) {
    url.port = '';
  }

  return url.toString();
}

async function createRoomOnServer(signal?: AbortSignal): Promise<string> {
  const response = await fetchWithTimeout(`${getServerBaseUrl()}/api/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal,
  });

  if (!response.ok) {
    throw new Error('Не удалось создать комнату на сервере');
  }

  const data = await response.json() as { roomCode: string };
  return data.roomCode;
}

function getStoredGender(): 'male' | 'female' {
  try { return localStorage.getItem('player_gender') === 'female' ? 'female' : 'male'; } catch { return 'male'; }
}

async function httpIdentify(roomCode: string, playerName: string, playerId: string, sessionId: string, wantsHost: boolean, gender: Gender, signal?: AbortSignal): Promise<{ playerId: string; sessionId: string; isHost: boolean } | null> {
  try {
    const response = await fetchWithTimeout(`${getServerBaseUrl()}/api/rooms/${roomCode}/identify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomCode, playerName, gender, playerId, sessionId, wantsHost }), signal,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'HTTP identify failed' }));
      console.error('[http] identify failed', error);
      return null;
    }

    const data = await response.json() as { playerId: string; sessionId: string; isHost: boolean };
    return data;
  } catch (error) {
    console.error('[http] identify error', error);
    return null;
  }
}

async function httpPollState(roomCode: string, sessionId: string, signal?: AbortSignal): Promise<PollStateResult> {
  try {
    const response = await fetchWithTimeout(`${getServerBaseUrl()}/api/rooms/${roomCode}/state?sessionId=${encodeURIComponent(sessionId)}`, {
      method: 'GET',
      headers: { 'content-type': 'application/json' }, signal,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'HTTP poll failed' }));
      console.error('[http] poll failed', error);
      return { ok: false, status: response.status, error: String(error.error || 'HTTP poll failed') };
    }

    return { ok: true, snapshot: await response.json() as PollingSnapshot };
  } catch (error) {
    console.error('[http] poll error', error);
    return { ok: false, status: null, error: error instanceof Error ? error.message : 'HTTP poll error' };
  }
}

async function httpSendCommand(
  roomCode: string,
  sessionId: string,
  endpoint: 'actions' | 'start' | 'kick' | 'sync' | 'leave',
  payload: Record<string, unknown>,
  signal?: AbortSignal
): Promise<boolean> {
  try {
    const body = { sessionId, ...payload };
    const response = await fetchWithTimeout(`${getServerBaseUrl()}/api/rooms/${roomCode}/${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), signal,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'HTTP command failed' }));
      console.error(`[http] ${endpoint} failed`, error);
      return false;
    }

    return true;
  } catch (error) {
    console.error(`[http] ${endpoint} error`, error);
    return false;
  }
}



export function useGameRoom(
  playerName: string,
  roomCode: string | null,
  isHost: boolean,
  restoredSession: GameSession | null = null,
  is16Plus: boolean = false,
  playerGender: Gender = getStoredGender()
) {
  const navigate = useNavigate();
  const [gameState, setGameState] = useState<GameState | null>(restoredSession?.gameState ?? null);
  const [roomCodeState, setRoomCodeState] = useState(restoredSession?.roomCode || roomCode || '');
  const [myId, setMyId] = useState(restoredSession?.myId || '');
  const [sessionId, setSessionId] = useState(restoredSession?.sessionId || '');
  const [connectionMode, setConnectionMode] = useState<ConnectionMode>('websocket');
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('connecting');
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [lobbyPlayers, setLobbyPlayers] = useState<LobbyPlayer[]>(restoredSession?.lobbyPlayers ?? []);
  const [isServerHost, setIsServerHost] = useState(restoredSession?.isHost ?? isHost);
  const [syncPending, setSyncPending] = useState(false);
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [pendingActionsCount, setPendingActionsCount] = useState(0);

  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const syncTimeoutRef = useRef<number | null>(null);
  const heartbeatIntervalRef = useRef<number | null>(null);
  const heartbeatTimeoutRef = useRef<number | null>(null);
  const pollingTimerRef = useRef<number | null>(null);
  const websocketRetryInPollingTimerRef = useRef<number | null>(null);
  const shouldPersistRef = useRef(true);
  const intentionalLeaveRef = useRef(false);
  const currentRoomCodeRef = useRef(roomCodeState);
  const latestModeRef = useRef(is16Plus);
  const latestIdentityRef = useRef({
    myId: restoredSession?.myId || '',
    sessionId: restoredSession?.sessionId || '',
    isHost: restoredSession?.isHost ?? isHost,
  });
  const connectRef = useRef<() => void>();
  const disconnectHistoryRef = useRef<number[]>([]);
  const syncHistoryRef = useRef<number[]>([]);
  const reconnectAttemptRef = useRef(0);
  const connectionModeRef = useRef<ConnectionMode>('websocket');
  const isPollingActiveRef = useRef(false);
  const lastMessageAtRef = useRef<number>(0);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const actionQueueRef = useRef<Array<Omit<PlayerAction, 'playerId'>>>([]);
  const pendingActionAcksRef = useRef(new Map<string, Omit<PlayerAction, 'playerId'>>());
  const transportAbortRef = useRef<AbortController | null>(null);
  const connectionFailureRef = useRef<() => void>(() => {});
  const scheduleReconnectRef = useRef<() => void>(() => {});
  const protocolConnectedRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const updatePendingActionsCount = useCallback(() => {
    setPendingActionsCount(actionQueueRef.current.length + pendingActionAcksRef.current.size);
  }, []);

  const requeuePendingActions = useCallback(() => {
    if (pendingActionAcksRef.current.size === 0) return;
    const pending = Array.from(pendingActionAcksRef.current.values());
    pendingActionAcksRef.current.clear();
    actionQueueRef.current = [...pending, ...actionQueueRef.current].slice(-ACTION_QUEUE_MAX_SIZE);
    updatePendingActionsCount();
  }, [updatePendingActionsCount]);

  const clearActionOutbox = useCallback(() => {
    actionQueueRef.current = [];
    pendingActionAcksRef.current.clear();
    updatePendingActionsCount();
  }, [updatePendingActionsCount]);

  useEffect(() => {
    latestModeRef.current = is16Plus;
  }, [is16Plus]);

  useEffect(() => {
    latestIdentityRef.current = {
      myId,
      sessionId,
      isHost: isServerHost,
    };
  }, [myId, sessionId, isServerHost]);

  useEffect(() => {
    currentRoomCodeRef.current = roomCodeState;
  }, [roomCodeState]);

  useEffect(() => {
    setPendingActionsCount(actionQueueRef.current.length);
  }, [actionQueueRef.current.length]);

  useEffect(() => {
    if (!shouldPersistRef.current) return;
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
    }

    saveTimerRef.current = window.setTimeout(() => {
      if (!currentRoomCodeRef.current || !myId) return;
      saveGameSession({
        roomCode: currentRoomCodeRef.current,
        myId,
        playerName,
        isHost: isServerHost,
        sessionId,
        gameState,
        lobbyPlayers: lobbyPlayers.map(({ id, name, gender }) => ({ id, name, gender })),
        timestamp: Date.now(),
      });
    }, SESSION_SAVE_MS);

    return () => {
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
      }
    };
  }, [gameState, isServerHost, lobbyPlayers, myId, playerName, sessionId]);

  const requestWakeLock = useCallback(async () => {
    if (!('wakeLock' in navigator)) return;
    if (document.hidden) return;
    try {
      if (wakeLockRef.current && !wakeLockRef.current.released) return;
      wakeLockRef.current = await (navigator as Navigator & { wakeLock: { request: (type: string) => Promise<WakeLockSentinel> } }).wakeLock.request('screen');
      wakeLockRef.current.addEventListener('release', () => {
        console.log('[wakeLock] released');
      });
      console.log('[wakeLock] acquired');
    } catch (error) {
      if (document.hidden || (error instanceof DOMException && error.name === 'NotAllowedError')) return;
      console.warn('[wakeLock] failed', error);
    }
  }, []);

  const releaseWakeLock = useCallback(() => {
    if (wakeLockRef.current && !wakeLockRef.current.released) {
      wakeLockRef.current.release().catch(() => {});
      wakeLockRef.current = null;
    }
  }, []);

  const applyServerSnapshot = useCallback((snapshot: PollingSnapshot) => {
    setLobbyPlayers(snapshot.lobby.players);
    setRoomCodeState(snapshot.lobby.roomCode);
    if (snapshot.game) {
      setGameState(snapshot.game);
    }
  }, []);

  const stopHeartbeat = useCallback(() => {
    if (heartbeatIntervalRef.current) {
      window.clearInterval(heartbeatIntervalRef.current);
      heartbeatIntervalRef.current = null;
    }
    if (heartbeatTimeoutRef.current) {
      window.clearTimeout(heartbeatTimeoutRef.current);
      heartbeatTimeoutRef.current = null;
    }
  }, []);

  const resetHeartbeatTimeout = useCallback(() => {
    lastMessageAtRef.current = Date.now();
    if (heartbeatTimeoutRef.current) {
      window.clearTimeout(heartbeatTimeoutRef.current);
    }
    heartbeatTimeoutRef.current = window.setTimeout(() => {
      if (document.hidden) {
        heartbeatTimeoutRef.current = null;
        return;
      }
      console.warn('[ws] heartbeat timeout, reconnecting');
      reconnectTimerRef.current = null;
      requeuePendingActions();
      protocolConnectedRef.current = false;
      socketRef.current?.close();
      socketRef.current = null;
      connectionFailureRef.current();
    }, HEARTBEAT_TIMEOUT_MS);
  }, [requeuePendingActions]);

  const startHeartbeat = useCallback(() => {
    stopHeartbeat();
    heartbeatIntervalRef.current = window.setInterval(() => {
      const socket = socketRef.current;
      if (!document.hidden && socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'ping' }));
      }
    }, HEARTBEAT_INTERVAL_MS);
    resetHeartbeatTimeout();
  }, [stopHeartbeat, resetHeartbeatTimeout]);

  const stopPolling = useCallback(() => {
    if (pollingTimerRef.current) {
      window.clearInterval(pollingTimerRef.current);
      pollingTimerRef.current = null;
    }
    if (websocketRetryInPollingTimerRef.current) {
      window.clearTimeout(websocketRetryInPollingTimerRef.current);
      websocketRetryInPollingTimerRef.current = null;
    }
    isPollingActiveRef.current = false;
    transportAbortRef.current?.abort();
    transportAbortRef.current = null;
  }, []);

  const handlePollingFailure = useCallback((result: Extract<PollStateResult, { ok: false }>) => {
    if (result.status === 401) {
      shouldPersistRef.current = false;
      stopPolling();
      clearGameSession();
      setConnectionStatus('disconnected');
      setConnectionError('Сессия устарела. Нужно войти в комнату заново.');
      toast.error('Сессия устарела. Войди в комнату заново.');
      navigate('/');
      return true;
    }

    if (result.status === 404) {
      shouldPersistRef.current = false;
      stopPolling();
      clearGameSession();
      setGameState(null);
      setLobbyPlayers([]);
      setConnectionStatus('disconnected');
      setConnectionError('Комната закрыта или не найдена');
      toast.error('Комната закрыта');
      navigate('/');
      return true;
    }

    setConnectionError('Резервный режим: не удалось обновить состояние');
    return false;
  }, [navigate, stopPolling]);

  const flushActionQueue = useCallback(async () => {
    if (actionQueueRef.current.length === 0) return;
    if (connectionModeRef.current === 'polling') {
      const queue = [...actionQueueRef.current];
      actionQueueRef.current = [];
      updatePendingActionsCount();
      const failed: Array<Omit<PlayerAction, 'playerId'>> = [];
      for (const action of queue) {
        const roomCode = currentRoomCodeRef.current;
        const sid = latestIdentityRef.current.sessionId;
        if (!roomCode || !sid) continue;
        const ok = await httpSendCommand(roomCode, sid, 'actions', { action }, transportAbortRef.current?.signal);
        if (!ok) failed.push(action);
      }
      if (failed.length > 0) {
        actionQueueRef.current = [...failed, ...actionQueueRef.current].slice(-ACTION_QUEUE_MAX_SIZE);
        updatePendingActionsCount();
        setConnectionError('Часть действий не отправилась и будет повторена');
      }
    } else {
      const socket = socketRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      const queue = [...actionQueueRef.current];
      actionQueueRef.current = [];
      updatePendingActionsCount();
      const failed: Array<Omit<PlayerAction, 'playerId'>> = [];
      for (const action of queue) {
        const actionId = action.actionId;
        if (actionId) {
          pendingActionAcksRef.current.set(actionId, action);
        }
        try {
          socket.send(JSON.stringify({ type: 'player_action', action }));
        } catch {
          if (actionId) pendingActionAcksRef.current.delete(actionId);
          failed.push(action);
        }
      }
      if (failed.length > 0) {
        actionQueueRef.current = [...failed, ...actionQueueRef.current].slice(-ACTION_QUEUE_MAX_SIZE);
      }
      updatePendingActionsCount();
    }
  }, [updatePendingActionsCount]);

  const recoverPollingStartup = useCallback(() => {
    if (!mountedRef.current) return;
    stopPolling();
    connectionModeRef.current = 'websocket';
    setConnectionMode('websocket');
    if (!intentionalLeaveRef.current) {
      scheduleReconnectRef.current();
    }
  }, [stopPolling]);

  const startPolling = useCallback(async () => {
    if (isPollingActiveRef.current) return;
    isPollingActiveRef.current = true;
    connectionModeRef.current = 'polling';
    setConnectionMode('polling');
    setConnectionStatus('connecting');
    setConnectionError('Резервный режим: обновление через HTTP');
    stopHeartbeat();
    transportAbortRef.current?.abort();
    const transportController = new AbortController();
    transportAbortRef.current = transportController;

    console.log('[http] switching to polling mode');

    let targetRoomCode = currentRoomCodeRef.current;
    if (!targetRoomCode) {
      if (!isHost) {
        setConnectionError('Код комнаты не передан');
        recoverPollingStartup();
        return;
      }
      try {
        targetRoomCode = await createRoomOnServer(transportController.signal);
      } catch (error) {
        setConnectionStatus('disconnected');
        setConnectionError('Не удалось создать комнату в резервном режиме');
        recoverPollingStartup();
        return;
      }
      setRoomCodeState(targetRoomCode);
      currentRoomCodeRef.current = targetRoomCode;
    }

    const identity = latestIdentityRef.current;
    const result = await httpIdentify(targetRoomCode, playerName, identity.myId, identity.sessionId, identity.isHost, playerGender, transportController.signal);
    if (!mountedRef.current || transportController.signal.aborted) return;
    if (result) {
      setMyId(result.playerId);
      setSessionId(result.sessionId);
      setIsServerHost(result.isHost);
      latestIdentityRef.current = {
        myId: result.playerId,
        sessionId: result.sessionId,
        isHost: result.isHost,
      };
    } else {
      setConnectionStatus('disconnected');
      setConnectionError('Не удалось войти в комнату в резервном режиме');
      recoverPollingStartup();
      return;
    }

    requeuePendingActions();
    protocolConnectedRef.current = false;
    socketRef.current?.close();
    socketRef.current = null;

    let pollInFlight = false;
    const poll = async () => {
      if (pollInFlight) return;
      const roomCode = currentRoomCodeRef.current;
      const sid = latestIdentityRef.current.sessionId;
      if (!roomCode || !sid) return;
      pollInFlight = true;
      try {
        const pollResult = await httpPollState(roomCode, sid, transportController.signal);
        if (!mountedRef.current || transportController.signal.aborted) return;
        if (pollResult.ok === false) {
          if (handlePollingFailure(pollResult)) stopPolling();
          return;
        }
        applyServerSnapshot(pollResult.snapshot);
        await flushActionQueue();
      } finally {
        pollInFlight = false;
      }
    };

    await poll();
    if (!mountedRef.current || !isPollingActiveRef.current || transportController.signal.aborted) return;
    setConnectionStatus('polling');
    pollingTimerRef.current = window.setInterval(poll, POLLING_INTERVAL_MS);

  }, [applyServerSnapshot, flushActionQueue, handlePollingFailure, isHost, playerName, playerGender, recoverPollingStartup, requeuePendingActions, stopHeartbeat, stopPolling]);

  const scheduleReconnect = useCallback(() => {
    if (intentionalLeaveRef.current) return;
    if (connectionModeRef.current !== 'websocket') return;

    if (reconnectTimerRef.current) {
      window.clearTimeout(reconnectTimerRef.current);
    }

    const attempt = reconnectAttemptRef.current;
    const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, attempt), RECONNECT_MAX_MS);
    const jitter = Math.floor(Math.random() * 1000);
    const totalDelay = delay + jitter;

    reconnectAttemptRef.current = attempt + 1;
    setReconnectAttempt(attempt + 1);
    setConnectionStatus('reconnecting');
    setConnectionError(`Переподключение через ${Math.round(totalDelay / 1000)}с (попытка ${attempt + 1})`);

    console.log(`[ws] reconnect scheduled in ${totalDelay}ms, attempt ${attempt + 1}`);

    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectTimerRef.current = null;
      connectRef.current?.();
    }, totalDelay);
  }, []);
  scheduleReconnectRef.current = scheduleReconnect;

  const recordDisconnect = useCallback(() => {
    const now = Date.now();
    disconnectHistoryRef.current = disconnectHistoryRef.current.filter(t => now - t < DISCONNECTS_WINDOW_MS);
    disconnectHistoryRef.current.push(now);

    if (disconnectHistoryRef.current.length >= DISCONNECTS_THRESHOLD) {
      console.log(`[ws] ${disconnectHistoryRef.current.length} disconnects in ${DISCONNECTS_WINDOW_MS}ms, switching to polling`);
      startPolling();
      return true;
    }
    return false;
  }, [startPolling]);

  useEffect(() => {
    connectionFailureRef.current = () => {
      if (intentionalLeaveRef.current || connectionModeRef.current !== 'websocket') return;
      if (recordDisconnect()) return;
      scheduleReconnect();
    };
  }, [recordDisconnect, scheduleReconnect]);

  const recordSyncPress = useCallback(() => {
    const now = Date.now();
    syncHistoryRef.current = syncHistoryRef.current.filter(t => now - t < SYNCS_WINDOW_MS);
    syncHistoryRef.current.push(now);

    if (syncHistoryRef.current.length >= SYNCS_THRESHOLD && connectionModeRef.current === 'websocket') {
      console.log(`[ws] ${syncHistoryRef.current.length} syncs in ${SYNCS_WINDOW_MS}ms, switching to polling`);
      startPolling();
      return true;
    }
    return false;
  }, [startPolling]);

  const sendMessage = useCallback(async (payload: ClientCommand) => {
    if (connectionModeRef.current === 'polling') {
      const roomCode = currentRoomCodeRef.current;
      const sid = latestIdentityRef.current.sessionId;
      if (!roomCode || !sid) {
        setConnectionError('Нет соединения в резервном режиме');
        return false;
      }

      switch (payload.type) {
        case 'player_action':
          return await httpSendCommand(roomCode, sid, 'actions', { action: payload.action }, transportAbortRef.current?.signal);
        case 'start_game':
          return await httpSendCommand(roomCode, sid, 'start', { is16Plus: payload.is16Plus }, transportAbortRef.current?.signal);
        case 'kick_player':
          return await httpSendCommand(roomCode, sid, 'kick', { playerId: payload.playerId }, transportAbortRef.current?.signal);
        case 'request_sync':
          return await httpSendCommand(roomCode, sid, 'sync', {}, transportAbortRef.current?.signal);
        case 'leave_room':
          return await httpSendCommand(roomCode, sid, 'leave', {}, transportAbortRef.current?.signal);
      }
    }

    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN || !protocolConnectedRef.current) {
      setConnectionError('WebSocket отключён');
      return false;
    }

    try {
      socket.send(JSON.stringify(payload));
      return true;
    } catch (error) {
      console.error('[ws] send failed', error);
      setConnectionError('Не удалось отправить сообщение');
      return false;
    }
  }, []);

  const queueAction = useCallback((action: Omit<PlayerAction, 'playerId'>) => {
    if (actionQueueRef.current.length >= ACTION_QUEUE_MAX_SIZE) {
      actionQueueRef.current.shift();
    }
    actionQueueRef.current.push(action);
    updatePendingActionsCount();
  }, [updatePendingActionsCount]);

  const reconnect = useCallback(() => {
    if (intentionalLeaveRef.current) return;
    if (connectionModeRef.current === 'polling') return;

    if (reconnectTimerRef.current) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    socketRef.current?.close();
    socketRef.current = null;
    connectRef.current?.();
  }, []);

  const forceSyncState = useCallback(async () => {
    if (syncPending) {
      toast.info('Синхронизация уже выполняется');
      return;
    }

    if (recordSyncPress()) {
      toast.info('Переключение в резервный режим из-за нестабильности');
      return;
    }

    if (connectionModeRef.current === 'polling') {
      const roomCode = currentRoomCodeRef.current;
      const sid = latestIdentityRef.current.sessionId;
      if (!roomCode || !sid) {
        toast.warning('Нет данных для синхронизации в резервном режиме');
        return;
      }
      setSyncPending(true);
      const pollResult = await httpPollState(roomCode, sid, transportAbortRef.current?.signal);
      if (pollResult.ok === true) {
        applyServerSnapshot(pollResult.snapshot);
        await flushActionQueue();
        toast.success('Синхронизация в резервном режиме');
      } else {
        handlePollingFailure(pollResult);
        toast.warning(pollResult.error || 'Не удалось синхронизировать в резервном режиме');
      }
      setSyncPending(false);
      return;
    }

    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN || !protocolConnectedRef.current) {
      toast.warning('Соединение не активно, переподключаемся');
      reconnect();
      return;
    }

    setSyncPending(true);
    if (syncTimeoutRef.current) {
      window.clearTimeout(syncTimeoutRef.current);
    }
    syncTimeoutRef.current = window.setTimeout(() => {
      setSyncPending(false);
      toast.warning('Сервер не ответил на синхронизацию');
    }, 5000);

    const ok = await sendMessage({ type: 'request_sync' });
    if (!ok) {
      window.clearTimeout(syncTimeoutRef.current);
      syncTimeoutRef.current = null;
      setSyncPending(false);
      toast.warning('Не удалось запросить синхронизацию');
      return;
    }

    toast.success('Запрошена синхронизация');
  }, [reconnect, syncPending, sendMessage, recordSyncPress, applyServerSnapshot, flushActionQueue, handlePollingFailure]);

  const leaveGame = useCallback(() => {
    shouldPersistRef.current = false;
    intentionalLeaveRef.current = true;
    releaseWakeLock();
    stopPolling();
    clearActionOutbox();
    void sendMessage({ type: 'leave_room', intentional: true });

    return new Promise<void>((resolve) => {
      window.setTimeout(() => {
        clearGameSession();
        socketRef.current?.close();
        socketRef.current = null;
        setGameState(null);
        setLobbyPlayers([]);
        setConnectionStatus('disconnected');
        setConnectionError(null);
        navigate('/');
        resolve();
      }, 150);
    });
  }, [clearActionOutbox, navigate, sendMessage, releaseWakeLock, stopPolling]);

  const kickPlayer = useCallback((targetPlayerId: string) => {
    void sendMessage({ type: 'kick_player', playerId: targetPlayerId });
  }, [sendMessage]);

  const startGame = useCallback(async () => {
    const ok = await sendMessage({ type: 'start_game', is16Plus: latestModeRef.current });
    if (!ok) {
      toast.error('Не удалось отправить команду старта');
    }
  }, [sendMessage]);

  const sendAction = useCallback(async (action: Omit<PlayerAction, 'playerId'>) => {
    const actionWithId = {
      ...action,
      actionId: crypto.randomUUID(),
    };
    const sentOverWebSocket = connectionModeRef.current === 'websocket'
      && socketRef.current?.readyState === WebSocket.OPEN
      && protocolConnectedRef.current;

    if (sentOverWebSocket) {
      pendingActionAcksRef.current.set(actionWithId.actionId!, actionWithId);
      updatePendingActionsCount();
    }

    const ok = await sendMessage({
      type: 'player_action',
      action: actionWithId,
    });

    if (!ok) {
      if (sentOverWebSocket) {
        pendingActionAcksRef.current.delete(actionWithId.actionId!);
      }
      if (
        connectionModeRef.current === 'websocket' &&
        (socketRef.current?.readyState !== WebSocket.OPEN || !protocolConnectedRef.current)
      ) {
        queueAction(actionWithId);
        toast.warning('Действие сохранено и будет отправлено при восстановлении соединения');
      } else if (connectionModeRef.current === 'polling') {
        queueAction(actionWithId);
        setConnectionError('Действие сохранено в очередь и будет повторено');
      } else {
        toast.error('Нет соединения с сервером');
      }
    }
    updatePendingActionsCount();

    return ok;
  }, [queueAction, sendMessage, updatePendingActionsCount]);

  useEffect(() => {
    let cancelled = false;

    const connect = async () => {
      try {
        if (connectionModeRef.current !== 'websocket') {
          console.log('[ws] not in websocket mode, skipping connect');
          return;
        }

        let targetRoomCode = currentRoomCodeRef.current;

        if (!targetRoomCode) {
          if (!isHost) {
            setConnectionError('Код комнаты не передан');
            setConnectionStatus('disconnected');
            return;
          }
          targetRoomCode = await createRoomOnServer();
          if (cancelled) return;
          setRoomCodeState(targetRoomCode);
          currentRoomCodeRef.current = targetRoomCode;
        }

        setConnectionStatus('connecting');
        const wsUrl = getWebSocketUrl();
        console.log('[ws] connecting to', wsUrl);
        const socket = new WebSocket(wsUrl);
        socketRef.current = socket;

        socket.addEventListener('open', () => {
          if (cancelled || socketRef.current !== socket) return;
          protocolConnectedRef.current = false;
          setConnectionStatus('connecting');
          startHeartbeat();
          requestWakeLock();
          const identity = latestIdentityRef.current;
          socket.send(JSON.stringify({
            type: 'identify',
            roomCode: targetRoomCode,
            playerName,
            gender: playerGender,
            playerId: identity.myId,
            sessionId: identity.sessionId,
            wantsHost: identity.isHost,
            is16Plus: latestModeRef.current,
          }));
        });

        socket.addEventListener('message', (event) => {
          if (socketRef.current !== socket || connectionModeRef.current !== 'websocket') {
            return;
          }

          resetHeartbeatTimeout();

          const payload = JSON.parse(event.data) as ServerEvent;

          switch (payload.type) {
            case 'pong':
              break;
            case 'connected':
              intentionalLeaveRef.current = false;
              protocolConnectedRef.current = true;
              setMyId(payload.playerId);
              setSessionId(payload.sessionId);
              setRoomCodeState(payload.roomCode);
              setIsServerHost(payload.isHost);
              setConnectionStatus('connected');
              setConnectionError(null);
              disconnectHistoryRef.current = [];
              syncHistoryRef.current = [];
              reconnectAttemptRef.current = 0;
              setReconnectAttempt(0);
              flushActionQueue();
              break;
            case 'lobby_state':
              setLobbyPlayers(payload.players);
              setSyncPending(false);
              if (syncTimeoutRef.current) {
                window.clearTimeout(syncTimeoutRef.current);
                syncTimeoutRef.current = null;
              }
              break;
            case 'game_state':
              setGameState(payload.state);
              setSyncPending(false);
              if (syncTimeoutRef.current) {
                window.clearTimeout(syncTimeoutRef.current);
                syncTimeoutRef.current = null;
              }
              break;
            case 'action_rejected':
              toast.error(payload.reason);
              break;
            case 'action_ack':
              if (pendingActionAcksRef.current.delete(payload.actionId)) {
                updatePendingActionsCount();
              }
              if (actionQueueRef.current.some((action) => action.actionId === payload.actionId)) {
                actionQueueRef.current = actionQueueRef.current.filter((action) => action.actionId !== payload.actionId);
                updatePendingActionsCount();
              }
              break;
            case 'player_kicked':
              shouldPersistRef.current = false;
              intentionalLeaveRef.current = true;
              releaseWakeLock();
              stopPolling();
              clearGameSession();
              socketRef.current?.close();
              if (reconnectTimerRef.current) {
                window.clearTimeout(reconnectTimerRef.current);
                reconnectTimerRef.current = null;
              }
              toast.error('Тебя удалили из комнаты');
              navigate('/');
              break;
            case 'room_closed':
              shouldPersistRef.current = false;
              intentionalLeaveRef.current = true;
              releaseWakeLock();
              stopPolling();
              clearGameSession();
              socketRef.current?.close();
              if (reconnectTimerRef.current) {
                window.clearTimeout(reconnectTimerRef.current);
                reconnectTimerRef.current = null;
              }
              toast.error(payload.reason === 'game_over' ? 'Игра завершена, комната очищена' : 'Комната закрыта');
              navigate('/');
              break;
            case 'error':
              setConnectionError(payload.message);
              toast.error(payload.message);
              if (!latestIdentityRef.current.myId) {
                intentionalLeaveRef.current = true;
                clearGameSession();
                socket.close();
                if (reconnectTimerRef.current) {
                  window.clearTimeout(reconnectTimerRef.current);
                  reconnectTimerRef.current = null;
                }
                navigate('/');
              }
              break;
          }
        });

        socket.addEventListener('close', () => {
          if (cancelled || socketRef.current !== socket) return;
          protocolConnectedRef.current = false;
          requeuePendingActions();
          stopHeartbeat();
          if (connectionModeRef.current !== 'websocket') {
            return;
          }
          setConnectionStatus('disconnected');

          if (intentionalLeaveRef.current) {
            setConnectionError(null);
            return;
          }

          if (document.hidden) {
            setConnectionError('Соединение приостановлено до возврата в игру');
            return;
          }

          if (recordDisconnect()) {
            return;
          }

          setConnectionError('Соединение потеряно, пытаюсь вернуть тебя в игру');
          scheduleReconnect();
        });

        socket.addEventListener('error', () => {
          if (socketRef.current !== socket) return;
          protocolConnectedRef.current = false;
          if (connectionModeRef.current !== 'websocket') return;
          setConnectionStatus('disconnected');
          setConnectionError('Ошибка WebSocket');
        });
      } catch (error) {
        setConnectionStatus('disconnected');
        setConnectionError(error instanceof Error ? error.message : 'Не удалось подключиться');
      }
    };

    connectRef.current = () => void connect();

    const handleVisibilityChange = () => {
      if (intentionalLeaveRef.current) return;
      if (document.hidden) {
        stopHeartbeat();
        releaseWakeLock();
        return;
      }

      const socket = socketRef.current;
      const now = Date.now();
      const stale = now - lastMessageAtRef.current > HEARTBEAT_TIMEOUT_MS;
      if (!socket || socket.readyState !== WebSocket.OPEN || stale) {
        console.log('[ws] tab visible, reconnecting. stale=', stale);
        if (connectionModeRef.current === 'polling') {
          startPolling();
        } else {
          reconnect();
        }
        return;
      }

      startHeartbeat();
      void requestWakeLock();
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    void connect();

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      stopHeartbeat();
      stopPolling();
      releaseWakeLock();
      socketRef.current?.close();
      if (reconnectTimerRef.current) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (syncTimeoutRef.current) {
        window.clearTimeout(syncTimeoutRef.current);
        syncTimeoutRef.current = null;
      }
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
      }
    };
  }, [isHost, navigate, playerName, playerGender, reconnect, scheduleReconnect, startHeartbeat, stopHeartbeat, stopPolling, releaseWakeLock, startPolling, recordDisconnect, flushActionQueue, resetHeartbeatTimeout, requestWakeLock, requeuePendingActions, updatePendingActionsCount]);

  const connected = connectionStatus === 'connected' || connectionStatus === 'polling';

  return {
    gameState,
    myId,
    roomCode: roomCodeState,
    connected,
    connectionStatus,
    connectionMode,
    connectionError,
    lobbyPlayers,
    syncPending,
    reconnectAttempt,
    pendingActionsCount,
    startGame,
    sendAction,
    leaveGame,
    kickPlayer,
    forceSyncState,
  };
}
