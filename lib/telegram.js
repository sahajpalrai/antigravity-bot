const https = require('https');

// Send a Telegram notification using standard Node.js built-in 'https'
function sendTelegramMessage(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN || '8707962240:AAFGubG_ZMoe51E658oVJdCa4n9Ns0-7SZ0';
  const chatId = process.env.TELEGRAM_CHAT_ID || '1992829715';

  if (!token || !chatId) {
    console.log('[Telegram] Missing token or chat ID, skipping alert.');
    return;
  }

  const formattedText = `🤖 *V1 Antigravity Smart Bot Alert*\n\n${text}`;
  
  const payload = JSON.stringify({
    chat_id: chatId,
    text: formattedText,
    parse_mode: 'Markdown'
  });

  const options = {
    hostname: 'api.telegram.org',
    port: 443,
    path: `/bot${token}/sendMessage`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    }
  };

  const req = https.request(options, (res) => {
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => {
      try {
        const parsed = JSON.parse(data);
        if (!parsed.ok) {
          console.error('[Telegram] Error response:', parsed.description);
        }
      } catch (e) {
        console.error('[Telegram] Failed to parse response:', e.message);
      }
    });
  });

  req.on('error', (err) => {
    console.error('[Telegram] Request error:', err.message);
  });

  req.write(payload);
  req.end();
}

module.exports = {
  sendTelegramMessage
};
