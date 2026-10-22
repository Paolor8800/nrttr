import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent, PointerEvent, ReactNode } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useGameRoom } from '@/hooks/useGameRoom';
import { copyText } from '@/lib/clipboard';
import { loadGameSession } from '@/lib/gameCookies';
import {
  ROULETTE_POCKET_DEGREES,
  ROULETTE_SEQUENCE,
  rouletteColorForNumber,
  rouletteTargetAngle,
  type RouletteColor,
} from '@/lib/casinoRoulette';
import { createRoomJoinUrl, isMobileReachabilityWarningUrl } from '@/lib/joinLink';
import { toast } from 'sonner';
import type { AnswerView, CasinoBetType, CasinoSpinResult, GameState, Player, ReactionType } from '@/types/game';
import { HOST_ANSWER_REACTION_ID } from '@/types/game';
import QRCode from 'qrcode';
import { AlertTriangle, ArrowRight, Brain, CheckCircle2, Copy, Crown, Dice5, DoorOpen, Laugh, Link as LinkIcon, QrCode, RefreshCw, Send, Smartphone, Sparkles, Trophy, Wifi, WifiOff, X } from 'lucide-react';

const genderIcon = (g?: string) => (g === 'female' ? '♀' : '♂');
const ANSWER_REACTIONS: Array<{ type: ReactionType; emoji: string; label: string; activeClass: string }> = [
  { type: 'joy', emoji: '😂', label: 'Смех', activeClass: 'border-sky-400/70 bg-sky-400/15 text-sky-100 shadow-[0_0_18px_rgba(56,189,248,0.18)]' },
  { type: 'fire', emoji: '🔥', label: 'Огонь', activeClass: 'border-orange-500/70 bg-orange-500/15 text-orange-100 shadow-[0_0_18px_rgba(249,115,22,0.2)]' },
  { type: 'clown', emoji: '🤡', label: 'Клоун', activeClass: 'border-fuchsia-400/70 bg-fuchsia-400/15 text-fuchsia-100 shadow-[0_0_18px_rgba(232,121,249,0.18)]' },
  { type: 'poop', emoji: '💩', label: 'Жесть', activeClass: 'border-amber-500/70 bg-amber-500/15 text-amber-100 shadow-[0_0_18px_rgba(245,158,11,0.18)]' },
];
const ANSWER_TONE_CLASSES = ['answer-card--ruby', 'answer-card--teal', 'answer-card--gold', 'answer-card--violet', 'answer-card--blue'];
const ANSWER_LEADER_PAUSE_MS = 2000;
const ANSWER_REVEAL_STEP_MS = 1200;
const ANSWER_INTERFACE_REVEAL_MS = 420;
const ANSWER_REACTION_LONG_PRESS_MS = 520;
const CASINO_SPIN_MS = 7600;
const ROULETTE_POCKET_GAP_DEGREES = 0.34;
const ROULETTE_SEGMENT_COLORS: Record<RouletteColor, string> = {
  green: '#087a4d',
  red: '#ba1227',
  black: '#101014',
};
const ROULETTE_WHEEL_BACKGROUND = `conic-gradient(${ROULETTE_SEQUENCE.flatMap((number, index) => {
  const color = ROULETTE_SEGMENT_COLORS[rouletteColorForNumber(number)];
  const start = index * ROULETTE_POCKET_DEGREES;
  const end = (index + 1) * ROULETTE_POCKET_DEGREES;
  const pocketStart = start + ROULETTE_POCKET_GAP_DEGREES;
  const pocketEnd = end - ROULETTE_POCKET_GAP_DEGREES;
  return [
    `#c99b3b ${start}deg ${pocketStart}deg`,
    `${color} ${pocketStart}deg ${pocketEnd}deg`,
    `#8f641f ${pocketEnd}deg ${end}deg`,
  ];
}).join(', ')})`;
const CASINO_BETS: Array<{ type: CasinoBetType; label: string; payout: string; className: string }> = [
  { type: 'red', label: 'Красное', payout: '+2', className: 'casino-bet-red' },
  { type: 'black', label: 'Черное', payout: '+2', className: 'casino-bet-black' },
  { type: 'number', label: 'Число', payout: '+4', className: 'casino-bet-gold' },
  { type: 'zero', label: 'Зеро', payout: '+6', className: 'casino-bet-green' },
];
const CASINO_FIREWORKS = Array.from({ length: 42 }, (_, index) => ({
  angle: index * (360 / 42),
  distance: 94 + (index % 5) * 22,
  delay: (index % 9) * 34,
}));

function toneForAnswer(answerId: string): string {
  let hash = 0;
  for (let index = 0; index < answerId.length; index += 1) {
    hash = (hash * 31 + answerId.charCodeAt(index)) >>> 0;
  }
  return ANSWER_TONE_CLASSES[hash % ANSWER_TONE_CLASSES.length];
}

function formatCasinoBet(spin: CasinoSpinResult): string {
  if (spin.betType === 'red') return 'красное';
  if (spin.betType === 'black') return 'черное';
  if (spin.betType === 'zero') return 'зеро';
  return `число ${spin.betNumber}`;
}

function useJudgingReveal(state: GameState): { visibleAnswers: AnswerView[]; revealComplete: boolean } {
  const [visibleIds, setVisibleIds] = useState<string[]>([]);
  const [revealComplete, setRevealComplete] = useState(false);
  const answerKey = state.answers.map((answer) => answer.id).join('|');

  useEffect(() => {
    if (state.phase !== 'judging') {
      setVisibleIds([]);
      setRevealComplete(false);
      return;
    }

    const order = answerKey ? answerKey.split('|') : [];
    setVisibleIds([]);
    setRevealComplete(order.length === 0);
    const timers = order.map((answerId, index) => window.setTimeout(() => {
      setVisibleIds((current) => current.includes(answerId) ? current : [...current, answerId]);
    }, ANSWER_LEADER_PAUSE_MS + index * ANSWER_REVEAL_STEP_MS));
    if (order.length > 0) {
      timers.push(window.setTimeout(() => {
        setRevealComplete(true);
      }, ANSWER_LEADER_PAUSE_MS + order.length * ANSWER_REVEAL_STEP_MS + ANSWER_INTERFACE_REVEAL_MS));
    }
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [state.phase, state.round, state.questionId, answerKey]);

  const byId = new Map(state.answers.map((answer) => [answer.id, answer]));
  const visibleAnswers = visibleIds.map((answerId) => byId.get(answerId)).filter(Boolean) as AnswerView[];
  const allAnswersVisible = state.phase === 'judging' && state.answers.length > 0 && visibleAnswers.length >= state.answers.length;
  return { visibleAnswers, revealComplete: allAnswersVisible && revealComplete };
}

export default function GameRoom() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const savedSession = useMemo(() => loadGameSession(), []);
  const [qrOpen, setQrOpen] = useState(false);
  const [leaveConfirmOpen, setLeaveConfirmOpen] = useState(false);
  const hostParam = params.get('host');
  const isHost = hostParam === null ? (savedSession?.isHost ?? false) : hostParam === 'true';
  const playerName = params.get('name') || savedSession?.playerName || 'Игрок';
  const playerGender = params.get('gender') === 'female' ? 'female' : 'male';
  const roomParam = params.get('room') || savedSession?.roomCode || null;
  const shouldUseSavedSession = Boolean(savedSession && savedSession.playerName === playerName && savedSession.isHost === isHost && savedSession.roomCode === roomParam);

  const {
    gameState,
    myId,
    roomCode,
    connected,
    connectionStatus,
    connectionMode,
    connectionError,
    lobbyPlayers,
    syncPending,
    pendingActionsCount,
    startGame,
    sendAction,
    leaveGame,
    kickPlayer,
    forceSyncState,
  } =
    useGameRoom(playerName, roomParam, isHost, shouldUseSavedSession ? savedSession : null, false, playerGender);

  const requestLeave = () => setLeaveConfirmOpen(true);
  const confirmLeave = async () => {
    setLeaveConfirmOpen(false);
    await leaveGame();
    navigate('/');
  };

  if (!connected && !gameState) {
    return (
      <Center>
        <div className='text-center space-y-3'>
          <div className='text-2xl font-display font-black'>Подключение…</div>
          <div className='text-muted-foreground text-sm'>{connectionStatus}</div>
          {connectionError && <div className='text-destructive text-sm'>{connectionError}</div>}
          <button onClick={() => navigate('/')} className='btn-secondary mt-4'>На главную</button>
        </div>
      </Center>
    );
  }

  if (!gameState) {
    const effectiveRoomCode = roomCode || roomParam || '';
    const joinUrl = effectiveRoomCode ? createRoomJoinUrl(effectiveRoomCode) : '';
    const handleShare = async () => {
      await copyText(joinUrl);
      toast.success('Ссылка скопирована');
    };
    const canStart = isHost && lobbyPlayers.length >= 3;
    return (
      <Center>
        <div className='w-full max-w-5xl space-y-6 py-6'>
          <Header title='Узнай друзей' subtitle='Лобби' />
          <div className='grid gap-4 lg:grid-cols-[360px_minmax(0,1fr)]'>
            <div className='card p-5 text-center space-y-4'>
              <div>
                <div className='text-sm text-muted-foreground'>Код комнаты</div>
                <div className='text-4xl font-black tracking-widest text-primary'>{roomCode || roomParam}</div>
              </div>
              <button onClick={handleShare} className='btn-secondary flex w-full items-center justify-center gap-2'>
                <LinkIcon className='h-4 w-4' />
                Поделиться ссылкой
              </button>
              {isHost && (
                <button onClick={() => setQrOpen(true)} className='btn-secondary flex w-full items-center justify-center gap-2 border border-primary/30 bg-primary/10 text-primary hover:bg-primary/15'>
                  <QrCode className='h-4 w-4' />
                  Подключиться по QR
                </button>
              )}
              {isHost ? (
                <button disabled={!canStart} onClick={() => startGame()} className='btn-primary w-full disabled:opacity-50'>
                  {canStart ? 'Начать игру' : 'Нужно минимум 3 игрока'}
                </button>
              ) : (
                <div className='text-center text-muted-foreground text-sm'>Ждём, пока хост начнёт игру…</div>
              )}
              <button onClick={requestLeave} className='btn-secondary flex w-full items-center justify-center gap-2'>
                <DoorOpen className='h-4 w-4' />
                Выйти
              </button>
            </div>
            <div className='card p-5 space-y-3'>
              <div className='flex items-center justify-between gap-3'>
                <div className='text-sm text-muted-foreground'>Игроки</div>
                <div className='badge bg-primary/15 text-primary'>{lobbyPlayers.length}/10</div>
              </div>
              <div className='grid gap-2 sm:grid-cols-2'>
                {lobbyPlayers.map((pl) => (
                  <div key={pl.id} className='rounded-lg border border-border bg-background/45 px-4 py-3 min-h-[64px] flex items-center justify-between gap-3'>
                    <span className='min-w-0 font-semibold'>
                      <span className='mr-2 text-primary'>{genderIcon((pl as { gender?: string }).gender)}</span>
                      <span className='break-words'>{pl.name}</span>
                      {pl.isHost && <span className='ml-2 text-xs text-primary'>хост</span>}
                      {(pl as { connected?: boolean }).connected === false && <span className='ml-2 text-xs text-muted-foreground'>не в сети</span>}
                    </span>
                    {isHost && pl.id !== myId && (
                      <button onClick={() => kickPlayer(pl.id)} className='shrink-0 text-xs text-destructive'>убрать</button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
        {isHost && (
          <QrJoinDialog
            open={qrOpen}
            onClose={() => setQrOpen(false)}
            roomCode={effectiveRoomCode}
            joinUrl={joinUrl}
            onCopy={handleShare}
          />
        )}
        <ConfirmLeaveDialog
          open={leaveConfirmOpen}
          onClose={() => setLeaveConfirmOpen(false)}
          onConfirm={confirmLeave}
          isHost={isHost}
        />
      </Center>
    );
  }

  return (
    <>
      <GamePlay
        state={gameState}
        myId={myId}
        sendAction={sendAction}
        isHost={isHost}
        connectionStatus={connectionStatus}
        connectionMode={connectionMode}
        connectionError={connectionError}
        syncPending={syncPending}
        pendingActionsCount={pendingActionsCount}
        onSync={forceSyncState}
        onLeave={requestLeave}
        onPlayAgain={() => startGame()}
      />
      <ConfirmLeaveDialog
        open={leaveConfirmOpen}
        onClose={() => setLeaveConfirmOpen(false)}
        onConfirm={confirmLeave}
        isHost={isHost}
      />
    </>
  );
}

function QrJoinDialog({ open, onClose, roomCode, joinUrl, onCopy }: {
  open: boolean;
  onClose: () => void;
  roomCode: string;
  joinUrl: string;
  onCopy: () => void;
}) {
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [qrError, setQrError] = useState('');
  const shouldWarnReachability = joinUrl ? isMobileReachabilityWarningUrl(joinUrl) : false;

  useEffect(() => {
    if (!open || !joinUrl) return;
    let cancelled = false;
    setQrDataUrl('');
    setQrError('');
    QRCode.toDataURL(joinUrl, {
      width: 360,
      margin: 2,
      errorCorrectionLevel: 'M',
      color: {
        dark: '#120f0d',
        light: '#ffffff',
      },
    })
      .then((dataUrl) => {
        if (!cancelled) setQrDataUrl(dataUrl);
      })
      .catch(() => {
        if (!cancelled) setQrError('Не удалось создать QR-код');
      });
    return () => {
      cancelled = true;
    };
  }, [open, joinUrl]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className='fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 px-4 py-4 backdrop-blur-sm' onClick={onClose}>
      <div
        role='dialog'
        aria-modal='true'
        aria-labelledby='qr-join-title'
        className='my-auto w-full max-w-[420px] rounded-xl border-2 border-border bg-card p-4 shadow-2xl'
        onClick={(event) => event.stopPropagation()}
      >
        <div className='mb-4 flex items-start justify-between gap-3'>
          <div>
            <div className='inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-xs font-bold uppercase tracking-[0.12em] text-primary'>
              <Smartphone className='h-3.5 w-3.5' />
              Быстрый вход
            </div>
            <h2 id='qr-join-title' className='mt-3 text-[1.75rem] font-black leading-tight text-foreground'>Подключиться по QR</h2>
            <p className='mt-1 text-sm text-muted-foreground'>Игрок сканирует код камерой, вводит имя и пол, затем сразу попадает в эту комнату.</p>
          </div>
          <button type='button' onClick={onClose} className='rounded-lg border border-border bg-background/70 p-2 text-muted-foreground transition-colors hover:text-foreground' aria-label='Закрыть QR-код'>
            <X className='h-5 w-5' />
          </button>
        </div>

        <div className='rounded-xl border border-border bg-background/45 p-2'>
          <div className='rounded-lg bg-white p-2'>
            {qrDataUrl ? (
              <img src={qrDataUrl} alt={`QR-код для комнаты ${roomCode}`} className='mx-auto aspect-square w-full max-w-[280px]' />
            ) : (
              <div className='flex aspect-square w-full items-center justify-center rounded-md bg-white text-sm font-semibold text-zinc-500'>
                {qrError || 'Создаю QR...'}
              </div>
            )}
          </div>
          <div className='mt-2 text-center'>
            <div className='text-xs text-muted-foreground'>Код комнаты</div>
            <div className='font-display text-[2rem] font-black leading-none tracking-widest text-primary'>{roomCode}</div>
          </div>
        </div>

        {shouldWarnReachability && (
          <div className='mt-3 rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-xs leading-relaxed text-amber-100'>
            Если игрок сканирует с другого телефона, ссылка должна быть открыта через публичный адрес сайта. На Railway QR будет вести на рабочий домен автоматически.
          </div>
        )}

        <div className='mt-4 hidden rounded-lg border border-border bg-background/35 px-3 py-2 text-xs text-muted-foreground break-all sm:block'>
          {joinUrl}
        </div>

        <div className='mt-3 grid gap-2 sm:mt-4 sm:grid-cols-2'>
          <button type='button' onClick={onCopy} className='btn-secondary flex items-center justify-center gap-2'>
            <Copy className='h-4 w-4' />
            Скопировать ссылку
          </button>
          <button type='button' onClick={onClose} className='btn-primary'>
            Готово
          </button>
        </div>
      </div>
    </div>
  );
}

function ConfirmLeaveDialog({ open, onClose, onConfirm, isHost }: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  isHost: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className='fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 py-6 backdrop-blur-sm' onClick={onClose}>
      <div
        role='dialog'
        aria-modal='true'
        aria-labelledby='leave-dialog-title'
        className='w-full max-w-[420px] rounded-xl border-2 border-border bg-card p-5 shadow-2xl'
        onClick={(event) => event.stopPropagation()}
      >
        <div className='flex items-start gap-3'>
          <div className='flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-destructive/40 bg-destructive/10 text-destructive'>
            <AlertTriangle className='h-5 w-5' />
          </div>
          <div className='min-w-0'>
            <h2 id='leave-dialog-title' className='text-xl font-black leading-tight'>Выйти из игры?</h2>
            <p className='mt-2 text-sm leading-relaxed text-muted-foreground'>
              {isHost
                ? 'Если выйдет хост, комната может закрыться для остальных игроков.'
                : 'Ты покинешь комнату. Вернуться можно будет только через код или сохранённую сессию.'}
            </p>
          </div>
        </div>
        <div className='mt-5 grid gap-2 sm:grid-cols-2'>
          <button type='button' onClick={onClose} className='btn-secondary'>Остаться</button>
          <button type='button' onClick={onConfirm} className='rounded-xl bg-destructive px-4 py-3 font-bold text-destructive-foreground transition-transform active:scale-[0.97]'>
            Выйти
          </button>
        </div>
      </div>
    </div>
  );
}

function ConnectionNotice({ status, mode, error, syncPending, pendingActionsCount, onSync }: {
  status: string;
  mode: string;
  error: string | null;
  syncPending: boolean;
  pendingActionsCount: number;
  onSync: () => void;
}) {
  const healthy = status === 'connected' && mode === 'websocket' && !error && pendingActionsCount === 0;
  const label = healthy
    ? 'Онлайн'
    : mode === 'polling'
      ? 'Резервный режим'
      : status === 'reconnecting'
        ? 'Переподключение'
        : status === 'connecting'
          ? 'Подключение'
          : 'Связь нестабильна';

  const statusTitle = [label, error, pendingActionsCount > 0 ? `${pendingActionsCount} в очереди` : null]
    .filter(Boolean)
    .join(' · ');

  return (
    <div
      title={statusTitle}
      aria-label={statusTitle}
      className={'inline-flex h-10 max-w-[min(54vw,17rem)] shrink-0 items-center gap-1.5 overflow-hidden rounded-lg border px-2 text-xs sm:max-w-[20rem] sm:px-2.5 ' + (healthy ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200' : 'border-amber-400/35 bg-amber-400/10 text-amber-100')}
    >
      {healthy ? <Wifi className='h-4 w-4 shrink-0' /> : <WifiOff className='h-4 w-4 shrink-0' />}
      <span className={'min-w-0 truncate font-bold ' + (healthy ? 'sr-only sm:not-sr-only' : '')}>{label}</span>
      {pendingActionsCount > 0 && (
        <span className='shrink-0 rounded-full border border-amber-300/40 px-1.5 py-0.5 text-[11px] font-bold tabular-nums' aria-label={`${pendingActionsCount} действий в очереди`}>
          {pendingActionsCount}
        </span>
      )}
      {!healthy && (
        <button
          type='button'
          onClick={onSync}
          disabled={syncPending}
          className='ml-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-current/30 transition-colors hover:bg-current/10 disabled:opacity-60'
          aria-label='Синхронизировать'
          title='Синхронизировать'
        >
          <RefreshCw className={'h-3.5 w-3.5 ' + (syncPending ? 'animate-spin' : '')} />
        </button>
      )}
    </div>
  );
}

function RolePrompt({ state, isLeader, myId }: { state: GameState; isLeader: boolean; myId: string | null }) {
  if (state.phase === 'roundResults' || state.phase === 'gameOver') return null;
  if (state.phase === 'answering' && !isLeader) return null;

  const submitted = Boolean(myId && state.submittedPlayerIds.includes(myId));
  const leaderName = state.players[state.currentLeaderIndex]?.name ?? 'ведущий';
  let eyebrow = 'Твоя задача';
  let title = '';
  let text = '';

  if (state.phase === 'answering') {
    title = isLeader ? 'Напиши настоящий ответ про себя' : `Ответь так, будто ты ${leaderName}`;
    text = submitted
      ? 'Ответ принят. Теперь можно смотреть, как подтягиваются остальные.'
      : isLeader
        ? 'Этот ответ будет эталоном для раунда. Игроки его увидят только на судействе.'
        : 'Твой ответ анонимный. Чем правдоподобнее маскировка, тем сложнее ведущему.';
  } else if (state.phase === 'judging') {
    eyebrow = isLeader ? 'Ход ведущего' : 'Голосование';
    title = isLeader ? 'Выбери правильный ответ и угадай авторов' : 'Выбери самый смешной ответ';
    text = isLeader
      ? 'Сначала отметь правильный ответ. После этого назначь автора каждому варианту.'
      : state.myFunnyVoteId
        ? 'Голос принят. Реакции можно ставить отдельно, они не меняют выбор раунда.'
        : 'Выбери самый смешной ответ. Реакции открываются долгим тапом по ответу.';
  }

  return (
    <section className='rounded-lg border border-primary/30 bg-primary/10 px-4 py-3'>
      <div className='text-xs font-bold uppercase tracking-[0.14em] text-primary'>{eyebrow}</div>
      <div className='mt-1 text-lg font-black leading-tight text-foreground'>{title}</div>
      <div className='mt-1 text-sm leading-relaxed text-muted-foreground'>{text}</div>
    </section>
  );
}

function GamePlay({ state, myId, sendAction, isHost, connectionStatus, connectionMode, connectionError, syncPending, pendingActionsCount, onSync, onLeave, onPlayAgain }: {
  state: GameState; myId: string | null; isHost: boolean;
  sendAction: (a: { type: string; payload?: unknown }) => Promise<boolean> | void;
  connectionStatus: string;
  connectionMode: string;
  connectionError: string | null;
  syncPending: boolean;
  pendingActionsCount: number;
  onSync: () => void;
  onLeave: () => void; onPlayAgain: () => void;
}) {
  const leader = state.players[state.currentLeaderIndex];
  const isLeader = leader?.id === myId;
  const myPlayer = state.players.find((player) => player.id === myId);
  const [casinoOpen, setCasinoOpen] = useState(false);
  const send = (type: string, payload?: unknown) => sendAction({ type, payload } as never);
  const circle = Math.floor(state.round / Math.max(1, state.players.length)) + 1;
  const { visibleAnswers, revealComplete } = useJudgingReveal(state);
  const showJudgingInterface = state.phase !== 'judging' || revealComplete;
  const casinoAvailable = Boolean(myPlayer && myPlayer.score >= 1 && state.phase !== 'gameOver');

  useEffect(() => {
    setCasinoOpen(false);
  }, [state.phase, state.round, state.currentLeaderIndex, state.questionId]);

  return (
    <Center>
      <div className='w-full max-w-7xl space-y-3 pt-0 pb-4 sm:space-y-4 sm:py-6'>
        <div className='flex items-start justify-between gap-3'>
          <div className='min-w-0 pt-1'>
            <div className='text-[10px] uppercase tracking-[0.2em] text-muted-foreground sm:text-xs'>Узнай друзей</div>
            <div className='font-display text-2xl font-black leading-none text-primary sm:text-3xl'>Раунд {state.round + 1}</div>
            <div className='mt-1 text-[11px] text-muted-foreground sm:text-xs'>Круг {circle} · ход {state.currentLeaderIndex + 1} из {state.players.length}</div>
          </div>
          <div className='flex flex-wrap items-center justify-end gap-2'>
            <ConnectionNotice
              status={connectionStatus}
              mode={connectionMode}
              error={connectionError}
              syncPending={syncPending}
              pendingActionsCount={pendingActionsCount}
              onSync={onSync}
            />
            {casinoAvailable && (
              <button
                type='button'
                onClick={() => setCasinoOpen(true)}
                className='casino-top-button inline-flex h-9 w-9 items-center justify-center rounded-lg p-0 sm:h-10 sm:w-10 sm:rounded-xl'
                aria-label='Казино'
                title='Казино'
              >
                <Dice5 className='h-4 w-4' />
              </button>
            )}
            <button onClick={onLeave} className='btn-secondary inline-flex h-10 items-center gap-2 rounded-lg px-3 py-0 text-sm sm:h-auto sm:rounded-xl sm:px-4 sm:py-2'>
              <DoorOpen className='h-4 w-4' />
              Выйти
            </button>
          </div>
        </div>
        <div className='grid gap-4'>
          <main className='min-w-0 space-y-4'>
            {(state.phase === 'answering' || (state.phase === 'judging' && showJudgingInterface)) && (
              <QuestionPanel state={state} leader={leader} />
            )}
            {showJudgingInterface && <RolePrompt state={state} isLeader={isLeader} myId={myId} />}
            {state.phase === 'answering' && <Answering state={state} myId={myId} isLeader={isLeader} send={send} />}
            {state.phase === 'judging' && <Judging state={state} isLeader={isLeader} send={send} visibleAnswers={visibleAnswers} revealComplete={revealComplete} />}
            {state.phase === 'roundResults' && <RoundResults state={state} isLeader={isLeader} isHost={isHost} send={send} />}
            {state.phase === 'gameOver' && <GameOver state={state} isHost={isHost} onPlayAgain={onPlayAgain} onLeave={onLeave} />}
          </main>
        </div>
      </div>
      <CasinoRouletteDialog
        open={casinoOpen}
        state={state}
        myId={myId}
        send={send}
        onClose={() => setCasinoOpen(false)}
      />
    </Center>
  );
}

function CasinoRouletteDialog({ open, state, myId, send, onClose }: {
  open: boolean;
  state: GameState;
  myId: string | null;
  send: (t: string, p?: unknown) => Promise<boolean> | void;
  onClose: () => void;
}) {
  const player = state.players.find((pl) => pl.id === myId);
  const playerScore = player?.score ?? 0;
  const latestSpin = myId ? state.casinoLastSpins?.[myId] : undefined;
  const [betType, setBetType] = useState<CasinoBetType>('red');
  const [betNumber, setBetNumber] = useState(7);
  const [pending, setPending] = useState(false);
  const [spinState, setSpinState] = useState<'idle' | 'spinning' | 'revealed'>('idle');
  const [shownSpin, setShownSpin] = useState<CasinoSpinResult | null>(null);
  const [displayBalance, setDisplayBalance] = useState(playerScore);
  const [wheelRotation, setWheelRotation] = useState(0);
  const seenSpinIdRef = useRef<string | null>(null);
  const latestSpinRef = useRef<CasinoSpinResult | undefined>(undefined);
  const resolvedSpinRef = useRef<CasinoSpinResult | null>(null);
  const playerScoreRef = useRef(playerScore);
  const preSpinBalanceRef = useRef(playerScore);
  const revealTimerRef = useRef<number | null>(null);
  const canSpin = Boolean(player && playerScore >= 1 && state.phase !== 'gameOver' && !pending && spinState !== 'spinning');

  useEffect(() => {
    latestSpinRef.current = latestSpin;
  }, [latestSpin]);

  useEffect(() => {
    playerScoreRef.current = playerScore;
  }, [playerScore]);

  useEffect(() => {
    if (!open || spinState === 'spinning') return;
    setDisplayBalance(playerScore);
  }, [open, playerScore, spinState]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) {
      setPending(false);
      setSpinState('idle');
      resolvedSpinRef.current = null;
      if (revealTimerRef.current) {
        window.clearTimeout(revealTimerRef.current);
        revealTimerRef.current = null;
      }
      return;
    }
    const currentSpin = latestSpinRef.current;
    seenSpinIdRef.current = currentSpin?.id ?? null;
    resolvedSpinRef.current = null;
    setShownSpin(null);
    preSpinBalanceRef.current = playerScoreRef.current;
    setDisplayBalance(playerScoreRef.current);
    setSpinState('idle');
  }, [open]);

  useEffect(() => {
    if (!open || !latestSpin || latestSpin.id === seenSpinIdRef.current) return;
    seenSpinIdRef.current = latestSpin.id;
    setPending(false);
    resolvedSpinRef.current = latestSpin;
    setShownSpin(null);
    setSpinState('spinning');
    if (!pending) {
      preSpinBalanceRef.current = Math.max(0, playerScoreRef.current - latestSpin.scoreDelta);
      setDisplayBalance(preSpinBalanceRef.current);
    }

    const targetAngle = rouletteTargetAngle(latestSpin.resultNumber);
    setWheelRotation((current) => {
      const base = Math.ceil(current / 360) * 360;
      return base + 360 * 14 - targetAngle;
    });

    if (revealTimerRef.current) window.clearTimeout(revealTimerRef.current);
    revealTimerRef.current = window.setTimeout(() => {
      const resolvedSpin = resolvedSpinRef.current;
      if (!resolvedSpin) return;
      setShownSpin(resolvedSpin);
      setDisplayBalance(Math.max(0, preSpinBalanceRef.current + resolvedSpin.scoreDelta));
      setSpinState('revealed');
      navigator.vibrate?.(resolvedSpin.won ? [26, 42, 24, 64, 24, 86, 30] : 10);
    }, CASINO_SPIN_MS);
  }, [latestSpin, open, pending]);

  useEffect(() => () => {
    if (revealTimerRef.current) window.clearTimeout(revealTimerRef.current);
  }, []);

  if (!open) return null;

  const resultColor = shownSpin ? rouletteColorForNumber(shownSpin.resultNumber) : null;
  const numberOptions = Array.from({ length: 36 }, (_, index) => index + 1);
  const resultLabel = shownSpin
    ? shownSpin.resultNumber === 0
      ? '0 · зеро'
      : `${shownSpin.resultNumber} · ${resultColor === 'red' ? 'красное' : 'черное'}`
    : 'ожидание ставки';

  const changeNumber = (delta: number) => {
    setBetNumber((current) => {
      const next = current + delta;
      if (next < 1) return 36;
      if (next > 36) return 1;
      return next;
    });
  };

  const handleSpin = async () => {
    if (!canSpin) return;
    setPending(true);
    setSpinState('spinning');
    setShownSpin(null);
    resolvedSpinRef.current = null;
    preSpinBalanceRef.current = playerScore;
    setDisplayBalance(playerScore);
    const ok = await send('casino_spin', {
      betType,
      betNumber: betType === 'number' ? betNumber : null,
    });
    if (ok === false) {
      setPending(false);
      setSpinState('idle');
      resolvedSpinRef.current = null;
    }
  };

  return (
    <div
      data-casino-overlay
      className='fixed inset-0 z-50 overflow-y-auto bg-black/80 px-2 py-[max(0.6rem,env(safe-area-inset-top))] backdrop-blur-md sm:px-5 sm:py-5'
      onClick={onClose}
    >
      <div className='flex min-h-full items-start justify-center sm:items-center'>
      <div
        role='dialog'
        aria-modal='true'
        aria-labelledby='casino-title'
        className={'casino-dialog relative w-full max-w-[760px] overflow-y-auto overscroll-contain rounded-2xl border p-3 shadow-2xl sm:p-4 ' + (shownSpin?.won && spinState === 'revealed' ? 'casino-dialog-win' : '')}
        onClick={(event) => event.stopPropagation()}
      >
        <div className='casino-sparkle-field' aria-hidden='true' />
        {shownSpin?.won && spinState === 'revealed' && (
          <div className='casino-fireworks' aria-hidden='true'>
            {CASINO_FIREWORKS.map((spark, index) => (
              <span
                key={index}
                style={{
                  '--casino-spark-angle': `${spark.angle}deg`,
                  '--casino-spark-distance': `${spark.distance}px`,
                  '--casino-spark-delay': `${spark.delay}ms`,
                } as CSSProperties}
              />
            ))}
          </div>
        )}
        <div className='casino-dialog-header relative z-30 flex items-start justify-between gap-3'>
          <div className='min-w-0'>
            <div className='inline-flex items-center gap-1.5 rounded-full border border-amber-300/35 bg-amber-300/10 px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.18em] text-amber-200'>
              <Dice5 className='h-3.5 w-3.5' />
              1 очко
            </div>
            <h2 id='casino-title' className='mt-2 font-display text-[1.65rem] font-black leading-none text-amber-100 sm:text-3xl'>Казино</h2>
            <div className='mt-1 text-xs font-semibold text-amber-100/70'>
              Баланс: <span id='casino-balance-value' className='text-amber-200'>{displayBalance}</span> · ставка всегда одна
              {spinState === 'spinning' && <span className='ml-1 text-amber-300/70'>· результат скрыт</span>}
            </div>
          </div>
          <button type='button' onClick={onClose} className='inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-white/10 bg-black/35 text-amber-100 transition-colors hover:bg-white/10' aria-label='Закрыть казино'>
            <X className='h-5 w-5' />
          </button>
        </div>

        <div className='relative z-10 mt-3 grid gap-3 md:grid-cols-[minmax(0,1.04fr)_minmax(17.5rem,0.96fr)] md:items-center'>
          <div className='casino-wheel-wrap mx-auto' aria-label='Колесо рулетки'>
            <div className='casino-pointer' aria-hidden='true' />
            <div
              className={'casino-wheel ' + (pending ? 'casino-wheel-waiting' : '')}
              style={{
                background: ROULETTE_WHEEL_BACKGROUND,
                transform: `rotate(${wheelRotation}deg)`,
              }}
            >
              <div className='casino-wheel-ring' />
              {ROULETTE_SEQUENCE.flatMap((number, index) => {
                const pocketColor = rouletteColorForNumber(number);
                const pocketAngle = index * ROULETTE_POCKET_DEGREES + ROULETTE_POCKET_DEGREES / 2;
                return [
                  <span
                    key={`${number}-divider`}
                    className='casino-pocket-divider'
                    style={{ transform: `translateX(-50%) rotate(${index * ROULETTE_POCKET_DEGREES}deg)` }}
                    aria-hidden='true'
                  />,
                  <span
                    key={number}
                    className={`casino-pocket-label casino-pocket-${pocketColor}`}
                    style={{
                      transform: `translate(-50%, -50%) rotate(${pocketAngle}deg) translateY(calc(-1 * var(--casino-pocket-radius))) rotate(-${pocketAngle}deg)`,
                    }}
                  >
                    {number}
                  </span>,
                ];
              })}
            </div>
            <div className='casino-wheel-center'>
              <div className='text-[10px] font-black uppercase tracking-[0.16em] text-amber-200/70'>Roulette</div>
              <div className='font-display text-2xl font-black text-amber-100'>{state.targetScore}</div>
            </div>
          </div>

          <div className='space-y-3'>
            <div className={'casino-result-panel ' + (shownSpin && spinState === 'revealed' ? (shownSpin.won ? 'casino-result-win' : 'casino-result-lose') : '')} aria-live='polite'>
              <div className='text-[10px] font-black uppercase tracking-[0.18em] text-amber-100/55'>Выпало</div>
              <div className='mt-1 flex items-center justify-between gap-3'>
                <div className={`casino-result-number casino-result-number-${resultColor ?? 'hidden'}`}>
                  {shownSpin && spinState === 'revealed' ? shownSpin.resultNumber : '?'}
                </div>
                <div className='min-w-0 text-right'>
                  <div className='truncate text-sm font-black text-amber-50'>
                    {spinState === 'spinning' ? 'рулетка крутится' : resultLabel}
                  </div>
                  <div className='text-xs text-amber-100/60'>
                    {shownSpin && spinState === 'revealed'
                      ? `ставка: ${formatCasinoBet(shownSpin)}`
                      : spinState === 'spinning'
                        ? 'результат появится после остановки'
                        : 'выберите ставку'}
                  </div>
                </div>
              </div>
              {shownSpin && spinState === 'revealed' && (
                <div className={'mt-2 rounded-lg px-3 py-2 text-center text-sm font-black ' + (shownSpin.won ? 'bg-emerald-400/15 text-emerald-200' : 'bg-red-500/15 text-red-100')}>
                  {shownSpin.won ? `Победа! ${shownSpin.scoreDelta > 0 ? '+' : ''}${shownSpin.scoreDelta} очка` : '-1 очко'}
                </div>
              )}
            </div>

            <div className='casino-betting-table' aria-label='Ставки казино'>
              <button
                type='button'
                disabled={!canSpin}
                onClick={handleSpin}
                className='casino-spin-button casino-spin-button-table'
              >
                {pending ? 'Крупье крутит...' : spinState === 'spinning' ? 'Рулетка крутится...' : 'Крутить'}
              </button>

              <div className='casino-color-grid'>
                {CASINO_BETS.filter((bet) => bet.type === 'red' || bet.type === 'black').map((bet) => (
                  <button
                    key={bet.type}
                    type='button'
                    disabled={pending || spinState === 'spinning'}
                    onClick={() => setBetType(bet.type)}
                    className={'casino-board-cell casino-color-cell ' + bet.className + (betType === bet.type ? ' casino-board-selected' : '')}
                  >
                    <span className='casino-mini-pockets' aria-hidden='true'>
                      <i />
                      <i />
                      <i />
                    </span>
                    <span className='casino-board-label'>{bet.label}</span>
                    <strong>{bet.payout}</strong>
                  </button>
                ))}
              </div>

              <button
                type='button'
                disabled={pending || spinState === 'spinning'}
                onClick={() => setBetType('number')}
                className={'casino-board-cell casino-number-cell ' + (betType === 'number' ? 'casino-board-selected' : '')}
              >
                <span className='casino-chip casino-chip-number'>{betNumber}</span>
                <span className='casino-board-label'>Конкретное число</span>
                <strong>+4</strong>
              </button>

              <button
                type='button'
                disabled={pending || spinState === 'spinning'}
                onClick={() => setBetType('zero')}
                className={'casino-board-cell casino-zero-cell casino-zero-cell-compact ' + (betType === 'zero' ? 'casino-board-selected' : '')}
              >
                <span className='casino-chip casino-chip-zero'>0</span>
                <span className='casino-board-label'>Зеро</span>
                <strong>+6</strong>
              </button>
            </div>

            {betType === 'number' && (
              <div className='casino-number-picker'>
                <button type='button' onClick={() => changeNumber(-1)} disabled={pending || spinState === 'spinning'} aria-label='Предыдущее число'>−</button>
                <select
                  value={betNumber}
                  disabled={pending || spinState === 'spinning'}
                  onChange={(event) => setBetNumber(Number(event.target.value))}
                  aria-label='Число ставки'
                >
                  {numberOptions.map((number) => (
                    <option key={number} value={number}>{number}</option>
                  ))}
                </select>
                <button type='button' onClick={() => changeNumber(1)} disabled={pending || spinState === 'spinning'} aria-label='Следующее число'>+</button>
              </div>
            )}

            {!player || player.score < 1 ? (
              <div className='rounded-lg border border-red-400/25 bg-red-500/10 px-3 py-2 text-center text-xs font-semibold text-red-100'>
                Нужно минимум 1 очко.
              </div>
            ) : (
              <div className='text-center text-[11px] leading-relaxed text-amber-100/55'>
                Проигрыш снимает 1 очко. Победа начисляет бонус ставки.
              </div>
            )}
          </div>
        </div>
      </div>
      </div>
    </div>
  );
}

function QuestionPanel({ state, leader }: { state: GameState; leader?: Player }) {
  return (
    <section className='card overflow-hidden'>
      <div className='border-b border-border bg-primary/10 px-5 py-4 sm:px-6'>
        <div className='text-xs uppercase tracking-[0.18em] text-muted-foreground'>Ведущий</div>
        <div className='mt-1 flex flex-wrap items-center gap-2 text-2xl font-black text-primary'>
          <span className='break-words'>{leader?.name}</span>
        </div>
      </div>
      <div className='px-5 py-6 sm:px-6 sm:py-8'>
        <div className='text-2xl font-display font-bold leading-snug text-balance sm:text-3xl'>
          {state.questionText}
        </div>
      </div>
    </section>
  );
}

function Answering({ state, myId, isLeader, send }: { state: GameState; myId: string | null; isLeader: boolean; send: (t: string, p?: unknown) => void; }) {
  const [text, setText] = useState('');
  const submitted = !!myId && state.submittedPlayerIds.includes(myId);
  const total = state.players.length;
  const done = state.submittedPlayerIds.length;
  if (submitted) {
    return (
      <div className='card border-emerald-500/45 bg-emerald-500/10 p-6 text-center space-y-3'>
        <div className='mx-auto flex h-12 w-12 items-center justify-center rounded-lg border border-emerald-500/40 bg-emerald-500/15 text-2xl text-emerald-300'>✓</div>
        <div className='text-xl font-display font-bold'>Ответ принят</div>
        <div className='text-sm text-muted-foreground'>Ждём остальных: {done}/{total}. Твой текст уже в игре.</div>
      </div>
    );
  }
  return (
    <div className='card p-5 sm:p-6 space-y-4'>
      <div className='flex flex-wrap items-end justify-between gap-3'>
        <div>
          <div className='text-xs uppercase tracking-[0.16em] text-muted-foreground'>{isLeader ? 'Правильный ответ' : 'Твоя версия'}</div>
          <div className='mt-1 text-xl font-display font-bold'>{isLeader ? 'Напиши ответ про себя' : 'Попробуй ответить как ведущий'}</div>
        </div>
        <div className='text-xs text-muted-foreground'>Ответили: {done}/{total}</div>
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        maxLength={280}
        rows={6}
        placeholder={isLeader ? 'Правильный ответ…' : 'Твой анонимный ответ…'}
        className='min-h-[180px] w-full resize-y rounded-lg border-2 border-border bg-background px-4 py-3 text-lg outline-none transition-colors placeholder:text-muted-foreground focus:border-primary'
      />
      <div className='sticky bottom-3 z-20 -mx-2 flex flex-wrap items-center justify-end gap-3 rounded-xl border border-border bg-card/95 p-3 shadow-2xl backdrop-blur sm:static sm:mx-0 sm:border-0 sm:bg-transparent sm:p-0 sm:shadow-none'>
        <button disabled={!text.trim()} onClick={() => send('submit_answer', { text: text.trim() })} className='btn-primary inline-flex min-w-[180px] flex-1 items-center justify-center gap-2 disabled:opacity-50 sm:flex-none'>
          <Send className='h-4 w-4' />
          Отправить
        </button>
      </div>
    </div>
  );
}

function Judging({ state, isLeader, send, visibleAnswers, revealComplete }: {
  state: GameState;
  isLeader: boolean;
  send: (t: string, p?: unknown) => void;
  visibleAnswers: AnswerView[];
  revealComplete: boolean;
}) {
  const leaderId = state.players[state.currentLeaderIndex].id;
  const others = state.players.filter((pl) => pl.id !== leaderId);
  const [pendingVoteAnswerId, setPendingVoteAnswerId] = useState<string | null>(null);
  const canGuessAuthors = !!state.mostCorrectAnswerId;
  const guessedCount = state.answers.filter((answer) => Boolean(state.authorGuesses[answer.id])).length;
  const uniqueGuesses = new Set(Object.values(state.authorGuesses).filter(Boolean));
  const guessesComplete = state.answers.length > 0 && guessedCount === state.answers.length && uniqueGuesses.size === state.answers.length;
  const votesDone = state.funnyVotesSubmittedCount;
  const votesTotal = state.answers.length;
  const votesComplete = votesTotal > 0 && votesDone >= votesTotal && !!state.mostFunnyAnswerId;
  const readyToFinish = !!state.mostCorrectAnswerId && votesComplete && guessesComplete;

  useEffect(() => {
    setPendingVoteAnswerId(null);
  }, [state.myFunnyVoteId, state.round]);

  const handleVoteTap = (answerId: string) => {
    if (isLeader) return;
    if (pendingVoteAnswerId === answerId) {
      send('vote_funniest', { answerId });
      setPendingVoteAnswerId(null);
      return;
    }
    setPendingVoteAnswerId(answerId);
  };

  return (
    <div className={'judging-stage space-y-4 ' + (revealComplete ? 'judging-stage-ready' : '')}>
      <HostAnswerCard state={state} send={send} />
      <div className='judging-answer-grid grid min-h-[62dvh] content-start gap-3 md:min-h-[48dvh] md:grid-cols-2'>
        {visibleAnswers.map((a) => {
          const isCorrect = state.mostCorrectAnswerId === a.id;
          const isFunny = state.mostFunnyAnswerId === a.id;
          const guessedPlayerId = state.authorGuesses[a.id] || '';
          return (
            <JudgingAnswerCard
              key={a.id}
              answer={a}
              state={state}
              isLeader={isLeader}
              isCorrect={isCorrect}
              isFunny={isFunny}
              isPendingVote={pendingVoteAnswerId === a.id}
              canGuessAuthors={canGuessAuthors}
              revealComplete={revealComplete}
              guessedPlayerId={guessedPlayerId}
              others={others}
              send={send}
              onVoteTap={handleVoteTap}
            />
          );
        })}
      </div>
      {isLeader && revealComplete && (
        <div className='cinematic-panel sticky bottom-3 z-20 rounded-xl border border-border bg-card/95 p-3 shadow-2xl backdrop-blur sm:static sm:border-0 sm:bg-transparent sm:p-0 sm:shadow-none'>
        <button disabled={!readyToFinish} onClick={() => send('finish_judging')} className='btn-primary w-full disabled:opacity-50'>
          Завершить раунд
        </button>
        </div>
      )}
      {!isLeader && revealComplete && pendingVoteAnswerId && !state.myFunnyVoteId && (
        <div className='cinematic-panel sticky bottom-3 z-20 rounded-xl border border-border bg-card/95 p-3 shadow-2xl backdrop-blur sm:hidden'>
          <button onClick={() => handleVoteTap(pendingVoteAnswerId)} className='btn-primary w-full'>Подтвердить смешной ответ</button>
        </div>
      )}
    </div>
  );
}

function useAnswerReactionPicker(enabled: boolean) {
  const [open, setOpen] = useState(false);
  const pressTimerRef = useRef<number | null>(null);
  const longPressedRef = useRef(false);
  const pressPointRef = useRef<{ x: number; y: number } | null>(null);

  const clearPressTimer = () => {
    if (pressTimerRef.current !== null) {
      window.clearTimeout(pressTimerRef.current);
      pressTimerRef.current = null;
    }
  };

  useEffect(() => () => clearPressTimer(), []);

  useEffect(() => {
    if (!enabled) {
      clearPressTimer();
      setOpen(false);
    }
  }, [enabled]);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!enabled || event.button !== 0 || (event.target as HTMLElement).closest('[data-card-control]')) return;
    clearPressTimer();
    longPressedRef.current = false;
    pressPointRef.current = { x: event.clientX, y: event.clientY };
    pressTimerRef.current = window.setTimeout(() => {
      longPressedRef.current = true;
      setOpen(true);
      navigator.vibrate?.(12);
    }, ANSWER_REACTION_LONG_PRESS_MS);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const point = pressPointRef.current;
    if (!point) return;
    if (Math.hypot(event.clientX - point.x, event.clientY - point.y) > 12) {
      clearPressTimer();
    }
  };

  const finishPointerPress = () => {
    clearPressTimer();
    pressPointRef.current = null;
    longPressedRef.current = false;
  };

  const onContextMenu = (event: MouseEvent<HTMLDivElement>) => {
    if (!enabled || (event.target as HTMLElement).closest('[data-card-control]')) return;
    event.preventDefault();
    setOpen(true);
  };

  return {
    open,
    close: () => setOpen(false),
    onPointerDown,
    onPointerMove,
    onPointerUp: finishPointerPress,
    onPointerCancel: finishPointerPress,
    onPointerLeave: finishPointerPress,
    onContextMenu,
  };
}

function HostAnswerCard({ state, send }: {
  state: GameState;
  send: (t: string, p?: unknown) => void;
}) {
  const reactionPicker = useAnswerReactionPicker(true);

  return (
    <div
      onPointerDown={reactionPicker.onPointerDown}
      onPointerMove={reactionPicker.onPointerMove}
      onPointerUp={reactionPicker.onPointerUp}
      onPointerCancel={reactionPicker.onPointerCancel}
      onPointerLeave={reactionPicker.onPointerLeave}
      onContextMenu={reactionPicker.onContextMenu}
      className={
        'card answer-reveal relative touch-pan-y select-none overflow-visible border-2 border-emerald-500/50 p-5 transition-[padding] ' +
        (reactionPicker.open ? 'pt-20 ' : '')
      }
    >
      {reactionPicker.open && (
        <AnswerReactionPicker
          answerId={HOST_ANSWER_REACTION_ID}
          state={state}
          send={send}
          onPick={reactionPicker.close}
          onClose={reactionPicker.close}
        />
      )}
      <div className='text-xs font-semibold uppercase tracking-[0.16em] text-emerald-400'>Правильный ответ ведущего</div>
      <div className='mt-2 text-xl font-semibold'>{state.correctAnswer || '—'}</div>
      <div className='mt-3'>
        <AnswerReactionSummary answerId={HOST_ANSWER_REACTION_ID} state={state} />
      </div>
    </div>
  );
}

function JudgingAnswerCard({ answer, state, isLeader, isCorrect, isFunny, isPendingVote, canGuessAuthors, revealComplete, guessedPlayerId, others, send, onVoteTap }: {
  answer: AnswerView;
  state: GameState;
  isLeader: boolean;
  isCorrect: boolean;
  isFunny: boolean;
  isPendingVote: boolean;
  canGuessAuthors: boolean;
  revealComplete: boolean;
  guessedPlayerId: string;
  others: Player[];
  send: (t: string, p?: unknown) => void;
  onVoteTap: (answerId: string) => void;
}) {
  const myVote = state.myFunnyVoteId === answer.id;
  const showFunnyVoteButton = !isLeader && !state.myFunnyVoteId;
  const showCorrectButton = isLeader && !state.mostCorrectAnswerId;
  const voteCount = state.funnyVoteCounts?.[answer.id] ?? 0;
  const revealVoteCount = Boolean(state.mostFunnyAnswerId);
  const answerTone = toneForAnswer(answer.id);
  const reactionPicker = useAnswerReactionPicker(revealComplete);
  const reactionPickerSpace = reactionPicker.open ? 'pt-16 ' : '';
  const border = isCorrect
    ? 'border-emerald-500'
    : isFunny
      ? 'border-amber-400'
      : myVote
        ? 'border-accent/70'
        : isPendingVote
          ? 'border-amber-300/80'
          : 'border-border';

  return (
    <div
      onPointerDown={reactionPicker.onPointerDown}
      onPointerMove={reactionPicker.onPointerMove}
      onPointerUp={reactionPicker.onPointerUp}
      onPointerCancel={reactionPicker.onPointerCancel}
      onPointerLeave={reactionPicker.onPointerLeave}
      onContextMenu={reactionPicker.onContextMenu}
      className={'card answer-reveal answer-card ' + answerTone + ' relative flex min-h-[172px] touch-pan-y select-none flex-col justify-between p-4 ' + reactionPickerSpace + 'space-y-4 border-2 transition-all ' + (isLeader ? 'sm:min-h-[250px] ' : 'sm:min-h-[190px] ') + border}
    >
      {reactionPicker.open && (
        <AnswerReactionPicker
          answerId={answer.id}
          state={state}
          send={send}
          onPick={reactionPicker.close}
          onClose={reactionPicker.close}
        />
      )}
      <div className='space-y-3'>
        <div className='text-lg font-medium leading-relaxed break-words'>{answer.text}</div>
        <AnswerReactionSummary answerId={answer.id} state={state} />
        <div className='flex flex-wrap items-center gap-2'>
          {revealVoteCount && voteCount > 0 && <span className='badge border border-amber-400/40 bg-amber-400/10 text-amber-300'>Голосов: {voteCount}</span>}
          {myVote && <span className='badge border border-accent/40 bg-accent/10 text-accent'>Ваш голос</span>}
          {isPendingVote && !myVote && <span className='badge border border-amber-300/50 bg-amber-300/10 text-amber-200'>Подтвердите</span>}
          {isCorrect && <span className='badge bg-emerald-500/20 text-emerald-500'>самый правильный</span>}
          {isFunny && <span className='badge bg-amber-400/20 text-amber-500'>самый смешной</span>}
        </div>
      </div>
      <div className='space-y-3'>
        {revealComplete && showFunnyVoteButton && (
          <button
            type='button'
            data-card-control
            disabled={Boolean(state.myFunnyVoteId)}
            onClick={() => onVoteTap(answer.id)}
            className={
              'w-full rounded-lg border px-3 py-2 text-sm font-bold transition-all disabled:cursor-default ' +
              (myVote
                ? 'border-accent/60 bg-accent/15 text-accent'
                : isPendingVote
                  ? 'border-amber-300/70 bg-amber-300/15 text-amber-200'
                  : 'border-primary/35 bg-primary/10 text-primary hover:bg-primary/15 disabled:opacity-60')
            }
          >
            {myVote ? 'Голос принят' : isPendingVote ? 'Подтвердить смешной ответ' : 'Голос за смешной'}
          </button>
        )}
        {revealComplete && isLeader && (
          <div data-card-control className='space-y-3'>
            {showCorrectButton && (
              <button
                type='button'
                onClick={() => send('select_most_correct', { answerId: answer.id })}
                className='w-full rounded-lg border border-border bg-background/45 px-3 py-2 text-sm font-bold text-muted-foreground transition-colors hover:border-emerald-500/60 hover:text-emerald-300'
              >
                Это самый правильный
              </button>
            )}
            <div className='space-y-2'>
              <div className='text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground'>Кто автор?</div>
              <div className='flex flex-wrap gap-2'>
              {others.map((pl) => {
                const usedByAnotherAnswer = Object.entries(state.authorGuesses)
                  .some(([answerId, playerId]) => answerId !== answer.id && playerId === pl.id);
                const selected = guessedPlayerId === pl.id;
                return (
                  <button
                    key={pl.id}
                    type='button'
                    disabled={!canGuessAuthors || usedByAnotherAnswer}
                    onClick={() => send('guess_author', { answerId: answer.id, guessedPlayerId: pl.id })}
                    className={
                      'rounded-full border px-3 py-1.5 text-xs font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-35 ' +
                      (selected
                        ? 'border-primary bg-primary/15 text-primary'
                        : 'border-border bg-background/45 text-muted-foreground hover:border-primary/50 hover:text-foreground')
                    }
                  >
                    {pl.name}
                  </button>
                );
              })}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function AnswerReactionSummary({ answerId, state }: { answerId: string; state: GameState }) {
  const counts = state.answerReactions?.[answerId] ?? {};
  const mine = new Set(state.myAnswerReactions?.[answerId] ?? []);
  const visibleReactions = ANSWER_REACTIONS.filter((reaction) => (counts[reaction.type] ?? 0) > 0 || mine.has(reaction.type));
  if (visibleReactions.length === 0) return null;

  return (
    <div className='flex flex-wrap items-center gap-1.5' aria-label='Реакции на ответ'>
      {visibleReactions.map((reaction) => {
        const count = counts[reaction.type] ?? 0;
        const selected = mine.has(reaction.type);
        return (
          <span
            key={reaction.type}
            title={`${reaction.label}${count > 0 ? `: ${count}` : ''}`}
            aria-label={`${reaction.label}${count > 0 ? `: ${count}` : ''}`}
            className={
              'inline-flex h-8 items-center gap-1 rounded-full border px-2 text-base leading-none shadow-sm transition-colors ' +
              (selected ? reaction.activeClass : 'border-white/10 bg-black/20 text-foreground')
            }
          >
            <span aria-hidden='true'>{reaction.emoji}</span>
            {count > 0 && <span className='min-w-[0.75rem] text-xs font-black tabular-nums leading-none'>{count}</span>}
          </span>
        );
      })}
    </div>
  );
}

function AnswerReactionPicker({ answerId, state, send, onPick, onClose }: {
  answerId: string;
  state: GameState;
  send: (t: string, p?: unknown) => void;
  onPick: () => void;
  onClose: () => void;
}) {
  const counts = state.answerReactions?.[answerId] ?? {};
  const mine = new Set(state.myAnswerReactions?.[answerId] ?? []);

  return (
    <div
      data-card-control
      className='reaction-picker-anchor z-30'
      onPointerDown={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <div className='reaction-picker-popover flex items-center gap-1 rounded-full border border-white/10 bg-[#1f1f1f]/95 p-1.5 shadow-2xl backdrop-blur-xl'>
        {ANSWER_REACTIONS.map((reaction) => {
          const selected = mine.has(reaction.type);
          return (
            <button
              key={reaction.type}
              type='button'
              title={reaction.label}
              aria-label={reaction.label}
              aria-pressed={selected}
              onClick={() => {
                send('toggle_answer_reaction', { answerId, reaction: reaction.type });
                onPick();
              }}
              className={
                'reaction-picker-button relative inline-flex h-11 w-11 items-center justify-center rounded-full border text-2xl leading-none transition-all active:scale-90 ' +
                (selected ? reaction.activeClass : 'border-transparent text-foreground hover:bg-white/10')
              }
            >
              <span aria-hidden='true'>{reaction.emoji}</span>
              {(counts[reaction.type] ?? 0) > 0 && (
                <span className='absolute -right-1 -top-1 min-w-5 rounded-full border border-[#1f1f1f] bg-primary px-1 text-[10px] font-black leading-5 text-primary-foreground tabular-nums'>
                  {counts[reaction.type]}
                </span>
              )}
            </button>
          );
        })}
        <button
          type='button'
          title='Закрыть'
          aria-label='Закрыть реакции'
          onClick={onClose}
          className='inline-flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground'
        >
          <X className='h-4 w-4' />
        </button>
      </div>
    </div>
  );
}

function RoundResults({ state, isLeader, isHost, send }: { state: GameState; isLeader: boolean; isHost: boolean; send: (t: string, p?: unknown) => void; }) {
  const r = state.lastResult;
  const findText = (id: string | null) => state.answers.find((a) => a.id === id)?.text || '-';
  const leader = r ? state.players.find((player) => player.id === r.leaderId) : null;
  const leaderDelta = r ? (r.deltas[r.leaderId] ?? 0) : 0;
  const nextLabel = state.players.some((player) => player.score >= state.targetScore) ? 'К финалу' : 'Следующий раунд';

  return (
    <div className='overflow-hidden rounded-xl border-2 border-primary/40 bg-[radial-gradient(circle_at_top_left,hsl(var(--primary)/0.18),transparent_34%),linear-gradient(135deg,hsl(var(--card)),hsl(24_14%_8%))] p-5 shadow-2xl sm:p-6'>
      <div className='text-center'>
        <div className='mx-auto inline-flex h-12 w-12 items-center justify-center rounded-full border border-primary/35 bg-primary/15 text-primary'>
          <Sparkles className='h-6 w-6' />
        </div>
        <div className='mt-3 text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground'>Раунд завершён</div>
        <h2 className='mt-2 font-display text-3xl font-black text-primary sm:text-4xl'>Итоги раунда</h2>
        <p className='mx-auto mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground'>
          Ответы остаются анонимными: видно только, какие варианты победили. Личный счёт откроется в финале.
        </p>
      </div>

      {r && (
        <div className='mt-6 space-y-4'>
          <div className='rounded-lg border border-primary/35 bg-background/45 p-4 sm:flex sm:items-center sm:justify-between sm:gap-4'>
            <div className='min-w-0'>
              <div className='text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground'>Очки ведущего</div>
              <div className='mt-1 break-words text-xl font-black text-foreground'>
                {leader ? leader.name : r.leaderName}
              </div>
            </div>
            <div className='mt-3 flex items-center gap-3 sm:mt-0'>
              <Brain className='h-6 w-6 text-primary' />
              <div className='text-right'>
                <div className='text-3xl font-black text-primary'>+{leaderDelta}</div>
                <div className='text-xs text-muted-foreground'>{r.correctGuesses}/{r.totalGuessable} угадано</div>
              </div>
            </div>
          </div>

          <div className='grid gap-3 md:grid-cols-2'>
            <div className='rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-4'>
              <div className='flex items-center gap-2 text-xs font-bold uppercase tracking-[0.12em] text-emerald-300'>
                <CheckCircle2 className='h-4 w-4' />
                Самый правильный
              </div>
              <div className='mt-3 break-words text-lg font-semibold leading-relaxed'>{findText(r.mostCorrectAnswerId)}</div>
            </div>
            <div className='rounded-lg border border-amber-400/40 bg-amber-400/10 p-4'>
              <div className='flex items-center gap-2 text-xs font-bold uppercase tracking-[0.12em] text-amber-300'>
                <Laugh className='h-4 w-4' />
                Самый смешной
              </div>
              <div className='mt-3 break-words text-lg font-semibold leading-relaxed'>{findText(r.mostFunnyAnswerId)}</div>
            </div>
          </div>
        </div>
      )}

      <div className='mt-6'>
        {(isLeader || isHost) ? (
          <button onClick={() => send('next_round')} className='btn-primary inline-flex w-full items-center justify-center gap-2 sm:w-auto'>
            {nextLabel}
            <ArrowRight className='h-4 w-4' />
          </button>
        ) : (
          <div className='rounded-lg border border-border bg-background/35 px-4 py-3 text-center text-sm text-muted-foreground'>
            Ждём ведущего...
          </div>
        )}
      </div>
    </div>
  );
}

function GameOver({ state, isHost, onPlayAgain, onLeave }: { state: GameState; isHost: boolean; onPlayAgain: () => void; onLeave: () => void; }) {
  const winner = state.players.find((pl) => pl.id === state.winnerId);
  const ranking = [...state.players].sort((a, b) => b.score - a.score);
  const podium = ranking.slice(0, 3);
  return (
    <div className='overflow-hidden rounded-xl border-2 border-primary/40 bg-[radial-gradient(circle_at_top,hsl(var(--primary)/0.20),transparent_38%),linear-gradient(135deg,hsl(var(--card)),hsl(24_14%_8%))] p-5 shadow-2xl sm:p-6'>
      <div className='text-center'>
        <div className='mx-auto inline-flex h-14 w-14 items-center justify-center rounded-full border border-primary/35 bg-primary/15 text-primary'>
          <Trophy className='h-7 w-7' />
        </div>
        <div className='mt-3 text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground'>Финал</div>
        <div className='mt-2 font-display text-3xl font-black text-primary sm:text-4xl'>{winner ? winner.name : 'Ничья'}</div>
        <div className='mt-1 text-sm text-muted-foreground'>{winner ? 'побеждает в этой партии' : 'верхняя строчка поделена'}</div>
      </div>

      {podium.length > 0 && (
        <div className='mt-6 grid gap-3 sm:grid-cols-3'>
          {podium.map((player, index) => (
            <div key={player.id} className={'rounded-lg border p-4 text-center ' + (index === 0 ? 'border-primary/45 bg-primary/15 sm:-mt-3' : 'border-border bg-background/35')}>
              <div className='mx-auto mb-2 flex h-9 w-9 items-center justify-center rounded-full border border-current/30'>
                {index === 0 ? <Crown className='h-5 w-5' /> : <span className='font-black'>{index + 1}</span>}
              </div>
              <div className='break-words font-black'>{player.name}</div>
              <div className='mt-1 text-2xl font-black text-primary'>{player.score}</div>
            </div>
          ))}
        </div>
      )}

      <div className='mt-5 grid gap-2 sm:grid-cols-2'>
        {ranking.map((player, index) => (
          <div key={player.id} className='rounded-lg border border-border bg-background/35 px-4 py-3 flex items-center justify-between gap-3'>
            <div className='min-w-0 font-semibold'>
              {index + 1}. <span className='break-words'>{player.name}</span>
            </div>
            <div className='text-xl font-black'>{player.score}</div>
          </div>
        ))}
      </div>
      <div className='mt-5 flex flex-wrap gap-3'>
        {isHost ? (
          <button onClick={onPlayAgain} className='btn-primary flex min-w-[180px] flex-1 items-center justify-center gap-2'>
            <RefreshCw className='h-4 w-4' />
            Следующая игра
          </button>
        ) : (
          <div className='flex min-w-[220px] flex-1 items-center justify-center rounded-xl border border-primary/30 bg-primary/10 px-4 py-3 text-center text-sm font-semibold text-primary'>
            Не закрывайте вкладку — ждём следующей игры от хоста.
          </div>
        )}
        <button onClick={onLeave} className='btn-secondary flex min-w-[180px] flex-1 items-center justify-center gap-2'>
          <DoorOpen className='h-4 w-4' />
          Выйти
        </button>
      </div>
    </div>
  );
}

function Center({ children }: { children: ReactNode }) {
  return <div className='min-h-[100dvh] w-full bg-background px-4 py-3 text-foreground sm:px-6 sm:py-4 flex justify-center'>{children}</div>;
}

function Header({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className='text-center'>
      <h1 className='text-3xl font-display font-black text-primary'>{title}</h1>
      {subtitle && <p className='text-muted-foreground text-sm mt-1'>{subtitle}</p>}
    </div>
  );
}
