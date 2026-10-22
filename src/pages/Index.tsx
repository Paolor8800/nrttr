import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Users, Plus, LogIn, RefreshCw, QrCode } from 'lucide-react';
import { isValidRoomCode } from '@/lib/roomCode';
import { loadGameSession, clearGameSession } from '@/lib/gameCookies';

export default function Index() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const qrRoomCode = searchParams.get('room')?.trim().toUpperCase() || '';
  const [name, setName] = useState('');
  const [gender, setGender] = useState<'male' | 'female'>(() => { try { return (localStorage.getItem('player_gender') as 'male'|'female') || 'male'; } catch { return 'male'; } });
  useEffect(() => {
    try {
      localStorage.setItem('player_gender', gender);
    } catch (error) {
      void error;
    }
  }, [gender]);
  const [joinCode, setJoinCode] = useState('');
  const [mode, setMode] = useState<'menu' | 'join'>('menu');
  const [error, setError] = useState('');
  const [savedSession, setSavedSession] = useState<ReturnType<typeof loadGameSession>>(null);

  // Проверяем наличие сохраненной сессии при загрузке
  useEffect(() => {
    const session = loadGameSession();
    if (session && !qrRoomCode) {
      setSavedSession(session);
    }
  }, [qrRoomCode]);

  useEffect(() => {
    if (!qrRoomCode) return;

    setJoinCode(qrRoomCode);
    setMode('join');
    setError('');
    setSavedSession(null);
  }, [qrRoomCode]);

  const handleCreate = () => {
    if (!name.trim()) { setError('Введи своё имя'); return; }
    clearGameSession();
    const params = new URLSearchParams({ host: 'true', name: name.trim(), gender });
    navigate(`/game?${params.toString()}`);
  };

  const handleJoin = () => {
    if (!name.trim()) { setError('Введи своё имя'); return; }
    if (!joinCode.trim()) { setError('Введи код комнаты'); return; }
    if (!isValidRoomCode(joinCode.trim().toUpperCase())) {
      setError('Неверный формат кода (должно быть 6 символов A-Z, 2-9)');
      return;
    }
    const params = new URLSearchParams({
      host: 'false',
      name: name.trim(),
      room: joinCode.trim().toUpperCase(),
      gender,
    });
    navigate(`/game?${params.toString()}`);
  };

  const handleRestoreSession = () => {
    if (!savedSession) return;
    
    // Восстанавливаем игру с сохраненными параметрами
    const params = new URLSearchParams({
      host: savedSession.isHost.toString(),
      name: savedSession.playerName,
      room: savedSession.roomCode,
    });
    
    navigate(`/game?${params.toString()}`);
  };

  const handleDiscardSession = () => {
    clearGameSession();
    setSavedSession(null);
  };

  return (
    <div className="min-h-[100dvh] flex flex-col items-center justify-center px-4 py-8 relative overflow-hidden">
      {/* Background effects */}
      <div className="absolute inset-0 bg-gradient-to-b from-primary/5 via-background to-background" />
      <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-[600px] h-[600px] rounded-full bg-primary/5 blur-[120px]" />

      <div className="relative z-10 w-full max-w-sm flex flex-col items-center gap-8">
        {/* Logo */}
        <div className="text-center animate-fade-in-up">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-primary/20 mb-4 overflow-hidden">
            <img src="/Main.ico" alt="Узнай друзей" className="w-12 h-12 object-contain" />
          </div>
          <h1 className="text-3xl sm:text-4xl font-display font-black text-foreground leading-tight text-balance">
            <span className="text-primary">УЗНАЙ</span><br />ДРУЗЕЙ
          </h1>
          <p className="text-muted-foreground text-sm mt-2">Весёлая игра для 3–10 друзей</p>
          <div className="mt-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground/55">beta версия</div>
        </div>

        {/* Восстановление сессии */}
        {savedSession && !qrRoomCode && (
          <div className="w-full p-4 rounded-xl bg-primary/10 border-2 border-primary/30 animate-fade-in-up space-y-3">
            <div className="flex items-center gap-2 text-primary">
              <RefreshCw className="w-4 h-4" />
              <span className="text-sm font-semibold">Найдена незавершенная игра</span>
            </div>
            <div className="text-xs text-muted-foreground space-y-1">
              <p>Комната: <span className="font-bold text-foreground">{savedSession.roomCode}</span></p>
              <p>Игрок: <span className="font-bold text-foreground">{savedSession.playerName}</span></p>
              <p>Роль: <span className="font-bold text-foreground">{savedSession.isHost ? 'Хост' : 'Игрок'}</span></p>
              {savedSession.gameState && (
                <p>Фаза: <span className="font-bold text-foreground">
                  {savedSession.gameState.phase === 'answering' ? 'Ответы игроков' :
                   savedSession.gameState.phase === 'judging' ? 'Судейство' :
                   savedSession.gameState.phase === 'roundResults' ? 'Итоги раунда' :
                   savedSession.gameState.phase === 'gameOver' ? 'Игра окончена' : 'Игра'}
                </span></p>
              )}
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleRestoreSession}
                className="flex-1 px-4 py-2 rounded-lg bg-primary text-primary-foreground font-semibold text-sm transition-all hover:brightness-110 active:scale-[0.97]"
              >
                Продолжить
              </button>
              <button
                onClick={handleDiscardSession}
                className="px-4 py-2 rounded-lg bg-secondary text-secondary-foreground font-semibold text-sm transition-all hover:bg-secondary/80 active:scale-[0.97]"
              >
                Отменить
              </button>
            </div>
          </div>
        )}

        {qrRoomCode && (
          <div className="w-full rounded-xl border-2 border-accent/40 bg-accent/10 p-4 animate-fade-in-up">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-accent">
                <QrCode className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <div className="text-sm font-bold text-accent">QR-код распознан</div>
                <div className="text-xs text-muted-foreground">
                  Комната <span className="font-bold text-foreground">{qrRoomCode}</span> уже выбрана. Введи имя и пол, чтобы присоединиться.
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Name input */}
        <div className="w-full space-y-3 animate-fade-in-up" style={{ animationDelay: '100ms' }}>
          <input
            type="text"
            placeholder="Твоё имя"
            value={name}
            onChange={(e) => { setName(e.target.value); setError(''); }}
            maxLength={16}
            className="w-full px-4 py-3 rounded-xl bg-card border-2 border-border text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none transition-colors text-center font-semibold text-lg"
          />
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => setGender('male')}
              className={`px-4 py-3 rounded-xl border-2 font-semibold transition-colors ${gender === 'male' ? 'border-primary bg-primary/15 text-primary' : 'border-border bg-card text-muted-foreground'}`}
            >
              ♂ Мужской
            </button>
            <button
              type="button"
              onClick={() => setGender('female')}
              className={`px-4 py-3 rounded-xl border-2 font-semibold transition-colors ${gender === 'female' ? 'border-primary bg-primary/15 text-primary' : 'border-border bg-card text-muted-foreground'}`}
            >
              ♀ Женский
            </button>
          </div>
          {error && <p className="text-accent text-xs text-center">{error}</p>}
        </div>

        {/* Actions */}
        {mode === 'menu' ? (
          <div className="w-full space-y-3 animate-fade-in-up" style={{ animationDelay: '200ms' }}>
            <button
              onClick={handleCreate}
              className="w-full flex items-center justify-center gap-2 px-6 py-4 rounded-xl bg-primary text-primary-foreground font-display font-bold text-lg transition-all hover:brightness-110 active:scale-[0.97] card-glow"
            >
              <Plus className="w-5 h-5" />
              Создать игру
            </button>
            <button
              onClick={() => setMode('join')}
              className="w-full flex items-center justify-center gap-2 px-6 py-4 rounded-xl bg-secondary text-secondary-foreground font-display font-semibold text-lg transition-all hover:bg-secondary/80 active:scale-[0.97] border border-border"
            >
              <LogIn className="w-5 h-5" />
              Присоединиться
            </button>
          </div>
        ) : (
          <div className="w-full space-y-3 animate-fade-in-up">
            <input
              type="text"
              placeholder="Код комнаты"
              value={joinCode}
              onChange={(e) => { setJoinCode(e.target.value.toUpperCase()); setError(''); }}
              maxLength={6}
              className="w-full px-4 py-3 rounded-xl bg-card border-2 border-border text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none transition-colors text-center font-display font-bold text-2xl tracking-[0.3em] uppercase"
            />
            <button
              onClick={handleJoin}
              className="w-full flex items-center justify-center gap-2 px-6 py-4 rounded-xl bg-primary text-primary-foreground font-display font-bold text-lg transition-all hover:brightness-110 active:scale-[0.97] card-glow"
            >
              <Users className="w-5 h-5" />
              Войти в игру
            </button>
            <button
              onClick={() => setMode('menu')}
              className="w-full text-center text-sm text-muted-foreground hover:text-foreground transition-colors py-2"
            >
              ← Назад
            </button>
          </div>
        )}

        {/* Footer */}
        <div className="text-center space-y-2 animate-fade-in-up" style={{ animationDelay: '300ms' }}>
          <p className="text-muted-foreground/50 text-xs">
            Отвечай так, чтобы тебя не узнали
          </p>
        </div>
      </div>
    </div>
  );
}
