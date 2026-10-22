import { generateRoomCode } from '../src/lib/roomCode.js';
import { GameState, PlayerAction, Player, Gender, ReactionType, AnswerReactionCounts, MyAnswerReactions, FunnyVoteCounts, CasinoBetType, HOST_ANSWER_REACTION_ID } from './shared-types.js';
import { GameEvent } from './shared-events.js';
import { LobbyPlayer } from './protocol.js';
import { pickQuestion, questionsForGender, renderQuestion } from '../src/data/questions.js';
import { ROULETTE_NUMBERS, rouletteColorForNumber } from '../src/lib/casinoRoulette.js';
import { buildAnonymizedAnswers, computeRoundScores, applyDeltas, pickWinnerId } from './shared-handlers.js';

const MAX_PLAYERS = 10;
const TARGET_SCORE = 20; // первый, кто набирает столько очков — победитель
const LOBBY_RESERVATION_TTL_MS = 5 * 60 * 1000;
const CASINO_PAYOUTS: Record<CasinoBetType, number> = {
  red: 2,
  black: 2,
  number: 4,
  zero: 6,
};
const CASINO_ENDGAME_FORCE_SCORES = new Set([18, 19]);
const CASINO_FORCED_LOSS_COUNT = 5;

type NormalizedCasinoBet = { betType: CasinoBetType; betNumber: number | null };

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

  constructor(code?: string) {
    this.code = code ?? generateRoomCode();
    this.ownerId = null;
    this.createdAt = Date.now();
  }

  static create() {
    return new Room();
  }

  setStateChangeListener(listener: (() => void) | null) {
    this.onStateChanged = listener;
  }

  addOrUpdatePlayer(playerId: string, name: string, wantsHost: boolean, gender: Gender = 'male') {
    if (this.kickedPlayerIds.has(playerId)) {
      throw new Error('Игрок был удалён из комнаты');
    }

    if (!this.players.has(playerId) && this.players.size >= MAX_PLAYERS) {
      throw new Error('Комната заполнена');
    }

    const existing = this.players.get(playerId);
    if (!this.ownerId && wantsHost) {
      this.ownerId = playerId;
    }

    const player: LobbyPlayer = {
      id: playerId,
      name,
      gender,
      isHost: this.ownerId === playerId,
      connected: true,
    };

    this.players.set(playerId, player);
    this.reservedPlayers.delete(playerId);
    this.reservedAt.delete(playerId);
    return { player, isNew: !existing };
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
    return this.players.size >= 3;
  }

  isStale() {
    const EMPTY_ROOM_TTL_MS = 5 * 60 * 1000;
    return this.players.size === 0 && !this.gameState && Date.now() - this.createdAt >= EMPTY_ROOM_TTL_MS;
  }


  startGame(_is16Plus?: boolean) {
    if (this.players.size < 3) {
      throw new Error('Нужно минимум 3 игрока');
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
      myFunnyVoteId: null,
      correctAnswer: '',
      mostCorrectAnswerId: null,
      mostFunnyAnswerId: null,
      authorGuesses: {},
      lastResult: null,
      winnerId: null,
      casinoLastSpins: {},
      roomCode: this.code,
      hostId: this.ownerId ?? '',
    };
    this.beginRound();
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

    state.phase = 'answering';
    state.questionId = question.id;
    state.questionText = renderQuestion(question.template, leader.name, gender);
    state.submittedPlayerIds = [];
    state.answers = [];
    state.answerReactions = {};
    state.myAnswerReactions = {};
    state.funnyVoteCounts = {};
    state.funnyVotesSubmittedCount = 0;
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
    state.answers = answers;
    state.answerReactions = {};
    state.myAnswerReactions = {};
    state.funnyVoteCounts = {};
    state.funnyVotesSubmittedCount = 0;
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

  private allFunnyVotesReady() {
    const state = this.gameState!;
    const leaderId = state.players[state.currentLeaderIndex]?.id;
    const voters = state.players.filter((player) => player.id !== leaderId).length;
    return voters > 0 && this.funniestVotes.size >= voters;
  }

  private updateFunnyVoteState() {
    const state = this.gameState!;
    state.funnyVoteCounts = this.getFunnyVoteCounts();
    state.funnyVotesSubmittedCount = this.funniestVotes.size;
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
    state.mostFunnyAnswerId = winnerCandidates.length > 0
      ? winnerCandidates[Math.floor(Math.random() * winnerCandidates.length)]
      : null;
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

  private pruneJudgingAnswerByPlayer(playerId: string) {
    const state = this.gameState;
    if (!state || state.phase !== 'judging') return;

    const removedAnswerIds = Object.entries(this.authorByAnswerId)
      .filter(([, authorId]) => authorId === playerId)
      .map(([answerId]) => answerId);

    if (removedAnswerIds.length === 0) return;

    const removed = new Set(removedAnswerIds);
    state.answers = state.answers.filter((answer) => !removed.has(answer.id));
    for (const [voterId, answerId] of Array.from(this.funniestVotes.entries())) {
      if (removed.has(answerId) || voterId === playerId) {
        this.funniestVotes.delete(voterId);
      }
    }
    for (const answerId of removed) {
      delete this.authorByAnswerId[answerId];
      delete this.answerReactionPlayers[answerId];
      delete state.authorGuesses[answerId];
    }
    state.answerReactions = this.getAnswerReactionCounts();
    state.myAnswerReactions = {};
    this.updateFunnyVoteState();
    state.authorGuesses = Object.fromEntries(
      Object.entries(state.authorGuesses).filter(([, guessedPlayerId]) => guessedPlayerId !== playerId),
    );

    if (state.mostCorrectAnswerId && removed.has(state.mostCorrectAnswerId)) {
      state.mostCorrectAnswerId = null;
      state.authorGuesses = {};
    }

    if (state.mostFunnyAnswerId && removed.has(state.mostFunnyAnswerId)) {
      state.mostFunnyAnswerId = null;
      state.authorGuesses = {};
    }
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

  markDisconnected(playerId: string) {
    const player = this.players.get(playerId);
    if (!player) return;
    this.players.set(playerId, { ...player, connected: false });
    this.reservedPlayers.add(playerId);
    this.reservedAt.set(playerId, Date.now());
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

    if (state.players.length < 3) {
      // Недостаточно игроков — заканчиваем партию.
      state.phase = 'gameOver';
      state.winnerId = pickWinnerId(state.players);
      this.onStateChanged?.();
      return;
    }

    // Пересчитываем индекс ведущего.
    const newLeaderIndex = Math.max(0, state.players.findIndex((p) => p.id === leaderId));
    state.currentLeaderIndex = leaderId && newLeaderIndex >= 0 ? newLeaderIndex : state.currentLeaderIndex % state.players.length;
    state.totalRounds = Math.min(state.totalRounds, state.players.length);

    if (wasLeader && (state.phase === 'answering' || state.phase === 'judging')) {
      // Ведущий ушёл во время раунда — прерываем раунд и стартуем заново
      // с тем же индексом (он теперь указывает на следующего игрока).
      state.currentLeaderIndex = state.currentLeaderIndex % state.players.length;
      this.beginRound();
    } else if (state.phase === 'answering') {
      // Возможно, оставшиеся уже все ответили.
      this.maybeStartJudging();
    }
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
  }

  /** Если ответили все живые игроки — переходим к судейству. */
  private maybeStartJudging() {
    const state = this.gameState!;
    if (state.phase !== 'answering') return;
    const everyone = state.players.length;
    if (this.submissions.size >= everyone) {
      this.startJudging();
    } else {
      state.submittedPlayerIds = Array.from(this.submissions.keys());
    }
  }

  processAction(playerId: string, action: PlayerAction): { state: GameState; events: GameEvent[]; privateHands: Map<string, string[]> } {
    if (!this.gameState) {
      throw new Error('Игра ещё не началась');
    }
    const state = this.gameState;
    const privateHands = new Map<string, string[]>();

    // Идемпотентность повторно присланных действий.
    if (action.actionId) {
      if (this.processedActionIds.has(action.actionId)) {
        return { state, events: [], privateHands };
      }
      this.processedActionIds.add(action.actionId);
    }

    const leader = state.players[state.currentLeaderIndex];
    const isLeader = leader?.id === playerId;
    const inGame = state.players.some((p) => p.id === playerId);
    if (!inGame) {
      return { state, events: [], privateHands };
    }

    let events: GameEvent[] = [];

    switch (action.type) {
      case 'submit_answer': {
        if (state.phase !== 'answering') break;
        const text = (action.payload?.text ?? '').toString().trim();
        if (!text) break;
        this.submissions.set(playerId, text.slice(0, 280));
        state.submittedPlayerIds = Array.from(this.submissions.keys());
        events.push({ type: 'answer_submitted', playerId });
        if (this.submissions.size >= state.players.length) {
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
        if (!isLeader && this.ownerId !== playerId) break;
        events = events.concat(this.advanceToNextRound());
        break;
      }
      default:
        break;
    }

    this.gameState = state;
    return { state: this.gameState, events, privateHands };
  }
}
