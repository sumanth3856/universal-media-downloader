import { useState, useEffect, useRef } from 'react';

export default function Home() {
  // Core state
  const [url, setUrl] = useState('');
  const [urls, setUrls] = useState(''); // For batch mode
  const [quality, setQuality] = useState('best');
  const [status, setStatus] = useState('');
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  
  // UI state
  const [darkMode, setDarkMode] = useState(false);
  const [history, setHistory] = useState([]);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [batchMode, setBatchMode] = useState(false);
  
  // Progress state
  const [progress, setProgress] = useState({ percent: 0, stage: '', message: '' });
  
  // Batch queue state: [{ url, status: 'pending'|'downloading'|'complete'|'error', filename }]
  const [batchQueue, setBatchQueue] = useState([]);
  const [currentBatchIndex, setCurrentBatchIndex] = useState(-1);
  
  // Advanced options state
  const [customFilename, setCustomFilename] = useState('');
  const [subtitles, setSubtitles] = useState(false);
  const [outputFormat, setOutputFormat] = useState('mp4');
  
  // Refs
  const abortControllerRef = useRef(null);
  const eventSourceRef = useRef(null);

  // Quality options
  const qualityOptions = [
    { value: 'best', label: '🎬 Best Quality' },
    { value: '1080', label: '📺 1080p HD' },
    { value: '720', label: '📱 720p' },
    { value: '480', label: '💾 480p' },
    { value: 'audio', label: '🎵 Audio Only' }
  ];

  const formatOptions = [
    { value: 'mp4', label: 'MP4' },
    { value: 'mkv', label: 'MKV' },
    { value: 'webm', label: 'WEBM' }
  ];

  // Load theme and history on mount
  useEffect(() => {
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'dark') {
      setDarkMode(true);
      document.body.classList.add('dark-mode');
    }
    const savedHistory = JSON.parse(localStorage.getItem('downloadHistory') || '[]');
    setHistory(savedHistory);

    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
    };
  }, []);

  const toggleTheme = () => {
    const newMode = !darkMode;
    setDarkMode(newMode);
    document.body.classList.toggle('dark-mode', newMode);
    localStorage.setItem('theme', newMode ? 'dark' : 'light');
  };

  const addToHistory = (downloadData) => {
    const newItem = {
      filename: downloadData.filename,
      url: downloadData.url,
      originalUrl: url,
      date: new Date().toLocaleDateString()
    };
    const newHistory = [newItem, ...history].slice(0, 10);
    setHistory(newHistory);
    localStorage.setItem('downloadHistory', JSON.stringify(newHistory));
  };

  const clearHistory = () => {
    setHistory([]);
    localStorage.removeItem('downloadHistory');
  };

  const handleRefresh = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }
    setLoading(false);
    setStatus('Ready');
    setError(null);
    setResult(null);
    setProgress({ percent: 0, stage: '', message: '' });
    setBatchQueue([]);
    setCurrentBatchIndex(-1);
  };

  // Download a single URL with streaming progress
  const downloadSingleUrl = async (targetUrl, index = -1) => {
    return new Promise(async (resolve, reject) => {
      try {
        const response = await fetch('/api/download-stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            url: targetUrl, 
            quality,
            customFilename: customFilename || undefined,
            subtitles,
            outputFormat: quality === 'audio' ? 'mp3' : outputFormat
          }),
        });

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let resultData = null;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const data = JSON.parse(line.slice(6));
                
                if (data.type === 'progress') {
                  setProgress({
                    percent: data.percent || 0,
                    stage: data.stage || '',
                    message: data.message || ''
                  });
                  setStatus(data.message);
                  
                  // Update batch queue item status
                  if (index >= 0) {
                    setBatchQueue(prev => prev.map((item, i) => 
                      i === index ? { ...item, status: 'downloading', progress: data.percent } : item
                    ));
                  }
                } else if (data.type === 'complete') {
                  resultData = data;
                  setProgress({ percent: 100, stage: 'Complete', message: 'Done!' });
                  addToHistory(data);
                  
                  if (index >= 0) {
                    setBatchQueue(prev => prev.map((item, i) => 
                      i === index ? { ...item, status: 'complete', filename: data.filename, downloadUrl: data.url } : item
                    ));
                  }
                } else if (data.type === 'error') {
                  if (index >= 0) {
                    setBatchQueue(prev => prev.map((item, i) => 
                      i === index ? { ...item, status: 'error', error: data.message } : item
                    ));
                  }
                  reject(new Error(data.message));
                  return;
                }
              } catch (e) {
                console.error('Parse error:', e);
              }
            }
          }
        }
        resolve(resultData);
      } catch (err) {
        reject(err);
      }
    });
  };

  // Handle batch download (sequential)
  const handleBatchDownload = async () => {
    const urlList = urls.split('\n').map(u => u.trim()).filter(u => u);
    
    if (urlList.length === 0) {
      setError('Please enter at least one URL');
      return;
    }

    // Initialize queue
    const queue = urlList.map(u => ({ url: u, status: 'pending', progress: 0 }));
    setBatchQueue(queue);
    setLoading(true);
    setError(null);

    // Process each URL sequentially
    for (let i = 0; i < queue.length; i++) {
      setCurrentBatchIndex(i);
      setBatchQueue(prev => prev.map((item, idx) => 
        idx === i ? { ...item, status: 'downloading' } : item
      ));
      setProgress({ percent: 0, stage: 'Starting', message: `Downloading ${i + 1} of ${queue.length}...` });

      try {
        await downloadSingleUrl(queue[i].url, i);
      } catch (err) {
        console.error(`Failed to download ${queue[i].url}:`, err);
        // Continue with next URL even if one fails
      }
    }

    setLoading(false);
    setCurrentBatchIndex(-1);
    setStatus(`Batch complete! ${queue.filter(q => q.status === 'complete').length}/${queue.length} succeeded.`);
  };

  // Handle single URL download
  const handleDownload = async () => {
    if (batchMode) {
      return handleBatchDownload();
    }

    if (!url) {
      setError('Please enter a URL');
      return;
    }

    setLoading(true);
    setError(null);
    setResult(null);
    setProgress({ percent: 0, stage: 'Starting', message: 'Initializing...' });

    try {
      const resultData = await downloadSingleUrl(url);
      if (resultData) {
        setResult(resultData);
        setStatus('Download complete!');
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        setError(err.message || 'Download failed');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="container">
      <button className="theme-toggle" onClick={toggleTheme} title="Toggle theme">
        {darkMode ? '🌙' : '☀️'}
      </button>

      <main className="main">
        <h1 className="title">Universal Media Downloader</h1>
        <p className="description">
          Download video & audio from YouTube, Instagram, TikTok and 1000+ sites
        </p>

        <div className="card">
          {/* URL Input */}
          {batchMode ? (
            <textarea
              className="input textarea"
              placeholder="Paste multiple URLs (one per line)"
              value={urls}
              onChange={(e) => setUrls(e.target.value)}
              rows={4}
            />
          ) : (
            <input
              type="text"
              className="input"
              placeholder="Paste URL here (e.g., https://youtu.be/...)"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !loading && handleDownload()}
            />
          )}

          {/* Quality & Format Row */}
          <div className="options-row">
            <select 
              className="input quality-select"
              value={quality}
              onChange={(e) => setQuality(e.target.value)}
            >
              {qualityOptions.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>

            {quality !== 'audio' && (
              <select 
                className="input format-select"
                value={outputFormat}
                onChange={(e) => setOutputFormat(e.target.value)}
              >
                {formatOptions.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            )}
          </div>

          {/* Advanced Options Toggle */}
          <button 
            type="button"
            className="advanced-toggle"
            onClick={() => setShowAdvanced(!showAdvanced)}
          >
            {showAdvanced ? '▲ Hide Advanced Options' : '▼ Show Advanced Options'}
          </button>

          {/* Advanced Options Panel */}
          {showAdvanced && (
            <div className="advanced-panel">
              <div className="option-group">
                <label className="option-label">Custom Filename</label>
                <input
                  type="text"
                  className="input"
                  placeholder="Leave empty for auto-generated"
                  value={customFilename}
                  onChange={(e) => setCustomFilename(e.target.value)}
                />
              </div>

              <div className="option-group checkbox-group">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={subtitles}
                    onChange={(e) => setSubtitles(e.target.checked)}
                  />
                  <span>Download & Embed Subtitles (English)</span>
                </label>
              </div>

              <div className="option-group checkbox-group">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={batchMode}
                    onChange={(e) => setBatchMode(e.target.checked)}
                  />
                  <span>Batch Mode (Multiple URLs)</span>
                </label>
              </div>
            </div>
          )}

          {/* Action Buttons */}
          <div className="button-group">
            <button 
              className="button" 
              onClick={handleDownload}
              disabled={loading}
            >
              {loading ? 'Downloading...' : '⬇️ Download'}
            </button>
            <button 
              className="button refresh-button" 
              onClick={handleRefresh}
              disabled={!loading}
              title="Cancel download"
            >
              ✕
            </button>
          </div>

          {/* Progress Bar */}
          {loading && (
            <div className="progress-container">
              <div className="progress-bar">
                <div 
                  className="progress-fill" 
                  style={{ width: `${progress.percent}%` }}
                />
              </div>
              <div className="progress-info">
                <span className="progress-stage">{progress.stage}</span>
                <span className="progress-percent">{progress.percent.toFixed(0)}%</span>
              </div>
              <p className="progress-message">{progress.message}</p>
            </div>
          )}

          {/* Status Message */}
          {status && !loading && <p className="status">{status}</p>}

          {/* Error Display */}
          {error && (
            <div className="error-box">
              <strong>⚠️ Error</strong>
              <p>{error}</p>
            </div>
          )}

          {/* Success Display */}
          {result && !batchMode && (
            <div className="success-box">
              <p><strong>Title:</strong><br />{result.filename}</p>
              <a 
                href={result.url} 
                download 
                className="download-link"
              >
                📥 Click to Download File
              </a>
            </div>
          )}

          {/* Batch Queue Display */}
          {batchQueue.length > 0 && (
            <div className="batch-queue">
              <h4 className="batch-title">Download Queue ({batchQueue.filter(q => q.status === 'complete').length}/{batchQueue.length})</h4>
              <ul className="batch-list">
                {batchQueue.map((item, idx) => (
                  <li key={idx} className={`batch-item batch-item-${item.status}`}>
                    <span className="batch-status">
                      {item.status === 'pending' && '⏳'}
                      {item.status === 'downloading' && '⬇️'}
                      {item.status === 'complete' && '✅'}
                      {item.status === 'error' && '❌'}
                    </span>
                    <span className="batch-url" title={item.url}>
                      {item.url.length > 40 ? item.url.slice(0, 40) + '...' : item.url}
                    </span>
                    {item.status === 'downloading' && (
                      <span className="batch-progress">{item.progress?.toFixed(0) || 0}%</span>
                    )}
                    {item.status === 'complete' && item.downloadUrl && (
                      <a href={item.downloadUrl} download className="batch-download">📥</a>
                    )}
                    {item.status === 'error' && (
                      <span className="batch-error" title={item.error}>Failed</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {/* History Section */}
        {history.length > 0 && (
          <div className="history-section">
            <div className="history-title">
              <span>Recent Downloads</span>
              <button className="clear-btn" onClick={clearHistory}>Clear</button>
            </div>
            <ul className="history-list">
              {history.map((item, idx) => (
                <li key={idx} className="history-item">
                  <a href={item.url} download title={item.filename}>{item.filename}</a>
                  <span className="history-date">{item.date}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </main>
    </div>
  );
}
