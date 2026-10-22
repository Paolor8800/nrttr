import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';

interface AliveWebSocket extends WebSocket {
  lastSeenAt?: number;
  replaced?: boolean;
}
import { generateRoomCode, isValidRoomCode } from '../src/lib/roomCode.js';
import { ClientMessage, RoomErrorCode, ServerEvent } from './protocol.js';
import { GameState, PlayerAction } from './shared-types.js';
import { Room, RoomError } from './room.js';

const PORT = Number(process.env.PORT || 8080);
const HOST = '0.0.0.0';
const DIST_DIR = resolve(process.cwd(), 'dist');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const rooms = new Map<string, Room>();
const sockets = new Map<WebSocket, { roomCode: string | null; playerId: string | null; sessionId: string | null; intentionalLeave: boolean }>();
const MAX_JSON_BODY_BYTES = 64 * 1024;
const MAX_WS_MESSAGE_BYTES = 64 * 1024;
/** Окно склейки рассылок: при 15 игроках всплеск реакций иначе даёт сотни сообщений подряд. */
const BROADCAST_COALESCE_MS = 25;
const PRESENCE_SWEEP_MS = 5000;
/** Клиент резервного режима опрашивает раз в 2 с; 20 с тишины — он ушёл. */
const HTTP_PRESENCE_TIMEOUT_MS = 20000;

function send(socket: WebSocket, event: ServerEvent) {
  sendRaw(socket, JSON.stringify(event));
}

function sendRaw(socket: WebSocket, payload: string) {
  if (socket.readyState !== WebSocket.OPEN) return;
  try {
    socket.send(payload);
  } catch (error) {
    console.warn('[ws] send failed', error);
  }
}

function sendFatalError(socket: WebSocket, code: RoomErrorCode, message: string) {
  send(socket, { type: 'error', message, code, fatal: true });
  socket.close();
}

function broadcast(roomCode: string, event: ServerEvent, filter?: (socket: WebSocket) => boolean) {
  const payload = JSON.stringify(event);
  for (const [socket, meta] of sockets.entries()) {
    if (meta.roomCode !== roomCode) continue;
    if (filter && !filter(socket)) continue;
    sendRaw(socket, payload);
  }
}

function buildLobbyEvent(room: Room): Extract<ServerEvent, { type: 'lobby_state' }> {
  return {
    type: 'lobby_state',
    roomCode: room.code,
    players: room.getLobbyPlayers(),
    ownerId: room.ownerId,
    gameInProgress: room.isGameInProgress(),
  };
}

function buildPlayerGameState(
  room: Room,
  playerId: string | null,
  shared = { answerReactions: room.getAnswerReactions(), funnyVoteCounts: room.getPublicFunnyVoteCounts() },
): GameState | null {
  const gameState = room.gameState;
  if (!gameState) return null;
  return {
    ...gameState,
    players: gameState.players.map((player) => ({
      ...player,
      hand: player.id === playerId ? player.hand : [],
    })),
    answerReactions: shared.answerReactions,
    myAnswerReactions: room.getMyAnswerReactions(playerId),
    funnyVoteCounts: shared.funnyVoteCounts,
    myFunnyVoteId: room.getMyFunnyVoteId(playerId),
  };
}

function buildRoomSnapshot(room: Room, playerId: string | null) {
  const { type: _type, ...lobby } = buildLobbyEvent(room);
  return { lobby, game: buildPlayerGameState(room, playerId) };
}

/** Полный снимок одному сокету: после identify и по запросу синхронизации. */
function sendRoomSnapshot(socket: WebSocket, room: Room, playerId: string | null) {
  send(socket, buildLobbyEvent(room));
  const state = buildPlayerGameState(room, playerId);
  if (state) send(socket, { type: 'game_state', state });
}

const lastLobbyPayloads = new WeakMap<Room, string>();

function broadcastRoomState(room: Room) {
  // Неизменившееся лобби не рассылаем повторно: новые сокеты получают снимок напрямую при identify.
  const lobbyPayload = JSON.stringify(buildLobbyEvent(room));
  const lobbyChanged = lastLobbyPayloads.get(room) !== lobbyPayload;
  lastLobbyPayloads.set(room, lobbyPayload);
  const shared = room.gameState
    ? { answerReactions: room.getAnswerReactions(), funnyVoteCounts: room.getPublicFunnyVoteCounts() }
    : null;

  for (const [socket, meta] of sockets.entries()) {
    if (meta.roomCode !== room.code) continue;
    if (lobbyChanged) sendRaw(socket, lobbyPayload);
    if (shared && meta.playerId) {
      const state = buildPlayerGameState(room, meta.playerId, shared);
      if (state) send(socket, { type: 'game_state', state });
    }
  }
}

const scheduledBroadcasts = new Set<Room>();

function scheduleBroadcast(room: Room) {
  if (scheduledBroadcasts.has(room)) return;
  scheduledBroadcasts.add(room);
  setTimeout(() => {
    scheduledBroadcasts.delete(room);
    if (rooms.get(room.code) === room) broadcastRoomState(room);
  }, BROADCAST_COALESCE_MS);
}

function deleteRoom(roomCode: string, room: Room) {
  room.endRoom();
  room.setStateChangeListener(null);
  scheduledBroadcasts.delete(room);
  if (rooms.get(roomCode) === room) rooms.delete(roomCode);
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown) {
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function identifyErrorStatus(error: unknown): { status: number; code: RoomErrorCode } {
  if (error instanceof RoomError) {
    return { status: error.code === 'kicked' ? 403 : error.code === 'room_full' ? 409 : 400, code: error.code };
  }
  return { status: 400, code: 'bad_request' };
}

class HttpRequestError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

function resolveIdentifyPlayerId(room: Room, requestedPlayerId: unknown, restoredSession: ReturnType<Room['resolveSession']>) {
  if (restoredSession) return restoredSession.playerId;
  const candidate = typeof requestedPlayerId === 'string' ? requestedPlayerId.trim() : '';
  if (candidate && !room.players.has(candidate)) return candidate;
  return crypto.randomUUID();
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_JSON_BODY_BYTES) {
        tooLarge = true;
        body = '';
        return;
      }
      body += chunk.toString('utf8');
    });
    req.on('end', () => {
      try {
        if (tooLarge) {
          reject(new HttpRequestError('Слишком большой запрос', 413));
          return;
        }
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(new HttpRequestError('Некорректный JSON', 400));
      }
    });
    req.on('error', reject);
  });
}

function attachPlayer(socket: WebSocket, roomCode: string, playerId: string, sessionId: string) {
  for (const [candidateSocket, candidateMeta] of sockets.entries()) {
    if (candidateSocket === socket) continue;
    if (candidateMeta.roomCode === roomCode && candidateMeta.playerId === playerId) {
      try {
        // Mark as replaced so cleanupSocket does not treat this close as a real disconnect
        (candidateSocket as AliveWebSocket).replaced = true;
        candidateSocket.close();
      } catch {
        // ignore close errors for stale sockets
      }
    }
  }

  sockets.set(socket, { roomCode, playerId, sessionId, intentionalLeave: false });
  console.log(`[ws] attached ${playerId.slice(0, 8)} in ${roomCode}, active sockets=${sockets.size}`);
}

function closeRoomForEveryone(roomCode: string, room: Room, reason: string) {
  broadcast(roomCode, { type: 'room_closed', roomCode, reason });
  for (const [candidateSocket, candidateMeta] of sockets.entries()) {
    if (candidateMeta.roomCode === roomCode) candidateSocket.close();
  }
  deleteRoom(roomCode, room);
}

function cleanupSocket(socket: WebSocket) {
  const meta = sockets.get(socket);
  if (!meta) return;
  sockets.delete(socket);
  if (!meta.roomCode || !meta.playerId || !meta.sessionId) return;

  const aliveSocket = socket as AliveWebSocket;
  if (aliveSocket.replaced) {
    console.log(`[ws] replaced socket closed ${meta.playerId.slice(0, 8)} from ${meta.roomCode}`);
    return;
  }

  const room = rooms.get(meta.roomCode);
  if (!room) return;

  console.log(`[ws] socket closed ${meta.playerId.slice(0, 8)} from ${meta.roomCode}, intentional=${meta.intentionalLeave}`);

  if (meta.intentionalLeave) {
    room.clearPlayerSessions(meta.playerId);
    const wasOwner = room.ownerId === meta.playerId;
    room.removePlayer(meta.playerId);

    if (wasOwner) {
      console.log(`[room] host left, closing ${meta.roomCode}`);
      closeRoomForEveryone(meta.roomCode, room, 'host_left');
      return;
    }

    if (room.players.size === 0) {
      console.log(`[room] empty after leave, removing ${meta.roomCode}`);
      deleteRoom(meta.roomCode, room);
      return;
    }

    scheduleBroadcast(room);
    return;
  }

  if (!room.resolveSession(meta.sessionId) && room.playerHasSession(meta.playerId)) {
    console.log(`[ws] stale socket closed while ${meta.playerId.slice(0, 8)} has a newer session in ${meta.roomCode}`);
    scheduleBroadcast(room);
    return;
  }

  room.markDisconnected(meta.playerId);
  if (!room.gameState) {
    room.pruneExpiredLobbyReservations();
    if (room.players.size === 0) {
      console.log(`[room] empty after disconnect, removing ${meta.roomCode}`);
      deleteRoom(meta.roomCode, room);
      return;
    }
  } else {
    room.refreshPresence();
  }
  // Раньше во время партии офлайн-статус никому не рассылался.
  scheduleBroadcast(room);
}

async function serveStatic(urlPath: string) {
  const normalized = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = join(DIST_DIR, normalized);
  try {
    const content = await readFile(filePath);
    return {
      status: 200,
      headers: {
        'content-type': MIME_TYPES[extname(filePath)] || 'application/octet-stream',
        // Файлы в /assets/ содержат хэш в имени; index.html должен перепроверяться после каждого деплоя.
        'cache-control': normalized.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
      },
      body: content,
    };
  } catch {
    if (normalized.startsWith('/assets/')) {
      // Вместо index.html под видом JS (белый экран у клиентов со старой вкладкой после деплоя).
      return { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }, body: 'Not found' };
    }
    const fallback = await readFile(join(DIST_DIR, 'index.html'));
    return {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' },
      body: fallback,
    };
  }
}

function createRoom() {
  let roomCode = generateRoomCode();
  while (rooms.has(roomCode)) roomCode = generateRoomCode();
  const room = new Room(roomCode);
  room.setStateChangeListener(() => scheduleBroadcast(room));
  rooms.set(roomCode, room);
  console.log(`[room] created ${roomCode}, total rooms=${rooms.size}`);
  return room;
}

function closePlayerSockets(roomCode: string, playerId: string, event?: ServerEvent) {
  for (const [candidateSocket, candidateMeta] of sockets.entries()) {
    if (candidateMeta.roomCode === roomCode && candidateMeta.playerId === playerId) {
      if (event) send(candidateSocket, event);
      candidateSocket.close();
    }
  }
}

/** HTTP-запрос с валидной сессией — признак жизни игрока в резервном режиме. */
function notePlayerSeen(room: Room, playerId: string) {
  if (room.markSeen(playerId)) {
    room.refreshPresence();
    scheduleBroadcast(room);
  }
}

async function handleHttpRequest(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || '/', 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/api/health') {
    sendJson(res, 200, { ok: true, rooms: rooms.size, sockets: sockets.size });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/rooms') {
    const room = createRoom();
    sendJson(res, 201, { roomCode: room.code });
    return;
  }

  const roomCodeMatch = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]{6})\/(identify|state|actions|start|kick|sync|leave)$/);
  if (roomCodeMatch) {
    const roomCode = roomCodeMatch[1];
    const endpoint = roomCodeMatch[2];
    const room = rooms.get(roomCode);

    if (!room) {
      sendJson(res, 404, { error: 'Комната не найдена', code: 'room_not_found' });
      return;
    }

    if (endpoint === 'state') {
      const sessionId = url.searchParams.get('sessionId') || undefined;
      const session = sessionId ? room.resolveSession(sessionId) : null;
      if (!session) {
        sendJson(res, 401, { error: 'Сессия не найдена' });
        return;
      }
      notePlayerSeen(room, session.playerId);
      sendJson(res, 200, buildRoomSnapshot(room, session.playerId));
      return;
    }

    let body: Record<string, unknown> = {};
    try {
      body = req.method === 'POST' || req.method === 'PUT' ? await readJsonBody(req) : {};
    } catch (error) {
      const statusCode = error instanceof HttpRequestError ? error.statusCode : 400;
      const message = error instanceof Error ? error.message : 'Некорректный запрос';
      sendJson(res, statusCode, { error: message });
      return;
    }

    if (endpoint === 'identify') {
      try {
        const requestedName = String(body.playerName || '').trim();
        const restoredSession = room.resolveSession(String(body.sessionId || ''));
        const resolvedPlayerId = resolveIdentifyPlayerId(room, body.playerId, restoredSession);
        const effectiveName = restoredSession?.playerName || requestedName;
        const effectiveWantsHost = restoredSession?.isHost ?? Boolean(body.wantsHost);
        const effectiveGender = (body.gender === 'female' ? 'female' : 'male') as ('male' | 'female');
        const joined = room.addOrUpdatePlayer(resolvedPlayerId, effectiveName, effectiveWantsHost, effectiveGender);
        const newSessionId = room.refreshSession(String(body.sessionId || ''), resolvedPlayerId, joined.player.name, joined.player.isHost);
        room.refreshPresence();
        scheduleBroadcast(room);
        sendJson(res, 200, {
          playerId: resolvedPlayerId,
          roomCode,
          sessionId: newSessionId,
          isHost: joined.player.isHost,
        });
      } catch (error) {
        const { status, code } = identifyErrorStatus(error);
        sendJson(res, status, { error: error instanceof Error ? error.message : 'Не удалось войти в комнату', code });
      }
      return;
    }

    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : undefined;
    const session = sessionId ? room.resolveSession(sessionId) : null;

    if (!session) {
      sendJson(res, 401, { error: 'Сессия не найдена' });
      return;
    }

    const playerId = session.playerId;
    notePlayerSeen(room, playerId);

    if (endpoint === 'actions') {
      try {
        const action = body.action as PlayerAction;
        if (!action || typeof action !== 'object' || typeof action.type !== 'string') {
          sendJson(res, 400, { error: 'Неверное действие' });
          return;
        }
        room.processAction(playerId, { ...action, playerId });
        scheduleBroadcast(room);
        sendJson(res, 200, { ok: true });
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : 'Не удалось обработать действие' });
      }
      return;
    }

    if (endpoint === 'start') {
      if (room.ownerId !== playerId) {
        sendJson(res, 403, { error: 'Только хост может начать игру' });
        return;
      }
      if (room.isGameInProgress()) {
        // Повторный старт (двойной клик, повтор запроса) не должен сбрасывать идущую партию.
        sendJson(res, 200, { ok: true, alreadyStarted: true });
        return;
      }
      try {
        room.startGame(Boolean(body.is16Plus));
        scheduleBroadcast(room);
        sendJson(res, 200, { ok: true });
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : 'Не удалось начать игру' });
      }
      return;
    }

    if (endpoint === 'kick') {
      if (room.ownerId !== playerId) {
        sendJson(res, 403, { error: 'Только хост может удалять игроков' });
        return;
      }
      const targetPlayerId = String(body.playerId || '');
      if (!targetPlayerId || targetPlayerId === playerId) {
        sendJson(res, 400, { error: 'Не указан игрок' });
        return;
      }
      try {
        room.kickPlayer(targetPlayerId);
        closePlayerSockets(roomCode, targetPlayerId, { type: 'player_kicked', roomCode });
        scheduleBroadcast(room);
        sendJson(res, 200, { ok: true });
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : 'Не удалось удалить игрока' });
      }
      return;
    }

    if (endpoint === 'sync') {
      sendJson(res, 200, { ok: true, ...buildRoomSnapshot(room, playerId) });
      return;
    }

    if (endpoint === 'leave') {
      try {
        room.clearPlayerSessions(playerId);
        const wasOwner = room.ownerId === playerId;
        room.removePlayer(playerId);

        if (wasOwner) {
          console.log(`[room] host left via HTTP, closing ${roomCode}`);
          closeRoomForEveryone(roomCode, room, 'host_left');
          sendJson(res, 200, { ok: true, roomClosed: true });
          return;
        }

        closePlayerSockets(roomCode, playerId);
        if (room.players.size === 0) {
          console.log(`[room] empty after HTTP leave, removing ${roomCode}`);
          deleteRoom(roomCode, room);
        } else {
          scheduleBroadcast(room);
        }
        sendJson(res, 200, { ok: true, roomClosed: false });
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : 'Не удалось выйти' });
      }
      return;
    }
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/rooms/')) {
    const roomCode = url.pathname.split('/')[3]?.trim().toUpperCase();
    const room = roomCode ? rooms.get(roomCode) : null;
    sendJson(res, 200, {
      exists: Boolean(room),
      players: room ? room.players.size : 0,
      gameInProgress: Boolean(room?.isGameInProgress()),
      isStale: room ? room.isStale() : false,
    });
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    sendJson(res, 404, { error: 'Не найдено' });
    return;
  }

  const staticFile = await serveStatic(url.pathname);
  res.writeHead(staticFile.status, staticFile.headers);
  res.end(staticFile.body);
}

const server = createServer((req, res) => {
  // Необработанная ошибка в async-обработчике раньше роняла весь процесс вместе со всеми комнатами.
  handleHttpRequest(req, res).catch((error) => {
    console.error('[http] request failed', req.method, req.url, error);
    if (!res.headersSent) {
      sendJson(res, 500, { error: 'Внутренняя ошибка сервера' });
    } else {
      res.end();
    }
  });
});

const wss = new WebSocketServer({
  server,
  path: '/ws',
  // По умолчанию ws принимает сообщения до 100 МБ.
  maxPayload: MAX_WS_MESSAGE_BYTES,
  perMessageDeflate: {
    // Only compress messages larger than 1KB to avoid overhead on tiny messages
    threshold: 1024,
  },
});

wss.on('connection', (socket: AliveWebSocket) => {
  sockets.set(socket, { roomCode: null, playerId: null, sessionId: null, intentionalLeave: false });
  console.log(`[ws] new connection, total=${wss.clients.size}`);
  socket.lastSeenAt = Date.now();

  socket.on('pong', () => {
    // Native ws pong and application-level ping are two transports for the
    // same liveness signal; both update the single last-seen clock.
    socket.lastSeenAt = Date.now();
  });

  socket.on('message', (raw) => {
    try {
      socket.lastSeenAt = Date.now();
      const message = JSON.parse(raw.toString()) as ClientMessage;
      const meta = sockets.get(socket);
      if (!meta || !message || typeof message !== 'object') return;

      if (message.type === 'ping') {
        send(socket, { type: 'pong' });
        return;
      }

      if (message.type === 'identify') {
        try {
          const roomCode = String(message.roomCode ?? '').trim().toUpperCase();
          if (!isValidRoomCode(roomCode)) {
            sendFatalError(socket, 'invalid_room', 'Неверный код комнаты');
            return;
          }

          const room = rooms.get(roomCode);
          if (!room) {
            sendFatalError(socket, 'room_not_found', 'Комната не найдена — возможно, сервер перезапускался или игра закончилась');
            return;
          }

          room.pruneExpiredLobbyReservations();
          if (room.isStale()) {
            console.log(`[room] stale cleanup ${roomCode}`);
            deleteRoom(roomCode, room);
            sendFatalError(socket, 'room_stale', 'Комната устарела и была очищена');
            return;
          }

          const requestedName = String(message.playerName ?? '').trim();
          console.log(`[ws] identify ${roomCode} from ${requestedName.slice(0, 24)}, players=${room.players.size}`);

          const restoredSession = room.resolveSession(message.sessionId);
          const playerId = resolveIdentifyPlayerId(room, message.playerId, restoredSession);
          const effectiveName = restoredSession?.playerName || requestedName;
          const effectiveWantsHost = restoredSession?.isHost ?? Boolean(message.wantsHost);
          const effectiveGender = (message.gender === 'female' ? 'female' : 'male') as ('male' | 'female');
          const joined = room.addOrUpdatePlayer(playerId, effectiveName, effectiveWantsHost, effectiveGender);
          const sessionId = room.refreshSession(message.sessionId, playerId, joined.player.name, joined.player.isHost);
          attachPlayer(socket, roomCode, playerId, sessionId);
          room.refreshPresence();

          send(socket, { type: 'connected', playerId, roomCode, sessionId, isHost: joined.player.isHost });
          sendRoomSnapshot(socket, room, playerId);
          scheduleBroadcast(room);
          return;
        } catch (error) {
          const { code } = identifyErrorStatus(error);
          sendFatalError(socket, code, error instanceof Error ? error.message : 'Не удалось войти в комнату');
          return;
        }
      }

      if (!meta.roomCode || !meta.playerId) {
        send(socket, { type: 'error', message: 'Сначала нужно идентифицироваться' });
        return;
      }

      const room = rooms.get(meta.roomCode);
      if (!room) {
        send(socket, { type: 'room_closed', roomCode: meta.roomCode, reason: 'room_missing' });
        return;
      }

      if (message.type === 'start_game') {
        if (room.ownerId !== meta.playerId) {
          send(socket, { type: 'error', message: 'Только хост может начать игру' });
          return;
        }
        if (room.isGameInProgress()) {
          // Повторный старт (двойной клик, повтор после переподключения) не должен сбрасывать партию.
          sendRoomSnapshot(socket, room, meta.playerId);
          return;
        }
        room.startGame(Boolean(message.is16Plus));
        scheduleBroadcast(room);
        return;
      }

      if (message.type === 'request_sync') {
        console.log(`[ws] sync requested by ${meta.playerId?.slice(0, 8)} in ${meta.roomCode}`);
        // Снимок только запросившему: раньше каждое нажатие рассылалось всей комнате.
        sendRoomSnapshot(socket, room, meta.playerId);
        return;
      }

      if (message.type === 'kick_player') {
        if (room.ownerId !== meta.playerId) {
          send(socket, { type: 'error', message: 'Только хост может удалять игроков' });
          return;
        }
        const targetPlayerId = typeof message.playerId === 'string' ? message.playerId : '';
        if (!targetPlayerId || targetPlayerId === meta.playerId) return;
        room.kickPlayer(targetPlayerId);
        closePlayerSockets(meta.roomCode, targetPlayerId, { type: 'player_kicked', roomCode: meta.roomCode });
        scheduleBroadcast(room);
        return;
      }

      if (message.type === 'leave_room') {
        const currentMeta = sockets.get(socket);
        if (currentMeta) {
          currentMeta.intentionalLeave = true;
          sockets.set(socket, currentMeta);
        }
        socket.close();
        return;
      }

      if (message.type === 'player_action') {
        const action = message.action && typeof message.action === 'object' ? message.action : null;
        const actionId = action && typeof action.actionId === 'string' ? action.actionId : null;
        try {
          if (!action || typeof action.type !== 'string') throw new Error('Неверное действие');
          room.processAction(meta.playerId, { ...action, playerId: meta.playerId } as PlayerAction);
          scheduleBroadcast(room);
        } catch (error) {
          send(socket, {
            type: 'action_rejected',
            reason: error instanceof Error ? error.message : 'Не удалось обработать действие',
            actionType: action?.type,
          });
        } finally {
          // Acknowledging duplicates as well as first deliveries lets clients
          // safely retain/resend an outbox entry across reconnects.
          if (actionId) send(socket, { type: 'action_ack', actionId });
        }
      }
    } catch (error) {
      send(socket, { type: 'error', message: error instanceof Error ? error.message : 'Ошибка протокола' });
    }
  });

  socket.on('close', () => cleanupSocket(socket));
  socket.on('error', () => {
    // close handler will perform delayed cleanup
  });
});

function connectedPlayerKeys() {
  const keys = new Set<string>();
  for (const meta of sockets.values()) {
    if (meta.roomCode && meta.playerId) keys.add(`${meta.roomCode}:${meta.playerId}`);
  }
  return keys;
}

// Присутствие: офлайн-игроки резервного режима и игроки, которых раунд больше не ждёт.
setInterval(() => {
  const withSocket = connectedPlayerKeys();
  for (const room of rooms.values()) {
    try {
      const lobbyChanged = room.expireSilentPlayers((playerId) => withSocket.has(`${room.code}:${playerId}`), HTTP_PRESENCE_TIMEOUT_MS);
      const gameChanged = room.refreshPresence();
      if (lobbyChanged || gameChanged) scheduleBroadcast(room);
    } catch (error) {
      console.error(`[presence] sweep failed for ${room.code}`, error);
    }
  }
}, PRESENCE_SWEEP_MS);

setInterval(() => {
  for (const [roomCode, room] of rooms.entries()) {
    room.pruneExpiredLobbyReservations();
    // Раньше комнаты с начатой партией не удалялись никогда (утечка памяти до перезапуска).
    if (room.isStale()) {
      console.log(`[room] stale cleanup ${roomCode}`);
      closeRoomForEveryone(roomCode, room, 'stale');
    }
  }
}, 60 * 1000);

const PING_INTERVAL_MS = 30000;
const PONG_TIMEOUT_MS = 60000;
setInterval(() => {
  for (const client of wss.clients) {
    const socket = client as AliveWebSocket;
    const meta = sockets.get(socket);
    const lastSeenAt = socket.lastSeenAt ?? 0;
    if (Date.now() - lastSeenAt > PONG_TIMEOUT_MS) {
      console.log(`[ws] terminating unresponsive socket ${meta?.playerId?.slice(0, 8) ?? 'unknown'}`);
      socket.terminate();
      continue;
    }
    socket.ping();
  }
}, PING_INTERVAL_MS);

// Сервер держит все комнаты в памяти: одна непойманная ошибка не должна обрывать игру всем.
process.on('unhandledRejection', (reason) => {
  console.error('[process] unhandled rejection', reason);
});
process.on('uncaughtException', (error) => {
  console.error('[process] uncaught exception', error);
});

server.on('error', (error) => {
  console.error('[http] server error', error);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`Server listening on http://${HOST}:${PORT}, rooms in memory, ping interval=${PING_INTERVAL_MS}ms`);
});
