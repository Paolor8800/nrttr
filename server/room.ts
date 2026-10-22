import { generateRoomCode } from '../src/lib/roomCode.js';
import { MAX_PLAYERS, MAX_PLAYER_NAME_LENGTH, MIN_PLAYERS } from '../src/lib/roomLimits.js';
import { GameState, PlayerAction, Player, Gender, ReactionType, AnswerReactionCounts, MyAnswerReactions, FunnyVoteCounts, CasinoBetType, HOST_ANSWER_REACTION_ID } from './shared-types.js';
import { GameEvent } from './shared-events.js';
import { LobbyPlayer, RoomErrorCode } from './protocol.js';
import { pickQuestion, questionsForGender, renderQuestion } from '../src/data/questions.js';
import { ROULETTE_NUMBERS, rouletteColorForNumber } from '../src/lib/casinoRoulette.js';
import { buildAnonymizedAnswers, computeRoundScores, applyDeltas, pickWinnerId } from './shared-handlers.js';

function envMs(name: string, fallback: number): number {
  const value = Number(typeof process !== 'undefined' ? process.env?.[name] : undefined);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

const TARGET_SCORE = 20; // первый, кто набирает столько очков — победитель
const LOBBY_RESERVATION_TTL_MS = 5 * 60 * 1000;
const EMPTY_ROOM_TTL_MS = 5 * 60 * 1000;
/** Компания может уйти на долгий перерыв с выключенными телефонами — партия должна дождаться. */
export const ABANDONED_ROOM_TTL_MS = 6 * 60 * 60 * 1000;
const PROCESSED_ACTION_IDS_LIMIT = 2000;
/** Через столько офлайна игрок перестаёт блокировать ответы и голосование. */
export const PLAYER_AWAY_GRACE_MS = envMs('PLAYER_AWAY_GRACE_MS', 30_000);
/** Через столько офлайна ведущий теряет ход, иначе раунд зависает навсегда. */
export const LEADER_AWAY_GRACE_MS = envMs('LEADER_AWAY_GRACE_MS', 60_000);
const ROUND_BOUND_ACTIONS = new Set<PlayerAction['type']>([
  'submit_answer',
  'select_most_correct',
  'guess_author',
  'vote_funniest',
  'toggle_answer_reaction',
  'finish_judging',
  'next_round',
]);
const CASINO_PAYOUTS: Record<CasinoBetType, number> = {
  red: 2,
  black: 2,
  number: 4,
  zero: 6,
};
const CASINO_ENDGAME_FORCE_SCORES = new Set([18, 19]);
const CASINO_FORCED_LOSS_COUNT = 5;

type NormalizedCasinoBet = { betType: CasinoBetType; betNumber: number | null };

export class RoomError extends Error {
  constructor(readonly code: RoomErrorCode, message: string) {
    super(message);
  }
}

export function normalizePlayerName(raw: unknown): string {
  const cleaned = String(raw ?? '')
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Array.from не режет эмодзи (суррогатные пары) пополам.
  return Array.from(cleaned).slice(0, MAX_PLAYER_NAME_LENGTH).join('').trim() || 'Игрок';
}

function isStaleRoundAction(action: PlayerAction, state: GameState): boolean {
  if (!ROUND_BOUND_ACTIONS.has(action.type)) return false;
  if (typeof action.round === 'number' && action.round !== state.round) return true;
  return typeof action.questionId === 'string' && action.questionId !== state.questionId;
}

function normalizeCasinoBet(payload: unknown): NormalizedCasinoBet | null {
  const { betType, betNumber } = (payload ?? {}) as { betType?: unknown; betNumber?: unknown };
  if (betType === 'red' || betType === 'black' || betType === 'zero') {
    return { betType, betNumber: null };
  }
  if (betType === 'number') {
    const numericBet = typeof betNumber === 'number' ? Math.trunc(betNumber) : Number.NaN;
    if (numericBet >= 1 && numericBet <= 36) {
      return { betType, betNumber: numericBet };
    }
  }
  return null;
}

function casinoBetWins(bet: NormalizedCasinoBet, resultNumber: number): boolean {
  const resultColor = rouletteColorForNumber(resultNumber);
  if (bet.betType === 'zero') return resultNumber === 0;
  if (bet.betType === 'number') return resultNumber === bet.betNumber;
  return resultColor === bet.betType;
}

function pickCasinoNumber(candidates = ROULETTE_NUMBERS): number {
  const index = Math.min(candidates.length - 1, Math.floor(Math.random() * candidates.length));
  return candidates[index] ?? 0;
}

function pickCasinoLossNumber(bet: NormalizedCasinoBet): number {
  const losingNumbers = ROULETTE_NUMBERS.filter((number) => !casinoBetWins(bet, number));
  return pickCasinoNumber(losingNumbers);
}

function hasEnoughFreshQuestionsForPlayers(players: Player[], usedQuestionIds: string[]): boolean {
  const available = new Set(
    players
      .flatMap((player) => questionsForGender((player.gender ?? 'male') as Gender))
      .map((question) => question.id)
      .filter((questionId) => !usedQuestionIds.includes(questionId)),
  );

  const slots = players
    .map((player) => (player.gender ?? 'male') as Gender)
    .sort((a, b) => (
      questionsForGender(a).filter((question) => available.has(question.id)).length -
      questionsForGender(b).filter((question) => available.has(question.id)).length
    ));

  for (const gender of slots) {
    const question = questionsForGender(gender)
      .filter((candidate) => available.has(candidate.id))
      .sort((a, b) => {
        const aExact = a.target === gender ? 0 : 1;
        const bExact = b.target === gender ? 0 : 1;
        return aExact - bExact;
      })[0];

    if (!question) return false;
    available.delete(question.id);
  }

  return true;
}

export class Room {
  readonly code: string;
  readonly createdAt: number;
  ownerId: string | null;
  players = new Map<string, LobbyPlayer>();
  sessions = new Map<string, { playerId: string; playerName: string; isHost: boolean }>();
  kickedPlayerIds = new Set<string>();
  reservedPlayers = new Set<string>();
  reservedAt = new Map<string, number>();
  processedActionIds = new Set<string>();
  gameState: GameState | null = null;
  onStateChanged: (() => void) | null = null;

  // --- Приватное состояние игры (НИКОГДА не попадает в рассылаемый gameState) ---
  /** Ответы текущего раунда: playerId -> текст (в фазе answering). */
  private submissions = new Map<string, string>();
  /** Карта авторства анонимных ответов: answerId -> playerId. */
  private authorByAnswerId: Record<string, string> = {};
  private answerReactionPlayers: Record<string, Partial<Record<ReactionType, Set<string>>>> = {};
  private funniestVotes = new Map<string, string>();
  /** Уже заданные id вопросов в серии игр этой комнаты. */
  private usedQuestionIds: string[] = [];
  private casinoForcedLosses = new Map<string, number>();
  /** Последний выбор при ничьей за «самый смешной», чтобы он не менялся при каждом пересчёте. */
  private funnyTieBreak: { key: string; winner: string } | null = null;
  /** Когда игрок последний раз был виден по HTTP (резервный режим без WebSocket). */
  private lastSeenAt = new Map<string, number>();
  private lastActivityAt: number;

  constructor(code?: string) {
    this.code = code ?? generateRoomCode();
    this.ownerId = null;
    this.createdAt = Date.now();
    this.lastActivityAt = this.createdAt;
  }

  static create() {
    return new Room();
  }

  setStateChangeListener(listener: (() => void) | null) {
    this.onStateChanged = listener;
  }

  isGameInProgress() {
    return Boolean(this.gameState && this.gameState.phase !== 'gameOver');
  }

  addOrUpdatePlayer(playerId: string, name: string, wantsHost: boolean, gender: Gender = 'male') {
    if (this.kickedPlayerIds.has(playerId)) {
      throw new RoomError('kicked', 'Тебя удалили из этой комнаты');
    }

    if (!this.players.has(playerId) && this.players.size >= MAX_PLAYERS) {
      throw new RoomError('room_full', `Комната заполнена (максимум ${MAX_PLAYERS} игроков)`);
    }

    const existing = this.players.get(playerId);
    if (!this.ownerId && wantsHost) {
      this.ownerId = playerId;
    }

    const player: LobbyPlayer = {
      id: playerId,
      name: this.uniquePlayerName(playerId, normalizePlayerName(name)),
      gender,
      isHost: this.ownerId === playerId,
      connected: true,
    };

    this.players.set(playerId, player);
    this.reservedPlayers.delete(playerId);
    this.reservedAt.delete(playerId);
    this.lastSeenAt.set(playerId, Date.now());
    this.lastActivityAt = Date.now();
    return { player, isNew: !existing };
  }

  /** Одинаковые имена мешают ведущему угадывать авторов, поэтому дубли получают номер. */
  private uniquePlayerName(playerId: string, name: string): string {
    const taken = new Set(
      Array.from(this.players.values())
        .filter((player) => player.id !== playerId)
        .map((player) => player.name.toLocaleLowerCase('ru')),
    );
    if (!taken.has(name.toLocaleLowerCase('ru'))) return name;
    for (let index = 2; index <= MAX_PLAYERS + 1; index += 1) {
      const suffix = ` ${index}`;
      const candidate = Array.from(name).slice(0, MAX_PLAYER_NAME_LENGTH - suffix.length).join('').trim() + suffix;
      if (!taken.has(candidate.toLocaleLowerCase('ru'))) return candidate;
    }
    return name;
  }

  issueSession(playerId: string, playerName: string, isHost: boolean) {
    const sessionId = crypto.randomUUID();
    this.sessions.set(sessionId, { playerId, playerName, isHost });
    return sessionId;
  }

  resolveSession(sessionId: string | undefined | null) {
    if (!sessionId) return null;
    return this.sessions.get(sessionId) ?? null;
  }

  refreshSession(previousSessionId: string | undefined | null, playerId: string, playerName: string, isHost: boolean) {
    // Identify is retried when the connected response is lost. Keep a valid
    // session stable so the retry cannot create a second identity/session.
    if (previousSessionId) {
      const existing = this.sessions.get(previousSessionId);
      if (existing?.playerId === playerId) {
        existing.playerName = playerName;
        existing.isHost = isHost;
        return previousSessionId;
      }
      this.sessions.delete(previousSessionId);
    }
    return this.issueSession(playerId, playerName, isHost);
  }

  removeSession(sessionId: string) {
    this.sessions.delete(sessionId);
  }

  playerHasSession(playerId: string) {
    for (const session of this.sessions.values()) {
      if (session.playerId === playerId) return true;
    }
    return false;
  }


  getLobbyPlayers(): LobbyPlayer[] {
    return Array.from(this.players.values()).sort((a, b) => {
      if (a.id === this.ownerId) return -1;
      if (b.id === this.ownerId) return 1;
      return a.name.localeCompare(b.name, 'ru');
    });
  }

  canStart() {
    return this.players.size >= MIN_PLAYERS;
  }

  /** Пустая комната живёт 5 минут, комната, где все офлайн, — 6 часов (раньше партии не чистились никогда). */
  isStale(now = Date.now()) {
    const anyoneConnected = Array.from(this.players.values()).some((player) => player.connected !== false);
    if (anyoneConnected) return false;
    const idleFor = now - this.lastActivityAt;
    return idleFor >= (this.players.size === 0 ? EMPTY_ROOM_TTL_MS : ABANDONED_ROOM_TTL_MS);
  }


  startGame(_is16Plus?: boolean) {
    if (this.isGameInProgress()) {
      throw new Error('Игра уже идёт');
    }
    if (this.players.size < MIN_PLAYERS) {
      throw new Error(`Нужно минимум ${MIN_PLAYERS} игрока`);
    }
    const lobby = this.getLobbyPlayers();
    const players: Player[] = lobby.map((p) => ({
      id: p.id,
      name: p.name,
      gender: (p.gender ?? 'male') as Gender,
      score: 0,
    }));

    if (!hasEnoughFreshQuestionsForPlayers(players, this.usedQuestionIds)) {
      this.usedQuestionIds = [];
    }
    this.casinoForcedLosses.clear();
    this.gameState = {
      phase: 'answering',
      round: 0,
      totalRounds: players.length,
      targetScore: TARGET_SCORE,
      players,
      currentLeaderIndex: 0,
      questionId: null,
      questionText: '',
      submittedPlayerIds: [],
      answers: [],
      answerReactions: {},
      myAnswerReactions: {},
      funnyVoteCounts: {},
      funnyVotesSubmittedCount: 0,
      funnyVotesRequiredCount: 0,
      myFunnyVoteId: null,
      correctAnswer: '',
      mostCorrectAnswerId: null,
      mostFunnyAnswerId: null,
      authorGuesses: {},
      lastResult: null,
      winnerId: null,
      casinoLastSpins: {},
      awayPlayerIds: [],
      roomCode: this.code,
      hostId: this.ownerId ?? '',
    };
    this.beginRound();
    this.gameState.awayPlayerIds = this.getAwayPlayerIds();
    return this.gameState;
  }

  /** Подготавливает новый раунд: выбирает вопрос для текущего ведущего. */
  private beginRound() {
    const state = this.gameState!;
    const leader = state.players[state.currentLeaderIndex];
    const gender = (leader.gender ?? 'male') as Gender;
    const hasFreshQuestion = questionsForGender(gender).some((question) => !this.usedQuestionIds.includes(question.id));
    if (!hasFreshQuestion) {
      this.usedQuestionIds = [];
    }
    const question = pickQuestion(gender, this.usedQuestionIds);
    this.usedQuestionIds.push(question.id);

    this.submissions.clear();
    this.authorByAnswerId = {};
    this.answerReactionPlayers = {};
    this.funniestVotes.clear();
    this.funnyTieBreak = null;

    state.phase = 'answering';
    state.questionId = question.id;
    state.questionText = renderQuestion(question.template, leader.name, gender);
    state.submittedPlayerIds = [];
    state.answers = [];
    state.answerReactions = {};
    state.myAnswerReactions = {};
    state.funnyVoteCounts = {};
    state.funnyVotesSubmittedCount = 0;
    state.funnyVotesRequiredCount = 0;
    state.myFunnyVoteId = null;
    state.correctAnswer = '';
    state.mostCorrectAnswerId = null;
    state.mostFunnyAnswerId = null;
    state.authorGuesses = {};
  }

  /** Переход к фазе судейства: строит анонимные ответы. */
  private startJudging() {
    const state = this.gameState!;
    const leader = state.players[state.currentLeaderIndex];
    const playerSubs: Array<[string, string]> = [];
    for (const [pid, text] of this.submissions.entries()) {
      if (pid === leader.id) continue;
      playerSubs.push([pid, text]);
    }
    const { answers, authorByAnswerId } = buildAnonymizedAnswers(playerSubs);
    this.authorByAnswerId = authorByAnswerId;
    this.funnyTieBreak = null;
    state.submittedPlayerIds = Array.from(this.submissions.keys());
    state.answers = answers;
    state.answerReactions = {};
    state.myAnswerReactions = {};
    state.funnyVoteCounts = {};
    state.funnyVotesSubmittedCount = 0;
    state.funnyVotesRequiredCount = this.requiredFunnyVoterIds().length;
    state.myFunnyVoteId = null;
    state.correctAnswer = this.submissions.get(leader.id) ?? '';
    state.phase = 'judging';
  }

  private getAnswerReactionCounts(): AnswerReactionCounts {
    const counts: AnswerReactionCounts = {};
    for (const [answerId, reactions] of Object.entries(this.answerReactionPlayers)) {
      for (const [reaction, playerIds] of Object.entries(reactions) as Array<[ReactionType, Set<string>]>) {
        if (playerIds.size === 0) continue;
        counts[answerId] ??= {};
        counts[answerId][reaction] = playerIds.size;
      }
    }
    return counts;
  }

  getAnswerReactions(): AnswerReactionCounts {
    return this.getAnswerReactionCounts();
  }

  getMyAnswerReactions(playerId: string | null): MyAnswerReactions {
    if (!playerId) return {};
    const mine: MyAnswerReactions = {};
    for (const [answerId, reactions] of Object.entries(this.answerReactionPlayers)) {
      for (const [reaction, playerIds] of Object.entries(reactions) as Array<[ReactionType, Set<string>]>) {
        if (!playerIds.has(playerId)) continue;
        mine[answerId] ??= [];
        mine[answerId].push(reaction);
      }
    }
    return mine;
  }

  private getFunnyVoteCounts(): FunnyVoteCounts {
    const counts: FunnyVoteCounts = {};
    for (const answerId of this.funniestVotes.values()) {
      counts[answerId] = (counts[answerId] ?? 0) + 1;
    }
    return counts;
  }

  getPublicFunnyVoteCounts(): FunnyVoteCounts {
    return this.getFunnyVoteCounts();
  }

  getMyFunnyVoteId(playerId: string | null): string | null {
    if (!playerId) return null;
    return this.funniestVotes.get(playerId) ?? null;
  }

  private requiredFunnyVoterIds(): string[] {
    const state = this.gameState!;
    const leaderId = state.players[state.currentLeaderIndex]?.id;
    return state.players
      .filter((player) => player.id !== leaderId && !this.isPlayerAway(player.id))
      .map((player) => player.id);
  }

  private allFunnyVotesReady() {
    const required = this.requiredFunnyVoterIds();
    return this.funniestVotes.size > 0 && required.every((playerId) => this.funniestVotes.has(playerId));
  }

  private updateFunnyVoteState() {
    const state = this.gameState!;
    state.funnyVoteCounts = this.getFunnyVoteCounts();
    state.funnyVotesSubmittedCount = this.funniestVotes.size;
    state.funnyVotesRequiredCount = this.requiredFunnyVoterIds().length;
    state.myFunnyVoteId = null;

    if (!this.allFunnyVotesReady()) {
      state.mostFunnyAnswerId = null;
      return;
    }

    let winnerVotes = 0;
    const winnerCandidates: string[] = [];
    for (const answer of state.answers) {
      const votes = state.funnyVoteCounts[answer.id] ?? 0;
      if (votes > winnerVotes) {
        winnerVotes = votes;
        winnerCandidates.length = 0;
        winnerCandidates.push(answer.id);
      } else if (votes === winnerVotes && votes > 0) {
        winnerCandidates.push(answer.id);
      }
    }
    if (winnerCandidates.length === 0) {
      state.mostFunnyAnswerId = null;
      return;
    }
    // Пересчёт идёт и на «Завершить раунд», и по таймеру присутствия — ничья не должна перевыбираться.
    const key = winnerCandidates.join('|');
    if (this.funnyTieBreak?.key !== key) {
      this.funnyTieBreak = { key, winner: winnerCandidates[Math.floor(Math.random() * winnerCandidates.length)] };
    }
    state.mostFunnyAnswerId = this.funnyTieBreak.winner;
  }

  /** Завершает раунд: начисляет очки (без раскрытия авторства). */
  private finishRound(): GameEvent[] {
    const state = this.gameState!;
    const { deltas, result } = computeRoundScores({ state, authorByAnswerId: this.authorByAnswerId });
    state.players = applyDeltas(state.players, deltas);
    state.lastResult = result;
    state.phase = 'roundResults';
    // авторство сразу забываем — оно никому не раскрывается
    this.authorByAnswerId = {};
    return [{ type: 'round_finished', result }];
  }

  private allAuthorGuessesReady() {
    const state = this.gameState!;
    const guessedIds = Object.values(state.authorGuesses);
    return (
      state.answers.length > 0 &&
      guessedIds.length === state.answers.length &&
      new Set(guessedIds).size === state.answers.length &&
      state.answers.every((answer) => Boolean(state.authorGuesses[answer.id]))
    );
  }

  /** Убирает следы ушедшего игрока из судейства: его ответ, голос и догадки о нём. */
  private pruneJudgingAnswerByPlayer(playerId: string) {
    const state = this.gameState;
    if (!state || state.phase !== 'judging') return;

    const removed = new Set(
      Object.entries(this.authorByAnswerId)
        .filter(([, authorId]) => authorId === playerId)
        .map(([answerId]) => answerId),
    );

    // Голос ушедшего удаляется всегда, даже если своего ответа у него не было.
    this.funniestVotes.delete(playerId);
    if (removed.size > 0) {
      state.answers = state.answers.filter((answer) => !removed.has(answer.id));
      for (const [voterId, answerId] of Array.from(this.funniestVotes.entries())) {
        if (removed.has(answerId)) this.funniestVotes.delete(voterId);
      }
      for (const answerId of removed) {
        delete this.authorByAnswerId[answerId];
        delete this.answerReactionPlayers[answerId];
        delete state.authorGuesses[answerId];
      }
      if (state.mostCorrectAnswerId && removed.has(state.mostCorrectAnswerId)) {
        state.mostCorrectAnswerId = null;
        state.authorGuesses = {};
      }
    }
    state.authorGuesses = Object.fromEntries(
      Object.entries(state.authorGuesses).filter(([, guessedPlayerId]) => guessedPlayerId !== playerId),
    );
    this.updateFunnyVoteState();
  }

  /** Передаёт ход следующему ведущему либо завершает игру. */
  private advanceToNextRound(): GameEvent[] {
    const state = this.gameState!;

    // Победа по очкам: первый, кто достиг TARGET_SCORE, заканчивает игру.
    const reached = state.players.filter((p) => p.score >= state.targetScore);
    if (reached.length > 0) {
      const top = reached.reduce((a, b) => (b.score > a.score ? b : a));
      state.phase = 'gameOver';
      state.winnerId = top.id;
      return [{ type: 'game_over', winnerId: state.winnerId }];
    }

    state.round += 1;
    state.currentLeaderIndex = (state.currentLeaderIndex + 1) % state.players.length;
    this.beginRound();
    const leader = state.players[state.currentLeaderIndex];
    return [{
      type: 'round_started',
      leaderId: leader.id,
      leaderName: leader.name,
      questionText: state.questionText,
      round: state.round,
    }];
  }

  markDisconnected(playerId: string, since = Date.now()) {
    const player = this.players.get(playerId);
    if (!player) return;
    this.lastActivityAt = Date.now();
    // Повторный разрыв не должен сдвигать момент ухода (от него считается ожидание).
    if (player.connected === false && this.reservedAt.has(playerId)) return;
    this.players.set(playerId, { ...player, connected: false });
    this.reservedPlayers.add(playerId);
    this.reservedAt.set(playerId, since);
  }

  /** HTTP-опрос резервного режима: игрок жив. Возвращает true, если он снова стал онлайн. */
  markSeen(playerId: string): boolean {
    const player = this.players.get(playerId);
    if (!player) return false;
    const now = Date.now();
    this.lastSeenAt.set(playerId, now);
    this.lastActivityAt = now;
    if (player.connected !== false) return false;
    this.players.set(playerId, { ...player, connected: true });
    this.reservedPlayers.delete(playerId);
    this.reservedAt.delete(playerId);
    return true;
  }

  /** Игроки без WebSocket, переставшие опрашивать сервер, помечаются офлайн (иначе они «онлайн» вечно). */
  expireSilentPlayers(hasSocket: (playerId: string) => boolean, timeoutMs: number): boolean {
    const now = Date.now();
    let changed = false;
    for (const player of Array.from(this.players.values())) {
      if (player.connected === false || hasSocket(player.id)) continue;
      const lastSeen = this.lastSeenAt.get(player.id) ?? 0;
      if (now - lastSeen < timeoutMs) continue;
      this.markDisconnected(player.id, lastSeen || now);
      changed = true;
    }
    return changed;
  }

  /** С какого момента игрок офлайн: null — в сети, 0 — его уже нет в комнате. */
  private offlineSince(playerId: string): number | null {
    const player = this.players.get(playerId);
    if (!player) return 0;
    if (player.connected !== false) return null;
    return this.reservedAt.get(playerId) ?? 0;
  }

  isPlayerAway(playerId: string, graceMs = PLAYER_AWAY_GRACE_MS): boolean {
    const since = this.offlineSince(playerId);
    return since !== null && Date.now() - since >= graceMs;
  }

  private getAwayPlayerIds(): string[] {
    return this.gameState?.players.filter((player) => this.isPlayerAway(player.id)).map((player) => player.id) ?? [];
  }

  /**
   * Пересчитывает всё, что зависит от присутствия: раунд не ждёт игроков, которые давно офлайн,
   * а ход пропавшего ведущего переходит дальше. Возвращает true, если состояние изменилось.
   */
  refreshPresence(): boolean {
    const state = this.gameState;
    if (!state) return false;
    const fingerprint = () => [
      state.phase,
      state.round,
      state.currentLeaderIndex,
      state.questionId,
      state.mostFunnyAnswerId,
      state.funnyVotesRequiredCount,
      state.awayPlayerIds.join(','),
    ].join('|');
    const before = fingerprint();
    if (state.phase === 'answering' || state.phase === 'judging') {
      if (this.skipAwayLeaderTurn().length === 0) {
        if (state.phase === 'answering') this.maybeStartJudging();
        else this.updateFunnyVoteState();
      }
    }
    state.awayPlayerIds = this.getAwayPlayerIds();
    return fingerprint() !== before;
  }

  private skipAwayLeaderTurn(): GameEvent[] {
    const state = this.gameState!;
    const leader = state.players[state.currentLeaderIndex];
    if (!leader || !this.isPlayerAway(leader.id, LEADER_AWAY_GRACE_MS)) return [];
    const total = state.players.length;
    for (let step = 1; step < total; step += 1) {
      const candidateIndex = (state.currentLeaderIndex + step) % total;
      if (this.isPlayerAway(state.players[candidateIndex].id)) continue;
      state.currentLeaderIndex = candidateIndex;
      state.round += 1;
      this.beginRound();
      const next = state.players[candidateIndex];
      return [{ type: 'round_started', leaderId: next.id, leaderName: next.name, questionText: state.questionText, round: state.round }];
    }
    return [];
  }

  pruneExpiredLobbyReservations() {
    if (this.gameState) {
      return;
    }

    for (const playerId of Array.from(this.reservedPlayers)) {
      const reservedSince = this.reservedAt.get(playerId);
      if (!reservedSince) {
        this.removePlayer(playerId);
        this.clearPlayerSessions(playerId);
        continue;
      }

      if (Date.now() - reservedSince >= LOBBY_RESERVATION_TTL_MS) {
        this.removePlayer(playerId);
        this.clearPlayerSessions(playerId);
      }
    }
  }


  removePlayer(playerId: string) {
    this.players.delete(playerId);
    this.reservedPlayers.delete(playerId);
    this.reservedAt.delete(playerId);

    let ownerChanged = false;
    if (this.ownerId === playerId) {
      this.ownerId = this.getLobbyPlayers()[0]?.id ?? null;
      if (this.ownerId) {
        const newOwner = this.players.get(this.ownerId);
        if (newOwner) newOwner.isHost = true;
      }
      ownerChanged = true;
    }

    // Если игрок участвовал в активной партии — корректно убираем его.
    if (this.gameState && this.gameState.players.some((p) => p.id === playerId)) {
      this.removePlayerFromGame(playerId);
    }

    return { ownerChanged };
  }

  /** Убирает игрока из активной партии и при необходимости двигает раунд. */
  private removePlayerFromGame(playerId: string) {
    const state = this.gameState!;
    const idx = state.players.findIndex((p) => p.id === playerId);
    if (idx < 0) return;
    const wasLeader = idx === state.currentLeaderIndex;
    const leaderId = state.players[state.currentLeaderIndex]?.id;

    state.players = state.players.filter((p) => p.id !== playerId);
    delete state.casinoLastSpins[playerId];
    this.casinoForcedLosses.delete(playerId);
    this.submissions.delete(playerId);
    this.pruneJudgingAnswerByPlayer(playerId);
    for (const reactions of Object.values(this.answerReactionPlayers)) {
      for (const playerIds of Object.values(reactions)) playerIds?.delete(playerId);
    }
    state.answerReactions = this.getAnswerReactionCounts();

    if (state.players.length < MIN_PLAYERS) {
      // Недостаточно игроков — заканчиваем партию.
      state.phase = 'gameOver';
      state.winnerId = pickWinnerId(state.players);
      state.awayPlayerIds = this.getAwayPlayerIds();
      this.onStateChanged?.();
      return;
    }

    if (wasLeader) {
      // Следующий по очереди игрок теперь стоит на месте ушедшего ведущего.
      const nextIndex = idx % state.players.length;
      state.currentLeaderIndex = state.phase === 'roundResults'
        ? (nextIndex - 1 + state.players.length) % state.players.length // next_round сам прибавит 1
        : nextIndex;
    } else {
      state.currentLeaderIndex = Math.max(0, state.players.findIndex((p) => p.id === leaderId));
    }
    state.totalRounds = Math.min(state.totalRounds, state.players.length);

    if (wasLeader && (state.phase === 'answering' || state.phase === 'judging')) {
      // Ведущий ушёл во время раунда — раунд начинается заново со следующим ведущим.
      this.beginRound();
    } else if (state.phase === 'answering') {
      // Возможно, оставшиеся уже все ответили.
      this.maybeStartJudging();
    }
    state.awayPlayerIds = this.getAwayPlayerIds();
    this.onStateChanged?.();
  }

  kickPlayer(playerId: string) {
    this.kickedPlayerIds.add(playerId);
    this.clearPlayerSessions(playerId);
    return this.removePlayer(playerId);
  }

  clearPlayerSessions(playerId: string) {
    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.playerId === playerId) {
        this.sessions.delete(sessionId);
      }
    }
  }


  endRoom() {
    this.players.clear();
    this.sessions.clear();
    this.kickedPlayerIds.clear();
    this.reservedPlayers.clear();
    this.reservedAt.clear();
    this.gameState = null;
    this.submissions.clear();
    this.authorByAnswerId = {};
    this.answerReactionPlayers = {};
    this.funniestVotes.clear();
    this.usedQuestionIds = [];
    this.casinoForcedLosses.clear();
    this.processedActionIds.clear();
    this.lastSeenAt.clear();
    this.funnyTieBreak = null;
  }

  /** Если ответили все, кого стоит ждать, — переходим к судейству. */
  private maybeStartJudging() {
    const state = this.gameState!;
    if (state.phase !== 'answering') return;
    if (this.allRequiredAnswersIn()) {
      this.startJudging();
    } else {
      state.submittedPlayerIds = Array.from(this.submissions.keys());
    }
  }

  /** Нужен ответ ведущего и всех, кто в сети; давно отключившиеся игроки не блокируют раунд. */
  private allRequiredAnswersIn() {
    const state = this.gameState!;
    const leaderId = state.players[state.currentLeaderIndex]?.id;
    if (!leaderId || !this.submissions.has(leaderId)) return false;
    let playerAnswers = 0;
    for (const player of state.players) {
      if (player.id === leaderId) continue;
      if (this.submissions.has(player.id)) playerAnswers += 1;
      else if (!this.isPlayerAway(player.id)) return false;
    }
    return playerAnswers > 0;
  }

  private rememberActionId(actionId: string): boolean {
    if (this.processedActionIds.has(actionId)) return false;
    this.processedActionIds.add(actionId);
    if (this.processedActionIds.size > PROCESSED_ACTION_IDS_LIMIT) {
      const oldest = this.processedActionIds.values().next().value;
      if (oldest !== undefined) this.processedActionIds.delete(oldest);
    }
    return true;
  }

  processAction(playerId: string, action: PlayerAction): { state: GameState; events: GameEvent[]; privateHands: Map<string, string[]> } {
    if (!this.gameState) {
      throw new Error('Игра ещё не началась');
    }
    const state = this.gameState;
    const privateHands = new Map<string, string[]>();

    // Идемпотентность повторно присланных действий.
    if (action.actionId && !this.rememberActionId(action.actionId)) {
      return { state, events: [], privateHands };
    }

    const leader = state.players[state.currentLeaderIndex];
    const isLeader = leader?.id === playerId;
    const inGame = state.players.some((p) => p.id === playerId);
    // Действие из очереди офлайна могло прийти уже после смены раунда — "a1" нового раунда это другой ответ.
    if (!inGame || isStaleRoundAction(action, state)) {
      return { state, events: [], privateHands };
    }

    let events: GameEvent[] = [];

    switch (action.type) {
      case 'submit_answer': {
        if (state.phase !== 'answering') break;
        const text = (action.payload?.text ?? '').toString().trim();
        if (!text) break;
        this.submissions.set(playerId, Array.from(text).slice(0, 280).join(''));
        state.submittedPlayerIds = Array.from(this.submissions.keys());
        events.push({ type: 'answer_submitted', playerId });
        if (this.allRequiredAnswersIn()) {
          this.startJudging();
          events.push({ type: 'all_answers_in' });
          events.push({ type: 'phase_changed', phase: 'judging' });
        }
        break;
      }
      case 'select_most_correct': {
        if (state.phase !== 'judging' || !isLeader) break;
        const id = action.payload?.answerId;
        if (id && state.answers.some((a) => a.id === id)) {
          if (state.mostCorrectAnswerId !== id) {
            state.authorGuesses = {};
          }
          state.mostCorrectAnswerId = id;
        }
        break;
      }
      case 'vote_funniest': {
        if (state.phase !== 'judging' || isLeader) break;
        const id = action.payload?.answerId;
        if (id && state.answers.some((a) => a.id === id)) {
          this.funniestVotes.set(playerId, id);
          this.updateFunnyVoteState();
        }
        break;
      }
      case 'guess_author': {
        if (state.phase !== 'judging' || !isLeader) break;
        if (!state.mostCorrectAnswerId) break;
        const { answerId, guessedPlayerId } = action.payload ?? ({} as { answerId?: string; guessedPlayerId?: string });
        const validAnswer = answerId && state.answers.some((a) => a.id === answerId);
        const validPlayer = guessedPlayerId && state.players.some((p) => p.id === guessedPlayerId && p.id !== leader.id);
        if (validAnswer && validPlayer) {
          const nextGuesses = { ...state.authorGuesses };
          for (const [existingAnswerId, existingPlayerId] of Object.entries(nextGuesses)) {
            if (existingAnswerId !== answerId && existingPlayerId === guessedPlayerId) {
              delete nextGuesses[existingAnswerId];
            }
          }
          nextGuesses[answerId] = guessedPlayerId;
          state.authorGuesses = nextGuesses;
        }
        break;
      }
      case 'toggle_answer_reaction': {
        if (state.phase !== 'judging' && state.phase !== 'roundResults') break;
        const { answerId, reaction } = action.payload ?? ({} as { answerId?: string; reaction?: ReactionType });
        const validAnswer = answerId && (
          state.answers.some((a) => a.id === answerId) ||
          (answerId === HOST_ANSWER_REACTION_ID && Boolean(state.correctAnswer))
        );
        const validReaction = reaction === 'joy' || reaction === 'poop' || reaction === 'fire' || reaction === 'clown';
        if (!validAnswer || !validReaction || !answerId || !reaction) break;

        this.answerReactionPlayers[answerId] ??= {};
        this.answerReactionPlayers[answerId][reaction] ??= new Set<string>();
        const playerIds = this.answerReactionPlayers[answerId][reaction]!;
        if (playerIds.has(playerId)) {
          playerIds.delete(playerId);
        } else {
          playerIds.add(playerId);
        }
        state.answerReactions = this.getAnswerReactionCounts();
        state.myAnswerReactions = {};
        break;
      }
      case 'casino_spin': {
        if (state.phase === 'gameOver') break;
        const bet = normalizeCasinoBet(action.payload);
        const player = state.players.find((p) => p.id === playerId);
        if (!bet || !player || player.score < 1) break;

        let forcedLossesRemaining = this.casinoForcedLosses.get(playerId) ?? 0;
        if (forcedLossesRemaining <= 0 && CASINO_ENDGAME_FORCE_SCORES.has(player.score)) {
          forcedLossesRemaining = CASINO_FORCED_LOSS_COUNT;
        }

        const forceLoss = forcedLossesRemaining > 0;
        const resultNumber = forceLoss ? pickCasinoLossNumber(bet) : pickCasinoNumber();
        const resultColor = rouletteColorForNumber(resultNumber);
        const won = forceLoss ? false : casinoBetWins(bet, resultNumber);
        const payout = CASINO_PAYOUTS[bet.betType];
        const scoreDelta = won ? payout : -1;
        const nextScore = Math.max(0, player.score + scoreDelta);

        state.players = state.players.map((p) => (
          p.id === playerId ? { ...p, score: nextScore } : p
        ));
        if (forceLoss) {
          forcedLossesRemaining -= 1;
          if (forcedLossesRemaining > 0) {
            this.casinoForcedLosses.set(playerId, forcedLossesRemaining);
          } else {
            this.casinoForcedLosses.delete(playerId);
          }
        } else if (CASINO_ENDGAME_FORCE_SCORES.has(nextScore)) {
          this.casinoForcedLosses.set(playerId, CASINO_FORCED_LOSS_COUNT);
        } else {
          this.casinoForcedLosses.delete(playerId);
        }
        state.casinoLastSpins[playerId] = {
          id: crypto.randomUUID(),
          playerId,
          betType: bet.betType,
          betNumber: bet.betNumber,
          resultNumber,
          resultColor,
          won,
          payout,
          scoreDelta,
          createdAt: Date.now(),
        };
        events.push({ type: 'casino_spin', playerId, resultNumber, scoreDelta });
        break;
      }
      case 'finish_judging': {
        if (state.phase !== 'judging' || !isLeader) break;
        this.updateFunnyVoteState();
        if (!state.mostCorrectAnswerId || !state.mostFunnyAnswerId || !this.allFunnyVotesReady() || !this.allAuthorGuessesReady()) break;
        events = events.concat(this.finishRound());
        break;
      }
      case 'next_round': {
        if (state.phase !== 'roundResults') break;
        // Если и ведущий, и хост пропали, раунд может продолжить любой игрок — иначе партия зависает.
        const leaderAndHostAway = (!leader || this.isPlayerAway(leader.id))
          && (!this.ownerId || this.isPlayerAway(this.ownerId));
        if (!isLeader && this.ownerId !== playerId && !leaderAndHostAway) break;
        events = events.concat(this.advanceToNextRound());
        break;
      }
      default:
        break;
    }

    state.awayPlayerIds = this.getAwayPlayerIds();
    this.gameState = state;
    return { state: this.gameState, events, privateHands };
  }
}
