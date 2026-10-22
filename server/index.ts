import { createServer, type IncomingMessage } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';

interface AliveWebSocket extends WebSocket {
  lastSeenAt?: number;
  replaced?: boolean;
}
import { generateRoomCode, isValidRoomCode } from '../src/lib/roomCode.js';
import { ClientMessage, ServerEvent } from './protocol.js';
import { PlayerAction } from './shared-types.js';
import { Room } from './room.js';

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
};

const rooms = new Map<string, Room>();
const sockets = new Map<WebSocket, { roomCode: string | null; playerId: string | null; sessionId: string | null; intentionalLeave: boolean }>();
const disconnectTimers = new Map<string, NodeJS.Timeout>();
const MAX_JSON_BODY_BYTES = 64 * 1024;

function send(socket: WebSocket, event: ServerEvent) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(event));
  }
}

function broadcast(roomCode: string, event: ServerEvent, filter?: (socket: WebSocket) => boolean) {
  for (const [socket, meta] of sockets.entries()) {
    if (meta.roomCode !== roomCode) continue;
    if (filter && !filter(socket)) continue;
    send(socket, event);
  }
}

function buildRoomSnapshot(room: Room, playerId: string | null) {
  const gameState = room.gameState;
  const filteredGameState = gameState
    ? {
        ...gameState,
        players: gameState.players.map((player) => ({
          ...player,
          hand: player.id === playerId ? player.hand : [],
        })),
        answerReactions: room.getAnswerReactions(),
        myAnswerReactions: room.getMyAnswerReactions(playerId),
        funnyVoteCounts: room.getPublicFunnyVoteCounts(),
        myFunnyVoteId: room.getMyFunnyVoteId(playerId),
      }
    : null;

  return {
    lobby: {
      roomCode: room.code,
      players: room.getLobbyPlayers(),
      ownerId: room.ownerId,
      gameInProgress: Boolean(gameState && gameState.phase !== 'gameOver'),
    },
    game: filteredGameState,
  };
}

function broadcastRoomState(room: Room) {
  const snapshot = buildRoomSnapshot(room, null);
  broadcast(room.code, {
    type: 'lobby_state',
    ...snapshot.lobby,
  });

  if (room.gameState) {
    for (const [socket, meta] of sockets.entries()) {
      if (meta.roomCode !== room.code || !meta.playerId) continue;
      const playerState = structuredClone(room.gameState);
      playerState.players = playerState.players.map((player) => ({
        ...player,
        hand: player.id === meta.playerId ? player.hand : [],
      }));
      playerState.answerReactions = room.getAnswerReactions();
      playerState.myAnswerReactions = room.getMyAnswerReactions(meta.playerId);
      playerState.funnyVoteCounts = room.getPublicFunnyVoteCounts();
      playerState.myFunnyVoteId = room.getMyFunnyVoteId(meta.playerId);
      send(socket, { type: 'game_state', state: playerState });
    }
  }
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
  const disconnectKey = `${roomCode}:${playerId}`;
  const existingTimer = disconnectTimers.get(disconnectKey);
  if (existingTimer) {
    clearTimeout(existingTimer);
    disconnectTimers.delete(disconnectKey);
  }

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
      for (const [candidateSocket, candidateMeta] of sockets.entries()) {
        if (candidateMeta.roomCode === meta.roomCode) {
          send(candidateSocket, { type: 'room_closed', roomCode: meta.roomCode, reason: 'host_left' });
          candidateSocket.close();
        }
      }
      room.endRoom();
      rooms.delete(meta.roomCode);
      return;
    }

    if (room.players.size === 0) {
      console.log(`[room] empty after leave, removing ${meta.roomCode}`);
      room.endRoom();
      rooms.delete(meta.roomCode);
      return;
    }

    broadcastRoomState(room);
    return;
  }

  if (!room.resolveSession(meta.sessionId) && room.playerHasSession(meta.playerId)) {
    console.log(`[ws] stale socket closed while ${meta.playerId.slice(0, 8)} has a newer session in ${meta.roomCode}`);
    broadcastRoomState(room);
    return;
  }

  room.markDisconnected(meta.playerId);
  if (!room.gameState) {
    room.pruneExpiredLobbyReservations();
    if (room.players.size === 0) {
      console.log(`[room] empty after disconnect, removing ${meta.roomCode}`);
      room.endRoom();
      rooms.delete(meta.roomCode);
      return;
    }
    broadcastRoomState(room);
  }
}

async function serveStatic(urlPath: string) {
  const normalized = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = join(DIST_DIR, normalized);
  try {
    const content = await readFile(filePath);
    return {
      status: 200,
      headers: { 'content-type': MIME_TYPES[extname(filePath)] || 'application/octet-stream' },
      body: content,
    };
  } catch {
    const fallback = await readFile(join(DIST_DIR, 'index.html'));
    return {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: fallback,
    };
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/api/health') {
    console.log(`[health] ${req.method} ${url.pathname} rooms=${rooms.size}`);
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/rooms') {
    const roomCode = generateRoomCode();
    const room = new Room(roomCode);
    room.setStateChangeListener(() => broadcastRoomState(room));
    rooms.set(roomCode, room);
    console.log(`[room] created ${roomCode}, total rooms=${rooms.size}`);
    res.writeHead(201, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ roomCode }));
    return;
  }

  const roomCodeMatch = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]{6})\/(identify|state|actions|start|kick|sync|leave)$/);
  if (roomCodeMatch) {
    const roomCode = roomCodeMatch[1];
    const endpoint = roomCodeMatch[2];
    const room = rooms.get(roomCode);

    if (!room) {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Комната не найдена' }));
      return;
    }

    if (endpoint === 'state') {
      const sessionId = url.searchParams.get('sessionId') || undefined;
      const session = sessionId ? room.resolveSession(sessionId) : null;
      if (!session) {
        res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Сессия не найдена' }));
        return;
      }
      const snapshot = buildRoomSnapshot(room, session.playerId);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(snapshot));
      return;
    }

    let body: Record<string, unknown> = {};
    try {
      body = req.method === 'POST' || req.method === 'PUT' ? await readJsonBody(req) : {};
    } catch (error) {
      const statusCode = error instanceof HttpRequestError ? error.statusCode : 400;
      const message = error instanceof Error ? error.message : 'Некорректный запрос';
      res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: message }));
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
        broadcastRoomState(room);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          playerId: resolvedPlayerId,
          roomCode,
          sessionId: newSessionId,
          isHost: joined.player.isHost,
        }));
        return;
      } catch (error) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Не удалось войти в комнату' }));
        return;
      }
    }

    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : undefined;
    const session = sessionId ? room.resolveSession(sessionId) : null;

    if (!session) {
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Сессия не найдена' }));
      return;
    }

    const playerId = session.playerId;

    if (endpoint === 'actions') {
      try {
        const action = body.action as PlayerAction;
        if (!action || typeof action.type !== 'string') {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'Неверное действие' }));
          return;
        }
        room.processAction(playerId, { ...action, playerId });
        broadcastRoomState(room);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true }));
        return;
      } catch (error) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Не удалось обработать действие' }));
        return;
      }
    }

    if (endpoint === 'start') {
      if (room.ownerId !== playerId) {
        res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Только хост может начать игру' }));
        return;
      }
      try {
        room.startGame(Boolean(body.is16Plus));
        broadcastRoomState(room);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true }));
      } catch (error) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Не удалось начать игру' }));
      }
      return;
    }

    if (endpoint === 'kick') {
      if (room.ownerId !== playerId) {
        res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Только хост может удалять игроков' }));
        return;
      }
      const targetPlayerId = String(body.playerId || '');
      if (!targetPlayerId) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Не указан игрок' }));
        return;
      }
      try {
        room.kickPlayer(targetPlayerId);
        for (const [candidateSocket, candidateMeta] of sockets.entries()) {
          if (candidateMeta.roomCode === roomCode && candidateMeta.playerId === targetPlayerId) {
            send(candidateSocket, { type: 'player_kicked', roomCode });
            candidateSocket.close();
          }
        }
        broadcastRoomState(room);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true }));
      } catch (error) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Не удалось удалить игрока' }));
      }
      return;
    }

    if (endpoint === 'sync') {
      broadcastRoomState(room);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (endpoint === 'leave') {
      try {
        room.clearPlayerSessions(playerId);
        const wasOwner = room.ownerId === playerId;
        room.removePlayer(playerId);

        if (wasOwner) {
          console.log(`[room] host left via HTTP, closing ${roomCode}`);
          for (const [candidateSocket, candidateMeta] of sockets.entries()) {
            if (candidateMeta.roomCode === roomCode) {
              send(candidateSocket, { type: 'room_closed', roomCode, reason: 'host_left' });
              candidateSocket.close();
            }
          }
          room.endRoom();
          rooms.delete(roomCode);
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, roomClosed: true }));
          return;
        }

        if (room.players.size === 0) {
          console.log(`[room] empty after HTTP leave, removing ${roomCode}`);
          room.endRoom();
          rooms.delete(roomCode);
        } else {
          broadcastRoomState(room);
        }

        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, roomClosed: false }));
      } catch (error) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Не удалось выйти' }));
      }
      return;
    }
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/rooms/')) {
    const roomCode = url.pathname.split('/')[3]?.trim().toUpperCase();
    const room = roomCode ? rooms.get(roomCode) : null;
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      exists: Boolean(room),
      players: room ? room.players.size : 0,
      gameInProgress: Boolean(room?.gameState && room.gameState.phase !== 'gameOver'),
      isStale: room ? room.isStale() : false,
    }));
    return;
  }

  const staticFile = await serveStatic(url.pathname);
  res.writeHead(staticFile.status, staticFile.headers);
  res.end(staticFile.body);
});

const wss = new WebSocketServer({
  server,
  path: '/ws',
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
      if (!meta) return;

      if (message.type === 'ping') {
        send(socket, { type: 'pong' });
        return;
      }

      if (message.type === 'identify') {
        try {
          const roomCode = message.roomCode.trim().toUpperCase();
          if (!isValidRoomCode(roomCode)) {
            send(socket, { type: 'error', message: 'Неверный код комнаты' });
            socket.close();
            return;
          }

          const room = rooms.get(roomCode);
          if (!room) {
            send(socket, { type: 'error', message: 'Комната не найдена' });
            socket.close();
            return;
          }

          room.pruneExpiredLobbyReservations();
          if (room.isStale()) {
            console.log(`[room] stale cleanup ${roomCode}`);
            room.endRoom();
            rooms.delete(roomCode);
            send(socket, { type: 'error', message: 'Комната устарела и была очищена' });
            socket.close();
            return;
          }

          console.log(`[ws] identify ${roomCode} from ${message.playerName}, room exists=${rooms.has(roomCode)}, players=${room.players.size}`);

          const requestedName = message.playerName.trim();
          const restoredSession = room.resolveSession(message.sessionId);
          const playerId = resolveIdentifyPlayerId(room, message.playerId, restoredSession);
          const effectiveName = restoredSession?.playerName || requestedName;
          const effectiveWantsHost = restoredSession?.isHost ?? Boolean(message.wantsHost);
          const effectiveGender = (message.gender === 'female' ? 'female' : 'male') as ('male' | 'female');
          const joined = room.addOrUpdatePlayer(playerId, effectiveName, effectiveWantsHost, effectiveGender);
          const sessionId = room.refreshSession(message.sessionId, playerId, joined.player.name, joined.player.isHost);
          attachPlayer(socket, roomCode, playerId, sessionId);

          send(socket, { type: 'connected', playerId, roomCode, sessionId, isHost: joined.player.isHost });
          broadcastRoomState(room);
          return;
        } catch (error) {
          send(socket, { type: 'error', message: error instanceof Error ? error.message : 'Не удалось войти в комнату' });
          socket.close();
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
        room.startGame(Boolean(message.is16Plus));
        broadcastRoomState(room);
        return;
      }

      if (message.type === 'request_sync') {
        console.log(`[ws] sync requested by ${meta.playerId?.slice(0, 8)} in ${meta.roomCode}`);
        broadcastRoomState(room);
        return;
      }

      if (message.type === 'kick_player') {
        if (room.ownerId !== meta.playerId) {
          send(socket, { type: 'error', message: 'Только хост может удалять игроков' });
          return;
        }
        room.kickPlayer(message.playerId);
        for (const [candidateSocket, candidateMeta] of sockets.entries()) {
          if (candidateMeta.roomCode === meta.roomCode && candidateMeta.playerId === message.playerId) {
            send(candidateSocket, { type: 'player_kicked', roomCode: meta.roomCode });
            candidateSocket.close();
          }
        }
        broadcastRoomState(room);
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
        const actionId = typeof message.action.actionId === 'string' ? message.action.actionId : null;
        try {
          room.processAction(meta.playerId, { ...message.action, playerId: meta.playerId } as PlayerAction);
          broadcastRoomState(room);
        } catch (error) {
          send(socket, {
            type: 'action_rejected',
            reason: error instanceof Error ? error.message : 'Не удалось обработать действие',
            actionType: message.action.type,
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

setInterval(() => {
  for (const [roomCode, room] of rooms.entries()) {
    if (room.gameState) continue;
    room.pruneExpiredLobbyReservations();
    if (room.isStale()) {
      console.log(`[room] stale cleanup ${roomCode}`);
      room.endRoom();
      rooms.delete(roomCode);
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

server.listen(PORT, HOST, () => {
  console.log(`Server listening on http://${HOST}:${PORT}, rooms in memory, ping interval=${PING_INTERVAL_MS}ms`);
});
