function copyWithTextarea(text: string) {
  const textarea = document.createElement('textarea');

  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';

  document.body.appendChild(textarea);
  textarea.select();

  try {
    const copied = document.execCommand('copy');
    if (!copied) {
      throw new Error('Copy command was rejected.');
    }
  } finally {
    document.body.removeChild(textarea);
  }
}

export async function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  copyWithTextarea(text);
}
