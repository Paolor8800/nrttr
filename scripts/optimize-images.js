/**
 * Скрипт для оптимизации изображений
 * Использование: node scripts/optimize-images.js
 * 
 * Требует: npm install --save-dev sharp
 */

import sharp from 'sharp';
import { readdir, stat } from 'fs/promises';
import { join } from 'path';

const PUBLIC_DIR = 'public';
const TARGET_QUALITY = 80;
const MAX_WIDTH = 1920;

async function optimizeImage(filePath) {
  try {
    const stats = await stat(filePath);
    const originalSize = stats.size / 1024; // KB

    if (originalSize < 100) {
      console.log(`⏭️  Пропуск ${filePath} (уже оптимизирован: ${originalSize.toFixed(0)} KB)`);
      return;
    }

    console.log(`🔄 Оптимизация ${filePath} (${originalSize.toFixed(0)} KB)...`);

    // Определяем формат
    const ext = filePath.toLowerCase().split('.').pop();
    
    if (ext === 'jpeg' || ext === 'jpg') {
      // Конвертируем JPEG в WebP для лучшего сжатия
      const webpPath = filePath.replace(/\.(jpeg|jpg)$/i, '.webp');
      
      await sharp(filePath)
        .resize(MAX_WIDTH, null, { 
          withoutEnlargement: true,
          fit: 'inside'
        })
        .webp({ quality: TARGET_QUALITY })
        .toFile(webpPath);

      const newStats = await stat(webpPath);
      const newSize = newStats.size / 1024;
      const savings = ((originalSize - newSize) / originalSize * 100).toFixed(1);

      console.log(`✅ Создан ${webpPath} (${newSize.toFixed(0)} KB, экономия ${savings}%)`);
      console.log(`   Замените в коде: ${filePath.split('/').pop()} → ${webpPath.split('/').pop()}`);
    } else if (ext === 'png') {
      // Оптимизируем PNG
      const optimizedPath = filePath.replace('.png', '.optimized.png');
      
      await sharp(filePath)
        .resize(MAX_WIDTH, null, { 
          withoutEnlargement: true,
          fit: 'inside'
        })
        .png({ quality: TARGET_QUALITY, compressionLevel: 9 })
        .toFile(optimizedPath);

      const newStats = await stat(optimizedPath);
      const newSize = newStats.size / 1024;
      const savings = ((originalSize - newSize) / originalSize * 100).toFixed(1);

      console.log(`✅ Создан ${optimizedPath} (${newSize.toFixed(0)} KB, экономия ${savings}%)`);
    }
  } catch (error) {
    console.error(`❌ Ошибка при оптимизации ${filePath}:`, error.message);
  }
}

async function processDirectory(dir) {
  const files = await readdir(dir);
  
  for (const file of files) {
    const filePath = join(dir, file);
    const stats = await stat(filePath);
    
    if (stats.isDirectory()) {
      await processDirectory(filePath);
    } else if (/\.(jpeg|jpg|png)$/i.test(file)) {
      await optimizeImage(filePath);
    }
  }
}

console.log('🖼️  Начинаем оптимизацию изображений...\n');

processDirectory(PUBLIC_DIR)
  .then(() => {
    console.log('\n✅ Оптимизация завершена!');
    console.log('\n📝 Не забудьте:');
    console.log('   1. Обновить пути к изображениям в коде');
    console.log('   2. Удалить старые неоптимизированные файлы');
    console.log('   3. Добавить fallback для браузеров без поддержки WebP');
  })
  .catch(error => {
    console.error('❌ Ошибка:', error);
    process.exit(1);
  });
