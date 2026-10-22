// Улучшенная генерация кодов комнат - 6 символов без путающихся I/1, O/0
export function generateRoomCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  const randomValues = new Uint32Array(6);
  crypto.getRandomValues(randomValues);
  for (let i = 0; i < 6; i++) {
    code += chars[randomValues[i] % chars.length];
  }
  return code;
}

// Валидация кода комнаты
export function isValidRoomCode(code: string): boolean {
  return /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/.test(code);
}
