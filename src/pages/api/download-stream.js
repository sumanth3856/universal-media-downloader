import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import ffmpegPath from 'ffmpeg-static';

// SSE Progress endpoint - streams download progress in real-time
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { url, quality = 'best', customFilename, subtitles, outputFormat = 'mp4' } = req.body;
  
  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  // Helper to send SSE messages
  const sendEvent = (type, data) => {
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  };

  // Download directory
  const downloadDir = path.join(process.cwd(), 'public', 'downloads');
  if (!fs.existsSync(downloadDir)) {
    fs.mkdirSync(downloadDir, { recursive: true });
  }

  // Build format string based on quality
  let formatString = 'bestvideo[vcodec^=avc1]+bestaudio[ext=m4a]/bestvideo+bestaudio/best';
  let qualitySuffix = '_best';
  let postprocessorArgs = 'ffmpeg:-c:v libx264 -preset ultrafast -crf 23 -c:a aac -b:a 192k';
  let outputExt = outputFormat;
  
  if (quality === '1080') {
    formatString = 'bestvideo[height<=1080][vcodec^=avc1]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best[height<=1080]';
    qualitySuffix = '_1080p';
    postprocessorArgs = 'ffmpeg:-c:v libx264 -preset ultrafast -crf 23 -vf scale=-2:1080 -c:a aac -b:a 192k';
  } else if (quality === '720') {
    formatString = 'bestvideo[height<=720][vcodec^=avc1]+bestaudio[ext=m4a]/bestvideo[height<=720]+bestaudio/best[height<=720]';
    qualitySuffix = '_720p';
    postprocessorArgs = 'ffmpeg:-c:v libx264 -preset ultrafast -crf 23 -vf scale=-2:720 -c:a aac -b:a 128k';
  } else if (quality === '480') {
    formatString = 'bestvideo[height<=480][vcodec^=avc1]+bestaudio[ext=m4a]/bestvideo[height<=480]+bestaudio/best[height<=480]';
    qualitySuffix = '_480p';
    postprocessorArgs = 'ffmpeg:-c:v libx264 -preset ultrafast -crf 25 -vf scale=-2:480 -c:a aac -b:a 96k';
  } else if (quality === 'audio') {
    qualitySuffix = '_audio';
    outputExt = 'mp3';
  }

  // Custom filename or default template
  const baseFilename = customFilename 
    ? customFilename.replace(/[<>:"/\\|?*]/g, '_') + qualitySuffix
    : `%(title)s${qualitySuffix}`;
  
  const outputTemplate = path.join(downloadDir, `${baseFilename}.${outputExt === 'mp3' ? 'mp3' : '%(ext)s'}`);

  sendEvent('progress', { stage: 'Starting', percent: 0, message: 'Initializing download...' });

  // Build yt-dlp arguments
  let args = ['-m', 'yt_dlp', '--newline', '--progress']; // --newline for line-by-line progress

  if (quality === 'audio') {
    args = args.concat([
      '-x',
      '--audio-format', 'mp3',
      '--audio-quality', '0',
      '--ffmpeg-location', ffmpegPath,
      '-o', outputTemplate,
      '--no-playlist',
      '--restrict-filenames',
      '--print', 'filename',
      '--force-overwrites',
      '--no-cache-dir',
      '--extractor-retries', '5',
      '--sleep-requests', '1',
      '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    ]);
  } else {
    args = args.concat([
      '-f', formatString,
      '--merge-output-format', outputFormat,
      '--ffmpeg-location', ffmpegPath,
      '-o', outputTemplate,
      '--no-playlist',
      '--postprocessor-args', postprocessorArgs,
      '--restrict-filenames',
      '--print', 'filename',
      '--no-simulate',
      '--retries', '5',
      '--fragment-retries', '5',
      '--extractor-retries', '5',
      '--force-overwrites',
      '--no-cache-dir',
      '--sleep-requests', '1',
      '--sleep-interval', '2',
      '--max-sleep-interval', '5',
      '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    ]);
  }

  // Add subtitles if requested
  if (subtitles) {
    args.push('--write-subs', '--sub-lang', 'en', '--embed-subs');
  }

  args.push(url);

  const ytDlp = spawn('python', args);
  let outputFilename = '';

  ytDlp.stdout.on('data', (data) => {
    const lines = data.toString().split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;

      // Parse progress from yt-dlp output
      // Example: [download]  45.2% of 100.00MiB at 5.00MiB/s ETA 00:12
      const downloadMatch = line.match(/\[download\]\s+([\d.]+)%\s+of\s+([\d.]+\w+)\s+at\s+([\d.]+\w+\/s)/);
      if (downloadMatch) {
        const percent = parseFloat(downloadMatch[1]);
        const size = downloadMatch[2];
        const speed = downloadMatch[3];
        sendEvent('progress', { 
          stage: 'Downloading', 
          percent: Math.min(percent * 0.7, 70), // Reserve 30% for post-processing
          message: `${percent.toFixed(1)}% of ${size} at ${speed}`
        });
      }

      // Merging stage
      if (line.includes('[Merger]') || line.includes('[ffmpeg]') || line.includes('Merging')) {
        sendEvent('progress', { stage: 'Merging', percent: 75, message: 'Merging video and audio...' });
      }

      // Encoding stage
      if (line.includes('Encoding') || line.includes('libx264') || line.includes('Converting')) {
        sendEvent('progress', { stage: 'Encoding', percent: 85, message: 'Re-encoding for compatibility...' });
      }

      // Capture output filename (last line is usually the filename)
      if (line.includes('.mp4') || line.includes('.mp3') || line.includes('.mkv') || line.includes('.webm')) {
        if (!line.includes('[') && !line.includes('%')) {
          outputFilename = line.trim();
        }
      }
    }
  });

  ytDlp.stderr.on('data', (data) => {
    const text = data.toString();
    console.error(`yt-dlp stderr: ${text}`);
    
    // Send error-like warnings to client
    if (text.includes('WARNING')) {
      sendEvent('warning', { message: text.trim() });
    }
  });

  ytDlp.on('close', (code) => {
    if (code === 0 && outputFilename) {
      const filename = path.basename(outputFilename);
      sendEvent('progress', { stage: 'Complete', percent: 100, message: 'Download complete!' });
      sendEvent('complete', { 
        filename,
        url: `/downloads/${filename}`
      });
    } else {
      sendEvent('error', { message: 'Download failed. Check if the URL is valid.' });
    }
    res.end();
  });

  ytDlp.on('error', (err) => {
    console.error('Spawn error:', err);
    sendEvent('error', { message: 'Failed to start download process.' });
    res.end();
  });

  // Handle client disconnect
  req.on('close', () => {
    ytDlp.kill('SIGTERM');
  });
}

// Disable body parser buffering for SSE
export const config = {
  api: {
    bodyParser: true,
    responseLimit: false,
  },
};
