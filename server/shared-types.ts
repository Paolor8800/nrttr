// «Узнай друзей» — модель игрового состояния (сервер-авторитетная).
//
// ВАЖНО про приватность: сетевой слой (server/index.ts → buildRoomSnapshot)
// рассылает ВСЁ содержимое gameState каждому клиенту (приватно только поле
// hand игрока). Поэтому авторство ответов НИКОГДА не хранится в gameState —
// оно живёт в приватном поле комнаты (Room.authorByAnswerId) и не рассылается.

export type Gender = 'male' | 'female';
export type ReactionType = 'joy' | 'poop' | 'fire' | 'clown';
export const HOST_ANSWER_REACTION_ID = 'host-answer';
export type CasinoBetType = 'red' | 'black' | 'number' | 'zero';
export type CasinoColor = 'red' | 'black' | 'green';
export type AnswerReactionCounts = Record<string, Partial<Record<ReactionType, number>>>;
export type MyAnswerReactions = Record<string, ReactionType[]>;
export type FunnyVoteCounts = Record<string, number>;

export interface CasinoSpinResult {
  id: string;
  playerId: string;
  betType: CasinoBetType;
  betNumber: number | null;
  resultNumber: number;
  resultColor: CasinoColor;
  won: boolean;
  payout: number;
  scoreDelta: number;
  createdAt: number;
}

export type GamePhase =
  | 'answering'      // показан вопрос; игроки пишут версии, ведущий — правильный ответ
  | 'judging'        // ведущий выбирает «самый правильный», «самый смешной» и угадывает авторов
  | 'roundResults'   // показан итог раунда (без раскрытия авторства)
  | 'gameOver';      // кто-то добрался до целевого счёта — итоговая таблица

export interface Player {
  id: string;
  name: string;
  gender: Gender;
  score: number;
  /** Не используется в этой игре; оставлено опциональным ради совместимости
   *  с нетронутым сетевым слоем, который читает/пишет player.hand. */
  hand?: string[];
}

/** Анонимный ответ в том виде, в котором его видят все клиенты. */
export interface AnswerView {
  id: string;   // анонимный идентификатор ответа (a1, a2, ...)
  text: string;
}

export interface RoundResult {
  questionText: string;
  leaderId: string;
  leaderName: string;
  mostCorrectAnswerId: string | null;
  mostFunnyAnswerId: string | null;
  correctGuesses: number;       // сколько авторов ведущий угадал
  totalGuessable: number;       // сколько всего ответов нужно было угадать
  deltas: Record<string, number>; // прибавка очков за раунд по playerId
}

export interface GameState {
  phase: GamePhase;
  round: number;          // 0-based номер текущего раунда
  totalRounds: number;    // размер одного круга ведущих (число игроков на старте)
  targetScore: number;    // целевой счёт для победы
  players: Player[];
  currentLeaderIndex: number;

  // Текущий вопрос (уже отрендеренный под имя и пол ведущего)
  questionId: string | null;
  questionText: string;

  // Кто уже отправил свой ответ в фазе answering (только id, без содержимого)
  submittedPlayerIds: string[];

  // Анонимные перемешанные ответы игроков (заполняются в фазе judging)
  answers: AnswerView[];
  answerReactions: AnswerReactionCounts;
  myAnswerReactions: MyAnswerReactions;
  funnyVoteCounts: FunnyVoteCounts;
  funnyVotesSubmittedCount: number;
  myFunnyVoteId: string | null;
  // Правильный ответ ведущего — показывается отдельно
  correctAnswer: string;

  // Рабочие выборы ведущего в фазе judging:
  mostCorrectAnswerId: string | null;             // +2 автору
  mostFunnyAnswerId: string | null;               // +2 автору
  authorGuesses: Record<string, string>;          // answerId -> предполагаемый playerId

  lastResult: RoundResult | null;
  winnerId: string | null;
  casinoLastSpins: Record<string, CasinoSpinResult>;

  // Совместимость с сетевым слоем / клиентом
  roomCode: string;
  hostId: string;
}

export type PlayerAction = (
  | { type: 'submit_answer'; playerId: string; payload: { text: string } }
  | { type: 'select_most_correct'; playerId: string; payload: { answerId: string } }
  | { type: 'guess_author'; playerId: string; payload: { answerId: string; guessedPlayerId: string } }
  | { type: 'vote_funniest'; playerId: string; payload: { answerId: string } }
  | { type: 'toggle_answer_reaction'; playerId: string; payload: { answerId: string; reaction: ReactionType } }
  | { type: 'casino_spin'; playerId: string; payload: { betType: CasinoBetType; betNumber?: number | null } }
  | { type: 'finish_judging'; playerId: string; payload?: Record<string, never> }
  | { type: 'next_round'; playerId: string; payload?: Record<string, never> }
) & { actionId?: string };
