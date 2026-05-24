const https = require('https');
const { URL } = require('url');

/*
================================================================================
GOOGLE APPS SCRIPT CODE FOR YOUR GOOGLE SHEET:
--------------------------------------------------------------------------------
1. Open a blank Google Sheet.
2. In the top menu, go to: Extensions -> Apps Script.
3. Replace all existing code in the editor with this script:

function doPost(e) {
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
    var data = JSON.parse(e.postData.contents);
    
    // Auto-create headers if sheet is empty
    if (sheet.getLastRow() === 0) {
      sheet.appendRow([
        "Timestamp", "Symbol", "Direction", "Contracts", "Entry Price", 
        "Exit Price", "Gross Profit/Loss", "Strategy Used", "Exit Reason"
      ]);
    }
    
    sheet.appendRow([
      data.exitTime || new Date().toISOString(),
      data.symbol,
      data.direction,
      data.qty,
      data.entryPrice,
      data.exitPrice,
      data.profit,
      data.strategyUsed,
      data.reason
    ]);
    
    return ContentService.createTextOutput(JSON.stringify({ "status": "success" }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ "status": "error", "message": err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

4. Click the Save icon.
5. Click "Deploy" (top right) -> "New deployment".
6. Select Type: "Web app".
7. Set Description: "Antigravity Smart Bot Webhook"
8. Set Execute as: "Me" (your email)
9. Set Who has access: "Anyone" (crucial, so our local server can log trades without Auth)
10. Click "Deploy". Authorize permissions if prompted.
11. Copy the "Web app URL" and paste it in your bot's Settings page or .env file!
================================================================================
*/

function logTradeToGoogleSheets(tradeRecord) {
  const webhookUrl = process.env.GOOGLE_SHEETS_WEBHOOK_URL;
  if (!webhookUrl) {
    console.log('[GoogleSheets] Webhook URL not set. Skipping sheet log.');
    return;
  }

  console.log(`[GoogleSheets] Sending trade log for ${tradeRecord.symbol} to spreadsheet...`);

  try {
    const parsedUrl = new URL(webhookUrl);
    const payload = JSON.stringify(tradeRecord);

    const options = {
      hostname: parsedUrl.hostname,
      port: 443,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    const req = https.request(options, (res) => {
      // Google Apps Script redirect handler (HTTP 302)
      if (res.statusCode === 302 && res.headers.location) {
        // Recurse using redirect location
        const redirectUrl = res.headers.location;
        const parsedRedirect = new URL(redirectUrl);
        
        const redirectOptions = {
          hostname: parsedRedirect.hostname,
          port: 443,
          path: parsedRedirect.pathname + parsedRedirect.search,
          method: 'GET'
        };

        const redirectReq = https.request(redirectOptions, (redirectRes) => {
          let data = '';
          redirectRes.on('data', (chunk) => { data += chunk; });
          redirectRes.on('end', () => {
            console.log('[GoogleSheets] Trade successfully logged to spreadsheet via redirect.');
          });
        });
        
        redirectReq.on('error', (err) => {
          console.error('[GoogleSheets] Redirect request error:', err.message);
        });
        redirectReq.end();
        return;
      }

      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        console.log('[GoogleSheets] Direct response from sheet webhook received.');
      });
    });

    req.on('error', (err) => {
      console.error('[GoogleSheets] HTTPS request error:', err.message);
    });

    req.write(payload);
    req.end();
  } catch (err) {
    console.error('[GoogleSheets] Webhook URL parsing failed:', err.message);
  }
}

module.exports = {
  logTradeToGoogleSheets
};
